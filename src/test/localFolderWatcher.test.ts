import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalFolderWatcher } from '../scm/localFolderWatcher';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const QUIET_MS = 100;
/** long enough for the watcher's quiet time and the system's events */
const SETTLE_MS = 600;

describe('LocalFolderWatcher, on a real folder', () => {
    let dir: string;
    let changes: string[];
    let unknown: string[];
    let watcher: LocalFolderWatcher;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-folder-watcher-'));
        fs.mkdirSync(path.join(dir, '.overleaf'));
        changes = [];
        unknown = [];
        watcher = new LocalFolderWatcher(dir, p => changes.push(p), reason => unknown.push(reason),
                                         p => p === '/.overleaf' || p.startsWith('/.overleaf/'), QUIET_MS);
        assert.deepStrictEqual(watcher.start(), { ok: true });
    });
    afterEach(() => {
        watcher.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reports a file another program writes in place, once for a write in many parts', async () => {
        const file = path.join(dir, 'main.tex');
        fs.writeFileSync(file, 'old');
        await wait(SETTLE_MS);
        changes.length = 0;
        // 1.3 MB in 20 writes, as cp writes a large file
        const fd = fs.openSync(file, 'w');
        for (let i = 0; i < 20; i++) {
            fs.writeSync(fd, Buffer.alloc(65536, 0x61 + i));
            await wait(5);
        }
        fs.closeSync(fd);
        await wait(SETTLE_MS);
        assert.deepStrictEqual(changes, ['/main.tex']);
    });

    it('reports a file renamed into place from outside the folder', async () => {
        const outside = path.join(os.tmpdir(), `ow-outside-${process.pid}.tex`);
        fs.writeFileSync(outside, 'new content');
        fs.renameSync(outside, path.join(dir, 'INDEXING.md'));
        await wait(SETTLE_MS);
        assert.deepStrictEqual(changes, ['/INDEXING.md']);
    });

    it('reports files in a new folder, and a removed file', async () => {
        fs.mkdirSync(path.join(dir, 'slike'));
        await wait(SETTLE_MS);
        fs.writeFileSync(path.join(dir, 'slike', 'photo.jpg'), Buffer.alloc(1000));
        await wait(SETTLE_MS);
        assert.ok(changes.includes('/slike/photo.jpg'), `got ${JSON.stringify(changes)}`);
        changes.length = 0;
        fs.rmSync(path.join(dir, 'slike', 'photo.jpg'));
        await wait(SETTLE_MS);
        assert.deepStrictEqual(changes, ['/slike/photo.jpg']);
    });

    it('leaves out the paths it is told to skip', async () => {
        fs.writeFileSync(path.join(dir, '.overleaf', 'state.json'), '{}');
        fs.writeFileSync(path.join(dir, 'main.tex'), 'x');
        await wait(SETTLE_MS);
        assert.deepStrictEqual(changes, ['/main.tex']);
        assert.deepStrictEqual(unknown, []);
    });

    it('reports nothing after it is disposed', async () => {
        watcher.dispose();
        fs.writeFileSync(path.join(dir, 'main.tex'), 'x');
        await wait(SETTLE_MS);
        assert.deepStrictEqual(changes, []);
    });
});

describe('LocalFolderWatcher, without a folder', () => {
    it('cannot start, and says why', () => {
        const watcher = new LocalFolderWatcher(path.join(os.tmpdir(), `ow-missing-${process.pid}`), () => {}, () => {});
        const started = watcher.start();
        assert.strictEqual(started.ok, false);
        assert.match((started as { reason: string }).reason, /ENOENT/);
        watcher.dispose();
    });
});
