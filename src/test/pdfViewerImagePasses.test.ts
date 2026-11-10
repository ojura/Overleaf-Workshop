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

describe('native image-pass presentation in both viewers', function () {
    const sources = new Map<string, { base: string; draw: string; redraw: string }>();
    before(async () => {
        const { pdfjsRelease } = await importModule(path.join(repo, 'scripts/viewer-protocol.mjs'));
        const { imageRevisionViewer } = await importModule(path.join(repo, 'scripts/pdfjs-image-revisions.mjs'));
        for (const [name, file] of [['pdfjs', path.join(pdfjsRelease, 'web/viewer.mjs')], ['overleaf', path.join(repo, 'node_modules/pdfjs-dist/web/pdf_viewer.mjs')]]) {
            const source = ts.createSourceFile(file, imageRevisionViewer(fs.readFileSync(file, 'utf8'), file), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
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

    for (const engine of ['pdfjs', 'overleaf']) {
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
