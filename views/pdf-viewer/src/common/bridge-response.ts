/** Native response bodies whose bytes arrived in one private host message. */
const ownedBodies = new WeakSet<ReadableStream<Uint8Array>>();

/**
 * A BufferSource passed to Response is copied. The host has already delivered an
 * owned byte array, so transfer it into a native byte stream instead. Its old
 * buffer is detached; callers must account for the bytes before this call.
 */
export function createBridgeResponse(bytes: Uint8Array | null, init: ResponseInit): Response {
    if (bytes === null) { return new Response(null, init); }
    if (!(bytes.buffer instanceof ArrayBuffer)) { throw new TypeError('The host response must own an ArrayBuffer'); }
    // Constructing a view rejects a detached buffer, including a detached empty view.
    const chunk = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const stream = new ReadableStream({
        type: 'bytes',
        start(controller) {
            if (chunk.byteLength) { controller.enqueue(chunk); }
            controller.close();
        },
    });
    const response = new Response(stream, init);
    ownedBodies.add(response.body!);
    return response;
}

/**
 * Overleaf's pinned loader immediately consumes these complete range/piece bodies.
 * Reading the original one-chunk stream avoids arrayBuffer's second byte copy.
 * Native Response still owns body use, locking, cancellation and cloning: clone()
 * replaces the original stream with a tee branch, which is deliberately unmarked.
 */
export async function readPdfResponse(response: Response): Promise<ArrayBuffer> {
    const body = response.body;
    if (!body || body.locked || response.bodyUsed || !ownedBodies.delete(body)) {
        return response.arrayBuffer();
    }
    const reader = body.getReader();
    try {
        const first = await reader.read();
        if (first.done) { return new ArrayBuffer(0); }
        const end = await reader.read();
        if (!(first.value instanceof Uint8Array) || !end.done) {
            await reader.cancel();
            throw new TypeError('The host response is not a single byte chunk');
        }
        const bytes = first.value;
        if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
            return bytes.buffer;
        }
        // A view may expose only part of a larger message buffer. Never return its neighbours.
        return new Uint8Array(bytes).buffer;
    } finally {
        reader.releaseLock();
    }
}
