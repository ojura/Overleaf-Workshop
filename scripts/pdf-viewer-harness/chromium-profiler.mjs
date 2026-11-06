import assert from 'node:assert/strict';

export const CPU_SAMPLE_INTERVAL_US = 10000;

/** Keep native call-tree samples while replacing source URLs with their file names. */
export function sanitizeCpuProfile(profile) {
  assert.ok(profile && Array.isArray(profile.nodes) && profile.nodes.length <= 100000, 'Invalid native CPU profile nodes');
  assert.ok(Array.isArray(profile.samples) && profile.samples.length <= 1000000, 'Invalid native CPU profile samples');
  assert.ok(Array.isArray(profile.timeDeltas) && profile.timeDeltas.length === profile.samples.length, 'CPU sample durations differ');
  assert.ok([profile.startTime, profile.endTime].every(Number.isFinite) && profile.endTime >= profile.startTime, 'Invalid CPU profile interval');
  const ids = new Set();
  const nodes = profile.nodes.map(node => {
    assert.ok(Number.isSafeInteger(node.id) && !ids.has(node.id) && node.callFrame, 'Invalid CPU profile node');
    ids.add(node.id);
    let name = '';
    try { name = new URL(node.callFrame.url).pathname.split('/').pop() ?? ''; } catch {}
    if (!/^[A-Za-z0-9_.-]{1,100}\.(?:js|mjs|cjs|ts)$/.test(name)) { name = '(runtime)'; }
    return { ...node, callFrame: { ...node.callFrame, functionName: String(node.callFrame.functionName).slice(0, 240), url: name } };
  });
  assert.ok(profile.samples.every(id => ids.has(id)), 'CPU sample has no node');
  assert.ok(profile.timeDeltas.every(value => Number.isFinite(value) && value >= 0), 'Invalid CPU sample duration');
  return { ...profile, nodes };
}

export function cpuHotspots(profile) {
  const weights = new Map();
  profile.samples.forEach((id, index) => weights.set(id, (weights.get(id) ?? 0) + profile.timeDeltas[index]));
  return profile.nodes.filter(node => weights.has(node.id)).map(node => ({
    name: node.callFrame.functionName, file: node.callFrame.url, line: node.callFrame.lineNumber + 1,
    sampledMs: weights.get(node.id) / 1000,
  })).sort((a, b) => b.sampledMs - a.sampledMs).slice(0, 20);
}

function metrics(reply) {
  assert.ok(Array.isArray(reply?.metrics), 'Native performance metrics are unavailable');
  return Object.fromEntries(reply.metrics.filter(item => /^[A-Za-z][A-Za-z0-9]*$/.test(item.name)
    && Number.isFinite(item.value)).map(item => [item.name, item.value]));
}

/** Profile the runner's existing movement and release these domains before its session detaches. */
export async function withChromiumProfile(context, runMovement) {
  const evidence = { sampleIntervalUs: CPU_SAMPLE_INTERVAL_US, started: false, stopped: false,
    workCompleted: false, cleanupErrors: [] };
  let performanceOwned = false, profilerOwned = false, startAttempted = false;
  const cleanup = context.defer('chromium-profile', async () => {
    if (startAttempted) {
      try {
        const result = await context.rpc('Profiler.stop', {});
        evidence.stopped = true;
        const profile = sanitizeCpuProfile(result.profile);
        evidence.hotspots = cpuHotspots(profile);
        evidence.samples = profile.samples.length; evidence.nodes = profile.nodes.length;
        evidence.durationMs = (profile.endTime - profile.startTime) / 1000;
        evidence.profile = await context.writeArtifact('cpu', JSON.stringify(profile), 'cpuprofile');
      } catch (error) { evidence.cleanupErrors.push({ stage: 'Profiler.stop', error: String(error.message ?? error) }); }
    }
    if (profilerOwned) {
      try { await context.rpc('Profiler.disable', {}); }
      catch (error) { evidence.cleanupErrors.push({ stage: 'Profiler.disable', error: String(error.message ?? error) }); }
    }
    if (performanceOwned) {
      try { evidence.metricsAfter = metrics(await context.rpc('Performance.getMetrics', {})); }
      catch (error) { evidence.cleanupErrors.push({ stage: 'Performance.getMetrics', error: String(error.message ?? error) }); }
      try { await context.rpc('Performance.disable', {}); }
      catch (error) { evidence.cleanupErrors.push({ stage: 'Performance.disable', error: String(error.message ?? error) }); }
    }
    await context.checkpoint('profile', evidence);
    if (evidence.cleanupErrors.length) { throw new Error('Native profiling cleanup failed: ' + evidence.cleanupErrors.map(value => value.stage).join(', ')); }
  });
  let result, workError;
  try {
    performanceOwned = true;
    await context.rpc('Performance.enable', {});
    evidence.metricsBefore = metrics(await context.rpc('Performance.getMetrics', {}));
    profilerOwned = true;
    await context.rpc('Profiler.enable', {});
    await context.rpc('Profiler.setSamplingInterval', { interval: CPU_SAMPLE_INTERVAL_US });
    startAttempted = true;
    await context.rpc('Profiler.start', {});
    evidence.started = true;
    await context.checkpoint('profile-start', { sampleIntervalUs: CPU_SAMPLE_INTERVAL_US, metrics: evidence.metricsBefore });
    result = await runMovement();
    evidence.workCompleted = true;
  } catch (error) { workError = error; evidence.workError = String(error.message ?? error); }
  try { await cleanup(); }
  catch (error) {
    if (workError) { throw new AggregateError([workError, error], 'Movement and native profiling cleanup failed'); }
    throw error;
  }
  if (workError) { throw workError; }
  return result;
}
