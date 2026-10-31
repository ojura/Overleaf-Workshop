/**
 * A project's state at a version of its Overleaf history: the list of files at that version,
 * the text of documents, and the content of binary files from the version's zip. The
 * requests only read; Overleaf answers them with HTTP 429 when they come too fast, so they
 * are spaced and repeated after a pause.
 */
import * as zlib from 'zlib';
import { BaseAPI, Identity, ProjectHistoryResponseSchema, ResponseSchema } from '../api/base';
import { Entry, FlatTree, Repo } from './plumbing';

/** One entry of the project's tree at a version. */
export interface VersionEntry { pathname: string; editable: boolean; }

/** A change of the file tree between two versions. */
export interface TreeChange { pathname: string; newPathname?: string; operation?: 'edited' | 'added' | 'removed' | 'renamed'; }

/** One history update: the versions it spans and when it ended (milliseconds). */
export interface HistoryUpdate { fromV: number; toV: number; endTs: number; }

/** What the tools read from a project's history. */
export interface HistorySource {
    /** updates, newest first, before `before` (a timestamp in milliseconds), with the timestamp to ask for the next page */
    updates(before?: number): Promise<{ updates: HistoryUpdate[], next?: number }>;
    /** the files at `version` */
    treeAt(version: number): Promise<VersionEntry[]>;
    /** the file-tree changes between two versions */
    treeChanges(from: number, to: number): Promise<TreeChange[]>;
    /** a document's text at `version`, or 'binary' for a binary file */
    docAt(pathname: string, version: number): Promise<string | 'binary'>;
    /** the project at `version` as a zip */
    zipAt(version: number): Promise<Buffer>;
}

/** Waits between requests and repeats the ones Overleaf refuses with HTTP 429. */
export class Pacer {
    private last = 0;
    constructor(readonly intervalMs = 1200, readonly pausesMs = [15000, 30000, 60000, 120000],
                readonly log: (message: string) => void = () => {}, readonly sleep = (ms: number) => new Promise(r => setTimeout(r, ms))) {}

    async call<T>(what: string, request: () => Promise<ResponseSchema>, pick: (res: ResponseSchema) => T): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            const wait = this.last + this.intervalMs - Date.now();
            if (wait > 0) { await this.sleep(wait); }
            this.last = Date.now();
            const res = await request();
            if (res.type === 'success') { return pick(res); }
            if (/^429\b/.test(res.message ?? '') && attempt < this.pausesMs.length) {
                this.log(`Overleaf answered ${what} with HTTP 429 (too many requests); asking again in ${this.pausesMs[attempt] / 1000} s`);
                await this.sleep(this.pausesMs[attempt]);
                continue;
            }
            throw new Error(`${what} failed: ${res.message}`);
        }
    }
}

class HistoryAPI extends BaseAPI {
    async getUpdates(identity: Identity, projectId: string, before?: number) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/updates?min_count=25${before ? `&before=${before}` : ''}`, undefined,
                            (res) => ({ updates: JSON.parse(res!) }));
    }
    async getTreeDiff(identity: Identity, projectId: string, from: number, to: number) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/filetree/diff?from=${from}&to=${to}`, undefined,
                            (res) => ({ treeDiff: JSON.parse(res!) }));
    }
    async getDocDiff(identity: Identity, projectId: string, pathname: string, from: number, to: number) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/diff?pathname=${encodeURIComponent(pathname)}&from=${from}&to=${to}`, undefined,
                            (res) => ({ diff: JSON.parse(res!) }));
    }
}

/** The history of `projectId` on an Overleaf server, with a login. */
export class OverleafHistory implements HistorySource {
    private readonly api: HistoryAPI;
    constructor(url: string, private readonly identity: Identity, readonly projectId: string, readonly pacer = new Pacer()) {
        this.api = new HistoryAPI(url);
    }

    async updates(before?: number) {
        const answer = await this.pacer.call('the history updates', () => this.api.getUpdates(this.identity, this.projectId, before), res => (res as any).updates);
        return {
            updates: (answer.updates as ProjectHistoryResponseSchema[]).map(u => ({ fromV: u.fromV, toV: u.toV, endTs: u.meta.end_ts })),
            next: answer.nextBeforeTimestamp as number | undefined,
        };
    }

    async treeAt(version: number) {
        const diff = await this.pacer.call(`the file tree at version ${version}`, () => this.api.getTreeDiff(this.identity, this.projectId, version, version), res => res.treeDiff!.diff);
        return diff.map(e => ({ pathname: e.pathname, editable: (e as any).editable !== false }));
    }

    async treeChanges(from: number, to: number) {
        const diff = await this.pacer.call(`the file-tree changes from version ${from} to ${to}`, () => this.api.getTreeDiff(this.identity, this.projectId, from, to), res => res.treeDiff!.diff);
        return diff.filter(e => e.operation).map(e => ({ pathname: e.pathname, newPathname: e.newPathname, operation: e.operation }));
    }

    async docAt(pathname: string, version: number): Promise<string | 'binary'> {
        const diff: any = await this.pacer.call(`${pathname} at version ${version}`, () => this.api.getDocDiff(this.identity, this.projectId, pathname, version, version), res => res.diff!.diff);
        if (diff && !Array.isArray(diff) && diff.binary) { return 'binary'; }
        // from a version to itself, every part is unchanged text ("u")
        return (diff as Array<{ u?: string, i?: string, d?: string }>).map(part => part.u ?? part.i ?? '').join('');
    }

    async zipAt(version: number) {
        const res = await this.pacer.call(`the project's zip at version ${version}`, () => this.api.downloadZipOfVersion(this.identity, this.projectId, version), r => r.content!);
        return Buffer.from(res);
    }
}

