// Chrome can throttle an emulated background view to one frame per second even when its
// document is visible and focused. A native, one-pixel capture keeps its compositor active.
export async function keepRendering(session) {
    // Capture exists to keep native rendering active, not to record a video. Sparse encoding
    // avoids backpressure while a page evaluation awaits its own rendering callbacks.
    const everyNthFrame = 10000;
    const pending = new Set(), errors = [], evidence = { width: 1, height: 1, quality: 0, everyNthFrame, frames: 0, acknowledgments: 0 };
    let stopping = false, closed, stillPhase;
    const unsubscribe = session.on('Page.screencastFrame', event => {
        evidence.frames++;
        if (stopping) { return; }
        const phase = stillPhase && event.metadata?.timestamp >= stillPhase.startedAt ? stillPhase : undefined;
        const operation = session.send('Page.screencastFrameAck', { sessionId: event.sessionId })
            .then(() => {
                evidence.acknowledgments++;
                if (phase && !phase.acknowledged) { phase.acknowledged = { sessionId: event.sessionId, timestamp: event.metadata.timestamp,
                    metadata: event.metadata, data: event.data }; }
            }, error => { errors.push(error); });
        pending.add(operation); operation.finally(() => pending.delete(operation));
    });
    const close = () => closed ??= (async () => {
        stopping = true;
        try { await session.send('Page.stopScreencast'); } catch (error) { errors.push(error); }
        finally { if (typeof unsubscribe === 'function') { unsubscribe(); } }
        await Promise.all(pending);
        if (errors.length) { throw new AggregateError(errors, errors.map(String).join('\n')); }
        return evidence;
    })();
    try {
        await session.send('Page.startScreencast', { format: 'jpeg', quality: 0, maxWidth: 1, maxHeight: 1, everyNthFrame });
        return { evidence, close, async still({ width, height }) {
            if (![width, height].every(value => Number.isInteger(value) && value > 0)) { throw new Error('A bounded PNG viewport is required'); }
            if (stillPhase) { throw new Error('A still capture is already active'); }
            const phase = stillPhase = { startedAt: Infinity };
            let result, failure;
            try {
                const deadline = Date.now() + 2000;
                await session.send('Page.stopScreencast');
                await Promise.all(pending);
                phase.startedAt = Date.now() / 1000;
                await session.send('Page.startScreencast', { format: 'png', maxWidth: width, maxHeight: height, everyNthFrame: 1 });
                // A quiet view may have no fresh surface under sparse capture. Drain the first
                // native PNG frame and its same-session ACK before returning the still image.
                do {
                    const remaining = deadline - Date.now();
                    if (remaining <= 0) { throw new Error('Still capture did not receive a native frame'); }
                    await session.send('Runtime.evaluate', { expression: 'true', returnByValue: true }, { limitMs: remaining });
                    await Promise.all(pending);
                } while (!stillPhase.acknowledged);
                const { sessionId, timestamp, metadata, data } = stillPhase.acknowledged;
                if (metadata.deviceWidth !== width || metadata.deviceHeight !== height || metadata.pageScaleFactor !== 1) {
                    throw new Error('Native PNG frame does not match the requested viewport');
                }
                if (typeof data !== 'string' || !data) { throw new Error('Native PNG frame has no pixels'); }
                (evidence.stillFrames ??= []).push({ startedAt: stillPhase.startedAt, sessionId, timestamp, metadata });
                evidence.stillCaptures = (evidence.stillCaptures ?? 0) + 1;
                result = { data };
            } catch (error) { failure = error; }
            try {
                await session.send('Page.stopScreencast');
                await session.send('Page.startScreencast', { format: 'jpeg', quality: 0, maxWidth: 1, maxHeight: 1, everyNthFrame });
            } catch (error) {
                if (failure) { throw new AggregateError([failure, error], 'Still capture and sparse restart failed'); }
                throw error;
            } finally { if (stillPhase === phase) { stillPhase = undefined; } }
            if (failure) { throw failure; }
            return result;
        }, async refresh() {
            await session.send('Page.stopScreencast');
            await session.send('Page.startScreencast', { format: 'jpeg', quality: 0, maxWidth: 1, maxHeight: 1, everyNthFrame });
        } };
    } catch (error) {
        try { await close(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Rendering capture setup and cleanup failed'); }
        throw error;
    }
}
