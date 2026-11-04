import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { BridgeResponse, PdfOutput } from './viewerProtocol';

/** One budget for all generations, content pieces, range blobs, and their manifests. */
export const PDF_DISK_POLICY = {
    defaultMaxBytes: 4096 * 1024 * 1024,
    chunkBytes: 256 * 1024,
    quietMs: 1500,
    paceMs: 250,
    memoryManifests: 128,
    ownerCheckMs: 1000,
} as const;

const HASH = /^[a-f0-9]{64}$/;
const FILE = /^(?:[a-f0-9]{64}|(?:build|object)-[a-f0-9]{64}\.json)$/;
const DATA_TEMP = /^(?:[a-f0-9]{64}|(?:build|object)-[a-f0-9]{64}\.json)\..+\.tmp$/;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const alive = (signal?: AbortSignal) => !signal?.aborted;
async function processStart(pid: number): Promise<string> {
    // Linux supplies a process start tick without reading its arguments or environment.
    const stat = await fs.promises.readFile('/proc/' + pid + '/stat', 'utf8').catch(() => '');
    return stat ? stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '' : '';
}
async function ownerAlive(token: string): Promise<boolean> {
    const [rawPid, start] = token.split(':');
    const pid = Number(rawPid);
    if (!Number.isSafeInteger(pid) || pid <= 0) { return true; }
    try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    const actualStart = await processStart(pid);
    return !start || !/^\d+$/.test(start) || !actualStart || actualStart === start;
}
type Validator = { name: 'etag' | 'last-modified', value: string };
type Part = { start: number, end: number, hash: string, offset: number };
type Piece = { start: number, end: number, hash: string, prefix: Uint8Array };
type Segment = Part | { start: number, end: number, inline: Uint8Array };
interface BuildManifest { version: 1, key: string, size: number, validator?: Validator, parts: Part[] }
interface ObjectManifest { version: 1, hash: string, size: number, parts: Part[] }
interface Layout { key: string, size: number, pieces: Piece[], output: PdfOutput }
interface Entry { size: number, used: number, identity: string }
export interface PdfFillRequest { output: PdfOutput, url: string, start: number, end: number, validator?: Validator, signal: AbortSignal }
export interface PdfDiskOptions {
    fetchRange?: (request: PdfFillRequest) => Promise<BridgeResponse>;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (timer: unknown) => void;
    setWaitTimer?: (callback: () => void, ms: number) => unknown;
    clearWaitTimer?: (timer: unknown) => void;
}
export interface PdfCacheViewer {
    setOutput(output: PdfOutput | undefined): void;
    setActivity(visible: boolean, idle: boolean): void;
    dispose(): void;
}
interface Viewer {
    output?: PdfOutput;
    visible: boolean;
    idle: boolean;
    generation: number;
    order: number;
    stopped: boolean;
}
interface Mutation {
    action?: () => Promise<boolean>;
    signal?: AbortSignal;
    finish(value: boolean): void;
    cancel(): void;
}

/**
 * Actual received bytes live in SHA-256 files. A build is only a small map of byte intervals:
 * it never reserves or truncates a file to the advertised PDF size. Existing pdf-pieces files
 * use this same directory and budget. Completed objects get reusable maps of their small blobs.
 *
 * A short writer lease covers one admission transaction. Reads never acquire it. A separate
 * per-transfer lease serializes background network requests across hosts. Atomic publication
 * and fresh accounting inside every admission keep all generations within the same budget.
 */
export class PdfDiskCache {
    private readonly entries = new Map<string, Entry>();
    private readonly builds = new Map<string, BuildManifest>();
    private readonly objects = new Map<string, ObjectManifest | undefined>();
    private readonly verified = new Set<string>();
    private readonly suspect = new Set<string>();
    private readonly layouts = new WeakMap<PdfOutput, Layout>();
    private readonly viewers = new Set<Viewer>();
    private readonly changes = new Set<() => void>();
    private readonly now: () => number;
    private readonly setTimer: (callback: () => void, ms: number) => unknown;
    private readonly clearTimer: (timer: unknown) => void;
    private readonly setWaitTimer: (callback: () => void, ms: number) => unknown;
    private readonly clearWaitTimer: (timer: unknown) => void;
    private ready?: Promise<void>;
    private watcher?: fs.FSWatcher;
    private dirty = true;
    private serial: Promise<unknown> = Promise.resolve();
    private mutations: Promise<unknown> = Promise.resolve();
    private readonly mutationQueue: Mutation[] = [];
    private mutationRunning = false;
    private activeMutation?: Mutation;
    private readonly waiters = new Map<string, Set<() => void>>();
    private waitTimer?: unknown;
    private bytes = 0;
    private reserved = 0;
    private owner?: string;
    private closed = false;
    private foreground = 0;
    private order = 0;
    private timer?: unknown;
    private filling?: { viewer: Viewer, output: PdfOutput, generation: number, controller: AbortController };
    private fillTask: Promise<void> = Promise.resolve();

