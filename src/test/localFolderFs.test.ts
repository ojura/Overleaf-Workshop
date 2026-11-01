import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as localFs from '../scm/localFolderFs';

// The local replica writes every download with localFolderFs.writeFile: the file must hold its
// old content or the new one, never a part of the new one.
describe('the local replica\'s writes into its folder', () => {
    /** writeFile, which the replica calls with its temporary folder */
    const write = localFs.writeFile;
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
        // a dangling link: the file it names is created
        const outside = path.join(dir, 'library.bib');
        const link = path.join(replica, 'refs.bib');
        fs.symlinkSync(outside, link);
        await write(link, enc('@book{a}\n'), temporary);
        assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link stays');
        assert.strictEqual(read(outside), '@book{a}\n');
        // a link to a file: that file is written in place
        const inode = fs.statSync(outside).ino;
        await write(link, enc('@book{b}\n'), temporary);
        assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link stays');
        assert.strictEqual(read(outside), '@book{b}\n');
        assert.strictEqual(fs.statSync(outside).ino, inode, 'the file the link names is the same file');
    });

    it('write a file that another user owns in place, so that it keeps its owner', async function () {
        if (process.getuid === undefined) { this.skip(); }
        const { replica, temporary } = layout();
        const file = path.join(replica, 'main.tex');
        fs.writeFileSync(file, 'old\n');
        const inode = fs.statSync(file).ino;
        // only root can give a file to another user: for the write, this process answers another user id
        const getuid = process.getuid;
        process.getuid = () => getuid() + 1;
        try {
            await write(file, enc('new\n'), temporary);
        } finally {
            process.getuid = getuid;
        }
        assert.strictEqual(read(file), 'new\n');
        assert.strictEqual(fs.statSync(file).ino, inode, 'the same file, written in place');
    });

    it('write the file in place when the rename finds it on another file system (EXDEV), and remove the temporary file', async () => {
        const { replica, temporary } = layout();
        const file = path.join(replica, 'main.tex');
        fs.writeFileSync(file, 'old\n');
        const inode = fs.statSync(file).ino;
        // as a target in a folder linked to another file system: the rename into it fails
        const promises = require('fs/promises');
        const rename = promises.rename;
        promises.rename = async () => { throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' }); };
        try {
            await write(file, enc('new\n'), temporary);
        } finally {
            promises.rename = rename;
        }
        assert.strictEqual(read(file), 'new\n');
        assert.strictEqual(fs.statSync(file).ino, inode, 'the same file, written in place');
        assert.deepStrictEqual(fs.readdirSync(temporary), []);
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

    it('remove what writes of processes that no longer run left in the temporary folder, and keep the files of a running one', async () => {
        const { temporary } = layout();
        fs.mkdirSync(temporary, { recursive: true });
        // a process that has ended: Linux gives out process ids in increasing order up to pid_max, so its id stays free
        const ended = spawnSync(process.execPath, ['-e', '']).pid;
        const running = `${process.pid}-0123456789abcdef.tmp`;
        for (const name of [running, `${ended}-0123456789abcdef.tmp`, 'notes.txt']) { fs.writeFileSync(path.join(temporary, name), 'x'); }
        await localFs.removeLeftoverWrites(temporary);
        assert.deepStrictEqual(fs.readdirSync(temporary), [running]);
    });

    it('remove a link at the temporary folder\'s path, and keep what it points to', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const { temporary } = layout();
        const elsewhere = path.join(dir, 'elsewhere');
        fs.mkdirSync(elsewhere);
        fs.writeFileSync(path.join(elsewhere, 'precious.txt'), 'x');
        fs.mkdirSync(path.dirname(temporary), { recursive: true });
        fs.symlinkSync(elsewhere, temporary);
        await localFs.removeLeftoverWrites(temporary);
        assert.strictEqual(fs.existsSync(temporary), false);
        assert.deepStrictEqual(fs.readdirSync(elsewhere), ['precious.txt']);
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
