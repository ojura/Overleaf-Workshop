// What the IDE scripts share. They drive only the window of an Antigravity instance that
// scripts/hidden-ide.sh started on a virtual display: the instance that instance.json describes in
// the folder that --instance names, or else in $HIDDEN_IDE_HOME (they require one of the two). They
// connect to the DevTools endpoint that start recorded, and only after the instance's IDE has
// answered there as itself (scripts/lib/test-instance.mjs); the workbench page and the viewers'
// frames are sessions of that one connection.
import fs from 'node:fs';
import path from 'node:path';
import { onCleanup, sleep } from '../../lib/cleanup.mjs';
import { answerWithin, clickAt, evaluate, notWithinLimit, pressKey, waitForTarget, waitUntil, whenTruthy } from '../../lib/devtools.mjs';
import { checkInstanceFolder, connectWindow, drawsExpression, instanceHome, readRunningInstance, workbenchTarget } from '../../lib/test-instance.mjs';
import { checker } from '../common.mjs';
import { ENGINE_OF_PAGE, pageInViewDrawn, viewerOf } from '../viewers.mjs';

export { clickAt, evaluate, notWithinLimit, onCleanup, pressKey, sleep, waitUntil, whenTruthy };
/** What the drivers use of the viewer pages (../viewers.mjs). */
export * from '../viewers.mjs';

/** The option that every driver takes: --instance DIR, the instance's folder, else $HIDDEN_IDE_HOME. */
export const INSTANCE_OPTION = { instance: 'value' };

/**
 * The instance: its record in instance.json (pid, devtools, display, profile, replica, ...) and its
 * folder, home, from the script's options (scripts/lib/options.mjs, with INSTANCE_OPTION). The
 * folder is checked first (checkInstanceFolder), and the instance must run (readRunningInstance),
 * before a driver changes a setting.
 */
export function instance(options) {
    const home = instanceHome(options.get('instance'), '--instance');
    checkInstanceFolder(home);
    return readRunningInstance(home);
}

/**
 * The instance's user settings (profile/User/settings.json): get(key), and set(key, value), which
 * VS Code applies when it sees the file change; set(key, undefined) removes the key. The file must
 * be plain JSON, as hidden-ide.sh and VS Code's settings editor write it. guard(key) registers the
 * restore of the key's present value as a clean-up of the script (scripts/lib/cleanup.mjs), and
 * returns the restore, which runs at once when called; change(key, value) guards the key and sets it.
 */
export function settings(inst) {
    const file = path.join(inst.profile, 'User', 'settings.json');
    const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {});
    const set = (key, value) => {
        const all = read();
        if (value === undefined) { delete all[key]; } else { all[key] = value; }
        fs.writeFileSync(file, `${JSON.stringify(all, null, 4)}\n`);
    };
    const guard = (key) => {
        const before = read()[key];
        return onCleanup(() => set(key, before)).run;
    };
    const change = (key, value) => {
        const restore = guard(key);
        set(key, value);
        return restore;
    };
    return { file, get: (key) => read()[key], set, guard, change };
}

/** The last resort for a workbench that never lays out its status bar, for example a window stuck on its start. */
const WORKBENCH_LAYOUT_LIMIT_MS = 60000;

/**
 * The instance's workbench window: `browser`, the checked connection to the instance's IDE,
 * `session` on the workbench page with the Runtime domain enabled, and E(expression), which
 * evaluates in that page. It returns once the workbench has laid out its status bar: the page
 * reports that from its own DOM changes (a MutationObserver), since the window's page exists some
 * time before the workbench's parts do. close() closes the connection, and with it every session
 * of the script.
 */
export async function workbench(inst) {
    const browser = await connectWindow(inst);
    try {
        const session = await browser.attach((await workbenchTarget(browser)).targetId);
        await session.send('Runtime.enable');
        await answerWithin(browser, "the workbench's layout", WORKBENCH_LAYOUT_LIMIT_MS, () => evaluate(session, `new Promise((resolve) => {
            const laidOut = () => document.querySelector('.monaco-workbench .part.statusbar');
            if (laidOut()) { resolve(true); return; }
            const observer = new MutationObserver(() => { if (laidOut()) { observer.disconnect(); resolve(true); } });
            observer.observe(document, { childList: true, subtree: true });
        })`));
        return { browser, session, E: (expression) => evaluate(session, expression), close: () => browser.close() };
    } catch (error) {
        browser.close();
        throw error;
    }
}

