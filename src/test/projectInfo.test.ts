/* eslint-disable @typescript-eslint/naming-convention -- Overleaf's field names */
import * as assert from 'assert';
import Module = require('module');
import { editorPageMeta, newerImages, offeredImages } from '../api/editorPage';
import { OverleafClient } from '../sandbox/client';
import { formatProjectInfo, gatherProjectInfo } from '../sandbox/projectInfo';

/**
 * A stand-in for socket.io-client, so that project-info reads through OverleafClient.readProject,
 * the reader push-check uses: it answers joinProject with `served.project`, and joinDoc with
 * `served.lines` and `served.ranges` of the document, as overleaf.com sends them.
 */
const served: { project?: any, lines: Record<string, string[]>, ranges: Record<string, any>, emitted: string[] } = { lines: {}, ranges: {}, emitted: [] };
const fakeIo = {
    connect: () => {
        const handlers: Record<string, (...args: any[]) => void> = {};
        const socket = {
            on: (event: string, handler: (...args: any[]) => void) => {
                handlers[event] = handler;
                if (event === 'joinProjectResponse') { setImmediate(() => handler({ project: served.project, permissionsLevel: 'owner' })); }
            },
            emit: (event: string, ...args: any[]) => {
                served.emitted.push(`${event} ${args[0]}`);
                const callback = args[args.length - 1];
                if (event === 'joinDoc') { setImmediate(() => callback(null, served.lines[args[0]] ?? [], 1, [], served.ranges[args[0]] ?? {})); }
                if (event === 'leaveDoc') { setImmediate(() => callback(null)); }
            },
            disconnect: () => {},
            removeAllListeners: () => {},
        };
        return socket;
    },
};
const moduleAny = Module as any;
const originalLoad = moduleAny._load;
before(() => {
    moduleAny._load = function (request: string, ...rest: any[]) {
        return request === 'socket.io-client' ? fakeIo : originalLoad.call(this, request, ...rest);
    };
});
after(() => { moduleAny._load = originalLoad; });

