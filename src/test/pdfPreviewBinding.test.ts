import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

class Bus {
    readonly listeners = new Map<string, Set<() => void>>();
    on(name: string, callback: () => void) { const group = this.listeners.get(name) ?? new Set(); group.add(callback); this.listeners.set(name, group); }
    off(name: string, callback: () => void) { this.listeners.get(name)?.delete(callback); }
    fire() { for (const callback of [...(this.listeners.get('pagesinit') ?? [])]) { callback(); } }
}

describe('preview attachment across deferred native document installation', () => {
    let directory: string, create: any;
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-preview-binding-'));
        const bundle = path.join(directory, 'binding.mjs');
        try {
            await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/pdf-preview-binding.ts')],
                outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
        } finally { await esbuild.stop(); }
        create = (await importModule(bundle)).createPdfPreviewBinding;
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });
    function fixture() {
        const old = {}, next = {}, eventBus = new Bus();
        const viewer = { pdfDocument: old, eventBus };
        const installed: Array<{ source: any, document: unknown }> = [];
        const binding = create(viewer, (source: any, document: unknown) => {
            // The controller accepts only the PDFDocumentProxy installed in its viewer.
            if (viewer.pdfDocument === document) { installed.push({ source, document }); }
        });
        return { old, next, eventBus, viewer, installed, binding };
    }

    it('waits for a deferred view-transition document and attaches before the page event returns', () => {
        const f = fixture(), source = { identity: { key: 'next', size: 1000 } };
        try {
            f.binding.set(source, f.next);
            assert.strictEqual(f.installed.length, 0);
            f.eventBus.fire(); assert.strictEqual(f.installed.length, 0, 'old pages cannot receive the new source');
            f.viewer.pdfDocument = f.next;
            f.eventBus.fire();
            assert.deepStrictEqual(f.installed, [{ source, document: f.next }]);
            f.eventBus.fire(); assert.strictEqual(f.installed.length, 1, 'duplicate page events do not restart the source');
        } finally { f.binding.dispose(); }
    });

    it('withdraws a superseded pending document while preserving the displayed source', () => {
        const f = fixture(), displayed = { name: 'displayed' }, obsolete = { name: 'obsolete' }, latest = { name: 'latest' }, newest = {};
        try {
            f.binding.set(displayed, f.old);
            f.binding.set(obsolete, f.next);
            f.binding.clear();
            assert.deepStrictEqual(f.installed, [{ source: displayed, document: f.old }], 'starting another load leaves current pixels attached');
            f.viewer.pdfDocument = f.next; f.eventBus.fire();
            assert.strictEqual(f.installed.length, 1, 'the late superseded transition has no preview binding');
            f.binding.set(latest, newest);
            f.viewer.pdfDocument = newest; f.eventBus.fire();
            assert.deepStrictEqual(f.installed.at(-1), { source: latest, document: newest });
        } finally { f.binding.dispose(); }
    });

    it('attaches an already installed document immediately and clears its source for whole-data replacement', () => {
        const f = fixture(), source = { name: 'ready' };
        try {
            f.binding.set(source, f.old);
            assert.deepStrictEqual(f.installed, [{ source, document: f.old }]);
            f.binding.set(undefined, f.next);
            assert.strictEqual(f.installed.length, 1);
            f.viewer.pdfDocument = f.next; f.eventBus.fire();
            assert.deepStrictEqual(f.installed.at(-1), { source: undefined, document: f.next });
        } finally { f.binding.dispose(); }
    });

    it('removes its event subscription and rejects an already queued callback after disposal', () => {
        const f = fixture(), source = { name: 'pending' };
        const late = [...f.eventBus.listeners.get('pagesinit')!][0];
        f.binding.set(source, f.next);
        f.binding.dispose(); f.binding.dispose();
        assert.strictEqual(f.eventBus.listeners.get('pagesinit')!.size, 0);
        f.viewer.pdfDocument = f.next; late(); f.binding.set(source, f.next);
        assert.strictEqual(f.installed.length, 0);
    });
});
