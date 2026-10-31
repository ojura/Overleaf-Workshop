// What the IDE scripts share. They drive only the window of an Antigravity instance that
// scripts/hidden-ide.sh started on a virtual display: the instance that instance.json describes in
// the folder that --instance names, or else in $HIDDEN_IDE_HOME (there is no default). They
// connect to the DevTools endpoint that start recorded, and only after the instance's IDE has
// answered there as itself (scripts/lib/test-instance.mjs); the workbench page and the viewers'
// frames are sessions of that one connection.
import fs from 'node:fs';
import path from 'node:path';
import { onCleanup, sleep } from '../../lib/cleanup.mjs';
import { evaluate, waitUntil, notWithinLimit } from '../../lib/devtools.mjs';
import { connectWindow, instanceHome, readInstance, workbenchTarget } from '../../lib/test-instance.mjs';
import { arg } from '../common.mjs';

export { evaluate, waitUntil, notWithinLimit, onCleanup, sleep };

/** The instance: its record in instance.json (pid, devtools, display, profile, replica, ...) and its folder, home. */
export function instance() {
    return readInstance(instanceHome(arg('instance')));
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

/** Press and release a key; modifiers add up from 1 Alt, 2 Ctrl, 4 Meta and 8 Shift. */
export async function key(session, keyChar, code, vk, modifiers = 0) {
    for (const type of ['rawKeyDown', 'keyUp']) {
        await session.send('Input.dispatchKeyEvent', { type, modifiers, key: keyChar, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    }
}

/** A left click at (x, y) in the session's page. */
export async function click(session, x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
        await session.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
}

/**
 * The instance's workbench window: `browser`, the checked connection to the instance's IDE,
 * `session` on the workbench page with the Runtime domain enabled, and E(expression), which
 * evaluates in that page. close() closes the connection, and with it every session of the script.
 */
export async function workbench(inst) {
    const browser = await connectWindow(inst);
    try {
        const session = await browser.attach((await workbenchTarget(browser)).targetId);
        await session.send('Runtime.enable');
        return { browser, session, E: (expression) => evaluate(session, expression), close: () => browser.close() };
    } catch (error) {
        browser.close();
        throw error;
    }
}

/** Run a command of the Command Palette by its title; returns whether the palette found it. */
export async function runCommand(wb, title) {
    await key(wb.session, 'P', 'KeyP', 80, 2 | 8);
    await sleep(400);
    await wb.session.send('Input.insertText', { text: title });
    await sleep(500);
    const selected = await wb.E(`document.querySelector('.quick-input-widget .quick-input-list .monaco-list-row.focused')?.textContent ?? ''`);
    if (!selected.toLowerCase().includes(title.toLowerCase())) {
        await key(wb.session, 'Escape', 'Escape', 27);
        return false;
    }
    await key(wb.session, 'Enter', 'Enter', 13);
    await sleep(500);
    return true;
}

/** Give the workbench the keyboard focus with a click on its title bar (or its status bar). */
export async function focusWorkbench(wb) {
    const bar = await wb.E(`(() => { const s = document.querySelector('.part.titlebar') || document.querySelector('.statusbar'); const r = s.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await click(wb.session, bar.x, bar.y);
    await sleep(200);
}

/**
 * Open *.pdf files in the extension's viewer, through workbench.editorAssociations in the
 * instance's settings: the viewer's own selector takes only PDFs of the extension's file system.
 * Returns a function that restores the setting, which also runs when the script ends otherwise.
 */
export async function associatePdfs(config) {
    const name = 'workbench.editorAssociations';
    const before = config.get(name);
    if (before?.['*.pdf'] === 'overleaf-workshop.pdfViewer') { return () => {}; }
    const restore = config.change(name, { ...(before ?? {}), '*.pdf': 'overleaf-workshop.pdfViewer' });
    await sleep(1500);
    return restore;
}

/**
 * Open a file with Quick Open, as a user would, and return the webview target of the viewer that
 * opens, or undefined. Quick Open opens an absolute path outside the workspace too. A tab of the
 * file that is open already is closed first, so that the file opens in a new viewer webview.
 */
export async function openWithQuickOpen(wb, file, timeoutMs = 15000) {
    await closeTab(wb, path.basename(file));
    const before = new Set((await viewerFrames(wb)).map(t => t.targetId));
    await focusWorkbench(wb);
    await key(wb.session, 'p', 'KeyP', 80, 2);
    await sleep(500);
    await wb.session.send('Input.insertText', { text: file });
    // wait for the file among Quick Open's results, which take a while in a new window
    const name = JSON.stringify(path.basename(file));
    for (let i = 0; i < 100; i++) {
        if (await wb.E(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row.focused')].some(r => r.textContent.includes(${name}))`)) { break; }
        await sleep(100);
    }
    await key(wb.session, 'Enter', 'Enter', 13);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const frame = (await viewerFrames(wb)).find(t => !before.has(t.targetId));
        if (frame) { return frame; }
        await sleep(50);
    }
    return undefined;
}

