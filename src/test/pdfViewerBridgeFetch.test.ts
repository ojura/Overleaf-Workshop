import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// tsc turns import() into require(), which cannot load ES modules
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

/**
 * The viewers' requests through the extension host (views/pdf-viewer/src/common/bridge-fetch.ts),
 * bundled as the viewers bundle it, and run in Node with the page globals that it reads.
 */
describe('the viewer\'s requests through the extension host (bridge-fetch.ts)', function () {
    this.timeout(30 * 1000);
    const names = ['window', 'location', 'fetch'];
    const saved: Record<string, PropertyDescriptor | undefined> = {};
    let dir: string;
    let bridge: any;
    /** the page's window, where the host's answers arrive as message events */
    let page: EventTarget;
    const posted: any[] = [];
    // Node's MessageEvent, which the extension's TypeScript library does not declare
    const deliver = (data: unknown) => page.dispatchEvent(new (globalThis as any).MessageEvent('message', { data }));

    before(async () => {
        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts', 'build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-viewer-bridge-fetch-'));
        const entry = path.join(dir, 'entry.ts');
        fs.writeFileSync(entry, `export { installBridgeFetch } from ${JSON.stringify(path.join(viewerRoot, 'src', 'common', 'bridge-fetch.ts'))};`);
        await esbuild.build({ ...bundleOptions, entryPoints: [entry], outfile: path.join(dir, 'bridge-fetch.mjs') });
        // esbuild's service process is not needed any more; another build starts it again
        await esbuild.stop();
        bridge = await importModule(path.join(dir, 'bridge-fetch.mjs'));
    });

    beforeEach(() => {
        for (const name of names) { saved[name] = Object.getOwnPropertyDescriptor(globalThis, name); }
        page = new EventTarget();
        Object.defineProperty(globalThis, 'window', { value: page, configurable: true, writable: true });
        Object.defineProperty(globalThis, 'location', { value: new URL('https://webview.test/index.html'), configurable: true, writable: true });
        posted.length = 0;
        // the page's ID, which the host wrote into its configuration
        bridge.installBridgeFetch((message: unknown) => posted.push(message), () => true, 'page-2');
    });

    afterEach(() => {
        for (const name of names) {
            if (saved[name]) { Object.defineProperty(globalThis, name, saved[name]!); } else { delete (globalThis as any)[name]; }
        }
    });

    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('names its page in each request, and takes only the answers to its page', async () => {
        const answered = (globalThis as any).fetch('https://dl.test/project/p1/output.pdf', { headers: { range: 'bytes=0-1' } });
        assert.deepStrictEqual(posted.map(m => [m.type, m.page, m.id]), [['fetch', 'page-2', 1]]);
        // the answer to the request that the panel's earlier page numbered 1, as it may still arrive
        deliver({ type: 'fetchResponse', page: 'page-1', id: 1, status: 206, statusText: 'Partial Content', headers: [], body: new Uint8Array([1, 1]) });
        deliver({ type: 'fetchResponse', page: 'page-2', id: 1, status: 206, statusText: 'Partial Content', headers: [], body: new Uint8Array([2, 2]) });
        const response = await answered;
        assert.deepStrictEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([2, 2]));
    });

    it('names its page when it stops a request', async () => {
        const abort = new AbortController();
        const answered = (globalThis as any).fetch('https://dl.test/project/p1/output.pdf', { signal: abort.signal });
        abort.abort();
        await assert.rejects(answered, { name: 'AbortError' });
        assert.deepStrictEqual(posted.map(m => [m.type, m.page, m.id]), [['fetch', 'page-2', 1], ['fetchAbort', 'page-2', 1]]);
    });
});
