import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

class TextElement {
    readonly style: Record<string, string> = { display: '', gridTemplateColumns: '' };
    readonly attributes = new Map<string, string>();
    readonly children: TextElement[] = [];
    textContent = '';
    parent?: TextElement;
    readonly ownerDocument: { createElement: () => TextElement };
    constructor() { this.ownerDocument = { createElement: () => new TextElement() }; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    append(child: TextElement) { child.remove(); this.children.push(child); child.parent = this; }
    remove() {
        if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined; }
    }
}

describe('finite automatic text reservation', function () {
    let directory: string, api: any;
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-reserved-text-'));
        try {
            await esbuild.build({ entryPoints: [path.resolve(__dirname, '../../views/pdf-viewer/src/common/reserved-text.ts')],
                outfile: path.join(directory, 'reserved.mjs'), bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
        } finally { await esbuild.stop(); }
        api = await importModule(path.join(directory, 'reserved.mjs'));
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    it('rejects unknown text before installation or an atomic domain change mutates the DOM', () => {
        const host = new TextElement();
        assert.throws(() => api.installReservedText(host, ['waiting'], ''), /finite variant domain/);
        assert.strictEqual(host.children.length, 0);
        assert.strictEqual(host.style.display, '');
        const text = api.installReservedText(host, ['waiting', 'preparing'], 'waiting');
        const owned = [...host.children];
        assert.throws(() => text.setText('unknown'), /finite variant domain/);
        assert.throws(() => text.update(['ready'], 'waiting'), /finite variant domain/);
        assert.deepStrictEqual(host.children, owned);
        assert.strictEqual(text.live.textContent, 'waiting');
        text.update(['ready'], 'ready');
        assert.strictEqual(text.live.textContent, 'ready');
        assert.strictEqual(host.children.length, 2);
        text.setText('ready');
        assert.strictEqual(host.children.length, 2, 'live refresh never expands the reservation domain');
    });

    it('restores owned styles after CSSOM normalizes their assigned syntax', () => {
        const host = new TextElement();
        let columns = 'fit-content(20px)';
        Object.defineProperty(host.style, 'gridTemplateColumns', {
            get: () => columns,
            set: (value: string) => { columns = value === 'minmax(0, 1fr)' ? 'minmax(0px, 1fr)' : value; },
        });
        const text = api.installReservedText(host, ['waiting'], 'waiting');
        assert.strictEqual(host.style.gridTemplateColumns, 'minmax(0px, 1fr)');
        text.dispose();
        assert.strictEqual(host.style.gridTemplateColumns, 'fit-content(20px)');
    });

    it('isolates hidden variants and disposes only its own children and unchanged style rules', () => {
        const host = new TextElement(), sibling = new TextElement();
        host.setAttribute('aria-hidden', 'true');
        host.style.display = 'inline-flex';
        host.append(sibling);
        const text = api.installReservedText(host, ['waiting', 'preparing'], 'waiting');
        for (const child of host.children.filter(child => child !== sibling && child !== text.live)) {
            assert.strictEqual(child.attributes.get('aria-hidden'), 'true');
            assert.strictEqual(child.style.visibility, 'hidden');
            assert.strictEqual(child.style.userSelect, 'none');
            assert.strictEqual(child.style.pointerEvents, 'none');
        }
        host.style.gridTemplateColumns = '1fr 1fr';
        text.dispose(); text.dispose();
        assert.deepStrictEqual(host.children, [sibling]);
        assert.strictEqual(host.style.display, 'inline-flex');
        assert.strictEqual(host.style.gridTemplateColumns, '1fr 1fr');
        assert.strictEqual(host.attributes.get('aria-hidden'), 'true');
        assert.throws(() => text.setText('waiting'), /disposed/);
    });
});
