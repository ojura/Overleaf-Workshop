import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pdfjsReleaseFolder } from '../viewer-protocol.mjs';
import { installDeliveryObservation } from './delivery-observation.mjs';

const nativeViewer = fs.readFileSync(new URL('../../views/pdf-viewer/' + pdfjsReleaseFolder + '/web/viewer.mjs', import.meta.url), 'utf8');
const initialViewStart = nativeViewer.indexOf('  setInitialView(storedHash, {');
const initialViewEnd = nativeViewer.indexOf('\n  _cleanup()', initialViewStart);
assert.ok(initialViewStart >= 0 && initialViewEnd > initialViewStart, 'use the pinned native application initial-view method');
const nativeInitialView = nativeViewer.slice(initialViewStart, initialViewEnd);

async function observation(engine = 'pdfjs', { pages = [1], spread = 0, zoom = 75, deferInitialView = false } = {}) {
    let now = 0, serial = 0, drawn;
    const frames = new Map(), timers = new Map(), documentEvents = new Map(), windowEvents = new Map(), pageEvents = new Map();
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
            removeEventListener: name => documentEvents.delete(name),
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
        isValidRotation: value => Number.isInteger(value) && value % 90 === 0,
        isValidScrollMode: value => Number.isInteger(value) && value >= 0 && value <= 3,
        isValidSpreadMode: value => Number.isInteger(value) && value >= 0 && value <= 2,
        ['DEFAULT_SCALE_VALUE']: 'auto',
        PDFViewerApplication: {
            initializedPromise: Promise.resolve(),
            pdfDocument: { numPages: Math.max(...pages), hasExternalImages: true },
            eventBus: { on: (name, callback) => pageEvents.set(name, callback),
                off: (name, callback) => { if (pageEvents.get(name) === callback) { pageEvents.delete(name); } } },
            pdfViewer: { getPageView: index => index === 0 ? view : undefined, container: { getBoundingClientRect: () => rectangle } },
        },
        pdfPrefetch: { snapshot: () => ({}), setRobotsEnabled() {}, robotsEnabled: false },
        addEventListener: (name, callback) => windowEvents.set(name, callback),
        removeEventListener: name => windowEvents.delete(name),
    });
    context.window = context;
    const application = context.PDFViewerApplication, viewer = application.pdfViewer;
    viewer.pdfDocument = application.pdfDocument; viewer.eventBus = application.eventBus;
    application.pdfLinkService = { setHash(hash) {
        const params = new URLSearchParams(hash);
        viewer.currentPageNumber = Number(params.get('page'));
        viewer.currentScaleValue = String(Number(params.get('zoom')) / 100);
    } };
    application.setInitialView = vm.runInContext('({' + nativeInitialView + '}).setInitialView', context);
    const restoreInitialView = ({ page = 1, zoom = 125, spread = 0 } = {}) => {
        // The extension restores its host position at pagesinit. The native app then
        // applies its on-load modes and bookmark before dispatching documentinit.
        viewer.currentPageNumber = page; viewer.currentScaleValue = String(zoom / 100);
        viewer.spreadMode = spread;
        application.initialBookmark = 'page=' + page + '&zoom=' + zoom;
        application.setInitialView(null, { spreadMode: spread, scrollMode: 0 });
        pageEvents.get('documentinit')?.({ source: application });
    };
    if (engine === 'overleaf') {
        delete context.PDFViewerApplication;
        context.overleafViewer = { wrapper: { viewer, eventBus: viewer.eventBus } };
    }
    vm.runInContext('(' + installDeliveryObservation.toString() + ')(' + JSON.stringify({ origin: 'https://reader.example', pages,
        spread, budgetMs: 1000, robots: false, zoom }) + ')', context);
    if (engine === 'pdfjs') vm.runInContext("document.dispatch('webviewerloaded', {detail:{source:window}})", context);
    else windowEvents.get('message')?.({ data: { type: 'initState' } });
    await Promise.resolve();
    pageEvents.get('pagesinit')();
    if (engine === 'pdfjs' && !deferInitialView) { restoreInitialView(); }
    const render = (at, status = view.paintedImageStatus) => {
        now = at;
        status = { discovered: true, ...status };
        view.paintedImageStatus = status;
        view.paintedImageRevision = status.revision;
        pageEvents.get('pagerendered')({ pageNumber: 1, imageStatus: status, imageRevision: status.revision });
    };
    return { context, view, canvas, viewer, localStorage, sessionStorage, render, frames, timers, windowEvents, pageEvents, restoreInitialView,
        api: context.__pdfDeliveryObservation };
}

