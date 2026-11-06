import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installDeliveryObservation } from './delivery-observation.mjs';

async function observation() {
    let now = 0, serial = 0, drawn;
    const frames = new Map(), timers = new Map(), documentEvents = new Map(), pageEvents = new Map();
    const rectangle = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
    const canvas = { isConnected: true, width: 100, height: 100, parentElement: null, ink: true,
        style: { display: 'block', visibility: 'visible', opacity: '1' },
        getBoundingClientRect: () => rectangle, toDataURL: () => 'data:image/png;base64,cGl4ZWxz' };
    const view = { canvas, renderingState: 3, paintedImageRevision: 0,
        paintedImageStatus: { pending: 2, completed: 0, failed: 0, revision: 0, total: 2, covered: 0, final: false, discovered: true },
        div: { querySelector: () => null, querySelectorAll: () => [{ textContent: 'Text before images' }] } };
    const storageClass = class {
        values = new Map();
        getItem(key) { return this.values.get(String(key)) ?? null; }
        setItem(key, value) { this.values.set(String(key), String(value)); }
    };
    const localStorage = new storageClass(), sessionStorage = new storageClass();
    localStorage.setItem('pdfjs.history', 'owner-history');
    localStorage.setItem('another-key', 'owner-setting');
    const context = vm.createContext({ Map, Set, Uint8Array, Uint8ClampedArray, Worker: class {}, Storage: storageClass,
        localStorage, sessionStorage, location: { origin: 'https://reader.example' }, innerWidth: 100, innerHeight: 100, devicePixelRatio: 1,
        performance: { timeOrigin: 1000, now: () => now },
        getComputedStyle: node => node.style,
        requestAnimationFrame: callback => { const id = ++serial; frames.set(id, callback); return id; },
        cancelAnimationFrame: id => frames.delete(id),
        setTimeout: callback => { const id = ++serial; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id),
        document: {
            addEventListener: (name, callback) => documentEvents.set(name, callback),
            dispatch: (name, event) => documentEvents.get(name)?.(event),
            querySelector: () => null,
            createRange: () => ({ selectNodeContents() {}, getClientRects: () => [rectangle] }),
            createElement: () => ({ getContext: () => ({ clearRect() {}, drawImage: value => { drawn = value; },
                getImageData: () => {
                    const data = new Uint8ClampedArray(48 * 48 * 4).fill(255);
                    if (drawn?.ink) for (let i = 0; i < 4; i++) data.fill(0, i * 4, i * 4 + 3);
                    return { data };
                } }) }),
        },
        PDFViewerApplication: {
            initializedPromise: Promise.resolve(),
            pdfDocument: { numPages: 1, hasExternalImages: true },
            eventBus: { on: (name, callback) => pageEvents.set(name, callback) },
            pdfViewer: { getPageView: index => index === 0 ? view : undefined, container: { getBoundingClientRect: () => rectangle } },
        },
        pdfPrefetch: { snapshot: () => ({}), setRobotsEnabled() {}, robotsEnabled: false },
        addEventListener() {},
    });
    context.window = context;
    vm.runInContext('(' + installDeliveryObservation.toString() + ')(' + JSON.stringify({ origin: 'https://reader.example', pages: [1],
        spread: 0, budgetMs: 1000, robots: false }) + ')', context);
    vm.runInContext("document.dispatch('webviewerloaded', {detail:{source:window}})", context);
    await Promise.resolve();
    pageEvents.get('pagesinit')();
    const render = (at, status = view.paintedImageStatus) => {
        now = at;
        status = { discovered: true, ...status };
        view.paintedImageStatus = status;
        view.paintedImageRevision = status.revision;
        pageEvents.get('pagerendered')({ pageNumber: 1, imageStatus: status, imageRevision: status.revision });
    };
    return { context, view, canvas, localStorage, sessionStorage, render, frames, timers,
        api: context.__pdfDeliveryObservation };
}

