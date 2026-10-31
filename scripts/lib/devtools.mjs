// The DevTools Protocol client of the scripts. It reaches a Chromium browser, the headless Chrome
// of the PDF viewer harness or the Antigravity of a test instance (scripts/hidden-ide.sh), through
// the port that the browser picks itself. Started with --remote-debugging-port=0, the browser
// listens on a free port of 127.0.0.1 and writes the port and the path of its browser target into
// the file DevToolsActivePort in its profile folder. The path holds an id that only that browser
// accepts, so a connection to it reaches the browser of that profile and no other process that
// listens on the machine. Pages and frames are reached through that connection
// (Target.attachToTarget), not through ports of their own.
import fs from 'node:fs';
import path from 'node:path';

/** The file in which a browser names its DevTools port and its browser target. */
const ACTIVE_PORT_FILE = 'DevToolsActivePort';

/**
 * The WebSocket URL of the browser that wrote `profile`'s DevToolsActivePort, or undefined while
 * the file is missing or not yet written whole. A browser leaves the file behind when it ends; a
 * connection to the URL of a browser that has ended fails.
 */
export function activePortUrl(profile) {
    let text;
    try {
        text = fs.readFileSync(path.join(profile, ACTIVE_PORT_FILE), 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') { return undefined; }
        throw error;
    }
    const match = /^(\d+)\n(\/devtools\/browser\/[0-9a-f-]+)\n?$/.exec(text);
    return match ? `ws://127.0.0.1:${match[1]}${match[2]}` : undefined;
}

/** Remove the DevToolsActivePort that a browser of `profile` left behind, before a new one starts. */
export function removeActivePort(profile) {
    fs.rmSync(path.join(profile, ACTIVE_PORT_FILE), { force: true });
}

/**
 * Wait until a browser started with --remote-debugging-port=0 on `profile` has written
 * DevToolsActivePort, and return activePortUrl(profile). The wait follows the folder's file
 * events. `ended`, a promise that settles when the browser's process ends, ends the wait with an
 * error; `limitMs` is the last resort for a browser that runs but never opens DevTools.
 */
export function waitForActivePort(profile, { ended, limitMs }) {
    return new Promise((resolve, reject) => {
        const watcher = fs.watch(profile);
        let timer;
        const finish = (settle, value) => { clearTimeout(timer); watcher.close(); settle(value); };
        const look = () => {
            const url = activePortUrl(profile);
            if (url) { finish(resolve, url); }
        };
        timer = setTimeout(() => finish(reject, new Error(`the browser of ${profile} did not open DevTools within ${limitMs / 1000} s`)), limitMs);
        watcher.on('change', (type, name) => { if (name === ACTIVE_PORT_FILE) { look(); } });
        watcher.on('error', (error) => finish(reject, error));
        ended?.then(
            (how) => finish(reject, new Error(`the browser of ${profile} ended (${how}) before it opened DevTools`)),
            (error) => finish(reject, error));
        look(); // in case the browser wrote the file before the watch began
    });
}

/**
 * A DevTools connection to the browser endpoint `url` (ws://127.0.0.1:<port>/devtools/browser/<id>):
 * - send(method, params) sends a command to the browser and resolves to its result;
 * - on(method, fn) calls fn with the params of each such event of the browser, and returns a
 *   function that stops it;
 * - attach(targetId) opens a session on one of the browser's targets (a page, a frame, a worker),
 *   with the same send and on for that target, and detach();
 * - discoverTargets() asks the browser for its target events (Target.targetCreated, ...), once;
 * - close() closes the connection, and `closed` resolves with the reason when it has closed.
 * A Node inspector's endpoint has no targets: use send and on alone there.
 * A command that waits for its answer fails when the connection closes, and a session's command
 * also when its target detaches or crashes; the error names the command and the reason.
 */
export async function connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        const opened = () => { ws.removeEventListener('error', failed); resolve(); };
        const failed = () => { ws.removeEventListener('open', opened); reject(new Error(`could not connect to ${url}`)); };
        ws.addEventListener('open', opened, { once: true });
        ws.addEventListener('error', failed, { once: true });
    });
    let next = 1;
    /** id -> { resolve, reject, method, sessionId } */
    const pending = new Map();
    /** `${sessionId}|${method}` ('' for the browser) -> Set of listeners */
    const listeners = new Map();
    /** sessionId -> targetId, for the sessions that are attached */
    const sessions = new Map();
    /** sessionId -> why it ended */
    const endedSessions = new Map();
    let endReason;
    let reportClosed;
    const closed = new Promise((resolve) => { reportClosed = resolve; });

    const failPending = (matches, reason) => {
        for (const [id, call] of pending) {
            if (matches(call)) {
                pending.delete(id);
                call.reject(new Error(`${call.method}: ${reason}`));
            }
        }
    };
    const endSession = (sessionId, reason) => {
        if (!sessions.has(sessionId)) { return; }
        sessions.delete(sessionId);
        endedSessions.set(sessionId, reason);
        failPending((call) => call.sessionId === sessionId, reason);
    };
    const emit = (sessionId, method, params) => {
        for (const fn of listeners.get(`${sessionId ?? ''}|${method}`) ?? []) { fn(params); }
    };

    ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== undefined) {
            const call = pending.get(message.id);
            if (!call) { return; }
            pending.delete(message.id);
            if (message.error) {
                call.reject(new Error(`${call.method}: ${message.error.message}${message.error.data ? ` (${message.error.data})` : ''}`));
            } else {
                call.resolve(message.result);
            }
            return;
        }
        if (message.method === 'Target.detachedFromTarget') {
            endSession(message.params.sessionId, 'the target was detached');
        } else if (message.method === 'Target.targetCrashed') {
            for (const [sessionId, targetId] of sessions) {
                if (targetId === message.params.targetId) {
                    endSession(sessionId, `the target crashed (${message.params.status}, error code ${message.params.errorCode})`);
                }
            }
        }
        emit(message.sessionId, message.method, message.params);
    });
    ws.addEventListener('close', (event) => {
        endReason = `the DevTools connection to ${url} closed (code ${event.code}${event.reason ? `, ${event.reason}` : ''})`;
        failPending(() => true, endReason);
        reportClosed(endReason);
    });

    const send = (method, params = {}, sessionId) => {
        if (endReason !== undefined) { return Promise.reject(new Error(`${method}: ${endReason}`)); }
        if (sessionId !== undefined && endedSessions.has(sessionId)) {
            return Promise.reject(new Error(`${method}: ${endedSessions.get(sessionId)}`));
        }
        return new Promise((resolve, reject) => {
            const id = next++;
            pending.set(id, { resolve, reject, method, sessionId });
            ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
        });
    };
    const on = (method, fn, sessionId) => {
        const key = `${sessionId ?? ''}|${method}`;
        if (!listeners.has(key)) { listeners.set(key, new Set()); }
        listeners.get(key).add(fn);
        return () => listeners.get(key)?.delete(fn);
    };
    let discovering;
    // the browser reports crashed targets only while it reports its targets at all
    const discoverTargets = () => (discovering ??= send('Target.setDiscoverTargets', { discover: true }));
    const attach = async (targetId) => {
        await discoverTargets();
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        sessions.set(sessionId, targetId);
        return {
            sessionId,
            targetId,
            send: (method, params) => send(method, params, sessionId),
            on: (method, fn) => on(method, fn, sessionId),
            /**
             * Detach from the target. A session that has ended, or that ends while the browser
             * answers, because its target or the connection went away, is gone already.
             */
            detach: async () => {
                if (!sessions.has(sessionId) || endReason !== undefined) { return; }
                try {
                    await send('Target.detachFromTarget', { sessionId });
                } catch (error) {
                    if (endReason === undefined && sessions.has(sessionId)) { throw error; }
                }
            },
        };
    };
    return {
        url, send: (method, params) => send(method, params), on: (method, fn) => on(method, fn),
        attach, discoverTargets, close: () => ws.close(), closed,
    };
}