describe('project info', () => {
    const imageNames = [
        { imageName: 'texlive-full:2026.1', imageDesc: '2026', hasCheckpointing: true, allowed: true },
        { imageName: 'texlive-full:2025.1', imageDesc: '2025', hasCheckpointing: true, allowed: true },
        { imageName: 'texlive-full:2024.1', imageDesc: '2024', allowed: true },
        { imageName: 'texlive-full:rolling', imageDesc: 'Rolling TeXLive (Labs)', rolling: true, monthlyExperimental: true, allowed: false },
        // not offered by Overleaf today: a rolling image with a version number, which newerImages must skip too
        { imageName: 'texlive-full:2027.0', imageDesc: 'rolling, numbered', rolling: true, allowed: true },
    ];
    const page = `<meta name="ol-imageNames" data-type="json" content="${JSON.stringify(imageNames).replace(/"/g, '&quot;')}">`
               + '<meta name="ol-gitBridgePublicBaseUrl" content="https://git.example.org">';

    /** An OverleafClient that reads the stand-in project; only its HTTP readings are replaced. */
    function source(over: Partial<{ imageName: string, trackChangesState: unknown, page: string }> = {}): OverleafClient {
        served.project = {
            _id: 'p'.repeat(24), name: 'Book', compiler: 'pdflatex', imageName: over.imageName ?? 'texlive-full:2025.1', rootDoc_id: 'd1',
            owner: { _id: 'u1', first_name: 'Owner', email: 'owner@example.org' },
            members: [{ _id: 'u2', first_name: 'Ana', last_name: 'B', email: 'ana@example.org', privileges: 'readAndWrite', source: 'invite' },
                      { _id: 'u3', first_name: 'Iva', email: 'iva@example.org', privileges: 'readOnly', source: 'token' }],
            invites: [], editAccessRequests: [], publicAccesLevel: 'tokenBased', trackChangesState: over.trackChangesState ?? { u2: true },
            features: { gitBridge: true, compileTimeout: 240 },
            rootFolder: [{ _id: 'f0', name: 'rootFolder', docs: [{ _id: 'd1', name: 'main.tex' }], fileRefs: [], folders: [{ _id: 'f1', name: 'ch', docs: [{ _id: 'd2', name: 'one.tex' }], fileRefs: [], folders: [] }] }],
        };
        // joinDoc packs each line's UTF-8 bytes into Latin-1 characters
        served.lines = { d1: [Buffer.from('Čitanje abc z', 'utf8').toString('latin1')], d2: ['x'] };
        served.ranges = {
            d1: { comments: [{ id: 'c1', op: { c: 'i', p: 1, t: 'th1' } }], changes: [{ id: 'ch1', op: { i: 'abc', p: 8 }, metadata: { user_id: 'u2' } }, { id: 'ch2', op: { d: 'z', p: 12 }, metadata: { user_id: 'u2' } }] },
            d2: {},
        };
        served.emitted = [];
        const client = new OverleafClient('https://www.overleaf.com/', { cookies: 'c=1', csrfToken: 'x' });
        client.commentThreads = async () => ({ th1: { resolved: true }, th2: {} });
        client.gitTokens = async () => [];
        client.editorPage = async () => over.page ?? page;
        return client;
    }

    it('reads the documents through readProject, the reader push-check uses, on one connection', async () => {
        const client = source();
        const { ranges } = await client.readProject('p'.repeat(24));
        assert.strictEqual(ranges.docs[0].text, 'Čitanje abc z');
        served.emitted = [];
        await gatherProjectInfo(client, 'p'.repeat(24), {});
        assert.deepStrictEqual(served.emitted, ['joinDoc d1', 'leaveDoc d1', 'joinDoc d2', 'leaveDoc d2']);
    });

    it('names the compiler, the main document and the image, and says plainly that a newer image is offered', async () => {
        const info = await gatherProjectInfo(source(), 'p'.repeat(24), {});
        assert.strictEqual(info.tex.mainDocument, 'main.tex');
        assert.deepStrictEqual(info.tex.newer.map(image => image.imageName), ['texlive-full:2026.1']);
        const text = formatProjectInfo(info);
        assert.match(text, /compiler: pdflatex; main document: main\.tex; TeX Live image: texlive-full:2025\.1/);
        assert.match(text, /Overleaf offers a NEWER image than the project's texlive-full:2025\.1: texlive-full:2026\.1 \(2026, checkpointing\)/);
    });

    it('says so when the project has the newest image, and skips the rolling one', async () => {
        const info = await gatherProjectInfo(source({ imageName: 'texlive-full:2026.1' }), 'p'.repeat(24), {});
        assert.deepStrictEqual(info.tex.newer, []);
        assert.match(formatProjectInfo(info), /the project's texlive-full:2026\.1 is the newest image Overleaf offers for it/);
    });

    it('counts comments and tracked changes per document, and resolved threads', async () => {
        const info = await gatherProjectInfo(source(), 'p'.repeat(24), {});
        assert.deepStrictEqual(info.documents.map(doc => [doc.path, doc.comments, doc.insertions, doc.deletions]), [['main.tex', 1, 1, 1], ['ch/one.tex', 0, 0, 0]]);
        assert.deepStrictEqual(info.threads, { total: 2, resolved: 1 });
        const text = formatProjectInfo(info);
        assert.match(text, /1 comment in 2 threads \(1 resolved\), 2 tracked changes \(1 insertion, 1 deletion\)/);
        assert.match(text, /main\.tex: 1 comment, 2 tracked changes \(by Ana B 2\)/);
        assert.match(text, /track changes: on for Ana B; off for everyone else/);
    });

    it('names a user with track changes on who is no longer a member', async () => {
        const info = await gatherProjectInfo(source({ trackChangesState: { u2: true, ['f'.repeat(24)]: true } }), 'p'.repeat(24), {});
        assert.match(formatProjectInfo(info), new RegExp(`track changes: on for Ana B, user ${'f'.repeat(24)}, not a member of the project now; off for everyone else`));
    });

    it('reports track changes on for everyone', async () => {
        const info = await gatherProjectInfo(source({ trackChangesState: true }), 'p'.repeat(24), {});
        assert.match(formatProjectInfo(info), /track changes: on for everyone/);
    });

    it('takes the git bridge from the editor page when the server is not a known one', async () => {
        const info = await gatherProjectInfo(source(), 'p'.repeat(24), {});
        assert.strictEqual(info.git.projectUrl, `https://git.example.org/${'p'.repeat(24)}`);
        assert.strictEqual(info.git.available, true);
        assert.match(formatProjectInfo(info), /git token: none stored/);
    });

    it('says why it could not read the offered images or the comment threads, with the cause that fetch reports', async () => {
        const client = source();
        // what Node's fetch throws when it cannot reach the server: the reason is in the cause
        const fetchFailure = () => Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 127.0.0.1:443') });
        client.editorPage = async () => { throw fetchFailure(); };
        client.commentThreads = async () => { throw fetchFailure(); };
        const text = formatProjectInfo(await gatherProjectInfo(client, 'p'.repeat(24), {}));
        assert.match(text, /^TeX Live images offered: unknown \(fetch failed: connect ECONNREFUSED 127\.0\.0\.1:443\)$/m);
        assert.match(text, /\(threads: fetch failed: connect ECONNREFUSED 127\.0\.0\.1:443\)/);
    });

    it('reads the offered images from the page', () => {
        const meta = editorPageMeta(page);
        assert.deepStrictEqual(offeredImages(meta).map(image => image.imageName), imageNames.map(image => image.imageName));
        assert.deepStrictEqual(newerImages('texlive-full:2024.1', offeredImages(meta)).map(image => image.imageName), ['texlive-full:2026.1', 'texlive-full:2025.1']);
    });
});
