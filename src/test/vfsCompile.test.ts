/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import { loadWithVscode } from './standIn';

const identity = { cookies: 'overleaf_session2=s', csrfToken: 't' };

// The VFS compiles incrementally, and clears the output only to compile from scratch.

function stub(): any {
    const f: any = function () { return stub(); };
    return new Proxy(f, {
        get(target, key) {
            if (key === 'then') { return undefined; }
            if (!(key in target)) { target[key] = stub(); }
            return target[key];
        },
        construct() { return stub(); },
    });
}
const withStubs = (target: any): any => new Proxy(target, { get: (t, key) => (key in t ? t[key] : stub()) });
const vscodeMock = withStubs({
    Disposable: class { dispose() {} },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    l10n: { t: (message: string) => message },
    workspace: withStubs({ textDocuments: [], getConfiguration: () => ({ get: (_k: string, v: any) => v }) }),
});
const { VirtualFileSystem } = loadWithVscode(vscodeMock, () => require('../core/remoteFileSystemProvider'));

describe('VirtualFileSystem.compile', () => {
    function vfsWith(calls: string[]) {
        const vfs = Object.create(VirtualFileSystem.prototype);
        vfs.root = { rootDoc_id: 'doc1', rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'doc1', name: 'main.tex' }], fileRefs: [], folders: [] }] };
        vfs.isDirty = true;
        vfs.serverName = 'www.overleaf.com';
        vfs.projectId = 'p1';
        vfs.context = { globalState: { get: () => ({ 'www.overleaf.com': { login: { identity } } }) } };
        vfs.notify = () => {};
        vfs.api = {
            deleteAuxFiles: async () => { calls.push('clear the output'); return { type: 'success' }; },
            compile: async (_identity: any, _projectId: string, request: any) => {
                calls.push(`compile ${request.rootResourcePath} (${request.rootDocId})`);
                return { type: 'success', compile: { status: 'failure', outputFiles: [] } };
            },
        };
        return vfs;
    }

    it('keeps the compile output on Overleaf for the first compile of a session', async () => {
        const calls: string[] = [];
        await vfsWith(calls).compile(true);
        assert.deepStrictEqual(calls, ['compile main.tex (doc1)']);
    });

    it('clears the compile output first when it compiles from scratch', async () => {
        const calls: string[] = [];
        await vfsWith(calls).compile(true, false, false, undefined, true);
        assert.deepStrictEqual(calls, ['clear the output', 'compile main.tex (doc1)']);
    });
});
