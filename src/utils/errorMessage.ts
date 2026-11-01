/**
 * The text of `error` for a message: an Error's message, with its cause's message when it has
 * one, as the failures of fetch have ("fetch failed: connect ECONNREFUSED ..."), else the value
 * as text.
 */
export function errorMessage(error: unknown): string {
    const cause = (error as { cause?: { message?: unknown } } | undefined)?.cause?.message;
    const message = (error as { message?: unknown } | undefined)?.message ?? String(error);
    return cause ? `${message}: ${cause}` : String(message);
}
