/** Retry-After's seconds or HTTP date, measured from `now` (RFC 9110, section 10.2.3). */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
    const text = value?.trim();
    if (!text) { return undefined; }
    if (/^\d+$/.test(text)) {
        const milliseconds = Number(text) * 1000;
        return Number.isFinite(milliseconds) ? milliseconds : undefined;
    }
    const date = /[a-z]/i.test(text) ? Date.parse(text) : NaN;
    return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
