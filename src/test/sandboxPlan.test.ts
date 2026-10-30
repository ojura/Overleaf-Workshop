/* eslint-disable @typescript-eslint/naming-convention -- the tests key files by their paths */
import * as assert from 'assert';
import { gitBlobHash } from '../scm/replicaSync';
import { LocalFile, MAX_DOC_LENGTH, overleafText, planSync, RemoteFile, RemoteTree } from '../sandbox/plan';

const enc = (text: string) => new TextEncoder().encode(text);

function localFile(content: string | Uint8Array): LocalFile {
    const bytes = typeof content === 'string' ? enc(content) : content;
    return { hash: gitBlobHash(bytes), text: overleafText(bytes), size: bytes.byteLength };
}

/** A project in memory: documents hold text, binary files their bytes. */
class Project {
    docs = new Map<string, string>();
    files = new Map<string, Uint8Array>();
    folders = new Set<string>(['/']);
    noHash = new Set<string>();
    reads: string[] = [];

    doc(path: string, text: string) { this.docs.set(path, text); this.addFolders(path); return this; }
    file(path: string, content: string | Uint8Array) {
        this.files.set(path, typeof content === 'string' ? enc(content) : content);
        this.addFolders(path);
        return this;
    }
    private addFolders(path: string) {
        for (let i = path.indexOf('/', 1); i > 0; i = path.indexOf('/', i + 1)) { this.folders.add(path.slice(0, i)); }
    }
    tree(): RemoteTree {
        const files = new Map<string, RemoteFile>();
        this.docs.forEach((_text, path) => files.set(path, { kind: 'doc', id: `doc:${path}` }));
        this.files.forEach((content, path) => files.set(path, {
            kind: 'file', id: `file:${path}`, hash: this.noHash.has(path) ? undefined : gitBlobHash(content),
        }));
        return { files, folders: new Map([...this.folders].map(path => [path, `folder:${path}`])) };
    }
    async text(path: string) {
        this.reads.push(path);
        const text = this.docs.get(path);
        if (text === undefined) { throw new Error(`no document ${path}`); }
        return text;
    }
}

async function plan(local: Record<string, string | Uint8Array>, copy: Project, shared: Project,
                    options: { mirror?: boolean, keep?: (path: string) => boolean } = {}) {
    const files = new Map(Object.entries(local).map(([path, content]) => [path, localFile(content)]));
    return planSync(files, copy.tree(), shared.tree(), { mirror: options.mirror ?? false, keep: options.keep ?? (() => false) }, {
        copy: (path) => copy.text(path),
        shared: (path) => shared.text(path),
    });
}