test('requested PDF.js spread and pages survive native default and host restoration', async () => {
    const h = await observation('pdfjs', { pages: [99, 100], spread: 1, zoom: 75, deferInitialView: true });
    h.restoreInitialView({ page: 7, zoom: 125, spread: 0 });
    assert.equal(h.viewer.spreadMode, 1, 'apply the requested spread after native setInitialView');
    assert.equal(h.viewer.currentPageNumber, 99, 'the requested first page follows restored host position');
    assert.equal(h.viewer.currentScaleValue, '0.75');
    assert.equal(h.pageEvents.has('documentinit'), false, 'one completion releases the layout listener');
    h.api.finish('test');
    assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
});

test('finishing before native initialization leaves later host layout untouched', async () => {
    const h = await observation('pdfjs', { pages: [99, 100], spread: 1, zoom: 75, deferInitialView: true });
    h.api.finish('cancelled');
    h.restoreInitialView({ page: 7, zoom: 125, spread: 0 });
    assert.equal(h.viewer.spreadMode, 0);
    assert.equal(h.viewer.currentPageNumber, 7);
    assert.equal(h.viewer.currentScaleValue, '1.25');
    assert.equal(h.pageEvents.has('documentinit'), false);
    assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
});

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

test('the Overleaf adapter uses its native viewer and host startup event for the same delivery milestones', async () => {
    const h = await observation('overleaf');
    assert.equal(h.context.PDFViewerApplication, undefined);
    assert.equal(h.viewer.currentPageNumber, 1);
    assert.equal(h.viewer.currentScaleValue, '0.75');
    assert.equal(h.windowEvents.has('message'), false, 'startup listener is released after binding');
    h.render(10);
    assert.equal(h.api.snapshot().pages[0].firstSelectableTextMs, 10);
    h.render(20, { pending: 0, completed: 2, failed: 0, revision: 2, total: 2, covered: 2, final: true });
    const result = h.api.snapshot();
    assert.equal(result.document.pages, 1);
    assert.equal(result.pages[0].firstCompletePageImagePaintMs, 20);
    assert.equal(result.pages[0].firstFinalPagePaintMs, 20);
    assert.equal(h.api.captureCanvases()[0].width, 100);
    assert.equal(h.api.viewer(), h.viewer);
    h.api.finish('test');
});

test('text, usable photo coverage and final image quality are independent painted milestones', async () => {
    const h = await observation();
    h.render(10);
    let page = h.api.snapshot().pages[0];
    assert.equal(page.firstSelectableTextMs, 10);
    assert.equal(page.firstNativePixelsMs, 10);
    assert.equal(page.firstPageImagePaintMs, undefined);
    assert.throws(() => h.api.captureCanvases(), /final image quality/);
    h.render(20, { pending: 2, completed: 0, failed: 0, revision: 1, total: 2, covered: 1, final: false });
    h.render(30, { pending: 2, completed: 0, failed: 0, revision: 2, total: 2, covered: 2, final: false });
    page = h.api.snapshot().pages[0];
    assert.equal(page.firstPageImagePaintMs, 20);
    assert.equal(page.firstCompletePageImagePaintMs, 30);
    assert.equal(page.firstFinalPagePaintMs, undefined);
    assert.throws(() => h.api.captureCanvases(), /final image quality/);
    h.render(40, { pending: 0, completed: 2, failed: 0, revision: 3, total: 2, covered: 2, final: true });
    page = h.api.snapshot().pages[0];
    assert.equal(page.firstFinalPagePaintMs, 40);
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
    assert.equal(h.api.snapshot().pages[0].firstPageImagePaintMs, 10);
    assert.equal(h.api.snapshot().pages[0].firstCompletePageImagePaintMs, undefined);
    h.render(20, { pending: 2, completed: 0, failed: 0, revision: 2, total: 2, covered: 2, final: false, discovered: true });
    assert.equal(h.api.snapshot().pages[0].firstCompletePageImagePaintMs, 20);
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
    assert.equal(h.api.snapshot().pages[0].firstPageImagePaintMs, 40);
    h.api.finish('test');
});

test('page-wide image milestones retain whether the whole page was actually visible', async () => {
    const h = await observation();
    const whole = h.canvas.getBoundingClientRect();
    h.canvas.getBoundingClientRect = () => ({ ...whole, bottom: 200, height: 200 });
    h.render(10, { pending: 0, completed: 2, failed: 0, revision: 1, total: 2, covered: 2, final: true });
    let result = h.api.snapshot();
    assert.equal(result.pages[0].pageFullyVisible, false);
    const milestones = result.events.filter(event => event.type.endsWith('paint'));
    assert.equal(milestones.length, 3);
    assert.ok(milestones.every(event => event.pageFullyVisible === false));
    h.canvas.getBoundingClientRect = () => whole;
    h.render(20, { pending: 0, completed: 2, failed: 0, revision: 2, total: 2, covered: 2, final: true });
    result = h.api.snapshot();
    assert.equal(result.pages[0].pageFullyVisible, true);
    assert.equal(result.pages[0].firstPageImagePaintMs, 10);
    assert.ok(result.events.filter(event => event.type.endsWith('paint')).every(event => event.pageFullyVisible === false));
    h.api.finish('test');
});
