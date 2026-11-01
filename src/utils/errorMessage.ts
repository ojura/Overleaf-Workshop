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
 * The longest JSON text of a value without a message that errorMessage gives whole: a longer one
 * is cut there, so that a notification, a viewer's line and the command-line tools' output stay
 * readable, and the text says so.
 */
export const ERROR_JSON_LIMIT = 300;

/**
 * A value without a message as text: an object as JSON, so that the fields of an error that a
 * server sent show, cut at ERROR_JSON_LIMIT; any other value, and an object that JSON cannot
 * write (a cycle, a BigInt) or gives no text for, by String.
 */
function valueText(value: unknown): string {
    if (typeof value === 'object' && value !== null) {
        let json: string | undefined;
        try { json = JSON.stringify(value); } catch { /* String below */ }
        if (json !== undefined) {
            return json.length > ERROR_JSON_LIMIT ? `${json.slice(0, ERROR_JSON_LIMIT)} [cut to ${ERROR_JSON_LIMIT} of ${json.length} characters]` : json;
        }
    }
    return String(value);
}
