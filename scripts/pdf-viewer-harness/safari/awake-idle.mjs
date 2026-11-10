export const SAFARI_AWAKE_IDLE_MS = 1500;
export const SAFARI_MAX_FRAME_GAP_MS = 100;

// The caller owns each frame/timeout and cancellation. A suspended wall-clock
// interval earns no idle credit; after a large gap the observation starts again.
export async function observeAwakeIdle({ now, deadline, sample, canContinue, ready, frameCount, nextFrame }) {
  const began = now();
  let state = sample(), sampledAt = began, intervalStart, intervalFrames, previousAt;
  const idle = { durationMs: 0, observedMs: 0, maxGapMs: 0, framesAdded: 0, awake: false };
  try {
    while (canContinue() && now() < deadline) {
      const at = await nextFrame(Math.max(1, Math.min(1000, deadline - now())));
      if (!canContinue()) break;
      const gap = previousAt === undefined ? 0 : at - previousAt; previousAt = at;
      idle.maxGapMs = Math.max(idle.maxGapMs, gap);
      if (gap > SAFARI_MAX_FRAME_GAP_MS) intervalStart = undefined;
      if (at - sampledAt >= 200) { state = sample(); sampledAt = at; }
      const usable = ready(state);
      if (!usable || intervalFrames !== undefined && frameCount(state) !== intervalFrames) intervalStart = undefined;
      if (usable && intervalStart === undefined) { intervalStart = at; intervalFrames = frameCount(state); }
      idle.observedMs = intervalStart === undefined ? 0 : at - intervalStart;
      if (idle.observedMs >= SAFARI_AWAKE_IDLE_MS) {
        state = sample(); sampledAt = at;
        if (ready(state) && frameCount(state) === intervalFrames) { idle.awake = true; break; }
        intervalStart = undefined; idle.observedMs = 0;
      }
    }
  } catch (error) {
    if (now() < deadline) idle.error = String(error.message || error);
  }
  if (!idle.awake && now() >= deadline) {
    idle.deadlineExpired = true;
    idle.error = 'Continuous awake idle was not reached before the observation deadline';
  }
  idle.durationMs = now() - began;
  idle.framesAdded = intervalFrames === undefined ? 0 : frameCount(state) - intervalFrames;
  return { state, idle };
}