/** The targets of the webviews of the extension's PDF viewers in the workbench `wb`, newest last. */
export async function viewerFrames(wb) {
    const { targetInfos } = await wb.browser.send('Target.getTargets');
    return targetInfos.filter(t => t.type === 'iframe' && t.url.includes('extensionId=iamhyc.overleaf-workshop'));
}

/** The viewer object of a page, by the viewer it runs: an expression for the page. */
export const viewerOf = (engine) => engine === 'overleaf' ? 'window.overleafViewer.wrapper.viewer' : 'window.PDFViewerApplication.pdfViewer';

/** Whether the page in view is drawn in the viewer `engine`: an expression that is false while the viewer has no document. */
const pageInViewDrawn = (engine) => `(() => { const v = ${viewerOf(engine).replaceAll('.', '?.')}; return !!v && v.pagesCount > 0 && v.getPageView(v.currentPageNumber - 1)?.renderingState === 3; })()`;

/** The webview shows no viewer page at the moment, for example while a new page replaces the old one. */
export class NoPageError extends Error {}

/**
 * Attach to a viewer's webview, a target of viewerFrames(wb). VS Code runs the viewer page in the webview's inner frame named
 * active-frame, and a new frame replaces it when the page reloads, as after a switch of viewer.
 * E(expression) evaluates in the page that the webview shows now, and fails with a NoPageError
 * while it shows none, or when the page goes away during the evaluation; that is known from the
 * page's context events, not from the error. engine() says which viewer the page runs (pdfjs or
 * overleaf), or undefined while the webview shows no viewer page. The page's console errors,
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
    const engine = () => E(`window.overleafViewer ? 'overleaf' : window.PDFViewerApplication ? 'pdfjs' : undefined`)
        .catch((error) => { if (error instanceof NoPageError) { return undefined; } throw error; });
    /**
     * Wait until the webview shows a viewer whose page in view is drawn (`want`: that viewer only),
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

/** Close the editor tab whose label starts with `label`; returns whether such a tab was open. */
export async function closeTab(wb, label) {
    const closed = await wb.E(`(() => { const tab = [...document.querySelectorAll('.tabs-container .tab')].find(t => (t.getAttribute('aria-label') || '').startsWith(${JSON.stringify(label)})); if (!tab) { return false; } tab.querySelector('.tab-actions .action-label, .codicon-close').click(); return true; })()`);
    if (closed) { await sleep(800); }
    return closed;
}

/**
 * Close the editor tab whose label starts with `label`, reopen it with View: Reopen Closed
 * Editor, and return the new viewer webview's target; undefined when the tab was not open, or
 * when it did not open again within `timeoutMs`.
 */
export async function reopenTab(wb, label, timeoutMs = 10000) {
    const before = new Set((await viewerFrames(wb)).map(t => t.targetId));
    if (!(await closeTab(wb, label))) { return undefined; }
    await focusWorkbench(wb);
    await key(wb.session, 'T', 'KeyT', 84, 2 | 8);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const frame = (await viewerFrames(wb)).find(t => !before.has(t.targetId));
        if (frame) { return frame; }
        await sleep(30);
    }
    return undefined;
}

/** Whether the window draws: requestAnimationFrame fires within 1.5 s. */
export const windowDraws = (wb) => wb.E(`Promise.race([new Promise(r => requestAnimationFrame(() => r(true))), new Promise(r => setTimeout(() => r(false), 1500))])`);

/** A script for viewerPage's beforeLoad: requestAnimationFrame on a 16 ms timer, for a window that does not draw. */
export const rafOnTimer = 'window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16); window.cancelAnimationFrame = (id) => clearTimeout(id);';

/** Record a check: prints PASS or FAIL with its detail. results() lists them. */
export function checker() {
    const all = [];
    const check = (name, ok, detail = '') => { all.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
    const summary = () => { const ok = all.length > 0 && all.every(Boolean); console.log(ok ? 'ALL PASS' : 'SOME FAILED'); process.exitCode = ok ? 0 : 1; };
    return { check, summary };
}
