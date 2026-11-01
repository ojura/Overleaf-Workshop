/**
 * The text of `error` for a message: an Error's message, with its cause's message when it has
 * one, as the failures of fetch have ("fetch failed: connect ECONNREFUSED ..."), else the value
 * as text (valueText). It imports nothing, so the PDF viewer pages use it too.
 */
export function errorMessage(error: unknown): string {
    const cause = (error as { cause?: { message?: unknown } } | undefined)?.cause?.message;
    const message = (error as { message?: unknown } | undefined)?.message ?? valueText(error);
    return cause ? `${message}: ${cause}` : String(message);
}

/**
 * A value without a message as text: an object as JSON, so that the fields of an error that a
 * server sent show; any other value, and an object that JSON cannot write (a cycle, a BigInt),
 * by String.
 */
function valueText(value: unknown): string {
    if (typeof value === 'object' && value !== null) {
        try { return JSON.stringify(value); } catch { /* String below */ }
    }
    return String(value);
}
