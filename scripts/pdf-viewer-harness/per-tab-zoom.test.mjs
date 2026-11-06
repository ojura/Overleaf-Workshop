import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pageZoomOwner, normalizeTabZoom } from './per-tab-zoom.mjs';

function fixture() {
    let factor = 1.25, settings = { mode: 'automatic', scope: 'per-origin' }, fail, settingsGate;
    const listeners = new Set(), writes = [];
    const chrome = { debugger: { async getTargets() { return [{ id: 'owned', tabId: 7 }, { id: 'other', tabId: 8 }]; } },
        tabs: { async getZoom() { return factor; }, async getZoomSettings() { await settingsGate; return { ...settings }; },
            async setZoomSettings(tab, value) { writes.push({ tab, settings: value }); if (fail) { throw new Error(fail); }
                settings = { ...value }; if (value.scope === 'per-origin') { factor = 1.5; } },
            async setZoom(tab, value) { writes.push({ tab, factor: value }); if (fail) { throw new Error(fail); } factor = value; },
            onUpdated: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } } } };
    const context = vm.createContext({ chrome });
    const rawCall = vm.runInContext('(' + pageZoomOwner.toString() + ')', context);
    const call = (action, target) => rawCall(action, target, 'fixture-owner');
    return { call, writes, listeners, evaluate: expression => vm.runInContext(expression, context),
        navigate(tab) { factor = 1.25; for (const fn of listeners) { fn(tab, { status: 'complete' }); } },
        blockSettings(value) { settingsGate = value; },
        fail(value) { fail = value; } };
}

test('normalizes only the exact tab after navigation and restores current inherited origin zoom', async () => {
    const f = fixture();
    const installed = await f.call('install', 'owned');
    assert.equal(installed.original.factor, 1.25); assert.equal(installed.current.factor, 1);
    const stable = f.writes.length; await f.call('ensure', 'owned'); assert.equal(f.writes.length, stable);
    const before = f.writes.length; f.navigate(8); await Promise.resolve(); assert.equal(f.writes.length, before);
    f.navigate(7); await Promise.resolve(); assert.equal(f.writes.length, before);
    assert.equal((await f.call('ensure', 'owned')).current.factor, 1);
    const restored = await f.call('close', 'owned');
    assert.equal(restored.restored.factor, 1.5); assert.equal(f.listeners.size, 0);
    assert.ok(f.writes.every(write => write.tab === 7));
    assert.equal(f.writes.at(-1).settings.scope, 'per-origin');
    await assert.rejects(f.call('ensure', 'owned'), /unavailable/);
});

test('zoom API failure remains explicit and cleanup restores settings', async () => {
    const f = fixture(); await f.call('install', 'owned'); f.fail('tab closed'); f.navigate(7);
    await assert.rejects(f.call('ensure', 'owned'), /tab closed/);
    await assert.rejects(f.call('close', 'owned'), /tab closed/);
    assert.equal(f.listeners.size, 0);
});

test('missing target mapping and duplicate owners fail before changing another tab', async () => {
    const f = fixture(); await assert.rejects(f.call('install', 'missing'), /exact fixture tab/); assert.equal(f.writes.length, 0);
    await f.call('install', 'owned'); await assert.rejects(f.call('install', 'owned'), /already has a zoom owner/);
    await f.call('close', 'owned');
});

function browserFixture(f, behavior) {
    let detached = 0;
    const session = { async send(method, params) {
        const value = await f.evaluate(params.expression);
        await behavior?.(params.expression);
        return { result: { value } };
    }, async detach() { detached++; } };
    return { browser: { async send() { return { targetInfos: [{ targetId: 'helper', type: 'other', url: 'chrome-extension://fixture/bridge.html' }] }; },
        async attach() { return session; } }, detached: () => detached };
}

test('an install response lost after mutation still restores settings', async () => {
    const f = fixture(), error = new Error('Install response timeout');
    const b = browserFixture(f, expression => { if (expression.includes(')("install","owned",')) { throw error; } });
    await assert.rejects(normalizeTabZoom(b.browser, 'helper', 'owned'), value => value === error);
    assert.equal(f.listeners.size, 0); assert.equal(b.detached(), 1);
    assert.equal(f.writes.at(-1).settings.scope, 'per-origin');
});

test('a lost helper context retains both setup and cleanup errors and detaches its session', async () => {
    const f = fixture(), setup = new Error('Install response timeout'), cleanup = new Error('Helper context lost');
    let installed = false;
    const b = browserFixture(f, () => { if (!installed) { installed = true; throw setup; } throw cleanup; });
    await assert.rejects(normalizeTabZoom(b.browser, 'helper', 'owned'), error => {
        assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], setup); assert.equal(error.errors[1], cleanup); return true;
    });
    assert.equal(b.detached(), 1);
});


test('a duplicate wrapper installation cannot close another invocation owner', async () => {
    const f = fixture(); await f.call('install', 'owned'); const writes = f.writes.length;
    const b = browserFixture(f);
    await assert.rejects(normalizeTabZoom(b.browser, 'helper', 'owned'), error => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[0].message, /already has a zoom owner/);
        assert.match(error.errors[1].message, /another invocation/); return true;
    });
    assert.equal(b.detached(), 1); assert.equal(f.writes.length, writes);
    assert.equal((await f.call('ensure', 'owned')).current.factor, 1);
    await f.call('close', 'owned');
});


test('reservation rejects overlapping installs and close before initialization prevents late mutation', async () => {
    const f = fixture(); let release;
    f.blockSettings(new Promise(resolve => { release = resolve; }));
    const installing = f.call('install', 'owned');
    await Promise.resolve();
    await assert.rejects(f.call('install', 'owned'), /already has a zoom owner/);
    const closing = f.call('close', 'owned');
    assert.equal(f.writes.length, 0);
    release();
    const [installed, restored] = await Promise.all([installing, closing]);
    assert.equal(installed.current.factor, 1.25); assert.equal(restored.restored.factor, 1.25);
    assert.equal(f.writes.length, 0);
    await assert.rejects(f.call('ensure', 'owned'), /unavailable/);
    await f.call('install', 'owned'); await f.call('close', 'owned');
});
