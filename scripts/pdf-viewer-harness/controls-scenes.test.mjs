import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { controlAssertions, collectHandleHits, installControlsScene, runScenario } from './controls-scenes.mjs';

const near = (a, b, tolerance = 0.05) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
const check = controlAssertions(assert.ok, near);
const leg = () => ({ at: 1200, offset: -50,
    column: { transition: { id: 3, startedAt: 300, durationMs: 2500, fromX: 0, toX: -106 } },
    pull: { actor: 11, phase: 'pull' }, forklift: { id: 4, outside: true } });
const quiet = at => ({ at, offset: -206, column: {}, panelMoving: false, columnMoving: false, pull: null,
    robotScheduled: false, labScheduled: false, robotFrames: 863, labFrames: 1273, forklift: { id: 4, outside: false } });

test('burst assertions retain the quiet interval and one immutable owned continuation', () => {
    const first = leg(), inputs = [10, 20, 30].map(at => ({ at, offset: 0, column: {} }));
    first.column.transition.startedAt = 330;
    check.firstLeg({ offset: 0 }, inputs, 30, first);
    const immediate = structuredClone(inputs); immediate[1].offset = -1;
    assert.throws(() => check.firstLeg({ offset: 0 }, immediate, 30, first), /before the quiet/);
    assert.throws(() => check.firstLeg({ offset: 0 }, inputs, 100, first), /quiet input interval/);
    check.heldLeg(first, structuredClone(first));
    const restarted = structuredClone(first); restarted.column.transition.startedAt++;
    assert.throws(() => check.heldLeg(first, restarted), /restarted/);
    const next = structuredClone(first); next.column.transition = { id: 4, startedAt: 2830, fromX: -106, toX: -206, durationMs: 2500 };
    check.continuation(first, next);
    next.forklift.id++;
    assert.throws(() => check.continuation(first, next), /same actor, lease/);
});

test('trusted-key assertions require a real shadow-owned event during the original pull', () => {
    const active = leg(), event = { key: 'ArrowLeft', trusted: true, ownsHandle: true, shadowFocus: true, before: structuredClone(active) };
    check.key(active, event, structuredClone(active));
    assert.throws(() => check.key(active, { ...event, trusted: false }, active), /native key/);
    assert.throws(() => check.key(active, { ...event, ownsHandle: false }, active), /native key/);
    const late = structuredClone(event); late.before.column.transition.id++;
    assert.throws(() => check.key(active, late, active), /original engaged leg/);
    const cancelled = structuredClone(active); cancelled.pull = null;
    assert.throws(() => check.key(active, event, cancelled), /cancelled or restarted/);
    const continuation = structuredClone(active);
    continuation.at = 2801; continuation.column.transition = { id: 4, startedAt: 2800, fromX: -106, toX: -115, durationMs: 2500 };
    check.key(active, event, continuation);
});

test('viewport and idle evidence reject immediate movement, unchanged feasibility and suspended wall time', () => {
    const before = { viewport: { width: 1800 }, offset: -106 };
    const event = { at: 100, trusted: true, size: { width: 2000 }, state: { offset: -106 } };
    const active = leg(); active.column.transition.startedAt = 400;
    check.viewport(before, event, { currentGapPx: -84, state: { column: {} } }, active);
    assert.throws(() => check.viewport(before, { ...event, state: { offset: -206 } }, { currentGapPx: -84, state: {} }, active), /snapped/);
    assert.throws(() => check.viewport(before, event, { currentGapPx: 16, state: {} }, active), /different clearance/);
    active.column.transition.startedAt = 120;
    assert.throws(() => check.viewport(before, event, { currentGapPx: -84, state: {} }, active), /calm/);
    check.idle(quiet(0), quiet(314), 20);
    assert.throws(() => check.idle(quiet(0), quiet(1000), 1), /actual rendering turns/);
    assert.throws(() => check.idle(quiet(0), { ...quiet(314), robotFrames: 864 }, 20), /continued painting/);
    assert.throws(() => check.idle(quiet(0), { ...quiet(314), forklift: { outside: true } }, 20), /lease/);
});

