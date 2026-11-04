/* eslint-disable @typescript-eslint/naming-convention -- mirrors the VS Code API */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadWithVscode } from './standIn';

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const report = { covered: 128, total: 1024, bytes: 512, maxBytes: 4096, filling: true, complete: false };

class Timers {
    now = 0;
    tasks = new Map<object, { callback: () => void, due: number }>();
    set = (callback: () => void, ms: number) => {
        const timer = { unref() {} };
        this.tasks.set(timer, { callback, due: this.now + ms });
        return timer;
    };
    clear = (timer: object) => { this.tasks.delete(timer); };
    advance(ms: number) {
        const end = this.now + ms;
        for (;;) {
            const entry = [...this.tasks].sort((a, b) => a[1].due - b[1].due)[0];
            if (!entry || entry[1].due > end) { break; }
            this.now = entry[1].due;
            this.tasks.delete(entry[0]);
            entry[1].callback();
        }
        this.now = end;
    }
}

class FakeCache {
    static current: FakeCache;
    readonly listeners = new Set<() => void>();
    readonly reads: Array<ReturnType<typeof deferred<typeof report>>> = [];
    constructor() { FakeCache.current = this; }
    onChange(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    snapshot() { const read = deferred<typeof report>(); this.reads.push(read); return read.promise; }
    change() { for (const listener of this.listeners) { listener(); } }
    dispose() {}
}

class Uri {
    constructor(readonly path: string) {}
    get fsPath() { return this.path; }
    toString() { return 'file://' + this.path; }
    static joinPath(base: Uri, ...parts: string[]) { return new Uri(path.posix.join(base.path, ...parts)); }
}
const vscode = {
    Uri,
    window: { state: { focused: true } },
    EventEmitter: class {
        event() { return { dispose() {} }; }
        dispose() {}
    },
    workspace: {
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
        fs: { delete: async () => {}, readFile: async () => Buffer.from('<html>viewer</html>') },
    },
};
const { PdfViewEditorProvider } = loadWithVscode(vscode, () => require('../core/pdfViewEditorProvider'), {
    './remoteFileSystemProvider': { parseUri: () => ({ pathParts: [] }) },
    '../utils/eventBus': { EventBus: { fire() {} } },
    '../utils/globalStateManager': { GlobalStateManager: { getPdfViewPersist: () => ({}), updatePdfViewPersist() {} } },
    './pdfViewerPages': { completeViewerPage: () => '<html>viewer</html>', isBuildPath: () => false },
    './pdfFetchBridge': {
        PieceCache: FakeCache,
        outputsOf: () => () => true,
        PdfFetchBridge: class {
            static fetchRange() {}
            setOutput() {}
            setActivity() {}
            dispose() {}
        },
    },
});

describe('host disk progress delivery', () => {
    it('coalesces a delayed snapshot into one read and spaces the latest follow-up report', async () => {
        const timers = new Timers();
        const nativeSet = globalThis.setTimeout;
        const nativeClear = globalThis.clearTimeout;
        (globalThis as any).setTimeout = timers.set;
        (globalThis as any).clearTimeout = timers.clear;
        let close = () => {};
        const messages: Array<{ at: number, message: any }> = [];
        let receive: (message: any) => void = () => {};
        const provider = new PdfViewEditorProvider({
            globalStorageUri: new Uri('/unused-progress-test-cache'), extensionUri: new Uri('/extension'),
            extension: { packageJSON: { devDependencies: { 'pdfjs-dist': '5.1.91' } } },
        });
        const doc = {
            uri: new Uri('/paper.pdf'), engine: 'pdfjs', isProjectFile: false, cache: new Uint8Array(),
            output: { file: { build: 'build-current', size: 1024 } },
            onDidChange: () => ({ dispose() {} }),
        };
        const panel = {
            visible: true,
            onDidDispose: (callback: () => void) => { close = callback; return { dispose() {} }; },
            onDidChangeViewState: () => ({ dispose() {} }),
            webview: {
                html: '', options: {}, asWebviewUri: (uri: Uri) => uri,
                postMessage: (message: any) => { messages.push({ at: timers.now, message }); return Promise.resolve(true); },
                onDidReceiveMessage: (callback: (message: any) => void) => { receive = callback; return { dispose() {} }; },
            },
        };
        try {
            await provider.resolveCustomEditor(doc, panel);
            const cache = FakeCache.current;
            receive({ type: 'ready' });
            timers.advance(1000);
            assert.strictEqual(cache.reads.length, 1);
            // Simulate a disk queue blocked for twenty seconds while many cache events arrive.
            for (let i = 0; i < 20; i++) { cache.change(); timers.advance(1000); }
            assert.strictEqual(cache.reads.length, 1, 'at most one disk snapshot may be queued or in flight');
            assert.strictEqual(timers.tasks.size, 0, 'events coalesce to one dirty bit while a snapshot is pending');
            cache.reads[0].resolve(report);
            await turn();
            const first = messages.filter(e => e.message.type === 'cacheProgress');
            assert.strictEqual(first.length, 1);
            assert.strictEqual(timers.tasks.size, 1, 'one follow-up reports the changes made during the delayed read');
            timers.advance(999);
            assert.strictEqual(cache.reads.length, 1);
            timers.advance(1);
            assert.strictEqual(cache.reads.length, 2);
            cache.reads[1].resolve({ ...report, covered: 256 });
            await turn();
            const delivered = messages.filter(e => e.message.type === 'cacheProgress');
            assert.strictEqual(delivered.length, 2);
            assert.ok(delivered[1].at - delivered[0].at >= 1000, 'late completion cannot cause a burst of reports');
            assert.strictEqual(delivered[1].message.storedBytes, 256);
            cache.change();
            timers.advance(1000);
            cache.change();
            close();
            cache.reads[2].resolve(report);
            await turn();
            assert.strictEqual(timers.tasks.size, 0, 'disposal suppresses a dirty follow-up');
            assert.strictEqual(cache.listeners.size, 0);
            assert.strictEqual(messages.filter(e => e.message.type === 'cacheProgress').length, 2);
        } finally {
            close();
            FakeCache.current.reads.forEach(read => read.resolve(report));
            await turn();
            (globalThis as any).setTimeout = nativeSet;
            (globalThis as any).clearTimeout = nativeClear;
        }
    });
});

// tsc turns import() into require(), which cannot load ES modules.
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('whole-data fallback disk progress', function () {
    this.timeout(30_000);
    let dir: string;
    let bundle: string;
    const names = ['window', 'location', 'fetch'];
    const saved: Record<string, PropertyDescriptor | undefined> = {};

    before(async () => {
        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts/build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-cache-progress-'));
        const entry = path.join(dir, 'entry.ts');
        fs.writeFileSync(entry, [
            'export { bridgeOutputsOf } from ' + JSON.stringify(path.join(viewerRoot, 'src/common/bridge.ts')) + ';',
            'export { pdfPerformance } from ' + JSON.stringify(path.join(viewerRoot, 'src/common/prefetch-performance.ts')) + ';',
            'export { onMessage } from ' + JSON.stringify(path.join(viewerRoot, 'src/common/host.ts')) + ';',
        ].join('\n'));
        bundle = path.join(dir, 'progress.mjs');
        try {
            await esbuild.build({ ...bundleOptions, entryPoints: [entry], outfile: bundle,
                plugins: [{
                    name: 'progress-page-fixture',
                    setup(build: any) {
                        build.onLoad({ filter: /\/common\/config\.ts$/ }, () => ({
                            contents: "export const config = {page:'page-current'};", loader: 'ts',
                        }));
                        build.onLoad({ filter: /\/common\/host\.ts$/ }, () => ({
                            contents: "const handlers = new Map(); export function onMessage(type, fn) { handlers.set(type,fn); } export function post(message) { window.posted.push(message); } window.addEventListener('message', event => handlers.get(event.data?.type)?.(event.data));",
                            loader: 'ts',
                        }));
                    },
                }],
            });
        } finally { await esbuild.stop(); }
    });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('clears old progress and rejects late reports while retaining the old document fetch route', async () => {
        for (const name of names) { saved[name] = Object.getOwnPropertyDescriptor(globalThis, name); }
        const page = Object.assign(new EventTarget(), { posted: [] as any[] });
        Object.defineProperty(globalThis, 'window', { value: page, configurable: true, writable: true });
        Object.defineProperty(globalThis, 'location', { value: new URL('https://viewer.test/'), configurable: true, writable: true });
        const deliver = (data: unknown) => page.dispatchEvent(new (globalThis as any).MessageEvent('message', { data }));
        try {
            const bridge = await importModule(bundle);
            let updates = 0;
            bridge.onMessage('update', () => { updates++; });
            bridge.bridgeOutputsOf({ downloadDomain: 'https://download.test', projectId: 'p', file: { build: 'old' } });
            const progress = { type: 'cacheProgress', page: 'page-current', build: 'old',
                storedBytes: 100, totalBytes: 1000, diskBytes: 200, budgetBytes: 4096, filling: false, complete: false };
            deliver(progress);
            assert.strictEqual(bridge.pdfPerformance.snapshot().diskCache.storedBytes, 100);
            deliver({ type: 'update', content: new ArrayBuffer(10) });
            assert.strictEqual(updates, 1, 'the application keeps its existing whole-PDF update handler');
            assert.strictEqual(bridge.pdfPerformance.snapshot().diskCache, undefined, 'whole-data replacement clears old build progress');
            deliver(progress);
            assert.strictEqual(bridge.pdfPerformance.snapshot().diskCache, undefined, 'late reports from the prior build remain rejected');
            const response = (globalThis as any).fetch('https://download.test/project/p/old.pdf');
            assert.strictEqual(page.posted.at(-1).type, 'fetch', 'the still-visible old document retains its bridge route');
            const request = page.posted.at(-1);
            deliver({ type: 'fetchResponse', page: 'page-current', id: request.id, status: 206, statusText: 'Partial Content', headers: [], body: new Uint8Array([1]) });
            assert.deepStrictEqual(new Uint8Array(await (await response).arrayBuffer()), new Uint8Array([1]));
        } finally {
            for (const name of names) {
                if (saved[name]) { Object.defineProperty(globalThis, name, saved[name]!); }
                else { delete (globalThis as any)[name]; }
            }
        }
    });
});
