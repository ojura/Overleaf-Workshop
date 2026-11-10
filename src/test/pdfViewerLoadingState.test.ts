/* eslint-disable @typescript-eslint/naming-convention -- execute the pinned viewer's actual toolbar event adapter */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const states = { INITIAL: 0, RUNNING: 1, PAUSED: 2, FINISHED: 3 };

describe('native toolbar semantic page-loading adapter', function () {
    let bindEvents: (this: any) => void;

    before(async () => {
        const { pdfjsRelease } = await importModule(path.join(repo, 'scripts/viewer-protocol.mjs'));
        const { imageRevisionViewer } = await importModule(path.join(repo, 'scripts/pdfjs-image-revisions.mjs'));
        const file = path.join(pdfjsRelease, 'web/viewer.mjs');
        const source = ts.createSourceFile(file, imageRevisionViewer(fs.readFileSync(file, 'utf8'), file),
            ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const names = new Set(['onPageRender', 'onPageRendered', 'onPageChanging', 'onPageLoadingStateChanged']);
        const handlers = new Map<string, string>();
        let binding = '';
        for (const statement of source.statements) {
            if (ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text)) {
                handlers.set(statement.name.text, statement.getText(source));
            }
            if (!ts.isVariableStatement(statement)) { continue; }
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'PDFViewerApplication'
                    || !declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) { continue; }
                for (const member of declaration.initializer.properties) {
                    if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === 'bindEvents') {
                        binding = member.getText(source);
                    }
                }
            }
        }
        for (const name of ['onPageRender', 'onPageRendered', 'onPageChanging']) {
            assert.ok(handlers.has(name), 'the actual viewer must supply ' + name);
        }
        assert.ok(binding, 'exercise actual application event registration');
        const unrelated = [...new Set(binding.match(/\bon[A-Z]\w*/g) ?? [])].filter(name => !handlers.has(name));
        bindEvents = new Function('RenderingStates', 'SidebarView', ...unrelated,
            [...handlers.values()].join('\n') + '\nreturn ({' + binding + '}).bindEvents;')(
                states, { THUMBS: 1 }, ...unrelated.map(() => () => {}));
    });

    function fixture(managed = true) {
        type Listener = (event: any) => void;
        const listeners = new Map<string, Listener[]>();
        const pending = new Map<number, boolean | undefined>();
        const views = new Map([[1, { renderingState: states.FINISHED }], [2, { renderingState: states.FINISHED }]]);
        const queries: number[] = [], calls: boolean[] = [], transitions: boolean[] = [], errors: unknown[] = [];
        let loading = false;
        const viewer: any = {
            getPageView: (index: number) => views.get(index + 1),
            getPageLoadingState: managed ? (page: number) => { queries.push(page); return pending.get(page); } : undefined,
        };
        const eventBus = {
            _on(name: string, listener: Listener, options: { signal: AbortSignal }) {
                const rows = listeners.get(name) ?? [];
                rows.push(listener); listeners.set(name, rows);
                options.signal.addEventListener('abort', () => {
                    const index = rows.indexOf(listener);
                    if (index >= 0) { rows.splice(index, 1); }
                }, { once: true });
            },
            dispatch(name: string, event: any) {
                for (const listener of [...listeners.get(name) ?? []]) { listener(event); }
            },
        };
        const app: any = {
            page: 1, eventBus, pdfViewer: viewer,
            toolbar: {
                updateLoadingIndicatorState(value = false) {
                    calls.push(value);
                    if (loading !== value) { transitions.push(value); loading = value; }
                },
                setPageNumber() {},
            },
            _otherError: (_message: string, error: unknown) => errors.push(error),
        };
        for (const name of ['beforePrint', 'afterPrint', 'requestPresentationMode', 'triggerPrinting',
            'downloadOrSave', 'zoomIn', 'zoomOut', 'zoomReset', 'rotatePages']) { app[name] = () => {}; }
        bindEvents.call(app);
        const emit = (name: string, event: any = {}) => eventBus.dispatch(name, { source: viewer, pageNumber: app.page, ...event });
        return { app, viewer, pending, views, queries, calls, transitions, errors, listeners, emit,
            get loading() { return loading; }, dispose: () => app._eventBusAbortController.abort() };
    }

    it('keeps one loading episode across completed native passes while source work remains pending', () => {
        const f = fixture();
        try {
            f.pending.set(1, true);
            for (let pass = 0; pass < 3; pass++) {
                f.emit('pagerender');
                f.emit('pagerendered');
                assert.strictEqual(f.loading, true, 'a completed partial pass cannot end the pending source episode');
            }
            assert.deepStrictEqual(f.transitions, [true]);
            f.pending.set(1, false);
            f.emit('pageloadingstatechanged');
            assert.strictEqual(f.loading, false, 'semantic settlement updates without requiring another native render');
            assert.deepStrictEqual(f.transitions, [true, false]);
        } finally { f.dispose(); }
    });

    it('does not introduce a loading pulse when the controller reports settled display work', () => {
        const f = fixture();
        try {
            f.pending.set(1, false);
            f.emit('pagerender');
            assert.strictEqual(f.loading, false, 'native render start must query the controller');
            f.emit('pagerendered');
            assert.deepStrictEqual(f.transitions, []);
            f.pending.set(1, true);
            f.emit('pageloadingstatechanged');
            assert.strictEqual(f.loading, true, 'new source work starts a real loading episode');
        } finally { f.dispose(); }
    });

    it('queries the new current page and ignores other pages and unrelated viewer owners', () => {
        const f = fixture();
        try {
            f.pending.set(1, false); f.pending.set(2, true);
            f.app.page = 2;
            f.emit('pagechanging', { pageLabel: 'ii' });
            assert.strictEqual(f.loading, true, 'FINISHED metadata does not overrule the current semantic pending state');
            assert.strictEqual(f.queries[f.queries.length - 1], 2);
            f.pending.set(2, false);
            f.emit('pageloadingstatechanged', { pageNumber: 1 });
            f.emit('pageloadingstatechanged', { source: {} });
            assert.strictEqual(f.loading, true, 'unrelated events must not publish another owner’s state');
            f.emit('pageloadingstatechanged');
            assert.strictEqual(f.loading, false);
        } finally { f.dispose(); }
    });

    it('preserves pending work after a failed pass and ends on explicit terminal settlement', () => {
        const f = fixture();
        try {
            const error = new Error('one image resource failed');
            f.pending.set(1, true);
            f.emit('pagerender');
            f.emit('pagerendered', { error });
            assert.strictEqual(f.loading, true, 'a failed pass does not erase other pending work');
            assert.deepStrictEqual(f.errors, [error]);
            f.pending.set(1, false);
            f.emit('pageloadingstatechanged');
            assert.strictEqual(f.loading, false, 'a settled failure must not require an impossible final render');
        } finally { f.dispose(); }
    });

    it('preserves native behavior when no controller owns the page', () => {
        for (const managed of [false, true]) {
            const f = fixture(managed);
            try {
                f.emit('pagerender'); assert.strictEqual(f.loading, true);
                f.emit('pagerendered'); assert.strictEqual(f.loading, false);
                f.views.get(2)!.renderingState = states.RUNNING;
                f.app.page = 2; f.emit('pagechanging'); assert.strictEqual(f.loading, true);
                f.views.get(2)!.renderingState = states.FINISHED;
                f.emit('pagechanging'); assert.strictEqual(f.loading, false);
            } finally { f.dispose(); }
        }
    });

    it('registers one semantic listener with the actual application event lifetime', () => {
        const f = fixture();
        bindEvents.call(f.app);
        assert.strictEqual(f.listeners.get('pageloadingstatechanged')?.length, 1);
        f.dispose();
        assert.strictEqual(f.listeners.get('pageloadingstatechanged')?.length, 0);
        f.pending.set(1, true);
        f.emit('pageloadingstatechanged');
        assert.strictEqual(f.loading, false, 'an aborted application cannot update the toolbar');
    });
});