/**
 * The files of a zip archive, by name. Handles stored and deflated entries, as Overleaf's
 * version zips have them; folders are skipped.
 */
export function readZip(zip: Buffer): Map<string, Buffer> {
    // the end of central directory record: signature 0x06054b50, at most 64 kB of comment after it
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) { throw new Error('not a zip archive: no end of central directory'); }
    const count = zip.readUInt16LE(eocd + 10);
    let offset = zip.readUInt32LE(eocd + 16);
    if (count === 0xffff || offset === 0xffffffff) { throw new Error('the zip archive needs ZIP64, which this reader does not read'); }
    const files = new Map<string, Buffer>();
    for (let n = 0; n < count; n++) {
        if (zip.readUInt32LE(offset) !== 0x02014b50) { throw new Error(`the zip's central directory is damaged at entry ${n}`); }
        const method = zip.readUInt16LE(offset + 10);
        const compressedSize = zip.readUInt32LE(offset + 20);
        const nameLength = zip.readUInt16LE(offset + 28), extraLength = zip.readUInt16LE(offset + 30), commentLength = zip.readUInt16LE(offset + 32);
        const local = zip.readUInt32LE(offset + 42);
        const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
        offset += 46 + nameLength + extraLength + commentLength;
        if (name.endsWith('/')) { continue; }
        if (zip.readUInt32LE(local) !== 0x04034b50) { throw new Error(`the zip's entry ${name} is damaged`); }
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const data = zip.subarray(start, start + compressedSize);
        if (method === 0) { files.set(name, Buffer.from(data)); }
        else if (method === 8) { files.set(name, zlib.inflateRawSync(data)); }
        else { throw new Error(`the zip's entry ${name} uses compression method ${method}, which this reader does not read`); }
    }
    return files;
}

/** The text of a document as git stores it: its UTF-8 bytes. */
const docBytes = (text: string) => Buffer.from(text, 'utf8');

/**
 * The history update after which the project was in the state of a git-bridge commit dated
 * `seconds`: the bridge dates a commit at the project's last change it holds, in whole
 * seconds, so it is the newest update that ended in or before that second.
 */
export async function versionAtTime(source: HistorySource, seconds: number): Promise<HistoryUpdate> {
    for (let before: number | undefined, pages = 0; pages < 200; pages++) {
        const { updates, next } = await source.updates(before);
        const match = updates.find(u => Math.floor(u.endTs / 1000) <= seconds);
        if (match) { return match; }
        if (!next) { break; }
        before = next;
    }
    throw new Error(`the project's history has no update before ${new Date(seconds * 1000).toISOString()}`);
}

/**
 * The history update that contains `version`, ending there: with toV set to `version` when
 * the version lies inside an update, and that update's end as its time.
 */
export async function updateForVersion(source: HistorySource, version: number): Promise<HistoryUpdate> {
    for (let before: number | undefined, pages = 0; pages < 400; pages++) {
        const { updates, next } = await source.updates(before);
        const match = updates.find(u => u.toV === version || (u.fromV < version && version < u.toV));
        if (match) { return { ...match, toV: version }; }
        if (updates.length && updates[updates.length - 1].toV < version) { break; }
        if (!next) { break; }
        before = next;
    }
    throw new Error(`the project's history has no version ${version}`);
}