/**
 * Wait until the browser on `connection` has a target for which `matches(targetInfo)` holds, and
 * return that targetInfo. The browser's targets are checked when the wait begins, and then with
 * each target event. The wait fails when the connection closes; `limitMs` is the last resort for
 * a browser that runs but never opens such a target, and `what` names the target in that error.
 */
export function waitForTarget(connection, matches, { what, limitMs }) {
    return new Promise((resolve, reject) => {
        let done = false;
        const stops = [];
        const finish = (settle, value) => {
            if (done) { return; }
            done = true;
            clearTimeout(timer);
            stops.forEach(stop => stop());
            settle(value);
        };
        const look = (targetInfo) => { if (matches(targetInfo)) { finish(resolve, targetInfo); } };
        const timer = setTimeout(() => finish(reject, new Error(`the browser at ${connection.url} did not open ${what} within ${limitMs / 1000} s`)), limitMs);
        stops.push(connection.on('Target.targetCreated', ({ targetInfo }) => look(targetInfo)));
        stops.push(connection.on('Target.targetInfoChanged', ({ targetInfo }) => look(targetInfo)));
        connection.closed.then((reason) => finish(reject, new Error(`${what}: ${reason}`)));
        connection.discoverTargets()
            .then(() => connection.send('Target.getTargets'))
            .then(({ targetInfos }) => targetInfos.forEach(look))
            .catch((error) => finish(reject, error));
    });
}

/**
 * The value of `expression` in a DevTools target: a session on a page or a frame, or a Node
 * inspector's connection; with `contextId`, in that execution context. An exception in the target
 * rejects with its description, as does a command that fails.
 */
export async function evaluate(target, expression, contextId) {
    const r = await target.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
    if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
}

/** A wait that reached its limit before its condition held. */
export class WaitLimitError extends Error {}

/**
 * Wait until `probe()` resolves to a truthy value, and return { value, ms }. probe runs again
 * `stepMs` after each falsy answer, and an error that it throws ends the wait with that error.
 * `limitMs` is the last resort for a condition that never holds: a timer that ends the wait with a
 * WaitLimitError naming `what`, also while a probe has not answered.
 */
export function waitUntil(probe, { what, limitMs, stepMs = 50 }) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        let done = false;
        let step;
        const finish = (settle, value) => {
            if (done) { return; }
            done = true;
            clearTimeout(limit);
            clearTimeout(step);
            settle(value);
        };
        const limit = setTimeout(() => finish(reject, new WaitLimitError(`${what} did not hold within ${limitMs / 1000} s`)), limitMs);
        const check = () => {
            Promise.resolve().then(probe).then((value) => {
                if (done) { return; }
                if (value) { finish(resolve, { value, ms: Date.now() - start }); } else { step = setTimeout(check, stepMs); }
            }, (error) => finish(reject, error));
        };
        check();
    });
}

/**
 * Wait until `expression` is truthy in `target` (in `contextId` when given), as waitUntil does:
 * an exception in the page ends the wait with that exception, and `limitMs` with a WaitLimitError.
 */
export function waitFor(target, expression, { what = expression, limitMs, stepMs, contextId } = {}) {
    return waitUntil(() => evaluate(target, expression, contextId), { what, limitMs, stepMs });
}

/** For a .catch() of a wait whose limit is a check's negative answer: undefined for a WaitLimitError, and any other error thrown again. */
export function notWithinLimit(error) {
    if (error instanceof WaitLimitError) { return undefined; }
    throw error;
}
