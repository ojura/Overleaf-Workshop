import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    canonicalReplicaFolder, ControlAnswer, POINTER_FILE, ReplicaCancelledError, ReplicaHostIdentity,
    ReplicaTimeoutError, requestReplica,
} from './replicaControl';

export class ReplicaReloadError extends Error {
    constructor(message: string, readonly answer?: ControlAnswer) { super(message); }
}

export interface ReplicaReloadReport {
    ok: true;
    folder: string;
    request: string;
    previousHost: ReplicaHostIdentity;
    host: ReplicaHostIdentity;
    readiness: ControlAnswer;
    elapsedMs: number;
}

function identity(answer: ControlAnswer, folder: string): ReplicaHostIdentity {
    if (!answer.ok) { throw new ReplicaReloadError(answer.error, answer); }
    if (answer.folder !== folder) { throw new ReplicaReloadError('The control answer belongs to a different replica folder.', answer); }
    const host = answer.host as ReplicaHostIdentity | undefined;
    if (!host || typeof host.id !== 'string' || !host.id || !Number.isInteger(host.pid) || typeof host.since !== 'string') {
        throw new ReplicaReloadError('The extension host does not identify this control session; activate a build with replica-reload support first.', answer);
    }
    return host;
}

/** Observe the existing atomic pointer before reload, so a fast replacement cannot be missed. */
function replacementHost(folder: string, previous: ReplicaHostIdentity, request: string, deadline: number,
    signal: AbortSignal, failed: (error: unknown) => void) {
    const file = path.join(folder, POINTER_FILE);
    let watcher: fs.FSWatcher | undefined, timer: NodeJS.Timeout | undefined, done = false;
    let resolve!: (host: ReplicaHostIdentity) => void, reject!: (error: unknown) => void;
    const promise = new Promise<ReplicaHostIdentity>((yes, no) => { resolve = yes; reject = no; });
    // The reload request can still be awaiting its answer when the pointer reports a failure.
    void promise.catch(() => {});
    const dispose = () => { watcher?.close(); clearTimeout(timer); signal?.removeEventListener('abort', cancelled); };
    const finish = (host?: ReplicaHostIdentity, error?: unknown) => {
        if (done) { return; }
        done = true; dispose();
        if (error !== undefined) { failed(error); reject(error); } else { resolve(host!); }
    };
    const cancelled = () => finish(undefined, new ReplicaCancelledError('Waiting for the replacement extension host was cancelled.'));
    const check = () => {
        if (done) { return; }
        let pointer: any;
        try { pointer = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (error: any) {
            if (error?.code === 'ENOENT' || error instanceof SyntaxError) { return; }
            finish(undefined, error); return;
        }
        if (pointer.host?.id === previous.id) {
            if (pointer.reload?.id === request && ['rejected', 'cancelled'].includes(pointer.reload.state)) {
                finish(undefined, new ReplicaReloadError(pointer.reload.error ?? `Window reload ${pointer.reload.state}.`));
            }
            return;
        }
        if (!pointer.host) { return; }
        try {
            const host = identity({ ok: true, folder: pointer.folder, host: pointer.host }, folder);
            if (typeof pointer.error === 'string') { throw new ReplicaReloadError('The replacement host cannot serve the replica: ' + pointer.error); }
            if (typeof pointer.socket !== 'string') { throw new ReplicaReloadError('The replacement host did not publish its control socket.'); }
            finish(host);
        } catch (error) { finish(undefined, error); }
    };
    try {
        watcher = fs.watch(path.dirname(file), (_event, name) => {
            if (name === null || name.toString() === path.basename(file)) { check(); }
        });
        watcher.on('error', error => finish(undefined, error));
        signal?.addEventListener('abort', cancelled, { once: true });
        timer = setTimeout(() => finish(undefined, new ReplicaTimeoutError(
            'The window reload has no replacement-host acknowledgement within the requested deadline.')), Math.max(1, deadline - Date.now()));
        if (signal?.aborted) { cancelled(); } else { check(); }
    } catch (error) { finish(undefined, error); }
    return { promise, dispose: () => { if (!done) { cancelled(); } else { dispose(); } } };
}

/** Ask once, then require a different host to acknowledge the same replica after initial sync. */
export async function reloadReplica(folder: string, timeoutMs: number, signal?: AbortSignal): Promise<ReplicaReloadReport> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { throw new Error('The reload deadline must be a positive finite duration.'); }
    const started = Date.now(), deadline = started + timeoutMs, canonical = canonicalReplicaFolder(folder);
    const remaining = () => {
        const value = deadline - Date.now();
        if (value <= 0) { throw new ReplicaTimeoutError('The replica reload deadline expired.'); }
        return value;
    };
    const initial = await requestReplica(canonical, { op: 'host' }, remaining(), signal);
    const previous = identity(initial, canonical);
    if (initial.reloadSupported !== true) {
        throw new ReplicaReloadError('This extension host does not support window reload; activate the installed build first.', initial);
    }
    const request = crypto.randomUUID(), pending = new AbortController();
    const cancelled = () => pending.abort();
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) { cancelled(); }
    let observerFailure: unknown;
    const replacement = replacementHost(canonical, previous, request, deadline, pending.signal, error => {
        observerFailure = error;
        pending.abort();
    });
    try {
        const accepted = await requestReplica(canonical, { op: 'reload', folder: canonical, host: previous.id, id: request }, remaining(), pending.signal);
        const acceptingHost = identity(accepted, canonical);
        if (acceptingHost.id !== previous.id || (accepted.reload as any)?.id !== request) {
            throw new ReplicaReloadError('The reload acknowledgement belongs to another host or request.', accepted);
        }
        const next = await replacement.promise;
        if (next.id === previous.id) { throw new ReplicaReloadError('The original extension host cannot acknowledge its own replacement.'); }
        const readiness = await requestReplica(canonical, { op: 'ready', folder: canonical, host: next.id }, remaining(), pending.signal);
        const readyHost = identity(readiness, canonical);
        if (readyHost.id !== next.id || readiness.ready !== true) {
            throw new ReplicaReloadError('The replacement extension host did not acknowledge replica readiness.', readiness);
        }
        return { ok: true, folder: canonical, request, previousHost: previous, host: readyHost, readiness, elapsedMs: Date.now() - started };
    } catch (error) {
        throw observerFailure ?? error;
    } finally {
        signal?.removeEventListener('abort', cancelled);
        replacement.dispose();
    }
}
