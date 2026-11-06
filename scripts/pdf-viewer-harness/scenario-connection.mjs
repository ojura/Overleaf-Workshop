// One client of the owner's persistent CDP daemon. Importing this file does not connect.
// The daemon owns browser focus/visibility preparation; this client owns only its fresh work
// session. Closing the client never reconnects or shuts down the shared daemon.
export class HarnessProtocolError extends Error {
    constructor(kind, method, details, cause) {
        super(`${method}: ${kind}: ${typeof details === 'string' ? details : JSON.stringify(details)}`, { cause });
        this.name = 'HarnessProtocolError';
        this.kind = kind;
        this.method = method;
        this.details = details;
    }
    toJSON() { return { name: this.name, kind: this.kind, method: this.method, details: this.details }; }
}

export async function evaluateHarness(target, expression, options) {
    const result = await target.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, options);
    if (result.exceptionDetails) {
        throw new HarnessProtocolError('javascript', 'Runtime.evaluate', result.exceptionDetails);
    }
    return result.result?.value;
}

/**
 * The same send/on/attach/close interface as scripts/lib/devtools.mjs. HTTP calls and event
 * drains are sequential; there is no background polling or second browser WebSocket.
 * Each command gets one bounded response wait. A timed-out command is never replayed.
 */
export async function connectDaemon(url, { request = fetch, limitMs = 10000 } = {}) {
    let closed;
    const listeners = new Map();
    const sessions = new Set();
    let cursor, queue = Promise.resolve();
    const failures = [];
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
        || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
        throw new Error('The CDP daemon must be an explicit local HTTP origin');
    }
    if (!Number.isFinite(limitMs) || limitMs < 1000) { throw new Error('A bounded daemon request budget is required'); }
    const nativeSeconds = ms => Math.max(0.01, (ms - Math.min(2000, ms / 4)) / 1000);
    async function http(route, body, method, ms = limitMs) {
        let response;
        try {
            response = await request(endpoint.origin + route, {
                method: body === undefined ? 'GET' : 'POST',
                ...(body === undefined ? {} : { headers: { ['Content-Type']: 'application/json' }, body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(ms),
            });
        } catch (error) {
            const kind = ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'transport';
            throw new HarnessProtocolError(kind, method, { message: error.message, commandMayHaveRun: body !== undefined }, error);
        }
        let value;
        try { value = await response.json(); }
        catch (error) { throw new HarnessProtocolError('response', method, { status: response.status, message: error.message }, error); }
        if (!response.ok || value?.error) {
            const details = value?.error ?? value;
            const kind = typeof details === 'string' && /TimeoutError:|timed out/i.test(details) ? 'timeout'
                : details?.kind ? 'preparation' : details?.code !== undefined ? 'protocol' : 'transport';
            throw new HarnessProtocolError(kind, method, { status: response.status, error: details,
                ...(kind === 'timeout' ? { commandMayHaveRun: body !== undefined } : {}) });
        }
        return value;
    }
    const status = await http('/status', undefined, 'daemon status');
    if (!status.connected || !Number.isSafeInteger(status.event_seq)) {
        throw new HarnessProtocolError('transport', 'daemon status', { connected: status.connected, state: status.state });
    }
    cursor = status.event_seq;
    const on = (method, callback, sessionId = '') => {
        const key = sessionId + '|' + method;
        if (!listeners.has(key)) { listeners.set(key, new Set()); }
        listeners.get(key).add(callback);
        return () => listeners.get(key)?.delete(callback);
    };
    async function drain(ms = limitMs) {
        if (ms <= 0) { throw new HarnessProtocolError('timeout', 'daemon events', 'No response budget remains'); }
        const events = await http('/events?since=' + cursor + '&limit=10000', undefined, 'daemon events', ms);
        if (!Array.isArray(events)) { throw new HarnessProtocolError('response', 'daemon events', 'Expected a native event array'); }
        for (const event of events) {
            if (event.seq !== cursor + 1) {
                throw new HarnessProtocolError('event-gap', 'daemon events', { after: cursor, next: event.seq });
            }
            cursor = event.seq;
            for (const callback of listeners.get((event.sessionId ?? '') + '|' + event.method) ?? []) {
                callback(event.params);
            }
        }
    }
    function sequential(operation) {
        const result = queue.then(operation);
        queue = result.catch(() => {});
        return result;
    }
    const checkOpen = method => { if (closed) { throw new HarnessProtocolError('closed', method, closed); } };
    const native = async (method, params, sessionId, ms = limitMs) => {
        const value = await http('/cdp', { method, params, ...(sessionId ? { sessionId } : {}),
            ['timeout_seconds']: nativeSeconds(ms) }, method, ms);
        return value.result;
    };
    const send = (method, params = {}, sessionId, budget = {}) => sequential(async () => {
        checkOpen(method);
        if (sessionId && !sessions.has(sessionId)) { throw new HarnessProtocolError('closed', method, 'Work session is detached'); }
        const started = Date.now(), ms = Math.min(30000, budget.limitMs ?? limitMs);
        const value = await native(method, params, sessionId, ms);
        await drain(ms - (Date.now() - started));
        checkOpen(method);
        return value;
    });
    const attach = targetId => sequential(async () => {
        checkOpen('Target.attachToTarget');
        // /attach has a native 15-second wait in the installed daemon. Keep the HTTP wait
        // longer so a returned session ID remains available for cleanup after a caller timeout.
        const { sessionId } = await http('/attach', { targetId }, 'Target.attachToTarget', 17000);
        if (typeof sessionId !== 'string' || !sessionId) { throw new HarnessProtocolError('response', 'Target.attachToTarget', 'Missing work session ID'); }
        sessions.add(sessionId);
        let detached;
        const detach = () => detached ??= (async () => {
            const errors = [];
            try { await http('/release', { sessionId, ['timeout_seconds']: nativeSeconds(limitMs) }, 'Release page', limitMs); }
            catch (error) { errors.push(error); }
            try { await native('Target.detachFromTarget', { sessionId }, undefined); }
            catch (error) { errors.push(error); }
            finally { sessions.delete(sessionId); }
            if (errors.length) { throw new AggregateError(errors, errors.map(error => String(error)).join('\n')); }
        })();
        const session = { sessionId, targetId,
            send: (method, params, budget) => send(method, params, sessionId, budget),
            on: (method, callback) => on(method, callback, sessionId),
            prepare: () => sequential(async () => {
                checkOpen('Prepare page');
                const started = Date.now();
                const value = await http('/prepare', { sessionId, readiness: 'animation', ['timeout_seconds']: nativeSeconds(limitMs) }, 'Prepare page');
                await drain(limitMs - (Date.now() - started));
                checkOpen('Prepare page');
                return value;
            }),
            detach: () => sequential(detach),
        };
        if (closed) {
            try { await detach(); } catch (error) { failures.push(error); }
            throw new HarnessProtocolError('closed', 'Target.attachToTarget', closed);
        }
        try { await drain(); checkOpen('Target.attachToTarget'); }
        catch (error) {
            try { await detach(); }
            catch (cleanup) { throw new AggregateError([error, cleanup], String(error) + '\n' + String(cleanup)); }
            throw error;
        }
        return session;
    });
    return { url: endpoint.origin, transport: 'daemon', send: (method, params, budget) => send(method, params, undefined, budget),
        on: (method, callback) => on(method, callback), attach, cleanupFailures: failures,
        close(reason = 'Work client closed') { closed ??= String(reason); listeners.clear(); },
    };
}
