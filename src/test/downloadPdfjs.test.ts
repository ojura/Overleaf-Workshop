/* eslint-disable @typescript-eslint/naming-convention -- package.json's package names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pdfjsReleaseOf } from '../core/viewerProtocol';

// tsc turns import() into require(), which cannot load ES modules
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

/** npm run download-pdfjs, which takes everything about pdf.js's release from package.json. */
describe('the download of pdf.js (scripts/download-pdfjs.mjs)', function () {
    this.timeout(60 * 1000);
    const packageText = fs.readFileSync(path.join(repo, 'package.json'), 'utf8');
    const packageJson = JSON.parse(packageText);
    const version: string = packageJson.devDependencies['pdfjs-dist'];
    let script: any;
    let scratch: string;

    before(async () => { script = await importModule(path.join(repo, 'scripts', 'download-pdfjs.mjs')); });
    // the script started esbuild's service to read the protocol; another build starts it again
    after(async () => { await (await importModule('esbuild')).stop(); });
    beforeEach(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'download-pdfjs-')); });
    afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

    it('takes the version, the folder and the patch from package.json\'s pdfjs-dist', () => {
        const plan = script.planOf();
        assert.strictEqual(plan.version, version);
        assert.strictEqual(plan.url, `https://github.com/mozilla/pdf.js/releases/download/v${version}/pdfjs-${version}-dist.zip`);
        assert.strictEqual(plan.release, path.join(repo, 'views', 'pdf-viewer', pdfjsReleaseOf(packageJson)));
        assert.strictEqual(plan.patch, `${plan.release}-dist.patch`);
        // the checkout keeps the extension's patch for the release it pins
        assert.ok(fs.existsSync(plan.patch), plan.patch);
    });

    it('package.json names the pdf.js version only where it pins pdfjs-dist', () => {
        assert.strictEqual(packageText.split(version).length - 1, 1);
        assert.ok(packageText.includes(`"pdfjs-dist": "${version}"`));
    });

    it('the settings\' texts and the viewer harness\'s server do not name the pdf.js version', () => {
        for (const file of ['package.nls.json', path.join('scripts', 'pdf-viewer-harness', 'server.mjs')]) {
            assert.ok(!fs.readFileSync(path.join(repo, file), 'utf8').includes(version), `${file} names ${version}`);
        }
    });

    it('refuses a release without its patch, before it downloads anything', () => {
        const release = path.join(scratch, 'vendor', 'pdfjs-9.8.7');
        assert.throws(() => script.download(script.planOf('9.8.7', release)), /there is no patch for pdf\.js 9\.8\.7/);
        assert.deepStrictEqual(fs.readdirSync(scratch), []);
    });

    it('leaves an earlier copy as it was, and nothing else, when the download fails', () => {
        const vendor = path.join(scratch, 'vendor');
        const release = path.join(vendor, 'pdfjs-9.8.7');
        fs.mkdirSync(release, { recursive: true });
        fs.writeFileSync(path.join(release, 'earlier.txt'), 'the earlier copy');
        fs.writeFileSync(`${release}-dist.patch`, '');
        // a name under .invalid never resolves (RFC 6761): the download fails at once
        const plan = { ...script.planOf('9.8.7', release), url: 'http://pdfjs.invalid/pdfjs-9.8.7-dist.zip' };
        // download-cli's output stays out of the suite's output, and the error carries what it said
        assert.throws(() => script.download(plan, { output: 'pipe' }), (error: Error) => {
            const [first, ...said] = error.message.split('\n');
            assert.match(first, /^the download of http:\/\/pdfjs\.invalid\/pdfjs-9\.8\.7-dist\.zip failed/);
            assert.ok(said.join('\n').includes('pdfjs.invalid'), error.message);
            return true;
        });
        assert.deepStrictEqual(fs.readdirSync(vendor).sort(), ['pdfjs-9.8.7', 'pdfjs-9.8.7-dist.patch']);
        assert.strictEqual(fs.readFileSync(path.join(release, 'earlier.txt'), 'utf8'), 'the earlier copy');
    });
});
