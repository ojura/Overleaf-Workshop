import * as fs from 'fs';
import * as os from 'os';
import { randomBytes } from 'crypto';

/**
 * A lock shared by the processes on this machine that compile in one sandbox project.
 *
 * Overleaf compiles one build per project and user at a time, and a run uploads files
 * before it compiles them, so two runs must not overlap: the second one's uploads would
 * change what the first one compiles. The lock is a file created with O_EXCL that names
 * its owner. A process that died without removing it (SIGKILL, power loss) is detected
 * by its pid, and by the start time of the process with that pid, so that a pid reused
 * by another process is not taken for the owner. Removing a stale lock is serialized by
 * a second lock file, so two waiters cannot both decide that the same lock is stale and
 * the second one remove the lock the first one has just taken.
 */

export interface LockOwner {
    pid: number;
    host: string;
    /** start time of the owning process, from /proc/<pid>/stat on Linux */
    processStart?: string;
    acquiredAt: string;
    /** what the owner is doing, shown to the processes that wait */
    purpose: string;
    /** tells this acquisition from any other one of the same process */
    token: string;
}

export interface LockOptions {
    /** how long to wait for the lock; 0 fails at once when it is taken */
    timeoutMs: number;
    purpose: string;
    pollMs?: number;
    /** called about every `reportMs` while waiting, with the current owner */
    onWait?: (owner: LockOwner | undefined, waitedMs: number) => void;
    reportMs?: number;
    /** a lock file without a readable owner is stale after this long (a crash while writing it) */
    unreadableStaleMs?: number;
    // replaceable in tests
    isStale?: (owner: LockOwner) => boolean;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

export interface HeldLock {
    owner: LockOwner;
    waitedMs: number;
    /** remove the lock if this acquisition still holds it; safe to call more than once */
    release(): void;
}

export class LockTimeoutError extends Error {
    constructor(readonly file: string, readonly owner: LockOwner | undefined, waitedMs: number) {
        super(owner
            ? `the sandbox lock ${file} is held by pid ${owner.pid} on ${owner.host} since ${owner.acquiredAt} (${owner.purpose}); gave up after ${Math.round(waitedMs/1000)} s`
            : `the sandbox lock ${file} is taken; gave up after ${Math.round(waitedMs/1000)} s`);
    }
}

/** Start time of process `pid` in clock ticks since boot, or undefined where /proc does not tell. */
export function processStartTime(pid: number): string | undefined {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // the command name in field 2 may contain spaces and parentheses
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return fields[19]; // field 22, starttime; `fields` starts at field 3
    } catch {
        return undefined;
    }
}

/** Whether the owner of a lock taken on this machine has exited. */
export function ownerHasExited(owner: LockOwner): boolean {
    if (owner.host !== os.hostname()) {
        return false; // another machine's process: no way to tell
    }
    try {
        process.kill(owner.pid, 0);
    } catch (error: any) {
        if (error?.code === 'ESRCH') { return true; }
        // EPERM: a process of another user has this pid; its start time tells whether it is the owner
    }
    if (owner.processStart !== undefined) {
        const start = processStartTime(owner.pid);
        if (start !== undefined && start !== owner.processStart) {
            return true; // the pid now belongs to another process
        }
    }
    return false;
}

function readOwner(file: string): LockOwner | undefined {
    try {
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
        return typeof owner?.pid === 'number' && typeof owner?.token === 'string' ? owner : undefined;
    } catch {
        return undefined;
    }
}

function ageMs(file: string, now: number): number | undefined {
    try {
        return now - fs.statSync(file).mtimeMs;
    } catch {
        return undefined;
    }
}

/**
 * Remove `file` if it still is the stale lock that was looked at: the one owned by
 * `token`, or, for `token` undefined, one without a readable owner that is older than
 * `unreadableStaleMs`. Returns false when another process is removing a stale lock.
 */
function removeStale(file: string, token: string | undefined, now: number, unreadableStaleMs: number): boolean {
    const breaker = `${file}.break`;
    let fd: number;
    try {
        fd = fs.openSync(breaker, 'wx');
    } catch (error: any) {
        if (error?.code !== 'EEXIST') { throw error; }
        // A process removes the stale lock in a few milliseconds; one that is older than a
        // minute was left by a process that died while doing it.
        if ((ageMs(breaker, now) ?? 0) > 60 * 1000) {
            try { fs.unlinkSync(breaker); } catch { /* removed meanwhile */ }
        }
        return false;
    }
    try {
        const current = readOwner(file);
        const stillStale = token === undefined
            ? current === undefined && (ageMs(file, now) ?? 0) > unreadableStaleMs
            : current?.token === token;
        if (stillStale) {
            try { fs.unlinkSync(file); } catch { /* removed meanwhile */ }
        }
        return true;
    } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(breaker); } catch { /* nothing to do */ }
    }
}

export async function acquireLock(file: string, options: LockOptions): Promise<HeldLock> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const isStale = options.isStale ?? ownerHasExited;
    const pollMs = options.pollMs ?? 1000;
    const reportMs = options.reportMs ?? 30 * 1000;
    const unreadableStaleMs = options.unreadableStaleMs ?? 30 * 1000;
    const started = now();
    let lastReport = -Infinity;

    const owner: LockOwner = {
        pid: process.pid,
        host: os.hostname(),
        processStart: processStartTime(process.pid),
        acquiredAt: '',
        purpose: options.purpose,
        token: randomBytes(8).toString('hex'),
    };

    for (;;) {
        owner.acquiredAt = new Date(now()).toISOString();
        try {
            const fd = fs.openSync(file, 'wx', 0o644);
            try {
                fs.writeSync(fd, JSON.stringify(owner, null, 2) + '\n');
            } finally {
                fs.closeSync(fd);
            }
            let released = false;
            return {
                owner,
                waitedMs: now() - started,
                release: () => {
                    if (released) { return; }
                    released = true;
                    if (readOwner(file)?.token === owner.token) {
                        try { fs.unlinkSync(file); } catch { /* removed meanwhile */ }
                    }
                },
            };
        } catch (error: any) {
            if (error?.code !== 'EEXIST') { throw error; }
        }

        const current = readOwner(file);
        if (current === undefined) {
            // being written right now, or left half-written by a process that crashed
            if ((ageMs(file, now()) ?? 0) > unreadableStaleMs && removeStale(file, undefined, now(), unreadableStaleMs)) {
                continue;
            }
        } else if (isStale(current)) {
            if (removeStale(file, current.token, now(), unreadableStaleMs)) {
                continue;
            }
        }

        const waited = now() - started;
        if (waited >= options.timeoutMs) {
            throw new LockTimeoutError(file, current, waited);
        }
        if (waited - lastReport >= reportMs) {
            lastReport = waited;
            options.onWait?.(current, waited);
        }
        // a little jitter, so that waiters do not retry in lockstep
        await sleep(Math.min(pollMs + Math.floor(Math.random() * pollMs / 4), Math.max(options.timeoutMs - waited, 1)));
    }
}