test('measurement history is local to the tab while unrelated storage remains functional', async () => {
    const h = await observation();
    assert.equal(h.localStorage.getItem('pdfjs.history'), null);
    h.localStorage.setItem('pdfjs.history', 'measurement-history');
    assert.equal(h.localStorage.getItem('pdfjs.history'), 'measurement-history');
    assert.equal(h.localStorage.values.get('pdfjs.history'), 'owner-history');
    h.localStorage.setItem('another-key', 'new-setting');
    assert.equal(h.localStorage.values.get('another-key'), 'new-setting');
    h.sessionStorage.setItem('pdfjs.history', 'session-history');
    assert.equal(h.sessionStorage.values.get('pdfjs.history'), 'session-history');
    h.api.finish('test');
    assert.equal(h.frames.size, 0);
    assert.equal(h.timers.size, 0);
});

test('text, usable photo coverage and final image quality are independent painted milestones', async () => {
    const h = await observation();
    h.render(10);
    let page = h.api.snapshot().pages[0];
    assert.equal(page.firstSelectableTextMs, 10);
    assert.equal(page.firstNativePixelsMs, 10);
    assert.equal(page.firstImagePixelsMs, undefined);
    assert.throws(() => h.api.captureCanvases(), /final image quality/);
    h.render(20, { pending: 2, completed: 0, failed: 0, revision: 1, total: 2, covered: 1, final: false });
    h.render(30, { pending: 2, completed: 0, failed: 0, revision: 2, total: 2, covered: 2, final: false });
    page = h.api.snapshot().pages[0];
    assert.equal(page.firstImagePixelsMs, 20);
    assert.equal(page.firstCompleteImageCoverageMs, 30);
    assert.equal(page.firstFinalQualityMs, undefined);
    assert.throws(() => h.api.captureCanvases(), /final image quality/);
    h.render(40, { pending: 0, completed: 2, failed: 0, revision: 3, total: 2, covered: 2, final: true });
    page = h.api.snapshot().pages[0];
    assert.equal(page.firstFinalQualityMs, 40);
    assert.equal(page.renders[0].imageStatus.covered, 0);
    assert.equal(h.api.captureCanvases()[0].width, 100);
    h.api.finish('test');
    h.render(80, { pending: 0, completed: 2, failed: 0, revision: 4, total: 2, covered: 2, final: true });
    assert.equal(h.api.snapshot().elapsedMs, 40);
    assert.equal(h.api.snapshot().pages[0].renders.length, 4);
});

test('complete photo coverage requires completed operator discovery', async () => {
    const h = await observation();
    h.render(10, { pending: 1, completed: 0, failed: 0, revision: 1, total: 1, covered: 1, final: false, discovered: false });
    assert.equal(h.api.snapshot().pages[0].firstImagePixelsMs, 10);
    assert.equal(h.api.snapshot().pages[0].firstCompleteImageCoverageMs, undefined);
    h.render(20, { pending: 2, completed: 0, failed: 0, revision: 2, total: 2, covered: 2, final: false, discovered: true });
    assert.equal(h.api.snapshot().pages[0].firstCompleteImageCoverageMs, 20);
    h.api.finish('test');
});

test('allocated, disconnected and hidden image canvases do not count as displayed pixels', async () => {
    const h = await observation();
    const status = { pending: 0, completed: 2, failed: 0, revision: 1, total: 2, covered: 2, final: true };
    h.canvas.ink = false;
    h.render(10, status);
    assert.equal(h.api.snapshot().pages[0].firstPixelsMs, undefined);
    h.canvas.ink = true; h.canvas.isConnected = false;
    h.render(20, status);
    assert.equal(h.api.snapshot().pages[0].firstPixelsMs, undefined);
    h.canvas.isConnected = true; h.canvas.style.visibility = 'hidden';
    h.render(30, status);
    assert.equal(h.api.snapshot().pages[0].firstPixelsMs, undefined);
    h.canvas.style.visibility = 'visible';
    h.render(40, status);
    assert.equal(h.api.snapshot().pages[0].firstImagePixelsMs, 40);
    h.api.finish('test');
});