    constructor(readonly dir: string, readonly maxBytes: number, private readonly options: PdfDiskOptions = {}) {
        this.maxBytes = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
        this.now = options.now ?? Date.now;
        this.setTimer = options.setTimer ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; });
        this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as NodeJS.Timeout));
        this.setWaitTimer = options.setWaitTimer ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; });
        this.clearWaitTimer = options.clearWaitTimer ?? (timer => clearTimeout(timer as NodeJS.Timeout));
    }

    private async initialize() {
        if (this.closed || !this.maxBytes && !await fs.promises.stat(this.dir).catch(() => undefined)) { return; }
        await fs.promises.mkdir(this.dir, { recursive: true });
        if (this.closed) { return; }
        this.watcher = fs.watch(this.dir, { persistent: false }, (event, filename) => {
            if (this.closed) { return; }
            const name = filename?.toString();
            if (!name || name === '.writer' || name === '.background') { this.wakeWaiters(name); }
            // Immutable data is published/evicted by rename. LRU touches and lock traffic do
            // not invalidate a reader's fast path or restart a completed background viewer.
            if (this.owner || name && (event !== 'rename' || !FILE.test(name))) { return; }
            this.dirty = true;
            for (const viewer of this.viewers) { viewer.stopped = false; }
            this.changed();
            this.schedule(PDF_DISK_POLICY.quietMs);
        });
        this.watcher.on('error', () => { this.dirty = true; this.wakeWaiters(); });
        await this.refresh();
    }

    private async tryLease(name: '.writer' | '.background'): Promise<string | undefined> {
        const lock = path.join(this.dir, name);
        const token = process.pid + ':' + await processStart(process.pid) + ':' + randomUUID();
        const candidate = path.join(this.dir, '.lock-' + name.slice(1) + '-' + randomUUID());
        try {
            await fs.promises.writeFile(candidate, token, { flag: 'wx' });
            for (let attempt = 0; attempt < 2; attempt++) {
                try { await fs.promises.link(candidate, lock); return token; }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
                    const previous = await fs.promises.readFile(lock, 'utf8').catch(() => '');
                    if (!previous) { continue; }
                    if (await ownerAlive(previous) || !await this.reap(lock, previous, candidate)) { return; }
                }
            }
        } finally { await fs.promises.unlink(candidate).catch(() => {}); }
    }

    private async releaseLease(name: '.writer' | '.background', token: string) {
        const lock = path.join(this.dir, name);
        if (await fs.promises.readFile(lock, 'utf8').catch(() => '') === token) {
            await fs.promises.unlink(lock).catch(() => {});
        }
    }

    private wakeWaiters(name?: string) {
        const groups = name ? [this.waiters.get(name)] : [...this.waiters.values()];
        for (const group of groups) { for (const wake of [...(group ?? [])]) { wake(); } }
    }

    private waitForLease(name: string, signal?: AbortSignal) {
        let finish!: () => void;
        const promise = new Promise<void>(resolve => {
            let done = false;
            finish = () => {
                if (done) { return; }
                done = true;
                const group = this.waiters.get(name);
                group?.delete(finish);
                if (!group?.size) { this.waiters.delete(name); }
                signal?.removeEventListener('abort', finish);
                if (!this.waiters.size && this.waitTimer !== undefined) {
                    this.clearWaitTimer(this.waitTimer); this.waitTimer = undefined;
                }
                resolve();
            };
            const group = this.waiters.get(name) ?? new Set<() => void>();
            group.add(finish); this.waiters.set(name, group);
            signal?.addEventListener('abort', finish, { once: true });
            if (this.closed || !alive(signal)) { finish(); return; }
            if (this.waitTimer === undefined) {
                this.waitTimer = this.setWaitTimer(() => {
                    this.waitTimer = undefined;
                    this.wakeWaiters();
                }, PDF_DISK_POLICY.ownerCheckMs);
            }
        });
        return { promise, cancel: () => finish() };
    }

    private async backgroundLease(signal: AbortSignal): Promise<string | undefined> {
        while (!this.closed && alive(signal)) {
            const waiting = this.waitForLease('.background', signal);
            try {
                const token = await this.tryLease('.background');
                if (token) { return token; }
                await waiting.promise;
            } finally { waiting.cancel(); }
        }
    }

    private async refresh(force = false) {
        if (this.closed) { return; }
        if (!force && !this.dirty) { return; }
        this.dirty = false;
        const previous = new Map(this.entries);
        this.entries.clear(); this.bytes = 0; this.builds.clear(); this.objects.clear();
        for (const name of await fs.promises.readdir(this.dir)) {
            if (FILE.test(name)) {
                const stat = await fs.promises.stat(path.join(this.dir, name)).catch(() => undefined);
                if (stat?.isFile()) {
                    const identity = stat.dev + ':' + stat.ino;
                    if (previous.get(name)?.identity !== identity) { this.verified.delete(name); this.suspect.delete(name); }
                    this.entries.set(name, { size: stat.size, used: stat.mtimeMs, identity }); this.bytes += stat.size;
                }
            }
        }
        for (const hash of this.verified) { if (!this.entries.has(hash)) { this.verified.delete(hash); } }
        for (const name of this.suspect) { if (!this.entries.has(name)) { this.suspect.delete(name); } }
    }

    private async cleanOrphans() {
        for (const name of await fs.promises.readdir(this.dir)) {
            const file = path.join(this.dir, name);
            if (DATA_TEMP.test(name)) { await fs.promises.unlink(file).catch(() => {}); }
            else if (/^\.lock-(?:writer|background)-[a-f0-9-]+$|^\.writer-.*\.tmp$|^\.reap-[a-f0-9]{64}-\d+$/.test(name)) {
                const token = await fs.promises.readFile(file, 'utf8').catch(() => '');
                if (token && !await ownerAlive(token)) { await fs.promises.unlink(file).catch(() => {}); }
            }
        }
    }

    private async repairSuspects() {
        for (const name of [...this.suspect]) {
            if (HASH.test(name)) { await this.verify(name); }
            else {
                const parsed = await this.json(name);
                const build = name.startsWith('build-');
                const key = name.slice(build ? 6 : 7, -5);
                let valid = parsed?.version === 1 && (build ? parsed.key : parsed.hash) === key
                    && Number.isSafeInteger(parsed.size) && parsed.size > 0 && this.validParts(parsed.parts, parsed.size)
                    && (!parsed.validator || this.validValidator(parsed.validator));
                if (valid && !build) {
                    const plan = this.plan(parsed.parts, 0, parsed.size);
                    const check = createHash('sha256');
                    valid = !!plan;
                    try { for await (const bytes of this.readPlan(plan ?? [])) { check.update(bytes); } }
                    catch { valid = false; }
                    valid = valid && check.digest('hex') === key;
                }
                if (!valid) { await this.remove(name); }
            }
            this.suspect.delete(name);
        }
    }

    private async reap(lock: string, previous: string, candidate: string): Promise<boolean> {
        // Exactly one live reaper may remove a dead writer. Indexed claims also recover a
        // reaper that crashed, without two windows unlinking a newly acquired writer lock.
        for (let attempt = 0; attempt < 64; attempt++) {
            const claim = path.join(this.dir, '.reap-' + digest(previous) + '-' + attempt);
            try { await fs.promises.link(candidate, claim); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
                const claimant = await fs.promises.readFile(claim, 'utf8').catch(() => '');
                if (await ownerAlive(claimant)) { return false; }
                continue;
            }
            try {
                if (await fs.promises.readFile(lock, 'utf8').catch(() => '') !== previous || await ownerAlive(previous)) { return false; }
                await fs.promises.unlink(lock);
                return true;
            } finally { await fs.promises.unlink(claim).catch(() => {}); }
        }
        return false;
    }

    private run<T>(action: () => Promise<T>): Promise<T> {
        const task = this.serial.then(async () => {
            this.ready ??= this.initialize().catch(() => {});
            await this.ready;
            if (!this.owner) { await this.refresh().catch(() => {}); }
            return action();
        });
        this.serial = task.catch(() => {});
        return task;
    }

    private mutate(action: () => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            let settled = false;
            const entry: Mutation = {
                action, signal,
                finish: value => {
                    if (settled) { return; }
                    settled = true; entry.action = undefined;
                    signal?.removeEventListener('abort', entry.cancel);
                    resolve(value);
                },
                cancel: () => {
                    entry.action = undefined;
                    const index = this.mutationQueue.indexOf(entry);
                    if (index >= 0) { this.mutationQueue.splice(index, 1); }
                    entry.finish(false);
                },
            };
            if (this.closed || !alive(signal)) { entry.cancel(); return; }
            signal?.addEventListener('abort', entry.cancel, { once: true });
            this.mutationQueue.push(entry);
            this.pumpMutations();
        });
    }

    private pumpMutations() {
        if (this.mutationRunning) { return; }
        this.mutationRunning = true;
        this.mutations = (async () => {
            while (this.mutationQueue.length) {
                const entry = this.mutationQueue.shift()!;
                this.activeMutation = entry;
                try { entry.finish(await this.performMutation(entry)); }
                catch { entry.finish(false); }
                finally { this.activeMutation = undefined; }
            }
        })().finally(() => {
            this.mutationRunning = false;
            if (this.mutationQueue.length) { this.pumpMutations(); }
        });
    }

    private async performMutation(entry: Mutation): Promise<boolean> {
        const signal = entry.signal;
        await this.run(async () => {});
        while (!this.closed && alive(signal) && entry.action) {
            if (!this.maxBytes && !await fs.promises.stat(this.dir).catch(() => undefined)) { return false; }
            const waiting = this.waitForLease('.writer', signal);
            try {
                // Waiting stays outside the local read queue. Only a nonblocking lease
                // attempt and its successful mutation occupy the queue.
                const result = await this.run(async () => {
                    if (this.closed || !alive(signal) || !entry.action) { return { done: true, value: false }; }
                    const token = await this.tryLease('.writer');
                    if (!token) { return { done: false, value: false }; }
                    waiting.cancel();
                    this.owner = token;
                    try {
                        await this.cleanOrphans();
                        await this.refresh(true);
                        await this.repairSuspects();
                        await this.room(0, new Set());
                        const action = entry.action;
                        return { done: true, value: !!action && !this.closed && alive(signal) && await action() };
                    } finally {
                        this.owner = undefined;
                        await this.releaseLease('.writer', token);
                    }
                });
                if (result.done) { return result.value; }
                await waiting.promise;
            } finally { waiting.cancel(); }
        }
        return false;
    }

    private layout(output: PdfOutput): Layout {
        const previous = this.layouts.get(output);
        if (previous) { return previous; }
        const size = output.file.size ?? 0;
        if (!Number.isSafeInteger(size) || size <= 0) { throw new Error('PDF cache needs a positive exact build size'); }
        const pieces = (output.file.ranges ?? []).filter(range =>
            Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) &&
            range.start >= 0 && range.end > range.start && range.end <= size && HASH.test(range.hash),
        ).map(range => ({ start: range.start, end: range.end, hash: range.hash, prefix: Buffer.from(range.objectId ?? '', 'utf8') }))
            .filter(range => range.prefix.length <= range.start)
            .sort((a, b) => a.start - b.start);
        const source = new URL(output.url); source.searchParams.sort();
        const key = digest(JSON.stringify([
            source.href, output.projectId, output.file.editorId ?? '',
            output.file.build, output.file.url, size,
            pieces.map(p => [p.start, p.end, p.hash, Buffer.from(p.prefix).toString('base64')]),
        ]));
        const layout = { key, size, pieces, output };
        this.layouts.set(output, layout);
        return layout;
    }

    private async manifest(layout: Layout): Promise<BuildManifest> {
        const existing = this.builds.get(layout.key);
        if (existing) { return existing; }
        const name = 'build-' + layout.key + '.json';
        const parsed = await this.json(name);
        const valid = parsed?.version === 1 && parsed.key === layout.key && parsed.size === layout.size && this.validParts(parsed.parts, layout.size);
        const manifest: BuildManifest = valid ? parsed : { version: 1, key: layout.key, size: layout.size, parts: [] };
        if (!valid && this.entries.has(name)) { await this.remove(name); }
        if (manifest.validator && !this.validValidator(manifest.validator)) { manifest.validator = undefined; manifest.parts = []; }
        this.remember(this.builds, layout.key, manifest);
        return manifest;
    }

    private validParts(parts: unknown, size: number): parts is Part[] {
        return Array.isArray(parts) && parts.every(p => p && HASH.test(p.hash) &&
            Number.isSafeInteger(p.start) && Number.isSafeInteger(p.end) && Number.isSafeInteger(p.offset) &&
            p.start >= 0 && p.end > p.start && p.end <= size && p.offset >= 0);
    }

    private validValidator(value: any): value is Validator {
        return typeof value?.value === 'string' && (
            value.name === 'etag' && /^"[^"\r\n]*"$/.test(value.value) ||
            value.name === 'last-modified' && Number.isFinite(Date.parse(value.value))
        );
    }

    private validator(headers: Array<[string, string]>): Validator | undefined {
        const values = new Map(headers.map(([name, value]) => [name.toLowerCase(), value]));
        for (const name of ['etag', 'last-modified'] as const) {
            const value = values.get(name);
            if (value && this.validValidator({ name, value })) { return { name, value }; }
        }
        return undefined;
    }

    private async json(name: string): Promise<any> {
        if (!this.entries.has(name)) { return undefined; }
        try { return JSON.parse(await fs.promises.readFile(path.join(this.dir, name), 'utf8')); }
        catch { return undefined; }
    }

    private remember<T>(map: Map<string, T>, key: string, value: T) {
        map.delete(key); map.set(key, value);
        while (map.size > PDF_DISK_POLICY.memoryManifests) { map.delete(map.keys().next().value!); }
    }

    private touch(name: string) {
        const entry = this.entries.get(name);
        if (entry) {
            entry.used = this.now();
            const now = new Date(entry.used);
            void fs.promises.utimes(path.join(this.dir, name), now, now).catch(() => {});
        }
    }

    private async remove(name: string) {
        if (name.startsWith('object-')) { this.objects.delete(name.slice(7, -5)); }
        if (name.startsWith('build-')) { this.builds.delete(name.slice(6, -5)); }
        if (!this.owner) { this.suspect.add(name); this.verified.delete(name); return; }
        await fs.promises.unlink(path.join(this.dir, name)).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        });
        this.bytes -= this.entries.get(name)?.size ?? 0;
        this.entries.delete(name);
        this.verified.delete(name);
        this.suspect.delete(name);
    }

    private async room(extra: number, protect: Set<string>): Promise<boolean> {
        if (!this.owner || this.closed || extra > this.maxBytes) { return false; }
        for (const [name] of [...this.entries].sort((a, b) => a[1].used - b[1].used)) {
            if (this.bytes + this.reserved + extra <= this.maxBytes) { return true; }
            if (!protect.has(name)) { await this.remove(name); }
        }
        return this.bytes + this.reserved + extra <= this.maxBytes;
    }

    private async write(name: string, content: Uint8Array, protect = new Set<string>(), signal?: AbortSignal): Promise<boolean> {
        if (!alive(signal) || !this.owner || this.closed) { return false; }
        const oldSize = this.entries.get(name)?.size ?? 0;
        const keep = new Set([...protect, name]);
        if (!await this.room(Math.max(0, content.length - oldSize), keep) || !alive(signal)) { return false; }
        // Remove the old metadata before reserving its replacement; no uncounted old+temporary copy.
        if (oldSize) { await this.remove(name); }
        this.reserved += content.length;
        const temp = path.join(this.dir, name + '.' + randomUUID() + '.tmp');
        try {
            await fs.promises.writeFile(temp, content, { flag: 'wx' });
            if (!alive(signal) || this.closed) { return false; }
            await fs.promises.rename(temp, path.join(this.dir, name));
            const stat = await fs.promises.stat(path.join(this.dir, name));
            this.entries.set(name, { size: content.length, used: this.now(), identity: stat.dev + ':' + stat.ino });
            this.bytes += content.length;
            this.changed();
            return true;
        } finally {
            this.reserved -= content.length;
            await fs.promises.unlink(temp).catch(() => {});
        }
    }

    private async blob(hash: string, bytes: Uint8Array, protect = new Set<string>(), signal?: AbortSignal): Promise<boolean> {
        if (!this.maxBytes || !HASH.test(hash) || digest(bytes) !== hash) { return false; }
        if (this.entries.get(hash)?.size === bytes.length && await this.verify(hash)) { this.touch(hash); return true; }
        if (!await this.write(hash, bytes, protect, signal)) { return false; }
        this.verified.add(hash);
        return true;
    }

    private async verify(hash: string): Promise<boolean> {
        if (!this.entries.has(hash) || this.suspect.has(hash) && !this.owner) { return false; }
        if (this.verified.has(hash)) { return true; }
        const check = createHash('sha256');
        try {
            for await (const bytes of fs.createReadStream(path.join(this.dir, hash), { highWaterMark: PDF_DISK_POLICY.chunkBytes })) { check.update(bytes); }
            if (check.digest('hex') === hash) { this.verified.add(hash); this.suspect.delete(hash); return true; }
        } catch {}
        await this.remove(hash);
        return false;
    }

    private async object(hash: string): Promise<ObjectManifest | undefined> {
        const name = 'object-' + hash + '.json';
        if (this.suspect.has(name)) { return undefined; }
        if (this.objects.has(hash)) { return this.objects.get(hash); }
        const parsed = await this.json(name);
        const valid = parsed?.version === 1 && parsed.hash === hash && Number.isSafeInteger(parsed.size) && parsed.size > 0 &&
            this.validParts(parsed.parts, parsed.size);
        const object = valid ? parsed as ObjectManifest : undefined;
        if (!valid && this.entries.has(name)) { await this.remove(name); }
        if (object) { this.remember(this.objects, hash, object); }
        return object;
    }

    private async segments(layout: Layout, manifest: BuildManifest): Promise<Segment[]> {
        const parts: Segment[] = manifest.parts.filter(p => !this.suspect.has(p.hash) && (this.entries.get(p.hash)?.size ?? -1) >= p.offset + p.end - p.start);
        for (const piece of layout.pieces) {
            if (piece.prefix.length) { parts.push({ start: piece.start - piece.prefix.length, end: piece.start, inline: piece.prefix }); }
            if (!this.suspect.has(piece.hash) && this.entries.get(piece.hash)?.size === piece.end - piece.start) {
                parts.push({ start: piece.start, end: piece.end, hash: piece.hash, offset: 0 });
            } else {
                const object = await this.object(piece.hash);
                if (object?.size === piece.end - piece.start) {
                    for (const p of object.parts) {
                        if (!this.suspect.has(p.hash) && (this.entries.get(p.hash)?.size ?? -1) >= p.offset + p.end - p.start) {
                            parts.push({ ...p, start: piece.start + p.start, end: piece.start + p.end });
                        }
                    }
                }
            }
        }
        return parts.sort((a, b) => a.start - b.start || b.end - a.end);
    }

    private plan(parts: Segment[], start: number, end: number): Segment[] | undefined {
        const plan: Segment[] = [];
        let cursor = start;
        while (cursor < end) {
            let best: Segment | undefined;
            for (const part of parts) {
                if (part.start > cursor) { break; }
                if (part.end > cursor && (!best || part.end > best.end)) { best = part; }
            }
            if (!best) { return undefined; }
            const until = Math.min(end, best.end);
            plan.push('inline' in best
                ? { start: cursor, end: until, inline: best.inline.subarray(cursor - best.start, until - best.start) }
                : { start: cursor, end: until, hash: best.hash, offset: best.offset + cursor - best.start });
            cursor = until;
        }
        return plan;
    }

    private async *readPlan(plan: Segment[], signal?: AbortSignal): AsyncGenerator<Uint8Array> {
        for (const part of plan) {
            if (!alive(signal)) { throw new Error('PDF cache read aborted'); }
            if ('inline' in part) { yield part.inline; continue; }
            if (!await this.verify(part.hash)) { throw new Error('PDF cache blob is unavailable'); }
            const handle = await fs.promises.open(path.join(this.dir, part.hash), 'r');
            try {
                for (let pos = 0; pos < part.end - part.start;) {
                    const size = Math.min(PDF_DISK_POLICY.chunkBytes, part.end - part.start - pos);
                    const buffer = Buffer.allocUnsafe(size);
                    const { bytesRead } = await handle.read(buffer, 0, size, part.offset + pos);
                    if (bytesRead !== size || !alive(signal)) { throw new Error('PDF cache range is incomplete'); }
                    pos += size;
                    yield buffer;
                }
            } finally { await handle.close(); }
            this.touch(part.hash);
        }
    }

    private protect(layout: Layout, manifest: BuildManifest, parts: Segment[]): Set<string> {
        return new Set([
            'build-' + layout.key + '.json', ...manifest.parts.map(p => p.hash),
            ...parts.filter((p): p is Part => 'hash' in p).map(p => p.hash),
            ...layout.pieces.map(p => 'object-' + p.hash + '.json'),
        ]);
    }

    /** Existing content-addressed piece API, including pieces assembled from background ranges. */
    get(hash: string): Promise<Uint8Array | undefined> {
        return this.run(async () => {
            if (!this.maxBytes || !HASH.test(hash)) { return undefined; }
            if (await this.verify(hash)) {
                this.touch(hash);
                return new Uint8Array(await fs.promises.readFile(path.join(this.dir, hash)));
            }
            const object = await this.object(hash);
            const plan = object && this.plan(object.parts, 0, object.size);
            if (!object || !plan) { return undefined; }
            const result = new Uint8Array(object.size);
            let cursor = 0;
            try {
                for await (const bytes of this.readPlan(plan)) { result.set(bytes, cursor); cursor += bytes.length; }
            } catch { return undefined; }
            if (digest(result) !== hash) { await this.remove('object-' + hash + '.json'); return undefined; }
            this.touch('object-' + hash + '.json');
            return result;
        });
    }

    put(hash: string, content: Uint8Array, signal?: AbortSignal): Promise<boolean> {
        return this.mutate(() => this.blob(hash, content, new Set(), signal), signal);
    }

    readRange(output: PdfOutput, start: number, end: number): Promise<{ body: Uint8Array, validator?: Validator } | undefined> {
        return this.run(async () => {
            if (!this.maxBytes) { return undefined; }
            const layout = this.layout(output);
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > layout.size) { return undefined; }
            const manifest = await this.manifest(layout);
            const plan = this.plan(await this.segments(layout, manifest), start, end);
            if (!plan) { return undefined; }
            const result = new Uint8Array(end - start);
            let cursor = 0;
            try {
                for await (const bytes of this.readPlan(plan)) { result.set(bytes, cursor); cursor += bytes.length; }
            } catch { return undefined; }
            this.touch('build-' + layout.key + '.json');
            return { body: result, validator: manifest.validator };
        });
    }

    private async saveManifest(manifest: BuildManifest, protect: Set<string>, signal?: AbortSignal): Promise<boolean> {
        const ok = await this.write('build-' + manifest.key + '.json', Buffer.from(JSON.stringify(manifest)), protect, signal);
        if (ok) { this.remember(this.builds, manifest.key, manifest); }
        return ok;
    }

    /** Only exact 206 ranges with a stable validator enter the build's persistent byte map. */
    storeRange(output: PdfOutput, start: number, end: number, response: BridgeResponse, signal?: AbortSignal): Promise<boolean> {
        return this.mutate(async () => {
            const layout = this.layout(output);
            const headers = new Map(response.headers.map(([name, value]) => [name.toLowerCase(), value]));
            const validator = this.validator(response.headers);
            if (!this.maxBytes || !alive(signal) || response.status !== 206 || !validator ||
                headers.get('content-range') !== 'bytes ' + start + '-' + (end - 1) + '/' + layout.size ||
                response.body.length !== end - start || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > layout.size || end <= start ||
                ![undefined, 'identity'].includes(headers.get('content-encoding'))) { return false; }
            const old = await this.manifest(layout);
            const changed = old.validator && (old.validator.name !== validator.name || old.validator.value !== validator.value);
            const manifest: BuildManifest = { ...old, validator, parts: changed ? [] : [...old.parts] };
            const parts = await this.segments(layout, manifest);
            const protect = this.protect(layout, manifest, parts);
            let cursor = start;
            while (cursor < end) {
                if (!alive(signal)) { return false; }
                const covered = parts.find(p => p.start <= cursor && p.end > cursor);
                if (covered) { cursor = Math.min(end, covered.end); continue; }
                const next = parts.find(p => p.start > cursor)?.start ?? end;
                const boundary = layout.pieces.flatMap(p => [p.start, p.end]).find(p => p > cursor) ?? end;
                const until = Math.min(end, next, boundary, cursor + PDF_DISK_POLICY.chunkBytes);
                const content = response.body.subarray(cursor - start, until - start);
                const hash = digest(content);
                if (!await this.blob(hash, content, protect, signal)) { return false; }
                const part = { start: cursor, end: until, hash, offset: 0 };
                manifest.parts.push(part);
                protect.add(hash);
                cursor = until;
            }
            manifest.parts.sort((a, b) => a.start - b.start);
            if (!await this.saveManifest(manifest, protect, signal)) { return false; }
            // Once all shards of a known object exist, certify its full hash and share the map
            // between builds. The object ID prefix is outside the hash and outside this interval.
            for (const piece of layout.pieces.filter(p => p.start < end && p.end > start)) {
                if (this.entries.has(piece.hash) || await this.object(piece.hash)) { continue; }
                const plan = this.plan(await this.segments(layout, manifest), piece.start, piece.end);
                if (!plan || plan.some(p => 'inline' in p)) { continue; }
                const check = createHash('sha256');
                try { for await (const bytes of this.readPlan(plan, signal)) { check.update(bytes); } } catch { continue; }
                if (check.digest('hex') !== piece.hash || !alive(signal)) { continue; }
                const object: ObjectManifest = {
                    version: 1, hash: piece.hash, size: piece.end - piece.start,
                    parts: (plan as Part[]).map(p => ({ ...p, start: p.start - piece.start, end: p.end - piece.start })),
                };
                const name = 'object-' + piece.hash + '.json';
                if (await this.write(name, Buffer.from(JSON.stringify(object)), protect, signal)) { this.remember(this.objects, piece.hash, object); }
            }
            return alive(signal);
        }, signal);
    }

    private gap(output: PdfOutput, fresh = false): Promise<{ start: number, end: number, validator?: Validator } | undefined> {
        return this.run(async () => {
            if (fresh) { await this.refresh(true); }
            const layout = this.layout(output);
            if (this.closed || layout.size > this.maxBytes) { return undefined; }
            const manifest = await this.manifest(layout);
            const parts = await this.segments(layout, manifest);
            let cursor = 0;
            for (const part of parts) {
                if (part.start > cursor) { break; }
                cursor = Math.max(cursor, part.end);
            }
            if (cursor >= layout.size) { return undefined; }
            const next = parts.find(p => p.start > cursor)?.start ?? layout.size;
            const boundary = layout.pieces.flatMap(p => [p.start, p.end]).find(p => p > cursor) ?? layout.size;
            return { start: cursor, end: Math.min(next, boundary, cursor + PDF_DISK_POLICY.chunkBytes), validator: manifest.validator };
        });
    }

    /** Every foreground bridge demand revokes background ownership before any cache or network I/O. */
    beginForeground(): () => void {
        this.foreground++;
        this.pause();
        this.changed();
        let ended = false;
        return () => {
            if (ended) { return; }
            ended = true;
            this.foreground--;
            this.changed();
            this.schedule(PDF_DISK_POLICY.quietMs);
        };
    }

    createViewer(): PdfCacheViewer {
        const viewer: Viewer = { visible: false, idle: false, generation: 0, order: ++this.order, stopped: false };
        this.viewers.add(viewer);
        const change = () => { viewer.stopped = false; viewer.order = ++this.order; this.pause(); this.changed(); this.schedule(PDF_DISK_POLICY.quietMs); };
        return {
            setOutput: output => {
                if (output && viewer.output && this.layout(output).key === this.layout(viewer.output).key) { return; }
                viewer.output = output;
                viewer.generation++;
                viewer.idle = false;
                change();
            },
            setActivity: (visible, idle) => {
                if (viewer.visible === visible && viewer.idle === idle) { return; }
                viewer.visible = visible; viewer.idle = idle;
                change();
            },
            dispose: () => { this.viewers.delete(viewer); viewer.generation++; this.pause(); this.changed(); this.schedule(PDF_DISK_POLICY.quietMs); },
        };
    }

    private pause() {
        if (this.timer !== undefined) { this.clearTimer(this.timer); this.timer = undefined; }
        this.filling?.controller.abort();
    }

    private eligible(): Viewer | undefined {
        if (this.closed || this.foreground || !this.options.fetchRange) { return undefined; }
        const visible = [...this.viewers].filter(v => v.visible && v.output);
        if (visible.some(v => !v.idle)) { return undefined; }
        return visible.filter(v => !v.stopped).sort((a, b) => b.order - a.order)[0];
    }

    private schedule(delay: number) {
        if (this.timer !== undefined || this.filling || !this.eligible()) { return; }
        this.timer = this.setTimer(() => {
            this.timer = undefined;
            this.fillTask = this.fill().catch(() => {});
        }, delay);
    }

    private async fill() {
        const viewer = this.eligible();
        if (!viewer?.output || this.filling) { return; }
        const output = viewer.output;
        const job = { viewer, output, generation: viewer.generation, controller: new AbortController() };
        this.filling = job;
        this.changed();
        const current = () => !job.controller.signal.aborted && this.viewers.has(viewer) &&
            viewer.generation === job.generation && viewer.output === output && this.eligible() === viewer;
        let transfer: string | undefined;
        try {
            if (!await this.gap(output)) { if (current()) { viewer.stopped = true; } return; }
            if (!current()) { return; }
            transfer = await this.backgroundLease(job.controller.signal);
            if (!transfer || !current()) { return; }
            const gap = await this.gap(output, true);
            if (!current()) { return; }
            if (!gap) { viewer.stopped = true; return; }
            const response = await this.options.fetchRange!({ ...gap, output, url: output.url, signal: job.controller.signal });
            if (!current()) { return; }
            const stored = await this.storeRange(output, gap.start, gap.end, response, job.controller.signal);
            if (current() && !stored) { viewer.stopped = true; }
        } catch {
            if (current()) { viewer.stopped = true; }
        } finally {
            if (transfer) { await this.releaseLease('.background', transfer); }
            if (this.filling === job) { this.filling = undefined; }
            this.changed();
            this.schedule(job.controller.signal.aborted ? PDF_DISK_POLICY.quietMs : PDF_DISK_POLICY.paceMs);
        }
    }

    /** Write a complete cached build to a user-selected path using one small buffer at a time. */
    copyComplete(output: PdfOutput, target: string, signal?: AbortSignal, progress?: (bytes: number) => void): Promise<boolean> {
        return this.run(async () => {
            const layout = this.layout(output);
            const manifest = await this.manifest(layout);
            const plan = this.plan(await this.segments(layout, manifest), 0, layout.size);
            if (!plan) { return false; }
            const temp = target + '.' + randomUUID() + '.part';
            let handle: fs.promises.FileHandle | undefined;
            try {
                handle = await fs.promises.open(temp, 'wx');
                let written = 0;
                for await (const bytes of this.readPlan(plan, signal)) {
                    for (let cursor = 0; cursor < bytes.length;) {
                        const { bytesWritten } = await handle.write(bytes, cursor, bytes.length - cursor);
                        if (!bytesWritten) { throw new Error('PDF cache save made no progress'); }
                        cursor += bytesWritten;
                    }
                    written += bytes.length;
                    progress?.(written);
                }
                await handle.close(); handle = undefined;
                if (!alive(signal)) { throw new Error('PDF cache save aborted'); }
                await fs.promises.rename(temp, target);
                return true;
            } catch (error) {
                if (!alive(signal)) { throw error; }
                return false;
            } finally {
                await handle?.close();
                await fs.promises.unlink(temp).catch(() => {});
            }
        });
    }

    snapshot(output?: PdfOutput) {
        return this.run(async () => {
            let covered = 0;
            let total = 0;
            if (output) {
                const layout = this.layout(output); total = layout.size;
                const parts = await this.segments(layout, await this.manifest(layout));
                let last = 0;
                for (const part of parts) { covered += Math.max(0, part.end - Math.max(last, part.start)); last = Math.max(last, part.end); }
            }
            return { bytes: this.bytes, reserved: this.reserved, maxBytes: this.maxBytes, writer: !!this.owner,
                files: this.entries.size, covered, total, complete: total > 0 && covered === total,
                foreground: this.foreground, filling: !!this.filling && (!output || this.layout(this.filling.output).key === this.layout(output).key), viewers: this.viewers.size,
                memoryManifests: this.builds.size + this.objects.size };
        });
    }

    /** Useful for deterministic lifecycle tests and extension shutdown; no polling is involved. */
    async settled() {
        await this.fillTask;
        while (this.mutationRunning) { await this.mutations; }
        await this.serial;
    }

    onChange(listener: () => void): () => void {
        this.changes.add(listener);
        return () => { this.changes.delete(listener); };
    }

    private changed() { for (const listener of this.changes) { listener(); } }

    async dispose() {
        this.closed = true;
        this.pause();
        this.activeMutation?.cancel();
        for (const entry of [...this.mutationQueue]) { entry.cancel(); }
        this.wakeWaiters();
        this.viewers.clear();
        this.changes.clear();
        this.watcher?.close();
        await this.fillTask;
        await this.mutations;
        await this.serial;
    }
}
