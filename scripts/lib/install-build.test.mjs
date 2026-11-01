// Tests of the rules by which scripts/lib/install-build.mjs decides what the package holds, as vsce
// 2.15.0 decides it (vscePackaged, globMatcher). npm run test:unit runs them with node --test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { globMatcher, vscePackaged } from './install-build.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vscodeignore = fs.readFileSync(path.join(repo, '.vscodeignore'), 'utf8');

test('globMatcher matches as minimatch 3 with { dot: true }', () => {
    const cases = [
        ['**/*.map', 'a.map', true],
        ['**/*.map', 'x/y/a.map', true],
        ['**/*.map', '.hidden/a.map', true],
        ['**/*.map', 'a.map.js', false],
        ['*.todo', 'a.todo', true],
        ['*.todo', 'x/a.todo', false],
        ['src/**', 'src/a/b.ts', true],
        ['src/**', 'srcx/a.ts', false],
        ['.eslintrc*', '.eslintrc.json', true],
        ['.eslintrc*', 'a/.eslintrc.json', false],
        ['**/.git/**', 'x/.git/HEAD', true],
        ['**/.git/**', '.git/config', true],
        ['data/vendor/LICENSE*', 'data/vendor/LICENSE.txt', true],
        ['views/pdf-viewer/vendor/*/web/*.pdf', 'views/pdf-viewer/vendor/pdfjs-5.1.91/web/sample.pdf', true],
        ['views/pdf-viewer/vendor/*/web/*.pdf', 'views/pdf-viewer/vendor/pdfjs-5.1.91/web/x/sample.pdf', false],
        ['.github', '.github/workflows/a.yml', false],
        ['a?c', 'abc', true],
        ['a?c', 'a/c', false],
    ];
    for (const [pattern, file, expected] of cases) {
        assert.equal(globMatcher(pattern)(file), expected, `${pattern} against ${file}`);
    }
});

test('globMatcher refuses the glob syntax that it does not read as minimatch does', () => {
    for (const pattern of ['{a,b}.js', '[ab].js', '+(a|b)', 'a\\*b']) {
        assert.throws(() => globMatcher(pattern), /glob syntax/, pattern);
    }
});

test('vscePackaged applies vsce\'s lists and the folder form of each line', () => {
    const ignore = 'docs\nfoo/\nlib/*.tmp\n!docs/keep.md\n# a comment\n';
    assert.deepEqual(
        vscePackaged(['docs/a.md', 'docs/keep.md', 'foo/a', 'lib/a.tmp', 'lib/b/a.tmp', 'package-lock.json', 'README.md', 'x.vsix', 'ok.js'], ignore),
        ['docs/keep.md', 'lib/b/a.tmp', 'README.md', 'ok.js'],
    );
});

test('the repository\'s .vscodeignore lets the run-time files through and keeps the rest out', () => {
    const packaged = [
        'package.json', 'package.nls.json', 'README.md', 'LICENSE', 'out/extension.js', 'l10n/bundle.l10n.json',
        'node_modules/undici/index.js', 'data/vendor/languages/latex-language-configuration.json', 'data/vendor/README.md',
        'data/vendor/LICENSE.txt', 'views/chat-view/dist/index.html', 'views/pdf-viewer/dist/pdfjs.mjs',
        'views/pdf-viewer/vendor/pdfjs-5.1.91/build/pdf.mjs', 'views/pdf-viewer/vendor/pdfjs-5.1.91/web/locale/locale.json',
        'views/pdf-viewer/vendor/pdfjs-5.1.91/web/cmaps/Adobe-GB1-UCS2.bcmap', 'views/pdf-viewer/overleaf/LICENSE',
    ];
    const left = [
        'src/extension.ts', 'out/test/a.test.js', 'out/extension.js.map', 'node_modules/undici/index.d.ts', 'scripts/hidden-ide.mjs',
        '.mocharc.json', 'CLAUDE.md', 'docs/wiki.md', 'package-lock.json', 'data/vendor/package.json', 'views/chat-view/src/App.vue',
        'views/pdf-viewer/src/pdfjs/index.html', 'views/pdf-viewer/vendor/pdfjs-5.1.91-dist.patch', 'views/pdf-viewer/tsconfig.json',
        'views/pdf-viewer/vendor/pdfjs-5.1.91/web/compressed.tracemonkey-pldi-09.pdf', '.local-install/a', 'CLAUDE.local.md',
    ];
    assert.deepEqual(vscePackaged([...packaged, ...left], vscodeignore), packaged);
});
