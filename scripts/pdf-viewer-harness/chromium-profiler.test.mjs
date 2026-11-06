import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeCpuProfile, cpuHotspots, withChromiumProfile } from './chromium-profiler.mjs';

const profile = () => ({ startTime: 1000, endTime: 41000, nodes: [
  { id: 1, callFrame: { functionName: 'paint', url: 'http://127.0.0.1:8123/private/path/pdfjs.js?token=private', lineNumber: 9 } },
  { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
], samples: [1, 2, 1], timeDeltas: [10000, 10000, 20000] });

function fixture(fail) {
  const calls = [], artifacts = [], receipts = new Map(), cleanup = [];
  const active = { profile: false, performance: false }, result = { ready: true };
  const context = {
    async rpc(method, params) {
      calls.push({ method, params });
      if (method === 'Performance.enable') { active.performance = true; }
      if (method === 'Profiler.start') { active.profile = true; }
      if (method === fail) { throw new Error(method + ' reply was lost'); }
      if (method === 'Profiler.stop') { active.profile = false; return { profile: profile() }; }
      if (method === 'Profiler.disable') { active.profile = false; }
      if (method === 'Performance.disable') { active.performance = false; }
      if (method === 'Performance.getMetrics') { return { metrics: [{ name: 'TaskDuration', value: calls.length / 100 }] }; }
      return {};
    },
    defer(_label, fn) {
      let active = true;
      const run = async () => { if (active) { active = false; await fn(); } };
      cleanup.push(run); return run;
    },
    async checkpoint(label, value) { receipts.set(label, structuredClone(value)); },
    async writeArtifact(label, contents, extension) {
      artifacts.push({ label, value: JSON.parse(contents), extension }); return '/owned/case-cpu.cpuprofile';
    },
  };
  return { context, calls, active, artifacts, receipts, cleanup, result };
}

test('native CPU output keeps call-tree weights and strips URL paths and parameters', () => {
  const value = sanitizeCpuProfile(profile()), hotspots = cpuHotspots(value);
  assert.equal(value.nodes[0].callFrame.url, 'pdfjs.js');
  assert.equal(value.nodes[1].callFrame.url, '(runtime)');
  assert.equal(JSON.stringify(value).includes('private'), false);
  assert.deepEqual(hotspots.map(value => [value.name, value.sampledMs]), [['paint', 30], ['(idle)', 10]]);
  const invalid = profile(); invalid.timeDeltas.pop();
  assert.throws(() => sanitizeCpuProfile(invalid), /durations/);
});

test('profiles the existing movement callback once and releases native domains', async () => {
  const f = fixture(); let runs = 0;
  assert.equal(await withChromiumProfile(f.context, async () => { runs++; return f.result; }), f.result);
  assert.equal(runs, 1); assert.deepEqual(f.active, { profile: false, performance: false });
  assert.equal(f.calls.filter(value => value.method === 'Profiler.start').length, 1);
  assert.equal(f.calls.filter(value => value.method === 'Profiler.stop').length, 1);
  assert.equal(f.artifacts[0].extension, 'cpuprofile');
  assert.equal(f.receipts.get('profile').workCompleted, true);
  assert.ok(f.receipts.get('profile').metricsAfter.TaskDuration > f.receipts.get('profile').metricsBefore.TaskDuration);
  await f.cleanup[0]();
  assert.equal(f.calls.filter(value => value.method === 'Profiler.stop').length, 1);
});

test('movement failure still writes its profile and stops both owned domains', async () => {
  const f = fixture();
  await assert.rejects(withChromiumProfile(f.context, async () => { throw new Error('movement failed'); }), /movement failed/);
  assert.deepEqual(f.active, { profile: false, performance: false });
  assert.equal(f.receipts.get('profile').workCompleted, false);
  assert.equal(f.artifacts.length, 1);
});

test('a lost start acknowledgement is reconciled through one stop without repeating movement', async () => {
  const f = fixture('Profiler.start'); let runs = 0;
  await assert.rejects(withChromiumProfile(f.context, async () => { runs++; }), /reply was lost/);
  assert.equal(runs, 0);
  assert.equal(f.calls.filter(value => value.method === 'Profiler.start').length, 1);
  assert.equal(f.calls.filter(value => value.method === 'Profiler.stop').length, 1);
  assert.deepEqual(f.active, { profile: false, performance: false });
});

test('a stop failure still disables both domains and records the failed stage', async () => {
  const f = fixture('Profiler.stop');
  await assert.rejects(withChromiumProfile(f.context, async () => f.result), /cleanup failed/);
  assert.deepEqual(f.active, { profile: false, performance: false });
  assert.deepEqual(f.receipts.get('profile').cleanupErrors.map(value => value.stage), ['Profiler.stop']);
  await f.cleanup[0]();
  assert.equal(f.calls.filter(value => value.method === 'Profiler.stop').length, 1);
});
