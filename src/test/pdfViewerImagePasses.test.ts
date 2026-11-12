/* eslint-disable @typescript-eslint/naming-convention -- execute the pinned native PageView methods */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const states = { INITIAL: 0, RUNNING: 1, PAUSED: 2, FINISHED: 3 };
class Cancelled extends Error {}
class Canvas {
    width = 100; height = 100; attached = false; replaced = 0;
    getContext() { return { canvas: this }; }
    remove() { this.attached = false; }
    replaceWith(value: Canvas) { assert.strictEqual(this.attached, true); this.attached = false; value.attached = true; this.replaced++; }
    setAttribute() {}
}

class NativeTask {
    private resolve!: () => void;
    private reject!: (error: Error) => void;
    readonly promise = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    onContinue?: (resume: () => void) => void;
    onError?: (error: Error) => void;
    readonly imageIntent = {};
    readonly imageRevision = 1;
    readonly imageStatus = { revision: 1, covered: 1, total: 1, pending: 0, completed: 1, failed: 0, discovered: true, final: true };
    settled = false;
    cancel() {
        if (this.settled) { return; }
        this.settled = true;
        const error = new Cancelled('native pass cancelled');
        this.reject(error);
        this.onError?.(error);
    }
    finish() { this.settled = true; this.resolve(); }
}