/** Whether Quick Open or the Command Palette is shown: an expression that is undefined while it is not. */
export const QUICK_INPUT_SHOWN = `(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none' ? true : undefined; })()`;
/** Whether Quick Open and the Command Palette are hidden: an expression that is undefined while one is shown. */
export const QUICK_INPUT_HIDDEN = `(() => { const w = document.querySelector('.quick-input-widget'); return !w || getComputedStyle(w).display === 'none' ? true : undefined; })()`;
/**
 * How long the Command Palette gets to list a command after its title was typed: the list follows
 * the typed text within a frame or two, and a command that it does not list by then is taken as
 * not offered.
 */
const PALETTE_LIST_LIMIT_MS = 2000;

/** Run a command of the Command Palette by its title; returns whether the palette offered it. */
export async function runCommand(wb, title) {
    await pressKey(wb.session, 'Ctrl+Shift+P');
    if (!(await untilInPage(wb, `document.activeElement?.closest('.quick-input-widget') ? true : undefined`))) {
        throw new Error(`the Command Palette did not take the keyboard focus within ${WORKBENCH_CHANGE_LIMIT_MS / 1000} s of Ctrl+Shift+P`);
    }
    await wb.session.send('Input.insertText', { text: title });
    const offered = await untilInPage(wb, `(document.querySelector('.quick-input-widget .quick-input-list .monaco-list-row.focused')?.textContent ?? '').toLowerCase().includes(${JSON.stringify(title.toLowerCase())}) ? true : undefined`, PALETTE_LIST_LIMIT_MS);
    await pressKey(wb.session, offered ? 'Enter' : 'Escape');
    if (!(await untilInPage(wb, QUICK_INPUT_HIDDEN))) {
        throw new Error(`the Command Palette is still shown ${WORKBENCH_CHANGE_LIMIT_MS / 1000} s after ${offered ? 'Enter' : 'Escape'}`);
    }
    return !!offered;
}

