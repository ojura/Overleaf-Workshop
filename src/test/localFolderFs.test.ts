import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as localFs from '../scm/localFolderFs';

// The local replica writes every download with localFolderFs.writeFile: the file must hold its
// old content or the new one, never a part of the new one.
describe('the local replica\'s writes into its folder', () => {
    /** writeFile with its temporary folder, as the replica calls it */
    const write = localFs.writeFile as (p: string, content: Uint8Array, temporaryFolder?: string) => Promise<void>;
    const enc = (text: string) => new TextEncoder().encode(text);
    const read = (file: string) => fs.readFileSync(file, 'utf8');
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-local-write-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    /** A replica folder, with its temporary folder inside its own .overleaf folder. */
    function layout() {
        const replica = path.join(dir, 'replica');
        fs.mkdirSync(replica);
        return { replica, temporary: path.join(replica, '.overleaf', 'tmp') };
    }
    /** The names in the replica folder, without its own .overleaf folder. */
    const synced = (replica: string) => fs.readdirSync(replica).filter(name => name !== '.overleaf');

    it('replace a file in one rename, and keep its mode', async () => {
        const { replica, temporary } = layout();
        const file = path.join(replica, 'main.tex');
        fs.writeFileSync(file, 'old content\n');
        fs.chmodSync(file, 0o750);
        // a reader that opened the file before the write
        const reader = fs.openSync(file, 'r');
        try {
            await write(file, enc('new content, longer than the old\n'), temporary);
            assert.strictEqual(fs.readFileSync(reader, 'utf8'), 'old content\n', 'the open file still holds the old content: the new one replaced it');
        } finally {
            fs.closeSync(reader);
        }
        assert.strictEqual(read(file), 'new content, longer than the old\n');
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o750);
        assert.deepStrictEqual(synced(replica), ['main.tex'], 'the temporary file is gone');
    });

    it('put the new content in the temporary folder while it is written, not next to the target', async () => {
        const { replica, temporary } = layout();
        const file = path.join(replica, 'main.tex');
        fs.writeFileSync(file, 'old\n');
        // hold the write at its fsync, and look at both folders meanwhile
        const probe = await fs.promises.open(file, 'r');
        const prototype = Object.getPrototypeOf(probe);
        await probe.close();
        const sync = prototype.sync;
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let reached!: () => void;
        const atSync = new Promise<void>(resolve => { reached = resolve; });
        prototype.sync = async function (this: unknown) { reached(); await released; return sync.call(this); };
        try {
            const writing = write(file, enc('new\n'), temporary);
            await atSync;
            assert.deepStrictEqual(synced(replica), ['main.tex'], 'only the target is in its folder');
            assert.strictEqual(fs.readdirSync(temporary).length, 1, 'the new content is in the temporary folder');
            release();
            await writing;
        } finally {
            prototype.sync = sync;
            release();
        }
        assert.strictEqual(read(file), 'new\n');
        assert.deepStrictEqual(fs.readdirSync(temporary), []);
    });

    it('write a file with a long name', async () => {
        const { replica, temporary } = layout();
        const file = path.join(replica, `${'x'.repeat(236)}.tex`);
        fs.writeFileSync(file, 'old\n');
        await write(file, enc('new\n'), temporary);
        assert.strictEqual(read(file), 'new\n');
    });

    it('write through a symbolic link, also a dangling one, and keep the link', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const { replica, temporary } = layout();
        const outside = path.join(dir, 'library.bib');
        const link = path.join(replica, 'refs.bib');
        fs.symlinkSync(outside, link);
        await write(link, enc('@book{a}\n'), temporary);
        assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link stays');
        assert.strictEqual(read(outside), '@book{a}\n');
    });

    it('write a file with another name in place, so that both names hold the new content', async () => {
        const { replica, temporary } = layout();
        const file = path.join(replica, 'main.tex');
        fs.writeFileSync(file, 'old\n');
        const other = path.join(dir, 'other-name.tex');
        fs.linkSync(file, other);
        await write(file, enc('new\n'), temporary);
        assert.strictEqual(read(other), 'new\n');
    });

    it('leave the old content in place when the new one cannot be written whole', function () {
        if (process.platform === 'win32') { this.skip(); }
        const { replica, temporary } = layout();
        const file = path.join(replica, 'main.tex');
        const old = 'old line\n'.repeat(500);
        fs.writeFileSync(file, old);
        // a child that may write files of 4 blocks at most: a longer write fails partway with EFBIG
        const script = `require(${JSON.stringify(require.resolve('../scm/localFolderFs'))}).writeFile(process.argv[1], new Uint8Array(65536).fill(65), process.argv[2])`
            + '.then(() => process.stdout.write("written"), error => process.stdout.write(String(error.code)))';
        const child = spawnSync('sh', ['-c', 'ulimit -f 4; exec "$0" -e "$1" "$2" "$3"', process.execPath, script, file, temporary], { encoding: 'utf8' });
        assert.strictEqual(child.status, 0, child.stderr);
        assert.strictEqual(child.stdout, 'EFBIG');
        assert.strictEqual(read(file), old, 'the file keeps its old content');
        assert.deepStrictEqual(synced(replica), ['main.tex'], 'the temporary file is removed');
    });
});