test('serialized hit check finds L-shaped arms and rejects an actual covering element', () => {
    const directions = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
    const nodes = directions.map((direction, i) => ({ dataset: { panelResize: direction }, tabIndex: 0,
        box: { x: i * 45, y: 0, width: 40, height: 40 }, getAttribute: () => 'Resize ' + direction }));
    const protectedNodes = ['.close', '.panel-drag'].map((selector, i) => ({ selector,
        box: { x: 400 + i * 45, y: 0, width: 30, height: 30 }, contains: () => false }));
    const host = { hidden: false, dataset: { dock: 'float' }, box: { x: 0, y: 0, width: 500, height: 80 } };
    const root = { querySelectorAll: () => nodes, querySelector: selector => protectedNodes.find(node => node.selector === selector),
        elementFromPoint(x, y) {
            return [...nodes, ...protectedNodes].find(node => x >= node.box.x && x < node.box.x + node.box.width
                && y >= node.box.y && y < node.box.y + node.box.height
                && (!node.dataset || x < node.box.x + 8 || y < node.box.y + 8));
        } };
    const win = { innerWidth: 600, innerHeight: 400, document: { elementFromPoint: () => host } };
    const collect = vm.runInNewContext('(' + collectHandleHits.toString() + ')');
    const h = { host, root, rect: node => node.box };
    const result = collect(win, h); check.hits(result);
    assert.ok(result.hits.every(hit => hit.hit.x < hit.rect.x + 8 || hit.hit.y < hit.rect.y + 8));
    win.document.elementFromPoint = () => ({ covered: true });
    assert.throws(() => check.hits(collect(win, h)), /reachable native hit/);
});

async function stoppedPageScene(mode) {
    const saved = { shown: false, reading: { page: 2, top: 500 }, focus: { body: true } };
    const viewport = { width: 1800, height: 1000, dpr: 1 }, timers = new Set();
    let rejectShow, restoration = 0, disposals = 0, settled;
    const done = new Promise(resolve => { settled = resolve; });
    const win = { performance: { now: () => 42 },
        setTimeout(callback, ms) { const id = setTimeout(() => { timers.delete(id); callback(); }, ms); timers.add(id); return id; },
        clearTimeout(id) { clearTimeout(id); timers.delete(id); } };
    const old = { near, capture: () => saved, read: () => ({ viewport }),
        show: () => new Promise((resolve, reject) => { rejectShow = reject; }),
        dispose() { disposals++; rejectShow?.(new Error('Pending probe disposed')); delete win.__pdfHarnessPanel; } };
    win.__pdfHarnessPanel = old;
    const install = current => { current.__pdfHarnessPanel = { read: () => ({ viewport }), until: async callback => callback(),
        async restore(value) { assert.equal(value, saved); restoration++; return { exactReading: true, exactPanel: true, exactFocus: true }; },
        dispose() { disposals++; delete current.__pdfHarnessPanel; settled(); } }; };
    const begin = vm.runInNewContext('(' + installControlsScene.toString() + ')');
    const ack = begin(win, { actionsMs: mode === 'deadline' ? 5 : 500, restoreMs: 100 }, install, controlAssertions, () => {}, 'case');
    assert.equal(ack.started, true); assert.equal(win.__pdfHarnessControls.status().finished, false);
    if (mode === 'stop') { win.__pdfHarnessControls.stop('Host lost acknowledgment'); }
    await done; await Promise.resolve();
    const final = win.__pdfHarnessControls.status();
    assert.equal(final.owner, 'case'); assert.equal(final.finished, true); assert.equal(final.result.status, 'failed');
    assert.equal(restoration, 1); assert.equal(disposals, 3); assert.equal(timers.size, 0);
    assert.equal(final.result.restoration.exactPanel, true);
    assert.equal(win.__pdfHarnessControls.dispose(), true); assert.equal(win.__pdfHarnessControls, undefined);
}

test('serialized scene acknowledges immediately and cancellation cancels waits before one restoration', () => stoppedPageScene('stop'));
test('serialized scene has a finite action deadline and no residual timer after recovery', () => stoppedPageScene('deadline'));

