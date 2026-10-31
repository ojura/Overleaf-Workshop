import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as localFs from '../scm/localFolderFs';

// The local replica writes every download with localFolderFs.writeFile: the file must hold its
// old content or the new one, never a part of the new one.
describe('the local replica\'s writes into its folder', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-local-write-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('replace a file in one rename, and keep its mode', async () => {
        const file = path.join(dir, 'main.tex');
        fs.writeFileSync(file, 'old content\n');
        fs.chmodSync(file, 0o750);
        // a reader that opened the file before the write
        const reader = fs.openSync(file, 'r');
        try {
            await localFs.writeFile(file, new TextEncoder().encode('new content, longer than the old\n'));
            assert.strictEqual(fs.readFileSync(reader, 'utf8'), 'old content\n', 'the open file still holds the old content: the new one replaced it');
        } finally {
            fs.closeSync(reader);
        }
        assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new content, longer than the old\n');
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o750);
        assert.deepStrictEqual(fs.readdirSync(dir), ['main.tex'], 'the temporary file is gone');
    });

    it('leave the old content in place when the new one cannot be written whole', function () {
        if (process.platform === 'win32') { this.skip(); }
        const file = path.join(dir, 'main.tex');
        const old = 'old line\n'.repeat(500);
        fs.writeFileSync(file, old);
        // a child that may write files of 4 blocks at most: a longer write fails partway with EFBIG
        const write = `require(${JSON.stringify(require.resolve('../scm/localFolderFs'))}).writeFile(process.argv[1], new Uint8Array(65536).fill(65))`
            + '.then(() => process.stdout.write("written"), error => process.stdout.write(String(error.code)))';
        const child = spawnSync('sh', ['-c', 'ulimit -f 4; exec "$0" -e "$1" "$2"', process.execPath, write, file], { encoding: 'utf8' });
        assert.strictEqual(child.status, 0, child.stderr);
        assert.strictEqual(child.stdout, 'EFBIG');
        assert.strictEqual(fs.readFileSync(file, 'utf8'), old, 'the file keeps its old content');
        assert.deepStrictEqual(fs.readdirSync(dir), ['main.tex'], 'the temporary file is removed');
    });
});
