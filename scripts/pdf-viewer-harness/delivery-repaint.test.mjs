import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { repaintDeliveryPages } from './delivery-observation.mjs';

function fixture() {
    const listeners = new Set(), timers = new Set(), queued = [], captures = [];
    const views = [1, 2].map(number => ({ number, redrawImages: () => true }));
    let finished = true, ready;
    const started = () => new Promise(resolve => { ready = resolve; });
    const context = vm.createContext({
        window: { __pdfDeliveryObservation: {
            snapshot: () => ({ finished }),
            captureCanvases: () => { const value = { after: [...queued] }; captures.push(value); return value; },
        }, PDFViewerApplication: {
            pdfViewer: { getPageView: index => views[index] },
            pdfRenderingQueue: { renderView: view => { queued.push(view.number); ready?.(); return true; } },
            eventBus: { on: (_name, callback) => listeners.add(callback), off: (_name, callback) => listeners.delete(callback) },
        } },
        setTimeout: callback => { timers.add(callback); return callback; },
        clearTimeout: callback => timers.delete(callback),
    });
    const run = pages => vm.runInContext('(' + repaintDeliveryPages.toString() + ')(' + JSON.stringify(pages) + ')', context);
    const emit = event => { for (const callback of [...listeners]) callback(event); };
    return { run, views, emit, listeners, timers, queued, captures, started, unfinish: () => { finished = false; } };
}

test('verification repaint waits for each exact native page and leaves the measurement frozen', async () => {
    const h = fixture();
    const pending = h.run([1, 2]);
    assert.deepEqual(h.queued, [1]);
    assert.equal(h.captures.length, 1);
    h.emit({ source: h.views[1], pageNumber: 1 });
    h.emit({ source: h.views[0], pageNumber: 1, isDetailView: true });
    h.emit({ source: h.views[0], pageNumber: 1, cssTransform: true });
    assert.deepEqual(h.queued, [1]);
    const next = h.started();
    h.emit({ source: h.views[0], pageNumber: 1 });
    await next;
    assert.deepEqual(h.queued, [1, 2]);
    h.emit({ source: h.views[1], pageNumber: 2 });
    assert.deepEqual(await pending, { after: [1, 2] });
    assert.equal(h.captures.length, 2);
    assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0);
});

for (const failure of ['native', 'timeout', 'queue']) test('verification repaint releases its listener after ' + failure + ' failure', async () => {
    const h = fixture();
    if (failure === 'queue') h.views[0].redrawImages = () => false;
    const rejected = assert.rejects(h.run([1]), /verification repaint|native failure/);
    if (failure === 'native') h.emit({ source: h.views[0], pageNumber: 1, error: 'native failure' });
    if (failure === 'timeout') [...h.timers][0]();
    await rejected;
    assert.equal(h.captures.length, 1);
    assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0);
});

test('verification cannot repaint while delivery is still being measured', async () => {
    const h = fixture(); h.unfinish();
    await assert.rejects(h.run([1]), /Finish delivery measurement/);
    assert.equal(h.queued.length, 0); assert.equal(h.captures.length, 0);
});
