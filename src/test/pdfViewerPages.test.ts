import * as assert from 'assert';
import { completeViewerPage, isBuildPath, viewerConfig } from '../core/pdfViewerPages';

describe('the pages of the PDF viewers that load in ranges', () => {
    const base = 'https://file+.vscode-resource.vscode-cdn.net/home/u/ext/views/pdf-viewer/';
    /** a pdf.js release of another version than the one package.json pins: the pages take the one they are given */
    const pdfjsRelease = 'vendor/pdfjs-9.8.7';

    it('puts the base URL and the configuration where the page asks for them', () => {
        const page = completeViewerPage('<head><!--viewer-config--><script type="module" src="dist/overleaf.mjs"></script></head>', { engine: 'overleaf', base: base.slice(0, -1), page: 'page-1', pdfjsRelease });
        const m = /^<head><base href="([^"]+)"><script id="viewer-config" type="application\/json">(.*)<\/script><script type="module"/.exec(page);
        assert.ok(m, page);
        assert.strictEqual(m[1], base);
        const config = JSON.parse(m[2]);
        assert.deepStrictEqual(config, viewerConfig({ engine: 'overleaf', base, page: 'page-1', pdfjsRelease }));
        assert.strictEqual(config.page, 'page-1');
        assert.strictEqual(config.pdfjs.build, `${base}vendor/pdfjs-9.8.7/build/`);
        assert.strictEqual(config.pdfjs.imageResourcesPath, `${base}vendor/pdfjs-9.8.7/web/images/`);
        for (const url of Object.values(config.pdfjs) as string[]) {
            assert.ok(url.startsWith(base) && url.endsWith('/'), url);
        }
    });

    it('keeps the configuration inside its script element', () => {
        const page = completeViewerPage('<!--viewer-config-->', { engine: 'pdfjs', base: 'https://x/a</script><b>"&/', page: 'page-1', pdfjsRelease });
        assert.strictEqual(page.match(/<\/script>/g)?.length, 1);
        assert.ok(page.startsWith('<base href="https://x/a&lt;/script&gt;&lt;b&gt;&quot;&amp;/">'), page);
        assert.strictEqual(JSON.parse(/type="application\/json">(.*)<\/script>$/.exec(page)![1]).pdfjs.build, 'https://x/a</script><b>"&/vendor/pdfjs-9.8.7/build/');
    });

    it('refuses a page without the placeholder', () => {
        assert.throws(() => completeViewerPage('<head></head>', { engine: 'pdfjs', base, page: 'page-1', pdfjsRelease }), /has no <!--viewer-config-->/);
    });

    it('takes only the output folder\'s output.pdf for the build', () => {
        assert.strictEqual(isBuildPath(['.output', 'output.pdf'], '.output'), true);
        assert.strictEqual(isBuildPath(['slike', 'figure.pdf'], '.output'), false);
        assert.strictEqual(isBuildPath(['output.pdf'], '.output'), false);
        assert.strictEqual(isBuildPath(['chapters', '.output', 'output.pdf'], '.output'), false);
        assert.strictEqual(isBuildPath(['out', 'output.pdf'], 'out'), true);
    });
});
