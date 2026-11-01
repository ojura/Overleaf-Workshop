/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
// One extension host for the local replica's tests: the local folder on disk, a project in
// memory, a stand-in for the 'vscode' module, and the replica's modules loaded against it.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { loadWithVscode } from './standIn';

/** Stands in for anything else: callable, constructible, and every member is one again. */
export function stub(): any {
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
export const withStubs = (target: any): any => new Proxy(target, { get: (t, key) => (key in t ? t[key] : stub()) });

export class Uri {
    constructor(public readonly scheme: string, public readonly path: string, public readonly authority = '', public readonly query = '') {}
    get fsPath() { return this.path; }
    toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`; }
    static file(p: string) { return new Uri('file', p); }
    static joinPath(base: Uri, ...parts: string[]) { return new Uri(base.scheme, path.posix.join(base.path, ...parts), base.authority, base.query); }
}

export class Emitter<T> {
    private listeners: ((value: T) => void)[] = [];
    event = (listener: (value: T) => void) => {
        this.listeners.push(listener);
        return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire(value: T) { this.listeners.forEach(listener => listener(value)); }
    dispose() { this.listeners = []; }
}

export const FileType = { File: 1, Directory: 2, SymbolicLink: 64 };
export const FileChangeType = { Changed: 1, Created: 2, Deleted: 3 };

/**
 * One extension host: the local folder on disk, a project in memory, the IDE's watchers recorded.
 * With `windowFrozen`, every call of the IDE's vscode.workspace.fs never settles, as in the real
 * IDE while the window's page is frozen: each of those calls first waits for the window.
 */
export function world(folder: string, syncOnFileChange: boolean, options: { windowFrozen?: boolean } = {}) {
    const w = {
        remote: new Map<string, string>(),
        remoteFolders: new Set<string>(),
        remoteWrites: [] as string[],
        ideWatchers: [] as any[],
        /** the project's history, newest first, as the history's updates request answers */
        updates: [] as any[],
    };
    const fsApi = {
        stat: async (uri: Uri) => {
            const stat = await fs.promises.stat(uri.fsPath);
            return { type: stat.isDirectory() ? FileType.Directory : FileType.File, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
        },
        readFile: async (uri: Uri) => new Uint8Array(await fs.promises.readFile(uri.fsPath)),
        // the IDE's writeFile creates the parent folders
        writeFile: async (uri: Uri, content: Uint8Array) => {
            await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
            await fs.promises.writeFile(uri.fsPath, content);
        },
        readDirectory: async (uri: Uri) => (await fs.promises.readdir(uri.fsPath, { withFileTypes: true }))
            .map(e => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]),
        createDirectory: async (uri: Uri) => { await fs.promises.mkdir(uri.fsPath, { recursive: true }); },
        delete: async (uri: Uri) => { await fs.promises.rm(uri.fsPath, { recursive: true, force: true }); },
        rename: async (from: Uri, to: Uri) => { await fs.promises.rename(from.fsPath, to.fsPath); },
    };
    const ideFs: any = options.windowFrozen
        ? Object.fromEntries(Object.keys(fsApi).map(key => [key, () => new Promise(() => { /* the window does not answer */ })]))
        : fsApi;
    const mock = withStubs({
        Uri,
        Disposable: class { dispose() {} },
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
        TreeItem: class {},
        ThemeIcon: class { constructor(public id: string) {} },
        RelativePattern: class { constructor(public base: any, public pattern: string) {} },
        FileType,
        FileChangeType,
        ProgressLocation: { Notification: 15 },
        l10n: { t: (message: string, args?: any) => message.replace(/\{(\w+)\}/g, (_m, k) => String(args?.[k])) },
        window: withStubs({
            withProgress: (_options: any, task: any) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested() {} }),
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            showErrorMessage: async () => undefined,
            setStatusBarMessage: () => ({ dispose() {} }),
        }),
        workspace: withStubs({
            fs: ideFs,
            getConfiguration: (section: string) => ({
                get: (key: string, value: any) => section === 'overleaf-workshop.localReplica.syncOnFileChange' && key === 'enabled' ? syncOnFileChange : value,
            }),
            createFileSystemWatcher: (pattern: any) => {
                w.ideWatchers.push(pattern);
                return { onDidChange: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} };
            },
            onDidSaveTextDocument: () => ({ dispose() {} }),
            textDocuments: [],
        }),
    });

    // the project: documents only, enough for the replica's Overleaf side
    // the project's files, addressed as the extension addresses them
    const origin = new Uri('overleaf-workshop', '/project', 'www.overleaf.com', 'user=u&project=p');
    const changes = new Emitter<{ type: number, uri: Uri, renamedFrom?: Uri }[]>();
    const rel = (uri: Uri) => uri.path.slice(origin.path.length);
    const vfs = {
        origin, serverName: 'www.overleaf.com', projectName: 'project', projectId: 'p', connected: true, _userId: 'u',
        onDidChangeFiles: changes.event,
        pathToUri: (...parts: string[]) => Uri.joinPath(origin, ...parts),
        getProjectSCMPersist: () => ({ settings: {} }),
        setProjectSCMPersist: () => {},
        init: async () => ({ rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [...w.remote.keys()].map(p => ({ _id: p, name: p.slice(1) })), fileRefs: [], folders: [] }] }),
        _resolveUri: async (uri: Uri) => w.remote.has(rel(uri)) ? { fileType: 'doc', fileEntity: {} }
            : w.remoteFolders.has(rel(uri)) ? { fileType: 'folder', fileEntity: { docs: [], fileRefs: [], folders: [] } }
            : { fileType: undefined, fileEntity: undefined },
        // as Overleaf does: a folder that exists already is refused, and the request takes a moment
        mkdir: async (uri: Uri) => {
            if (w.remoteFolders.has(rel(uri))) { throw new Error(`${uri.path}: 400: file already exists`); }
            await new Promise(resolve => setTimeout(resolve, 20));
            if (w.remoteFolders.has(rel(uri))) { throw new Error(`${uri.path}: 400: file already exists`); }
            w.remoteFolders.add(rel(uri));
        },
        openFile: async (uri: Uri) => new TextEncoder().encode(w.remote.get(rel(uri)) ?? ''),
        writeFile: async (uri: Uri, content: Uint8Array) => { w.remote.set(rel(uri), new TextDecoder().decode(content)); w.remoteWrites.push(rel(uri)); },
        createFile: async (uri: Uri, content: Uint8Array) => {
            w.remote.set(rel(uri), new TextDecoder().decode(content));
            w.remoteWrites.push(rel(uri));
            return { _type: 'doc', _id: rel(uri), name: path.posix.basename(uri.path) };
        },
        remove: async (uri: Uri) => { w.remote.delete(rel(uri)); },
        rename: async (from: Uri, to: Uri) => {
            if (!w.remote.has(rel(from)) || w.remote.has(rel(to))) { return; }
            w.remote.set(rel(to), w.remote.get(rel(from))!);
            w.remote.delete(rel(from));
            // as the project reports a rename: the Created event names where the file was
            changes.fire([{ type: FileChangeType.Deleted, uri: from }, { type: FileChangeType.Created, uri: to, renamedFrom: from }]);
        },
        getUpdates: async () => ({ updates: w.updates, nextBeforeTimestamp: 0 }),
        documentUpdatesSettled: async () => {},
    };
    /** a change on Overleaf, as the project reports it */
    const remoteChange = (p: string, text: string) => {
        w.remote.set(p, text);
        changes.fire([{ type: FileChangeType.Changed, uri: Uri.joinPath(origin, p) }]);
    };
    /** a file deleted on Overleaf, as the project reports it */
    const remoteDelete = (p: string) => {
        w.remote.delete(p);
        changes.fire([{ type: FileChangeType.Deleted, uri: Uri.joinPath(origin, p) }]);
    };
    return { w, mock, vfs, remoteChange, remoteDelete };
}

export function load(mock: any) {
    return loadWithVscode(mock, () => {
        require('../scm/localFolderWatcher').LocalFolderWatcher.quietMs = 50;
        return {
            LocalReplicaSCMProvider: require('../scm/localReplicaSCM').LocalReplicaSCMProvider,
            requestReplica: require('../scm/replicaControl').requestReplica,
        };
    });
}

export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function until(condition: () => boolean, ms = 4000) {
    for (const end = Date.now() + ms; Date.now() < end; await wait(25)) {
        if (condition()) { return; }
    }
    assert.fail('timed out waiting');
}