/** Give the workbench the keyboard focus with a click on its title bar (or its status bar), and wait until a webview no longer has it. */
export async function focusWorkbench(wb) {
    const bar = await wb.E(`(() => { const s = document.querySelector('.part.titlebar') || document.querySelector('.statusbar'); const r = s.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await clickAt(wb.session, bar.x, bar.y);
    if (!(await untilInPage(wb, `document.activeElement?.tagName !== 'IFRAME' ? true : undefined`))) {
        throw new Error(`the workbench did not take the keyboard focus within ${WORKBENCH_CHANGE_LIMIT_MS / 1000} s of a click on its title bar`);
    }
}

/**
 * How long VS Code gets to read a change of settings.json: it reads the file when its file watcher
 * reports the change, and the workbench's page does not show when that has happened, so this is a
 * wait of a fixed time.
 */
const SETTINGS_READ_MS = 1500;

/**
 * Open *.pdf files in the extension's viewer, through workbench.editorAssociations in the
 * instance's settings: the viewer's own selector takes only PDFs of the extension's file system.
 * Returns a function that restores the setting, which also runs when the script ends otherwise.
 * A viewer that does not open after the change shows as openWithQuickOpen's failure.
 */
export async function associatePdfs(config) {
    const name = 'workbench.editorAssociations';
    const before = config.get(name);
    if (before?.['*.pdf'] === 'overleaf-workshop.pdfViewer') { return () => {}; }
    const restore = config.change(name, { ...(before ?? {}), '*.pdf': 'overleaf-workshop.pdfViewer' });
    await sleep(SETTINGS_READ_MS);
    return restore;
}

/**
 * The last resort for the workbench's own changes that the drivers wait for: Quick Open's input,
 * its list of files, which a new window fills within a few seconds, and a tab that closes.
 */
const WORKBENCH_CHANGE_LIMIT_MS = 15000;
/** The last resort for a viewer that does not open after Enter in Quick Open. */
const VIEWER_OPEN_LIMIT_MS = 15000;

/**
 * The value of `condition`, an expression for the workbench page, once it is truthy: the page
 * evaluates it again on each change of its DOM and of its focus (whenTruthy in
 * scripts/lib/devtools.mjs). After `limitMs` the page answers undefined.
 */
export function untilInPage(wb, condition, limitMs = WORKBENCH_CHANGE_LIMIT_MS) {
    return wb.E(whenTruthy(condition, limitMs));
}

/**
 * Open the file `file`, an absolute path, with Quick Open, as a user would, and return the
 * webview target of the viewer that opens. Quick Open opens an absolute path outside the workspace
 * too. A tab of the file that is open already is closed first, so that the file opens in a new
 * viewer webview. Enter goes to Quick Open only once its focused row is the file, by its name and
 * its folder, so that a row of another file with the same name, which Quick Open's history can
 * put first, is not opened. Fails, naming Quick Open's focused row, when that does not happen
 * within WORKBENCH_CHANGE_LIMIT_MS, and when the viewer does not open within VIEWER_OPEN_LIMIT_MS.
 */
export async function openWithQuickOpen(wb, file) {
    await closeTab(wb, path.basename(file));
    const before = new Set((await viewerFrames(wb)).map(t => t.targetId));
    await focusWorkbench(wb);
    await pressKey(wb.session, 'Ctrl+P');
    if (!(await untilInPage(wb, `document.activeElement?.closest('.quick-input-widget') ? true : undefined`))) {
        throw new Error(`Quick Open did not take the keyboard focus within ${WORKBENCH_CHANGE_LIMIT_MS / 1000} s of Ctrl+P`);
    }
    await wb.session.send('Input.insertText', { text: file });
    const want = JSON.stringify({ name: path.basename(file), folder: path.dirname(file) });
    const focusedRow = `document.querySelector('.quick-input-widget .monaco-list-row.focused')`;
    const isFile = `(() => { const row = ${focusedRow}; const want = ${want}; return row && row.querySelector('.label-name')?.textContent === want.name && row.querySelector('.label-description')?.textContent === want.folder ? true : undefined; })()`;
    if (!(await untilInPage(wb, isFile))) {
        const row = await wb.E(`${focusedRow}?.getAttribute('aria-label') ?? '(Quick Open does not focus a row)'`);
        await pressKey(wb.session, 'Escape');
        throw new Error(`Quick Open did not focus ${file} within ${WORKBENCH_CHANGE_LIMIT_MS / 1000} s; its focused row is ${row}`);
    }
    await pressKey(wb.session, 'Enter');
    return waitForTarget(wb.browser, (t) => isViewerFrame(t) && !before.has(t.targetId), { what: `a viewer of ${file}`, limitMs: VIEWER_OPEN_LIMIT_MS });
}

/** Whether the DevTools target `t` is the webview of one of the extension's PDF viewers. */
const isViewerFrame = (t) => t.type === 'iframe' && t.url.includes('extensionId=iamhyc.overleaf-workshop');

/** The targets of the webviews of the extension's PDF viewers in the workbench `wb`, newest last. */
export async function viewerFrames(wb) {
    const { targetInfos } = await wb.browser.send('Target.getTargets');
    return targetInfos.filter(isViewerFrame);
}

/** The webview does not show a viewer page at the moment, for example while a new page replaces the old one. */
export class NoPageError extends Error {}

/**
 * Attach to a viewer's webview, a target of viewerFrames(wb). VS Code runs the viewer page in the webview's inner frame named
 * active-frame, and a new frame replaces it when the page reloads, as after a switch of viewer.
 * E(expression) evaluates in the page that the webview shows now, and fails with a NoPageError
 * while it does not show one, or when the page goes away during the evaluation; that is known from the
 * page's context events, not from the error. engine() says which viewer the page runs (pdfjs or
 * overleaf), or undefined while the webview does not show a viewer page. The page's console errors,
 * warnings and exceptions collect in `problems`. `beforeLoad` is a script that runs in every page
 * the webview loads from now on, before the page's own scripts.
 */
export async function viewerPage(wb, frameTarget, { beforeLoad } = {}) {
    const session = await wb.browser.attach(frameTarget.targetId);
    /** the execution contexts that exist, by id, from the Runtime domain's events */
    const contexts = new Map();
    const problems = [];
    session.on('Runtime.executionContextCreated', (p) => contexts.set(p.context.id, p.context));
    session.on('Runtime.executionContextDestroyed', (p) => contexts.delete(p.executionContextId));
    session.on('Runtime.executionContextsCleared', () => contexts.clear());
    session.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'warning') { problems.push(`${p.type}: ${p.args.map(a => a.value ?? a.description).join(' ').slice(0, 300)}`); } });
    session.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 300)}`));
    await session.send('Page.enable');
    if (beforeLoad) { await session.send('Page.addScriptToEvaluateOnNewDocument', { source: beforeLoad }); }
    await session.send('Runtime.enable');
    /** the default context of the page in the active frame, or undefined */
    const context = async () => {
        const { frameTree } = await session.send('Page.getFrameTree');
        const all = [];
        const walk = (node) => { all.push(node.frame); (node.childFrames ?? []).forEach(walk); };
        walk(frameTree);
        const inner = all.find(f => f.name === 'active-frame');
        return inner && [...contexts.values()].filter(c => c.auxData?.frameId === inner.id && c.auxData?.isDefault).at(-1);
    };
    const E = async (expression) => {
        const ctx = await context();
        if (!ctx) { throw new NoPageError('the webview does not show a page'); }
        try {
            return await evaluate(session, expression, ctx.id);
        } catch (error) {
            if (!contexts.has(ctx.id)) { throw new NoPageError(`the page went away during the evaluation (${error.message})`); }
            throw error;
        }
    };
    const engine = () => E(ENGINE_OF_PAGE)
        .catch((error) => { if (error instanceof NoPageError) { return undefined; } throw error; });
    /**
     * Wait until the webview shows a viewer that has drawn the page in view (`want`: that viewer only),
     * and return { engine, ms }, or undefined when that has not happened within `limitMs`. An error
     * in the page ends the wait with that error.
     */
    const drawn = (want, limitMs = 60000) => waitUntil(async () => {
        const now = await engine();
        if (!now || (want && now !== want)) { return undefined; }
        try {
            return (await E(pageInViewDrawn(now))) && now;
        } catch (error) {
            if (error instanceof NoPageError) { return undefined; }
            throw error;
        }
    }, { what: `a drawn page in the ${want ?? 'pdfjs or overleaf'} viewer`, limitMs, stepMs: 100 })
        .then(({ value, ms }) => ({ engine: value, ms }), notWithinLimit);
    return { session, problems, context, E, engine, drawn, close: () => session.detach() };
}

