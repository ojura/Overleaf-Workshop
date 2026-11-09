import { constants } from 'http2';
import { setTimeout as sleep } from 'timers/promises';

export const HTTP_RETRIES = 2;
const retryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 4000);

/** An HTTP answer that the caller could not use, after consuming or cancelling its body. */
export class HttpResponseError extends Error {
    constructor(readonly status: number, message: string, readonly retryAfterMs?: number) {
        super(message);
    }
}

/** The server's requested pause exceeds the caller's existing server-wait allowance. */
export class HttpBackoffError extends Error {
    constructor(readonly retryAfterMs: number | undefined, maximumWaitMs: number) {
        super(retryAfterMs === undefined
            ? `Waiting for the server to recover exceeded the ${maximumWaitMs / 1000} s allowance.`
            : `The server asks to wait ${Math.ceil(retryAfterMs / 1000)} s before another request, `
                + `longer than the ${maximumWaitMs / 1000} s allowed for waiting for the server.`);
    }
}

/** Undici preserves Node's stream reset code on the cause of a fetch/body error. */
export function http2ErrorCode(error: unknown): number | undefined {
    const seen = new Set<unknown>();
    while (error !== null && typeof error === 'object' && !seen.has(error)) {
        seen.add(error);
        const detail = error as {http2ErrorCode?: unknown, cause?: unknown};
        if (typeof detail.http2ErrorCode === 'number') { return detail.http2ErrorCode; }
        error = detail.cause;
    }
    return undefined;
}

interface Congestion {
    resumeAt: number;
    failures: number;
    revision: number;
    probe?: Promise<void>;
}

interface Permit {
    state?: Congestion;
    revision?: number;
    release(): void;
}

interface Clock {
    now(): number;
    wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Retry eligible operations and share server backpressure by origin. After overload, one
 * request checks recovery while the others wait. Its permit lasts through body consumption,
 * and an answer from a request sent before the overload cannot release the pause.
 */
export class HttpRequestRetry {
    private readonly origins = new Map<string, Congestion>();

    constructor(private readonly clock: Clock = {
        now: () => Date.now(),
        wait: (milliseconds, signal) => sleep(milliseconds, undefined, {signal}),
    }) {}

    async run<T>(url: string, send: (observe: (error: HttpResponseError) => void) => Promise<T>, options: {
        retries: number;
        maximumWaitMs: number;
        retrying?: (error: unknown, attempt: number) => void;
    }): Promise<T> {
        const origin = new URL(url).origin;
        for (let attempt = 0; ; attempt++) {
            const permit = await this.admit(origin, options.maximumWaitMs);
            let failure: unknown;
            let overloaded = false;
            let observed: HttpResponseError | undefined;
            try {
                const value = await send(error => {
                    if (this.overloaded(error)) {
                        this.pause(origin, permit, error.retryAfterMs);
                        observed = error;
                    }
                });
                this.recovered(origin, permit);
                return value;
            } catch (error) {
                failure = error;
                overloaded = this.overloaded(error);
                if (error !== observed && (overloaded || (permit.state && this.transient(error)))) {
                    this.pause(origin, permit, error instanceof HttpResponseError ? error.retryAfterMs : undefined);
                } else if (error instanceof HttpResponseError) {
                    this.recovered(origin, permit);
                }
            } finally {
                permit.release();
            }
            if (attempt >= options.retries || !this.transient(failure)) { throw failure; }
            options.retrying?.(failure, attempt + 1);
            // Overload waits at admission, including requests started by other API clients.
            if (!overloaded) { await this.clock.wait(retryDelay(attempt)); }
        }
    }

    private overloaded(error: unknown): boolean {
        return http2ErrorCode(error) === constants.NGHTTP2_ENHANCE_YOUR_CALM
            || (error instanceof HttpResponseError
                && (error.status === 429 || error.status === 503));
    }

    private transient(error: unknown): boolean {
        if (error instanceof HttpBackoffError) { return false; }
        return !(error instanceof HttpResponseError) || error.status >= 500 || error.status === 429;
    }

    private pause(origin: string, permit: Permit, requestedMs?: number) {
        let state = this.origins.get(origin);
        if (!state) {
            state = {resumeAt: 0, failures: 0, revision: 0};
            this.origins.set(origin, state);
        } else if (permit.state === state && permit.revision === state.revision) {
            state.failures++;
        }
        state.resumeAt = Math.max(state.resumeAt, this.clock.now() + (requestedMs ?? retryDelay(state.failures)));
        state.revision++;
    }

    private recovered(origin: string, permit: Permit) {
        if (permit.state && this.origins.get(origin) === permit.state && permit.revision === permit.state.revision) {
            this.origins.delete(origin);
        }
    }

    private async admit(origin: string, maximumWaitMs: number): Promise<Permit> {
        const deadline = this.clock.now() + maximumWaitMs;
        for (;;) {
            const state = this.origins.get(origin);
            if (!state) { return {release() {}}; }
            const delay = Math.max(0, state.resumeAt - this.clock.now());
            const remaining = Math.max(0, deadline - this.clock.now());
            if (delay > remaining) { throw new HttpBackoffError(delay, maximumWaitMs); }
            if (delay > 0) {
                await this.clock.wait(delay);
                continue;
            }
            if (state.probe) {
                if (!remaining) { throw new HttpBackoffError(undefined, maximumWaitMs); }
                const stop = new AbortController();
                try {
                    const completed = await Promise.race([
                        state.probe.then(() => true),
                        this.clock.wait(remaining, stop.signal).then(() => false),
                    ]);
                    if (!completed) { throw new HttpBackoffError(undefined, maximumWaitMs); }
                } finally {
                    stop.abort();
                }
                continue;
            }
            let complete!: () => void;
            const probe = new Promise<void>(resolve => { complete = resolve; });
            state.probe = probe;
            return {
                state, revision: state.revision,
                release: () => {
                    if (state.probe === probe) { state.probe = undefined; }
                    complete();
                },
            };
        }
    }
}

/** Shared by API instances and their ordinary, compile and download dispatchers. */
export const apiRequests = new HttpRequestRetry();
