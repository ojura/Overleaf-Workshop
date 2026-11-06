import assert from 'node:assert/strict';
import test from 'node:test';
import { connectDaemon, evaluateHarness, HarnessProtocolError } from './scenario-connection.mjs';

function fixture(override = () => undefined) {
    const calls = [], events = [];
    const request = async (url, init) => {
        const parsed = new URL(url), body = init.body && JSON.parse(init.body);
        calls.push({ route: parsed.pathname, body });
        const custom = await override(parsed, body, init);
        if (custom) { return custom; }
        let value;
        if (parsed.pathname === '/status') { value = { connected: true, ['event_seq']: 2 }; }
        else if (parsed.pathname === '/events') { value = events.filter(event => event.seq > Number(parsed.searchParams.get('since'))); }
        else if (parsed.pathname === '/attach') { value = { sessionId: 'owned-session' }; }
        else if (parsed.pathname === '/prepare' || parsed.pathname === '/release') { value = { ready: true }; }
        else { value = { result: {} }; }
        return Response.json(value);
    };
    return { request, calls, events };
}

test('daemon owns preparation while the client drains exact-session events and releases before detach', async () => {
    const f = fixture(), browser = await connectDaemon('http://127.0.0.1:7799', f);
    const session = await browser.attach('fixture-target'), parsed = [];
    session.on('Debugger.scriptParsed', event => parsed.push(event.scriptId));
    await session.prepare();
    f.events.push({ seq: 3, method: 'Debugger.scriptParsed', sessionId: 'another-session', params: { scriptId: 'other' } },
        { seq: 4, method: 'Debugger.scriptParsed', sessionId: 'owned-session', params: { scriptId: 'entry' } });
    await session.send('Debugger.enable');
    assert.deepEqual(parsed, ['entry']);
    await session.detach(); await session.detach(); browser.close();
    const mutations = f.calls.filter(call => call.body);
    assert.deepEqual(mutations.map(call => call.body.method ?? call.route),
        ['/attach', '/prepare', 'Debugger.enable', '/release', 'Target.detachFromTarget']);
    assert.equal(mutations[1].body.readiness, 'animation');
    assert.ok(mutations.every(call => call.body.method !== 'Emulation.setFocusEmulationEnabled'));
    await assert.rejects(session.send('Page.reload'), /closed/);
});

test('native error details, page exceptions and uncertain timeouts remain distinct without replay', async () => {
    const f = fixture((url, body) => {
        if (body?.method === 'Page.reload') { return Response.json({ error: { code: -32000, message: 'Native rejected', data: { phase: 'dispatch' } } }, { status: 500 }); }
        if (body?.method === 'Page.navigate') { return Response.json({ error: 'TimeoutError: Page.navigate timed out after 8s' }, { status: 500 }); }
        if (body?.method === 'Runtime.evaluate') { return Response.json({ result: { exceptionDetails: { text: 'Uncaught', lineNumber: 7, exception: { description: 'page failed' } } } }); }
    });
    const browser = await connectDaemon('http://127.0.0.1:7799', f), session = await browser.attach('fixture');
    await assert.rejects(session.send('Page.reload'), error => error instanceof HarnessProtocolError
        && error.kind === 'protocol' && error.details.error.data.phase === 'dispatch');
    await assert.rejects(session.send('Page.navigate'), error => error.kind === 'timeout' && error.details.commandMayHaveRun);
    await assert.rejects(evaluateHarness(session, 'throw new Error()'), error => error.kind === 'javascript' && error.details.lineNumber === 7);
    assert.equal(f.calls.filter(call => call.body?.method === 'Page.navigate').length, 1);
    await session.detach(); browser.close();
});

test('release failure still detaches the work session and preserves its preparation error', async () => {
    const f = fixture(url => url.pathname === '/release'
        ? Response.json({ error: { kind: 'stale_session', stage: 'release', message: 'replaced' } }, { status: 500 }) : undefined);
    const browser = await connectDaemon('http://127.0.0.1:7799', f), session = await browser.attach('fixture');
    browser.close('deadline');
    await assert.rejects(session.detach(), error => error instanceof AggregateError && error.errors[0].kind === 'preparation');
    assert.equal(f.calls.at(-1).body.method, 'Target.detachFromTarget');
});

test('an attach acknowledgment after abandonment cleans only its returned work session', async () => {
    let complete;
    const f = fixture(url => url.pathname === '/attach' ? new Promise(resolve => { complete = resolve; }) : undefined);
    const browser = await connectDaemon('http://127.0.0.1:7799', f), pending = browser.attach('fixture');
    await Promise.resolve(); await Promise.resolve();
    browser.close('caller deadline'); complete(Response.json({ sessionId: 'late-owned' }));
    await assert.rejects(pending, /caller deadline/);
    assert.deepEqual(f.calls.filter(call => call.body).slice(-2).map(call => call.body.sessionId ?? call.body.params?.sessionId), ['late-owned', 'late-owned']);
    assert.deepEqual(browser.cleanupFailures, []);
});

test('a missing daemon event interval fails the source evidence instead of accepting a partial stream', async () => {
    const f = fixture(), browser = await connectDaemon('http://127.0.0.1:7799', f), session = await browser.attach('fixture');
    f.events.push({ seq: 4, method: 'Debugger.scriptParsed', sessionId: 'owned-session', params: { scriptId: 'entry' } });
    await assert.rejects(session.send('Debugger.enable'), error => error.kind === 'event-gap' && error.details.after === 2);
    await session.detach(); browser.close();
});

test('abandonment during the post-attach event drain releases the known session before returning', async () => {
    let deliver, draining, adopted;
    const atDrain = new Promise(resolve => { draining = resolve; });
    const f = fixture(url => url.pathname === '/events' ? new Promise(resolve => { deliver = resolve; draining(); }) : undefined);
    const browser = await connectDaemon('http://127.0.0.1:7799', f);
    const pending = browser.attach('fixture').then(session => { adopted = session; return session; });
    await atDrain; browser.close('caller deadline during event drain'); deliver(Response.json([]));
    try { await assert.rejects(pending, /caller deadline during event drain/); }
    finally { await adopted?.detach(); }
    assert.equal(adopted, undefined);
    assert.deepEqual(f.calls.filter(call => call.body).map(call => call.body.method ?? call.route),
        ['/attach', '/release', 'Target.detachFromTarget']);
});
