// What the IDE scripts share. They drive only the window of an Antigravity instance that
// scripts/hidden-ide.sh started on a virtual display, through the window's debugging port: the
// instance that instance.json describes in $HIDDEN_IDE_HOME (default /tmp/hidden-ide-<uid>), or in
// the folder that --instance names.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { arg } from '../common.mjs';

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * The instance: its main process, debugging port, display, profile and replica folder. The main
 * process must hold the debugging port, so a script cannot reach a window that took the port of an
 * instance that has stopped.
 */
export function instance() {
    const home = path.resolve(arg('instance') ?? process.env.HIDDEN_IDE_HOME ?? `/tmp/hidden-ide-${os.userInfo().uid}`);
    const file = path.join(home, 'instance.json');
    if (!fs.existsSync(file)) {
        throw new Error(`${file} does not exist: start an instance with scripts/hidden-ide.sh start, or name its folder with --instance or HIDDEN_IDE_HOME`);
    }
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    const listener = execFileSync('ss', ['-ltnpH', `sport = :${info.cdp}`], { encoding: 'utf8' });
    if (!listener.includes(`pid=${info.pid},`)) {
        throw new Error(`port ${info.cdp} does not belong to the instance's process ${info.pid}: ${listener.trim() || 'the port is closed'}`);
    }
    return { home, pid: Number(info.pid), port: Number(info.cdp), display: info.display, profile: info.profile, replica: info.replica };
}

/**
 * The instance's user settings (profile/User/settings.json): get(key), and set(key, value), which
 * VS Code applies when it sees the file change; set(key, undefined) removes the key. The file must
 * be plain JSON, as hidden-ide.sh and VS Code's settings editor write it.
 */
export function settings(inst) {
    const file = path.join(inst.profile, 'User', 'settings.json');
    const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {});
    return {
        file,
        get: (key) => read()[key],
        set: (key, value) => {
            const all = read();
            if (value === undefined) { delete all[key]; } else { all[key] = value; }
            fs.writeFileSync(file, `${JSON.stringify(all, null, 4)}\n`);
        },
    };
}

/** The debugging targets of the instance on `port`, as /json/list lists them. */
export async function targets(port) {
    return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

/** A DevTools Protocol connection to one target: send(method, params), on(event, fn), close(). */
export async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let next = 1;
    const pending = new Map();
    const listeners = new Map();
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        } else if (msg.method) {
            for (const fn of listeners.get(msg.method) ?? []) { fn(msg.params); }
        }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });
    const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
    return { send, on, close: () => ws.close() };
}

/** Evaluate an expression in a session, in the context `contextId` or the default one, and return its value. */
export async function evaluate(session, expression, contextId) {
    const r = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) });
    if (r.exceptionDetails) { throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); }
    return r.result.value;
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

/** The instance's workbench page, connected, with the Runtime domain enabled; E(expression) evaluates in it. */
export async function workbench(port) {
    const target = (await targets(port)).find(t => t.type === 'page' && t.url.includes('/workbench/workbench.html'));
    if (!target) { throw new Error(`the instance on port ${port} does not show a workbench window`); }
    const session = await connect(target.webSocketDebuggerUrl);
    await session.send('Runtime.enable');
    return { session, E: (expression) => evaluate(session, expression), close: () => session.close() };
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
 * Returns a function that restores the setting.
 */
export async function associatePdfs(config) {
    const name = 'workbench.editorAssociations';
    const before = config.get(name);
    if (before?.['*.pdf'] === 'overleaf-workshop.pdfViewer') { return () => {}; }
    config.set(name, { ...(before ?? {}), '*.pdf': 'overleaf-workshop.pdfViewer' });
    await sleep(1500);
    return () => config.set(name, before);
}

/**
 * Open a file with Quick Open, as a user would, and return the webview target of the viewer that
 * opens, or undefined. Quick Open opens an absolute path outside the workspace too. A tab of the
 * file that is open already is closed first, so that the file opens in a new viewer webview.
 */
export async function openWithQuickOpen(wb, port, file, timeoutMs = 15000) {
    await closeTab(wb, path.basename(file));
    const before = new Set((await viewerFrames(port)).map(t => t.id));
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
        const frame = (await viewerFrames(port)).find(t => !before.has(t.id));
        if (frame) { return frame; }
        await sleep(50);
    }
    return undefined;
}

/** The webviews of the extension's PDF viewers, newest last. */
export async function viewerFrames(port) {
    return (await targets(port)).filter(t => t.type === 'iframe' && t.url.includes('extensionId=iamhyc.overleaf-workshop'));
}

/** The viewer object of a page, by the viewer it runs: an expression for the page. */
export const viewerOf = (engine) => engine === 'overleaf' ? 'window.overleafViewer.wrapper.viewer' : 'window.PDFViewerApplication.pdfViewer';

/**
 * Connect to a viewer's webview. VS Code runs the viewer page in the webview's inner frame named
 * active-frame, and a new frame replaces it when the page reloads, as after a switch of viewer.
 * E(expression) evaluates in the page that the webview shows now; engine() says which viewer that
 * is (pdfjs or overleaf), or undefined while it shows neither. The page's console errors, warnings
 * and exceptions collect in `problems`. `beforeLoad` is a script that runs in every page the
 * webview loads from now on, before the page's own scripts.
 */
export async function viewerPage(frameTarget, { beforeLoad } = {}) {
    const session = await connect(frameTarget.webSocketDebuggerUrl);
    const contexts = [];
    const problems = [];
    session.on('Runtime.executionContextCreated', (p) => contexts.push(p.context));
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
        return inner && contexts.filter(c => c.auxData?.frameId === inner.id && c.auxData?.isDefault).at(-1);
    };
    const E = async (expression) => {
        const ctx = await context();
        if (!ctx) { throw new Error('the webview does not show a page'); }
        return evaluate(session, expression, ctx.id);
    };
    const engine = () => E(`window.overleafViewer ? 'overleaf' : window.PDFViewerApplication ? 'pdfjs' : undefined`).catch(() => undefined);
    /** wait until the webview shows a viewer whose page in view is drawn (`want`: that viewer only); returns the viewer and the time taken */
    const drawn = async (want, timeoutMs = 60000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            const now = await engine();
            if (now && (!want || now === want)) {
                const ok = await E(`(() => { try { const v = ${viewerOf(now)}; return v.pagesCount > 0 && v.getPageView(v.currentPageNumber - 1).renderingState === 3; } catch { return false; } })()`).catch(() => false);
                if (ok) { return { engine: now, ms: Date.now() - t0 }; }
            }
            await sleep(100);
        }
        return undefined;
    };
    return { session, problems, context, E, engine, drawn, close: () => session.close() };
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
export async function reopenTab(wb, port, label, timeoutMs = 10000) {
    const before = new Set((await viewerFrames(port)).map(t => t.id));
    if (!(await closeTab(wb, label))) { return undefined; }
    await focusWorkbench(wb);
    await key(wb.session, 'T', 'KeyT', 84, 2 | 8);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const frame = (await viewerFrames(port)).find(t => !before.has(t.id));
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