/** Whether the files of `files` (path to content) are exactly the project's at `version`. */
export async function filesMatchVersion(source: HistorySource, version: number, files: Map<string, Buffer>, log: (m: string) => void = () => {}): Promise<{ match: boolean, differing: string[] }> {
    const atV = new Map((await source.treeAt(version)).map(e => [e.pathname, e]));
    const differing: string[] = [];
    let zip: Map<string, Buffer> | undefined;
    for (const [pathname, content] of files) {
        const entry = atV.get(pathname);
        if (!entry) { differing.push(pathname); continue; }
        let at: Buffer;
        if (entry.editable) {
            const text = await source.docAt(pathname, version);
            if (text === 'binary') {
                zip ??= readZip(await source.zipAt(version));
                at = zip.get(pathname) ?? Buffer.alloc(0);
            } else {
                at = docBytes(text);
            }
        } else {
            zip ??= readZip(await source.zipAt(version));
            at = zip.get(pathname) ?? Buffer.alloc(0);
        }
        if (!at.equals(content)) { differing.push(pathname); }
    }
    if (differing.length) { log(`version ${version}: ${differing.length} of ${files.size} files differ (${differing.slice(0, 5).join(', ')}${differing.length > 5 ? ', ...' : ''})`); }
    return { match: differing.length === 0, differing };
}

/**
 * The version of the project at which `files` were taken: the version current at `seconds`
 * when its files match, else the nearest one that matches, looking at up to `limit` updates
 * on each side.
 */
export async function findStartVersion(source: HistorySource, files: Map<string, Buffer>, seconds: number,
                                       log: (m: string) => void = () => {}, limit = 12): Promise<HistoryUpdate> {
    // the updates around `seconds`, newest first
    const around: HistoryUpdate[] = [];
    let pivot = -1;
    for (let before: number | undefined, pages = 0; pages < 200; pages++) {
        const { updates, next } = await source.updates(before);
        around.push(...updates);
        if (pivot < 0) { pivot = around.findIndex(u => Math.floor(u.endTs / 1000) <= seconds); }
        if (pivot >= 0 && around.length > pivot + limit) { break; }
        if (!next) { break; }
        before = next;
    }
    if (pivot < 0) { throw new Error(`the project's history has no update before ${new Date(seconds * 1000).toISOString()}`); }
    const order = [pivot];
    for (let d = 1; d <= limit; d++) {
        if (pivot + d < around.length) { order.push(pivot + d); }
        if (pivot - d >= 0) { order.push(pivot - d); }
    }
    for (const i of order) {
        const update = around[i];
        log(`checking version ${update.toV} (${new Date(update.endTs).toISOString()})`);
        if ((await filesMatchVersion(source, update.toV, files, log)).match) { return update; }
    }
    throw new Error(`none of the ${order.length} versions around ${new Date(seconds * 1000).toISOString()} has these files; name the version with --start-version`);
}

/**
 * The project's whole tree at `version`, as a flat git tree. Files that the history lists as
 * unchanged between `version` and `headVersion` are taken from `headTree` (the git bridge's
 * tree at `headVersion`); documents that changed are read at `version`, and binary files
 * that changed come from the version's zip, which is downloaded only then.
 */
export async function treeAtVersion(source: HistorySource, repo: Repo, version: number, headVersion: number, headTree: FlatTree,
                                    log: (m: string) => void = () => {}): Promise<{ tree: FlatTree, read: string[], fromZip: string[] }> {
    const atV = await source.treeAt(version);
    const changes = version === headVersion ? [] : await source.treeChanges(version, headVersion);
    const changed = new Set<string>();
    for (const c of changes) { changed.add(c.pathname); if (c.newPathname) { changed.add(c.newPathname); } }
    const tree: FlatTree = new Map();
    const read: string[] = [], fromZip: string[] = [];
    const needZip: string[] = [];
    for (const entry of atV) {
        const head = headTree.get(entry.pathname);
        if (head && !changed.has(entry.pathname)) { tree.set(entry.pathname, head); continue; }
        if (entry.editable) {
            const text = await source.docAt(entry.pathname, version);
            if (text !== 'binary') {
                tree.set(entry.pathname, { mode: '100644', oid: repo.blob(docBytes(text)) });
                read.push(entry.pathname);
                continue;
            }
        }
        needZip.push(entry.pathname);
    }
    if (needZip.length) {
        log(`${needZip.length} binary files changed after version ${version}; downloading the project's zip at that version`);
        const zip = readZip(await source.zipAt(version));
        for (const p of needZip) {
            const content = zip.get(p);
            if (!content) { throw new Error(`the zip of version ${version} has no ${p}, which the history lists at that version`); }
            const entry: Entry = { mode: '100644', oid: repo.blob(content) };
            tree.set(p, entry);
            fromZip.push(p);
        }
    }
    return { tree, read, fromZip };
}