describe('sandbox plan', () => {
    it('uploads only the local files that differ from the copy', async () => {
        const shared = new Project().doc('/main.tex', 'old').file('/autoindex.pl', 'v1').file('/slike/a.jpg', 'jpeg');
        const copy = new Project().doc('/main.tex', 'old').file('/autoindex.pl', 'v1').file('/slike/a.jpg', 'jpeg');
        const result = await plan({ '/main.tex': 'new', '/autoindex.pl': 'v1' }, copy, shared);
        assert.deepStrictEqual(result.uploads, [{ path: '/main.tex', from: 'local', reason: 'differs' }]);
        assert.deepStrictEqual(result.unchanged, { local: ['/autoindex.pl'], shared: ['/slike/a.jpg'] });
        assert.deepStrictEqual(result.deletions, []);
        assert.deepStrictEqual(result.problems, []);
    });

    it('compares binary files by hash without reading them, and documents by text', async () => {
        const shared = new Project().file('/a.png', 'png').doc('/b.tex', 'b');
        const copy = new Project().file('/a.png', 'png').doc('/b.tex', 'b');
        const result = await plan({ '/a.png': 'png', '/b.tex': 'b' }, copy, shared);
        assert.deepStrictEqual(result.uploads, []);
        assert.deepStrictEqual(copy.reads, ['/b.tex']);
        assert.deepStrictEqual(shared.reads, []);
    });

    it('takes a document as unchanged when only its line endings differ, as Overleaf stores "\\n"', async () => {
        const copy = new Project().doc('/main.tex', 'a\nb\n');
        const result = await plan({ '/main.tex': 'a\r\nb\r\n' }, copy, copy);
        assert.deepStrictEqual(result.uploads, []);
    });

    it('uploads a file the copy does not have, after creating its folders, outermost first', async () => {
        const project = new Project().doc('/main.tex', 'x');
        const result = await plan({ '/main.tex': 'x', '/fig/new/b.png': 'b', '/fig/a.png': 'a' }, project, project);
        assert.deepStrictEqual(result.uploads.map(u => [u.path, u.reason]), [['/fig/a.png', 'missing'], ['/fig/new/b.png', 'missing']]);
        assert.deepStrictEqual(result.folders, ['/fig', '/fig/new']);
    });

    it('deletes what only the copy has: an earlier run uploaded it', async () => {
        const shared = new Project().doc('/main.tex', 'x');
        const copy = new Project().doc('/main.tex', 'x').doc('/extra.tex', 'from another run').file('/old.pl', 'p');
        const result = await plan({ '/main.tex': 'x' }, copy, shared);
        assert.deepStrictEqual(result.deletions.map(d => [d.path, d.kind, d.id]), [['/extra.tex', 'doc', 'doc:/extra.tex'], ['/old.pl', 'file', 'file:/old.pl']]);
    });

    it('takes what the directory lacks from the shared project, also over an earlier run\'s version', async () => {
        const shared = new Project().doc('/main.tex', 'x').doc('/latexmkrc', 'shared rc').file('/slike/a.jpg', 'new photo').file('/slike/b.jpg', 'b');
        const copy = new Project().doc('/main.tex', 'x').doc('/latexmkrc', 'rc of an earlier run').file('/slike/a.jpg', 'old photo');
        const result = await plan({ '/main.tex': 'x' }, copy, shared);
        assert.deepStrictEqual(result.uploads, [
            { path: '/latexmkrc', from: 'shared', reason: 'differs' },
            { path: '/slike/a.jpg', from: 'shared', reason: 'differs' },
            { path: '/slike/b.jpg', from: 'shared', reason: 'missing' },
        ]);
        assert.deepStrictEqual(result.unchanged.local, ['/main.tex']);
    });

    it('with mirror, deletes the shared project\'s files that the directory lacks, except the kept ones', async () => {
        const shared = new Project().doc('/main.tex', 'x').doc('/old.ist', 'removed by the version').file('/slike/a.jpg', 'a');
        const copy = new Project().doc('/main.tex', 'x').doc('/old.ist', 'removed by the version').file('/slike/a.jpg', 'a');
        const result = await plan({ '/main.tex': 'x' }, copy, shared, { mirror: true, keep: path => path.startsWith('/slike/') });
        assert.deepStrictEqual(result.deletions.map(d => d.path), ['/old.ist']);
        assert.deepStrictEqual(result.unchanged.shared, ['/slike/a.jpg']);
    });

    it('uploads a file whose entry carries no hash, since it cannot tell', async () => {
        const project = new Project().file('/a.png', 'png');
        project.noHash.add('/a.png');
        const result = await plan({ '/a.png': 'png' }, project, project);
        assert.deepStrictEqual(result.uploads, [{ path: '/a.png', from: 'local', reason: 'differs' }]);
    });

    it('replaces a document with the local file when the local file cannot be a document', async () => {
        const project = new Project().doc('/data.txt', 'text');
        const result = await plan({ '/data.txt': new Uint8Array([0x74, 0x00, 0x78]) }, project, project);
        assert.deepStrictEqual(result.uploads, [{ path: '/data.txt', from: 'local', reason: 'differs' }]);
    });

    it('reports a path that is a folder in the copy, or that needs a folder where the copy has a file', async () => {
        const copy = new Project().file('/fig', 'a file named fig').file('/x/y.png', 'y');
        const result = await plan({ '/fig/a.png': 'a', '/x': 'a file named x' }, copy, new Project());
        assert.deepStrictEqual(result.problems.map(p => p.path).sort(), ['/fig/a.png', '/x']);
    });

    it('reports a document whose text cannot be read, instead of guessing', async () => {
        const copy = new Project().doc('/main.tex', 'x');
        copy.text = async () => { throw new Error('HTTP 500'); };
        const result = await plan({ '/main.tex': 'x' }, copy, copy);
        assert.deepStrictEqual(result.problems.map(p => p.path), ['/main.tex']);
        assert.match(result.problems[0].message, /HTTP 500/);
    });
});

describe('overleafText', () => {
    it('decodes UTF-8, UTF-16LE after a byte order mark, and Latin-1 otherwise', () => {
        assert.strictEqual(overleafText(enc('čćž')), 'čćž');
        assert.strictEqual(overleafText(new Uint8Array([0xff, 0xfe, 0x41, 0x00])), '﻿A');
        assert.strictEqual(overleafText(new Uint8Array([0xe8, 0x0a])), 'è\n');
    });

    it('turns every line ending into "\\n"', () => {
        assert.strictEqual(overleafText(enc('a\r\nb\rc\n')), 'a\nb\nc\n');
    });

    it('says a file cannot be a document for NUL, characters outside the BMP, and too much text', () => {
        assert.strictEqual(overleafText(new Uint8Array([0x61, 0x00])), undefined);
        assert.strictEqual(overleafText(enc('emoji 😀')), undefined);
        assert.strictEqual(overleafText(enc('a'.repeat(MAX_DOC_LENGTH))), undefined);
        assert.strictEqual(overleafText(enc('a'.repeat(MAX_DOC_LENGTH - 1)))?.length, MAX_DOC_LENGTH - 1);
    });
});