function hostFixture({ failExpansion = false, lostAck = false, foreign = false, failKeyDown = false, failKeyUp = false } = {}) {
    const calls = [], evidence = {}, owner = foreign ? 'another-owner' : 'receipt:pdfjs-controls';
    const result = { status: 'passed', restoration: { exactReading: true, exactPanel: true, exactFocus: true } };
    let phase = 'awaiting-trusted-key', present = true, stopped = 0, cleaned;
    const context = { options: { id: 'receipt' }, row: { tag: 'pdfjs-controls' }, config: { width: 1800, height: 1000, dpr: 1 },
        defer(label, callback) { return () => cleaned ??= callback(); },
        checkpoint(label, value) { evidence[label] = value; }, pause: async () => {},
        waitFor: async () => true,
        async evaluate(expression) {
            if (expression.startsWith('(')) { if (lostAck) { throw new Error('Initialization acknowledgment lost'); } return { started: true }; }
            if (expression.includes('.stop(')) { stopped++; phase = 'finished'; return true; }
            if (expression.includes('.dispose(')) { present = false; return true; }
            assert.ok(expression.includes('.status()'));
            return present ? { owner, phase, finished: phase === 'finished', result: phase === 'finished' ? result : undefined } : undefined;
        },
        async rpc(method, params) {
            calls.push({ method, params });
            if (method === 'Input.dispatchKeyEvent' && params.type === 'rawKeyDown' && failKeyDown) { throw new Error('Key down acknowledgment lost'); }
            if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp' && failKeyUp) { throw new Error('Key release failed'); }
            if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') { phase = 'awaiting-viewport-expansion'; }
            if (method === 'Emulation.setDeviceMetricsOverride') {
                if (params.width === 2000) {
                    phase = 'awaiting-viewport-restore';
                    if (failExpansion) { throw new Error('Viewport acknowledgment lost'); }
                } else { phase = 'finished'; }
            }
            return {};
        } };
    return { context, calls, evidence, stopped: () => stopped, present: () => present };
}

test('host sends one native key and target-local resize, then restores and disposes the same task', async () => {
    const f = hostFixture(); await runScenario(f.context);
    assert.deepEqual(f.calls.map(call => call.method), ['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent',
        'Emulation.setDeviceMetricsOverride', 'Emulation.setDeviceMetricsOverride']);
    assert.deepEqual(f.calls.slice(2).map(call => call.params.width), [2000, 1800]);
    assert.equal(f.evidence.controls.restoration.exactFocus, true); assert.equal(f.present(), false);
});

test('an uncertain resize acknowledgment is not replayed and cleanup restores its original metrics', async () => {
    const f = hostFixture({ failExpansion: true });
    await assert.rejects(runScenario(f.context), /Viewport acknowledgment lost/);
    assert.deepEqual(f.calls.filter(call => call.method === 'Emulation.setDeviceMetricsOverride').map(call => call.params.width), [2000, 1800]);
    assert.equal(f.present(), false);
});

test('lost initialization acknowledgment still cleans the matching task but leaves another owner alone', async () => {
    const own = hostFixture({ lostAck: true });
    await assert.rejects(runScenario(own.context), /Initialization acknowledgment lost/);
    assert.equal(own.stopped(), 1); assert.equal(own.present(), false);
    const other = hostFixture({ lostAck: true, foreign: true });
    await assert.rejects(runScenario(other.context), /Initialization acknowledgment lost/);
    assert.equal(other.stopped(), 0); assert.equal(other.present(), true);
});

test('native key and release failures both survive controls cleanup without another press', async () => {
    const f = hostFixture({ failKeyDown: true, failKeyUp: true });
    await assert.rejects(runScenario(f.context), error => error instanceof AggregateError
        && error.errors[0].message === 'Key down acknowledgment lost' && error.errors[1].message === 'Key release failed');
    assert.deepEqual(f.calls.map(call => call.params.type), ['rawKeyDown', 'keyUp']);
    assert.equal(f.stopped(), 1); assert.equal(f.present(), false);
});