describe('native image-pass presentation in both viewers', function () {
    const sources = new Map<string, { base: string; draw: string; redraw: string }>();
    before(async () => {
        const { pdfjsRelease } = await importModule(path.join(repo, 'scripts/viewer-protocol.mjs'));
        const { imageRevisionViewer } = await importModule(path.join(repo, 'scripts/pdfjs-image-revisions.mjs'));
        for (const [name, file] of [['pdfjs', path.join(pdfjsRelease, 'web/viewer.mjs')], ['overleaf', path.join(repo, 'node_modules/pdfjs-dist/web/pdf_viewer.mjs')]]) {
            const transformed = imageRevisionViewer(fs.readFileSync(file, 'utf8'), file);
            assert.strictEqual(imageRevisionViewer(transformed, file), transformed, `${name} transforms an already prepared viewer once`);
            const source = ts.createSourceFile(file, transformed, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            let base = '', draw = '', redraw = '';
            for (const statement of source.statements) {
                if (!ts.isClassDeclaration(statement)) { continue; }
                if (statement.name?.text === 'BasePDFPageView') { base = statement.getText(source); }
                if (statement.name?.text === 'PDFPageView') {
                    for (const method of statement.members) {
                        if (!ts.isMethodDeclaration(method) || !method.name || !ts.isIdentifier(method.name)) { continue; }
                        if (method.name.text === 'draw') { draw = method.getText(source).replace(/#/g, '_'); }
                        if (method.name.text === 'redrawImages') { redraw = method.getText(source); }
                    }
                }
            }
            assert.ok(base && draw && redraw, name);
            sources.set(name, { base, draw, redraw });
        }
    });

    function nativePage(engine: string) {
        const source = sources.get(engine)!;
        const created: Canvas[] = [], tasks: NativeTask[] = [], passes: Promise<unknown>[] = [], events: any[] = [];
        const Constructor = new Function('RenderingStates', 'RenderingCancelledException', 'document', source.base + '\nreturn BasePDFPageView;')(
            states, Cancelled, { createElement() { const canvas = new Canvas(); created.push(canvas); return canvas; } });
        const page = new Constructor({ id: 1, eventBus: { dispatch: (name: string, value: any) => events.push({ name, ...value }) } });
        const viewport = { width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100], rawDims: {} };
        Object.assign(page, {
            div: { classList: { add() {}, remove() {} }, style: { setProperty() {} }, setAttribute() {} },
            l10n: {}, viewport, textLayer: {}, annotationLayer: null,
            _annotationMode: 0, _textLayerMode: 1, _layerProperties: {}, _useThumbnailCanvas: {},
            _ensureCanvasWrapper: () => ({ prepend(canvas: Canvas) { canvas.attached = true; } }),
            _renderTextLayer: () => Promise.resolve(),
            outputScale: { sx: 1, sy: 1, scaled: false },
            _getRenderingContext: (canvasContext: unknown) => ({ canvasContext, viewport: page.viewport }),
            pdfPage: { _externalImages: {}, isPureXfa: false, render() { const task = new NativeTask(); tasks.push(task); return task; } },
        });
        const draw = new Function('RenderingStates', 'TextLayerMode', 'AnnotationMode', 'StructTreeLayerBuilder',
            'approximateFraction', 'floorToDivide', 'calcRound', `return ({${source.draw}}).draw;`)(states, { DISABLE: 0 }, { DISABLE: 0 }, class {},
            () => [1, 1], (n: number) => Math.floor(n), Math.round);
        return { page, created, tasks, events,
            start() { const result = draw.call(page); passes.push(result); return result; },
            async dispose() {
                for (const task of tasks) { task.cancel(); }
                await Promise.allSettled(passes);
                page.cancelRendering(); page.renderingState = states.INITIAL; page._resetCanvas();
            },
        };
    }

    for (const engine of ['pdfjs', 'overleaf']) {
        it(`${engine} returns a cancelled native RUNNING pass to the rendering queue`, async () => {
            const f = nativePage(engine), { page } = f;
            try {
                const first = f.start();
                assert.strictEqual(page.renderingState, states.RUNNING);
                assert.strictEqual(page.renderTask, f.tasks[0]);
                assert.ok(page.canvas);
                f.tasks[0].cancel(); await first;
                assert.strictEqual(page.renderingState, states.INITIAL, 'a cancelled current pass must be drawable again');
                assert.strictEqual(page.renderTask, null);
                assert.strictEqual(page.canvas, null);
                assert.strictEqual(page.resume, null);
                assert.strictEqual(f.events.filter(event => event.name === 'pagerendered').length, 0,
                    'cancellation is retryable work, not a completed or failed page');
                const next = f.start(); f.tasks[1].finish(); await next;
                assert.strictEqual(page.renderingState, states.FINISHED);
                assert.strictEqual(page.canvas.attached, true);
                assert.strictEqual(f.events.filter(event => event.name === 'pagerendered').length, 1);
            } finally { await f.dispose(); }
        });

        it(`${engine} releases a cancelled native PAUSED continuation before retry`, async () => {
            const f = nativePage(engine), { page } = f;
            try {
                page.renderingQueue = { isHighestPriority: () => false };
                const pending = f.start();
                let continued = 0;
                f.tasks[0].onContinue!(() => continued++);
                assert.strictEqual(page.renderingState, states.PAUSED);
                assert.strictEqual(typeof page.resume, 'function');
                f.tasks[0].cancel(); await pending;
                assert.strictEqual(page.renderingState, states.INITIAL, 'a cancelled paused task cannot retain queue priority');
                assert.strictEqual(page.resume, null, 'the queue must not resume the cancelled task');
                assert.strictEqual(page.renderTask, null);
                assert.strictEqual(continued, 0);
                assert.strictEqual(f.events.filter(event => event.name === 'pagerendered').length, 0);
            } finally { await f.dispose(); }
        });

        it(`${engine} keeps accepted pixels and their viewport through a cancelled native replacement`, async () => {
            const f = nativePage(engine), { page } = f;
            const prior = new Canvas(); prior.attached = true;
            const oldViewport = { width: 80, height: 80 };
            const oldStatus = { revision: 7, covered: 1, total: 1, discovered: true, final: true };
            page.canvas = prior; page._originalViewport = oldViewport;
            page.paintedImageStatus = oldStatus; page.paintedImageRevision = 7;
            try {
                const pending = f.start(), candidate = page.canvas;
                assert.notStrictEqual(candidate, prior);
                f.tasks[0].cancel(); await pending;
                assert.strictEqual(page.renderingState, states.INITIAL);
                assert.strictEqual(page.canvas, prior, 'the actual PDFPageView cancellation callback restores its predecessor');
                assert.strictEqual(prior.attached, true);
                assert.strictEqual(prior.width, 100);
                assert.strictEqual(candidate.width, 0);
                assert.strictEqual(page._originalViewport, oldViewport);
                assert.strictEqual(page.paintedImageStatus, oldStatus);
                assert.strictEqual(page.paintedImageRevision, 7);
                assert.strictEqual(f.events.filter(event => event.name === 'pagerendered').length, 0);
            } finally { await f.dispose(); }
        });

        it(`${engine} leaves newer task, canvas and continuation ownership intact after superseded cancellation`, async () => {
            const f = nativePage(engine), { page } = f;
            try {
                const oldPass = f.start(), oldTask = f.tasks[0], oldError = oldTask.onError!;
                oldTask.cancel();
                // reset() can start the next pass before the old rejected promise settles.
                page.renderingState = states.INITIAL;
                const newPass = f.start(), newTask = f.tasks[1], canvas = page.canvas;
                page.renderingQueue = { isHighestPriority: () => false };
                let continued = 0;
                newTask.onContinue!(() => continued++);
                const resume = page.resume;
                // A callback still held by the former task has no authority over this pass.
                oldError(new Cancelled('late old cancellation'));
                await oldPass;
                assert.strictEqual(page.renderTask, newTask);
                assert.strictEqual(page.canvas, canvas, 'old onError must not clear the current canvas');
                assert.strictEqual(page.renderingState, states.PAUSED);
                assert.strictEqual(page.resume, resume);
                assert.strictEqual(canvas.width, 100);
                assert.strictEqual(continued, 0);
                resume(); newTask.finish(); await newPass;
                assert.strictEqual(continued, 1);
                assert.strictEqual(page.renderingState, states.FINISHED);
                assert.strictEqual(page.canvas.attached, true);
                assert.strictEqual(f.events.filter(event => event.name === 'pagerendered').length, 1);
            } finally { await f.dispose(); }
        });

        it(`${engine} derives page loading-icon suppression from the live displayed owner after reset`, () => {
            const source = sources.get(engine)!;
            const Constructor = new Function('RenderingStates', 'RenderingCancelledException', 'document', source.base + '\nreturn BasePDFPageView;')(states, Cancelled, {});
            const page = new Constructor({ id: 1, eventBus: { dispatch() {} } });
            const classes = new Set<string>();
            page.div = { classList: { add: (...names: string[]) => names.forEach(name => classes.add(name)), remove: (...names: string[]) => names.forEach(name => classes.delete(name)) } };
            page.hasUsefulPresentation = true;
            let displayed = false;
            page.hasDisplayedPresentation = () => displayed;
            page.renderingState = states.RUNNING;
            assert.ok(classes.has('loadingIcon'), 'detached old raster cannot suppress loading while no preview exists');
            page.renderingState = states.INITIAL;
            displayed = true;
            page.renderingState = states.RUNNING;
            assert.strictEqual(classes.has('loadingIcon'), false, 'accepted preview suppresses the native pass icon');
            page.renderingState = states.INITIAL;
        });

        it(`${engine} shows monotone photo coverage within one render intent while preserving replacement and zoom barriers`, async () => {
            const created: Canvas[] = [], events: any[] = [];
            const source = sources.get(engine)!;
            const Constructor = new Function('RenderingStates', 'RenderingCancelledException', 'document', source.base + '\nreturn BasePDFPageView;')(states, Cancelled, {
                createElement() { const value = new Canvas(); created.push(value); return value; },
            });
            const page = new Constructor({ id: 1, eventBus: { dispatch: (_name: string, value: any) => events.push(value) } });
            page.div = { classList: { add() {}, remove() {} } };
            const intent = Object.freeze({}), replacement = Object.freeze({});
            const initial = { revision: 0, covered: 0, total: 3, pending: 3, completed: 0, failed: 0, discovered: true, final: false };
            const paint = async (status: any, imageIntent = intent, scale = 1) => {
                const { ctx } = page._createCanvas((value: Canvas) => { value.attached = true; });
                page.pdfPage = { render: () => ({ promise: Promise.resolve(), imageRevision: status.revision, imageStatus: status, imageIntent }) };
                const viewport = { width: 100 * scale, height: 100 * scale, transform: [scale, 0, 0, -scale, 0, 100 * scale] };
                await page._drawCanvas({ canvasContext: ctx, viewport, transform: [1, 0, 0, 1, 0, 0] },
                    () => assert.fail('unexpected cancellation'), () => page.dispatchPageRendered(false, false));
            };
            await paint(initial);
            const text = page.canvas;
            await paint({ ...initial, revision: 1, covered: 1 });
            assert.notStrictEqual(page.canvas, text, 'the first usable photo must replace the initial text-only canvas');
            assert.strictEqual(text.width, 0);
            assert.strictEqual(events[1].imageStatus.covered, 1);
            const coarse = page.canvas;
            await paint({ ...initial, revision: 2, covered: 1, completed: 1, pending: 2 });
            assert.notStrictEqual(page.canvas, coarse, 'better pixels for an already covered image are visible before every image finishes');
            await paint({ ...initial, revision: 3, covered: 2, completed: 1, pending: 2 });
            const partial = page.canvas, displayed = page.paintedImageStatus;
            assert.strictEqual(displayed.covered, 2);
            for (const status of [
                { ...initial, revision: 4, covered: 1 },
                { ...initial, revision: 2, covered: 2 },
                { ...initial, revision: 4, covered: 2, total: 4 },
                { ...initial, revision: 4, covered: 2, discovered: false },
            ]) {
                await paint(status);
                assert.strictEqual(page.canvas, partial, 'incomplete discovery or regressing coverage cannot replace displayed pixels');
                assert.strictEqual(page.paintedImageStatus, displayed);
            }
            await paint({ ...initial, revision: 4, covered: 2 }, replacement);
            assert.strictEqual(page.canvas, partial, 'equal counts from a replacement intent do not identify the same covered photos');
            await paint({ ...initial, revision: 5, covered: 2 }, intent, 1.25);
            assert.strictEqual(page.canvas, partial, 'a zoom retains its barrier even when its native image intent is reusable');
            assert.strictEqual(page.paintedImageStatus, displayed);
            await paint({ ...initial, revision: 6, covered: 3 }, replacement, 1.25);
            assert.notStrictEqual(page.canvas, partial);
            assert.strictEqual(partial.width, 0);
            assert.strictEqual(page.canvas.attached, true);
            assert.strictEqual(page.paintedImageStatus.covered, 3);
            assert.strictEqual(page.paintedImageStatus.final, false);
            assert.ok(created.slice(4, -1).every(value => value.width === 0 && !value.attached));
        });

        it(`${engine} retains displayed photo pixels and their status until the replacement has complete image coverage`, async () => {
            const created: Canvas[] = [], events: any[] = [];
            const source = sources.get(engine)!;
            const Constructor = new Function('RenderingStates', 'RenderingCancelledException', 'document', source.base + '\nreturn BasePDFPageView;')(states, Cancelled, {
                createElement() { const value = new Canvas(); created.push(value); return value; },
            });
            const page = new Constructor({ id: 1, eventBus: { dispatch: (_name: string, value: any) => events.push(value) } });
            page.div = { classList: { add() {}, remove() {} } };
            const prior = new Canvas(); prior.attached = true;
            page.canvas = prior;
            const oldStatus = { revision: 7, covered: 2, total: 2, pending: 0, completed: 2, failed: 0, discovered: true, final: true };
            page.paintedImageStatus = oldStatus; page.paintedImageRevision = 7;
            const paint = async (status: any) => {
                const { ctx } = page._createCanvas((value: Canvas) => { value.attached = true; });
                page.pdfPage = { render: () => ({ promise: Promise.resolve(), imageRevision: status.revision, imageStatus: status }) };
                await page._drawCanvas({ canvasContext: ctx }, () => assert.fail('unexpected cancellation'), () => page.dispatchPageRendered(false, false));
            };
            await paint({ ...oldStatus, revision: 8, covered: 1, completed: 0, pending: 2, final: false });
            assert.strictEqual(page.canvas, prior);
            assert.strictEqual(prior.attached, true);
            assert.strictEqual(created[0].width, 0);
            assert.strictEqual(page.paintedImageStatus, oldStatus);
            assert.strictEqual(events[0].imageRevision, 7);
            assert.strictEqual(events[0].imagePassRevision, 8);
            assert.strictEqual(events[0].imagePassStatus.covered, 1);
            await paint({ ...oldStatus, revision: 9, completed: 0, pending: 2, final: false });
            assert.strictEqual(page.canvas, created[1]);
            assert.strictEqual(created[1].attached, true);
            assert.strictEqual(prior.width, 0);
            assert.strictEqual(prior.replaced, 1);
            assert.strictEqual(events[1].imageRevision, 9);
            assert.strictEqual(events[1].imageStatus.covered, 2);
            assert.strictEqual(events[1].imageStatus.final, false);
        });

        it(`${engine} starts selectable text before the native canvas pass and reuses its existing layers for image replay`, async () => {
            const order: string[] = [];
            const source = sources.get(engine)!;
            const draw = new Function('RenderingStates', 'TextLayerMode', 'AnnotationMode', 'StructTreeLayerBuilder',
                'approximateFraction', 'floorToDivide', 'calcRound', `return ({${source.draw}}).draw;`)(states, { DISABLE: 0 }, { DISABLE: 0 }, class {},
                () => [1, 1], (n: number) => Math.floor(n), Math.round);
            const textLayer = {}, annotationLayer = null, canvasWrapper = {}, viewport = { width: 110, height: 85, rawDims: {} };
            const page: any = { renderingState: states.INITIAL, div: { style: { setProperty() {} }, setAttribute() {} }, l10n: {},
                pdfPage: { _externalImages: {}, isPureXfa: false }, viewport, textLayer, annotationLayer,
                _annotationMode: 0, _textLayerMode: 1, _layerProperties: {}, _useThumbnailCanvas: {},
                _ensureCanvasWrapper: () => canvasWrapper, _renderTextLayer: () => { order.push('text'); return Promise.resolve(); },
                _createCanvas: () => ({ canvas: new Canvas(), ctx: {}, prevCanvas: null }), outputScale: { sx: 1, sy: 1, scaled: false },
                _getRenderingContext: () => ({}), _drawCanvas: async (_context: any, _cancel: any, finish: any) => {
                    order.push('canvas'); finish({ separateAnnots: false });
                }, dispatchPageRendered() {}, dispatchPageRender() {},
            };
            await draw.call(page);
            assert.deepStrictEqual(order, ['text', 'canvas']);
            page.renderingState = states.FINISHED;
            page.canvas = new Canvas();
            const retained = page.canvas;
            page.reset = () => assert.fail('image replay must retain native layers');
            const redraw = new Function('RenderingStates', `return ({${source.redraw}}).redrawImages;`)(states);
            assert.strictEqual(redraw.call(page), true);
            assert.strictEqual(page.renderingState, states.INITIAL);
            assert.strictEqual(page.canvas, retained);
            assert.strictEqual(page.textLayer, textLayer);
            assert.strictEqual(redraw.call(page), false, 'only the existing queue owns the pending native pass');
        });
    }
});