/**
 * The newest PDF viewer in the workbench `wb` (the last of viewerFrames), attached with viewerPage
 * and `beforeLoad`, once it has drawn the page in view: { view, engine, V }, where V is the
 * expression for its viewer object (viewerOf). It fails when the workbench does not show a viewer,
 * and when the viewer has not drawn the page in view within `limitMs`; that error lists the
 * page's console problems.
 */
export async function newestViewer(wb, { beforeLoad, limitMs = 30000 } = {}) {
    const frame = (await viewerFrames(wb)).at(-1);
    if (!frame) { throw new Error('the instance does not show a PDF viewer: open a PDF in it first'); }
    const view = await viewerPage(wb, frame, { beforeLoad });
    const shown = await view.drawn(undefined, limitMs);
    if (!shown) {
        const problems = view.problems.length ? view.problems.slice(0, 8).join(' | ') : 'none';
        throw new Error(`the newest viewer has not drawn the page in view within ${limitMs / 1000} s; console problems in its page: ${problems}`);
    }
    return { view, engine: shown.engine, V: viewerOf(shown.engine) };
}

/**
 * Close the editor tab with a label that starts with `label`, and wait until the workbench has
 * removed it; returns whether such a tab was open.
 */
export async function closeTab(wb, label) {
    const tab = `[...document.querySelectorAll('.tabs-container .tab')].find(t => (t.getAttribute('aria-label') || '').startsWith(${JSON.stringify(label)}))`;
    const closed = await wb.E(`(() => { const tab = ${tab}; if (!tab) { return false; } tab.querySelector('.tab-actions .action-label, .codicon-close').click(); return true; })()`);
    if (closed && !(await untilInPage(wb, `${tab} ? undefined : true`))) {
        throw new Error(`the tab ${label} is still open ${WORKBENCH_CHANGE_LIMIT_MS / 1000} s after its close button was clicked`);
    }
    return closed;
}

/**
 * Close the editor tab with a label that starts with `label`, reopen it with View: Reopen Closed
 * Editor, and return the new viewer webview's target, from the targets or the event of its
 * creation; undefined when the tab was not open, or when it did not open again within `timeoutMs`.
 */
export async function reopenTab(wb, label, timeoutMs = 10000) {
    const before = new Set((await viewerFrames(wb)).map(t => t.targetId));
    if (!(await closeTab(wb, label))) { return undefined; }
    await focusWorkbench(wb);
    await pressKey(wb.session, 'Ctrl+Shift+T');
    return waitForTarget(wb.browser, (t) => isViewerFrame(t) && !before.has(t.targetId), { what: `a viewer of ${label}`, limitMs: timeoutMs }).catch(notWithinLimit);
}

/** Whether the window draws (drawsExpression in scripts/lib/test-instance.mjs). */
export const windowDraws = (wb) => wb.E(drawsExpression);

/** A script for viewerPage's beforeLoad: requestAnimationFrame on a 16 ms timer, for a window that does not draw. */
export const rafOnTimer = 'window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16); window.cancelAnimationFrame = (id) => clearTimeout(id);';

/** The checks of a driver (common.mjs). */
export { checker };
