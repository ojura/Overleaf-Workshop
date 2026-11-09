import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GitIgnoreMatcher } from '../scm/gitIgnore';
import { AsyncGit } from '../scm/replicaGit';
import { Cleanup } from './cleanup';

describe('the replica .gitignore matcher', function () {
    this.timeout(10_000);
    let cleanup: Cleanup, folder: string, git: AsyncGit;
    beforeEach(async () => {
        cleanup = new Cleanup();
        folder = cleanup.tempDir('replica-ignore-rules-');
        git = new AsyncGit(folder);
        await git.run(['init', '-q']);
        await git.run(['config', 'core.excludesFile', '']);
        await git.run(['config', 'core.ignorecase', 'false']);
    });
    afterEach(() => cleanup.undo());

    function write(relative: string, text: string) {
        fs.mkdirSync(path.dirname(path.join(folder, relative)), {recursive: true});
        fs.writeFileSync(path.join(folder, relative), text);
    }

    async function assertGit(matcher: GitIgnoreMatcher, paths: string[]) {
        const result = await git.run(['check-ignore', '--no-index', '-z', '--stdin'], {
            input: paths.join('\0') + '\0', allowFailure: true,
            // check-ignore takes literal paths already and rejects the pathspec environment flag.
            // eslint-disable-next-line @typescript-eslint/naming-convention
            env: {GIT_LITERAL_PATHSPECS: '0'},
        });
        assert.ok(result.status === 0 || result.status === 1, result.stderr);
        const ignored = new Set(result.stdout.toString('utf8').split('\0').filter(Boolean));
        for (const relative of paths) {
            assert.strictEqual(matcher.matches('/' + relative, relative.endsWith('/')), ignored.has(relative), relative);
        }
    }

    it('matches Git for tracked files, nested rules, negations, anchors, escapes and ignored parents', async () => {
        write('.gitignore', '# comment\n*.generated\ncache/\n!cache/keep.txt\nnested/*\n/*.root\ndoc/**/draft?.tex\n\\#draft\n\\!draft\nescaped\\ space\nUPPER\n');
        write('sub/.gitignore', '\uFEFF!keep.generated\r\n/only-here.dat\r\n*.temporary\n\\#notes\n\\!notes\nfolder/   \n\t\n   \n');
        write('nested/.gitignore', '!keep/\nkeep/*.tmp\n!keep/safe.tmp\n');
        write('chapter[1]/.gitignore', '*.dat\n');
        write('cache/.gitignore', '!keep.txt\n');
        const files = ['tracked.generated', 'main.tex', '#draft', '!draft', 'escaped space', 'UPPER', 'upper',
            'at.root', 'sub/at.root', 'sub/drop.generated', 'sub/keep.generated', 'sub/only-here.dat', 'sub/deeper/only-here.dat',
            'sub/a.temporary', 'sub/#notes', 'sub/!notes', 'nested/keep/free.tex', 'nested/keep/drop.tmp', 'nested/keep/safe.tmp',
            'nested/drop.tex', 'cache/keep.txt', 'doc/draft1.tex', 'doc/deep/draft2.tex', 'doc/deep/clean.tex', 'chapter[1]/result.dat'];
        files.forEach(file => write(file, 'content\n'));
        await git.run(['add', '-f', '--', 'tracked.generated']);
        const matcher = new GitIgnoreMatcher(folder);
        await matcher.refresh();
        await assertGit(matcher, [...files, 'sub/remote-only.generated', 'cache/remote-only.tex', 'nested/keep/', 'cache/',
            'sub/deeper/folder/remote-only.tex', 'sub/\t', 'sub/free/remote-only.tex']);
    });

    it('refreshes edits, additions, removals and replacement of nested rule files before path events', async () => {
        write('.gitignore', '*.generated\n');
        write('sub/keep.generated', 'content\n');
        const matcher = new GitIgnoreMatcher(folder);
        await matcher.refresh();
        assert.strictEqual(matcher.matches('/sub/keep.generated'), true);
        write('sub/.gitignore', '!keep.generated\n');
        await matcher.refreshPath('/sub/keep.generated');
        assert.strictEqual(matcher.matches('/sub/keep.generated'), false);
        write('sub/.replacement', '*.generated\n');
        fs.renameSync(path.join(folder, 'sub/.replacement'), path.join(folder, 'sub/.gitignore'));
        await matcher.refreshPath('/sub/keep.generated');
        assert.strictEqual(matcher.matches('/sub/keep.generated'), true);
        fs.unlinkSync(path.join(folder, '.gitignore'));
        fs.unlinkSync(path.join(folder, 'sub/.gitignore'));
        await matcher.refreshPath('/sub/keep.generated');
        assert.strictEqual(matcher.matches('/sub/keep.generated'), false);
        await assertGit(matcher, ['sub/keep.generated']);
    });

    it('does not apply Git info/exclude, global exclusions or a symlinked .gitignore', async () => {
        write('.git/info/exclude', 'local-only.tex\n');
        write('.global-ignore', 'global-only.tex\n');
        await git.run(['config', 'core.excludesFile', path.join(folder, '.global-ignore')]);
        write('rules', '*.generated\n');
        if (process.platform !== 'win32') { fs.symlinkSync('rules', path.join(folder, '.gitignore')); }
        const matcher = new GitIgnoreMatcher(folder);
        await matcher.refresh();
        assert.strictEqual(matcher.matches('/local-only.tex'), false);
        assert.strictEqual(matcher.matches('/global-only.tex'), false);
        assert.strictEqual(matcher.matches('/output.generated'), false);
    });

    it('honors Git case sensitivity and treats the folder part of a nested rule as a literal name', async () => {
        write('chapter[1]/.gitignore', 'RESULT.DAT\n');
        const sensitive = new GitIgnoreMatcher(folder);
        await sensitive.refresh();
        assert.strictEqual(sensitive.matches('/chapter[1]/RESULT.DAT'), true);
        assert.strictEqual(sensitive.matches('/chapter1/RESULT.DAT'), false);
        assert.strictEqual(sensitive.matches('/chapter[1]/result.dat'), false);
        await git.run(['config', 'core.ignorecase', 'true']);
        const insensitive = new GitIgnoreMatcher(folder, true);
        await insensitive.refresh();
        await assertGit(insensitive, ['chapter[1]/RESULT.DAT', 'chapter[1]/result.dat']);
    });

    it('shares concurrent rule reads and matches a file batch without filesystem work', async () => {
        write('.gitignore', '*.generated\n');
        write('sub/.gitignore', '!keep.generated\n');
        const read = fs.promises.readFile;
        let reads = 0;
        (fs.promises as any).readFile = (...args: any[]) => {
            if (String(args[0]).endsWith('.gitignore')) { reads++; }
            return (read as any)(...args);
        };
        cleanup.add(() => { fs.promises.readFile = read; });
        const matcher = new GitIgnoreMatcher(folder);
        await Promise.all(Array.from({length: 100}, () => matcher.refresh()));
        assert.strictEqual(reads, 2);
        const key = matcher.key;
        for (let index = 0; index < 1000; index++) { assert.strictEqual(matcher.matches(`/sub/${index}.generated`), true); }
        assert.strictEqual(reads, 2, 'matching itself does no file reads');
        await Promise.all(Array.from({length: 100}, () => matcher.refreshPath('/sub/keep.generated')));
        assert.strictEqual(reads, 4, 'concurrent path events share their ancestor reads');
        assert.strictEqual(matcher.key, key, 'unchanged rules keep the same value');
    });
});
