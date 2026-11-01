import * as assert from 'assert';
import { LocalStat, RemoteEntry, ReplicaLocal, ReplicaRemote, ReplicaStore, ReplicaSync, ReplicaUI, SavedState } from '../scm/replicaSync';
import { overleafLineEndings } from '../utils/docUpdate';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** Overleaf's side for one document: it stores the text with "\n", as the extension now sends it. */
class Overleaf implements ReplicaRemote {
    disconnected() { return undefined; }
    docs = new Map<string, string>();
    writes: string[] = [];
    async list() { return new Map<string, RemoteEntry>([...this.docs.keys()].map(path => [path, { kind: 'doc' }])); }
    async entry(path: string): Promise<RemoteEntry | undefined> { return this.docs.has(path) ? { kind: 'doc' } : undefined; }
    async isFolder() { return false; }
    async readDoc(path: string) { return this.docs.get(path)!; }
    async readFile(): Promise<Uint8Array> { throw new Error('no files'); }
    async writeDoc(path: string, text: string) { this.writes.push(text); this.docs.set(path, overleafLineEndings(text)); }
    async upload(path: string, content: Uint8Array): Promise<RemoteEntry> { this.docs.set(path, overleafLineEndings(dec(content))); return { kind: 'doc' }; }
    async remove(path: string) { this.docs.delete(path); }
    async removeFolderIfEmpty() {}
    async settled() {}
}

/** The local folder, in memory, with a clock for modification times. */
class Folder implements ReplicaLocal {
    async verify() {}
    files = new Map<string, { content: Uint8Array, mtime: number }>();
    clock = 1_000_000;
    set(path: string, text: string) { this.clock += 10_000; this.files.set(path, { content: enc(text), mtime: this.clock }); }
    text(path: string) { return dec(this.files.get(path)!.content); }
    async list() { return new Map<string, LocalStat>([...this.files].map(([path, f]) => [path, { size: f.content.byteLength, mtime: f.mtime }])); }
    async stat(path: string): Promise<LocalStat | 'folder' | undefined> { const f = this.files.get(path); return f && { size: f.content.byteLength, mtime: f.mtime }; }
    async read(path: string) { return this.files.get(path)?.content; }
    async write(path: string, content: Uint8Array) { this.set(path, dec(content)); return { size: content.byteLength, mtime: this.clock }; }
    async remove(path: string) { this.files.delete(path); }
    async removeFolderIfEmpty() {}
}

class Store implements ReplicaStore {
    state?: SavedState;
    bases = new Map<string, string>();
    async load() { return this.state && JSON.parse(JSON.stringify(this.state)); }
    async save(state: SavedState) { this.state = JSON.parse(JSON.stringify(state)); }
    async readBase(hash: string) { return this.bases.get(hash); }
    async writeBase(hash: string, text: string) { this.bases.set(hash, text); }
    async pruneBases() {}
    async keepCopy(path: string) { return `/.overleaf/sync/conflicts${path}`; }
}

const ui: ReplicaUI = { log() {}, progress() {}, confirmDeletions: async () => true, conflictBlocked() {}, liveResult() {} };

describe('local replica: a document written with "\\r\\n" line endings', () => {
    before(() => { ReplicaSync.remoteDeleteDelayMs = 0; ReplicaSync.saveDelayMs = 0; });

    it('goes up once, is written back once with "\\n", and then stays as it is', async () => {
        const overleaf = new Overleaf(), folder = new Folder(), store = new Store();
        const sync = () => new ReplicaSync(overleaf, folder, store, ui, () => false).syncAll();
        overleaf.docs.set('/main.tex', 'line 1\nline 2\n');
        await sync();
        assert.strictEqual(folder.text('/main.tex'), 'line 1\nline 2\n');

        // a program writes the file with "\r\n" and a change
        folder.set('/main.tex', 'line 1\r\nline 2 changed\r\n');
        const up = await sync();
        assert.deepStrictEqual(up.uploaded, ['/main.tex']);
        assert.strictEqual(overleaf.docs.get('/main.tex'), 'line 1\nline 2 changed\n');

        // Overleaf holds "\n" now, so the file is written back with "\n", once
        const back = await sync();
        assert.deepStrictEqual(back.downloaded, ['/main.tex']);
        assert.deepStrictEqual(back.uploaded, []);
        assert.strictEqual(folder.text('/main.tex'), 'line 1\nline 2 changed\n');

        const quiet = await sync();
        assert.deepStrictEqual([quiet.uploaded, quiet.downloaded, quiet.merged], [[], [], []]);
        assert.strictEqual(overleaf.writes.length, 1);
    });
});
