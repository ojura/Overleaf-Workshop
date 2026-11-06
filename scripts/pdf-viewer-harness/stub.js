// Stands in for VS Code's webview API and for the extension host's side of the viewer's
// messages, in the harness page (server.mjs). Loaded as a classic script before the viewer's
// modules, as VS Code defines acquireVsCodeApi before the extension's scripts run.
(() => {
    const doc = new URL(document.currentScript.src).searchParams.get('doc') || 'book';
    const syncJSON = (url) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.send();
        return JSON.parse(xhr.responseText || 'null');
    };
    let hostState = syncJSON(`/state?doc=${encodeURIComponent(doc)}`);
    const builds = syncJSON('/builds');
    let currentBuild = new URLSearchParams(location.search).get('build') || 'a';
    const t0 = performance.now();
    const events = [];
    /** the probes waiting for an event of a type (harness.first) */
    const waiting = [];
    const log = (type, data = {}) => {
        const event = { t: Math.round(performance.now() - t0), type, ...data };
        events.push(event);
        for (const waiter of waiting.filter(w => w.type === type)) {
            waiting.splice(waiting.indexOf(waiter), 1);
            waiter.resolve(event);
        }
    };
    const deliver = (message) => window.postMessage(message, '*');
    const themes = {
        default: { fontColor: '#000000', bgColor: '#FFFFFF' },
        light: { fontColor: '#000000', bgColor: '#F5F5DC' },
        dark: { fontColor: '#FBF0D9', bgColor: '#4B4B4B' },
    };
    const stateKey = `vscode-state:${doc}`;
    const api = {
        postMessage(message) { handle(message); },
        getState() { return JSON.parse(sessionStorage.getItem(stateKey) || 'null'); },
        setState(state) { sessionStorage.setItem(stateKey, JSON.stringify(state)); return state; },
    };
    let acquired = false;
    window.acquireVsCodeApi = () => {
        if (acquired) { throw new Error('An instance of the VS Code API has already been acquired'); }
        acquired = true;
        return api;
    };
    const loadMessage = (build) => ({ type: 'load', output: builds[build] });
    async function handle(message) {
        if (message?.type === 'ready' || message?.type === 'saveState') {
            const page = JSON.parse(document.getElementById('viewer-config').textContent).page;
            if (message.page !== page) { return; }
        }
        switch (message?.type) {
            case 'ready':
                log('ready');
                deliver({ type: 'initState', content: hostState ?? undefined, colorThemes: themes, defaults: { scrollMode: 'vertical', spreadMode: 'none' } });
                deliver(loadMessage(currentBuild));
                log('load', { build: currentBuild });
                break;
            case 'saveState':
                hostState = message.content;
                fetch(`/state?doc=${encodeURIComponent(doc)}`, { method: 'POST', body: JSON.stringify(message.content) });
                log('saveState');
                break;
            case 'fetch': {
                const range = (message.headers || []).find(([name]) => name.toLowerCase() === 'range')?.[1];
                log('fetch', { url: new URL(message.url).pathname.replace(/^.*\/(build|content)\//, '$1/'), range });
                const res = await fetch('/bridge', { method: 'POST', body: JSON.stringify(message) });
                const error = res.headers.get('x-bridge-error');
                if (error) {
                    deliver({ type: 'fetchError', page: message.page, id: message.id, message: decodeURIComponent(error) });
                    log('fetchError', { message: decodeURIComponent(error) });
                    break;
                }
                const meta = JSON.parse(res.headers.get('x-bridge'));
                const body = new Uint8Array(await res.arrayBuffer());
                // the answer names the page that asked, as the extension host's does
                deliver({ type: 'fetchResponse', ...meta, page: message.page, body });
                break;
            }
            case 'buildGone':
            case 'buildShown':
                log(message.type, { build: message.build });
                break;
            case 'fetchAbort':
                fetch('/bridge-abort', { method: 'POST', body: JSON.stringify({ id: message.id }) });
                log('fetchAbort', { id: message.id });
                break;
            case 'switchViewer':
                // the viewer that the page asks the host to show the PDF in
                log('switchViewer', { engine: message.engine });
                break;
            default:
                log(message?.type ?? 'unknown', { content: message?.content });
        }
    }
    // VS Code's webview adds its keydown listener to the page's window when the page has loaded
    // (handleInnerKeydown in pre/index.html, bubble phase) and passes each key on to VS Code.
    window.addEventListener('load', () => {
        window.addEventListener('keydown', (e) => log('did-keydown', { key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, meta: e.metaKey }));
    });
    window.harness = {
        events,
        log,
        builds,
        /** the host's 'load' after a new compile */
        load(build) { currentBuild = build; log('load', { build }); deliver(loadMessage(build)); },
        /** the host's 'update', with the whole PDF */
        async update(build) {
            const data = await (await fetch(`/whole?build=${build}`)).arrayBuffer();
            log('update', { build, bytes: data.byteLength });
            deliver({ type: 'update', content: data });
        },
        syncCode(boxes) { log('syncCode'); deliver({ type: 'syncCode', content: boxes }); },
        messages(type) { return events.filter(e => e.type === type); },
        /** the first event of `type`: logged already, or the next one */
        first(type) {
            const seen = events.find(e => e.type === type);
            return seen ? Promise.resolve(seen) : new Promise(resolve => waiting.push({ type, resolve }));
        },
        /** the host's 'buildState' (src/core/projectBuilds.ts) */
        buildState(state, detail) { log('buildState', { state }); deliver({ type: 'buildState', state, detail }); },
    };
})();
