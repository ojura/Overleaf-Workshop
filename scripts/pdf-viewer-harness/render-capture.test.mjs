import test from 'node:test';
import assert from 'node:assert/strict';
import { keepRendering } from './render-capture.mjs';

function fixture(fail) {
    const calls = []; let listener, removed = 0;
    return { calls, removed: () => removed, frame: (value, timestamp = Date.now() / 1000) => listener?.({ sessionId: value, data: 'native-png', metadata: { timestamp, deviceWidth: 1800, deviceHeight: 1000, pageScaleFactor: 1 } }),
        session: { on(method, fn) { assert.equal(method, 'Page.screencastFrame'); listener = fn; return () => { listener = undefined; removed++; }; },
            async send(method, params) { calls.push({ method, params }); if (fail?.(method)) { throw new Error(method + ' failed'); } } } };
}

test('native capture acknowledges exact frames and stops once before releasing its listener', async () => {
    const f = fixture(), capture = await keepRendering(f.session);
    f.frame(17); f.frame(18); await capture.close(); await capture.close();
    assert.deepEqual(f.calls.map(call => call.method), ['Page.startScreencast', 'Page.screencastFrameAck', 'Page.screencastFrameAck', 'Page.stopScreencast']);
    assert.deepEqual(f.calls.slice(1, 3).map(call => call.params.sessionId), [17, 18]);
    assert.equal(capture.evidence.acknowledgments, 2); assert.equal(f.removed(), 1);
});

test('uncertain capture start still stops and retained ACK errors fail cleanup', async () => {
    const start = fixture(method => method === 'Page.startScreencast');
    await assert.rejects(keepRendering(start.session), /Page.startScreencast failed/);
    assert.equal(start.calls.at(-1).method, 'Page.stopScreencast'); assert.equal(start.removed(), 1);
    const ack = fixture(method => method === 'Page.screencastFrameAck');
    const capture = await keepRendering(ack.session); ack.frame(23);
    await assert.rejects(capture.close(), error => error instanceof AggregateError && /FrameAck/.test(error.errors[0].message));
    assert.equal(ack.calls.at(-1).method, 'Page.stopScreencast'); assert.equal(ack.removed(), 1);
});

test('native PNG still capture rejects stale frames, awaits its ACK and restores sparse capture', async () => {
    const f = fixture(), send = f.session.send;
    f.session.send = async (method, params, options) => {
        await send(method, params, options);
        if (method === 'Page.startScreencast' && params.format === 'png') { f.frame(29, 0); f.frame(31); }
    };
    const capture = await keepRendering(f.session);
    assert.deepEqual(await capture.still({ width: 1800, height: 1000 }), { data: 'native-png' });
    assert.equal(capture.evidence.acknowledgments, 2);
    assert.equal(capture.evidence.stillFrames.at(-1).sessionId, 31);
    assert.equal(f.calls.at(-1).params.everyNthFrame, 10000);
    const failure = new Error('PNG drain failed'); let starts = 0;
    const original = f.session.send;
    f.session.send = async (method, params, options) => {
        if (method === 'Runtime.evaluate') { throw failure; }
        if (method === 'Page.startScreencast' && ++starts === 2) { throw new Error('sparse restart failed'); }
        return original(method, params, options);
    };
    await assert.rejects(capture.still({ width: 1800, height: 1000 }), error => {
        assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], failure);
        assert.match(error.errors[1].message, /sparse restart/); return true;
    });
    await capture.close(); assert.equal(f.removed(), 1);
});
