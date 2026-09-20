"use strict";

const MIN_TARGET_HZ = 60;
const MAX_TARGET_HZ = 960;
const MIN_DISPLAY_HZ = 30;
const MAX_DISPLAY_HZ = 500;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finiteOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * Fixed-step simulation budgeter used by the patched Kirka update call.
 *
 * The game's outer callback remains in charge of scheduling/rendering. This
 * clock only subdivides the elapsed outer-frame time into bounded fixed slices,
 * so a 480 Hz setting on a 240 Hz display executes two 1/480 s simulation
 * updates per presentation instead of one variable update. Catch-up debt is
 * capped to prevent a focus switch or long task from causing a spiral.
 */
function createSimulationClock(options = {}) {
  const scope = options.scope || globalThis;
  const now = options.now || (() => scope.performance.now());

  let lastTimestamp = 0;
  let accumulatorSeconds = 0;
  let targetHz = MIN_TARGET_HZ;
  let configuredDisplayHz = 60;
  let observedDisplayHz = 0;
  let lastPresentationAt = 0;
  let presentationPeriodMs = 0;

  const stats = {
    advances: 0,
    simulationSteps: 0,
    lastSteps: 0,
    droppedDebtMs: 0,
    resets: 0,
    targetHz,
    displayHz: configuredDisplayHz,
    observedDisplayHz: 0,
    fixedStepMs: 1000 / targetHz,
    phaseAgeMs: null,
    mode: "variable-60",
  };

  const invoke = (receiver, method, dtSeconds, timeScale) => {
    if (!receiver) return false;
    const fn = typeof method === "function" ? method : receiver[method];
    if (typeof fn !== "function") return false;
    fn.call(receiver, dtSeconds * timeScale);
    return true;
  };

  const reset = (timestamp = now()) => {
    const numericTimestamp = Number(timestamp);
    const value = Number.isFinite(numericTimestamp) ? numericTimestamp : now();
    lastTimestamp = value;
    accumulatorSeconds = 0;
    scope.__lastMainDelta = value;
    scope.__dawnTickDt = 0;
    scope.__dawnTickSteps = 0;
    stats.lastSteps = 0;
    stats.resets++;
  };

  const observePresentation = (timestamp) => {
    const value = finiteOr(timestamp, 0);
    if (!value) return;
    if (lastPresentationAt) {
      const interval = value - lastPresentationAt;
      if (interval >= 2 && interval <= 40) {
        presentationPeriodMs = presentationPeriodMs
          ? presentationPeriodMs * 0.9 + interval * 0.1
          : interval;
        observedDisplayHz = clamp(1000 / presentationPeriodMs, MIN_DISPLAY_HZ, MAX_DISPLAY_HZ);
        stats.observedDisplayHz = Math.round(observedDisplayHz * 10) / 10;
      }
    }
    lastPresentationAt = value;
  };

  const advance = (
    receiver,
    method,
    timeScale = 1,
    timestamp = now(),
    requestedTargetHz = MIN_TARGET_HZ,
    requestedDisplayHz = configuredDisplayHz,
    enabled = true,
    measuredDeltaSeconds,
  ) => {
    const numericTimestamp = Number(timestamp);
    const value = Number.isFinite(numericTimestamp) ? numericTimestamp : now();
    const nextTargetHz = clamp(finiteOr(requestedTargetHz, MIN_TARGET_HZ), MIN_TARGET_HZ, MAX_TARGET_HZ);
    const nextDisplayHz = clamp(finiteOr(requestedDisplayHz, 60), MIN_DISPLAY_HZ, MAX_DISPLAY_HZ);
    const scale = finiteOr(timeScale, 1);

    if (nextTargetHz !== targetHz || nextDisplayHz !== configuredDisplayHz) {
      targetHz = nextTargetHz;
      configuredDisplayHz = nextDisplayHz;
      accumulatorSeconds = 0;
    }

    stats.targetHz = targetHz;
    stats.displayHz = Math.round((observedDisplayHz || configuredDisplayHz) * 10) / 10;
    stats.fixedStepMs = Math.round((1000 / targetHz) * 1000) / 1000;
    stats.phaseAgeMs = lastPresentationAt
      ? Math.round(Math.max(0, value - lastPresentationAt) * 1000) / 1000
      : null;
    stats.advances++;

    let elapsedSeconds;
    if (!lastTimestamp || value <= lastTimestamp) {
      // The first update should never burst through a whole display frame.
      elapsedSeconds = 1 / targetHz;
    } else {
      elapsedSeconds = (value - lastTimestamp) / 1000;
    }
    lastTimestamp = value;
    scope.__lastMainDelta = value;
    const measuredDelta = finiteOr(measuredDeltaSeconds, elapsedSeconds);

    // Disabling fixed-step pacing is an exact escape hatch to the previous
    // Dawn behavior: one measured update divided by the selected multiplier.
    if (!enabled) {
      const multiplier = Math.max(1, targetHz / MIN_TARGET_HZ);
      const dt = clamp(measuredDelta, 0.0005, 0.05) / multiplier;
      scope.__dawnRemoteClockScale = multiplier;
      scope.__dawnTickDt = dt;
      scope.__dawnTickSteps = 1;
      stats.mode = "legacy-variable";
      stats.lastSteps = invoke(receiver, method, dt, scale) ? 1 : 0;
      stats.simulationSteps += stats.lastSteps;
      return stats.lastSteps;
    }

    scope.__dawnRemoteClockScale = 1;

    // Keep stock 60 Hz behavior variable-step and single-call. The fixed-step
    // path is for overclocked simulation and therefore cannot disturb stock.
    if (targetHz <= MIN_TARGET_HZ) {
      const dt = clamp(measuredDelta, 0.0005, 0.05);
      scope.__dawnTickDt = dt;
      scope.__dawnTickSteps = 1;
      stats.mode = "variable-60";
      stats.lastSteps = invoke(receiver, method, dt, scale) ? 1 : 0;
      stats.simulationSteps += stats.lastSteps;
      return stats.lastSteps;
    }

    const fixedStepSeconds = 1 / targetHz;
    const activeDisplayHz = observedDisplayHz || configuredDisplayHz;
    // Keep at most two display frames of debt. Anything older is stale input
    // and should be dropped rather than replayed after a hitch or Space switch.
    const maxDebtSeconds = Math.max(2 / activeDisplayHz, fixedStepSeconds * 2);
    if (elapsedSeconds > maxDebtSeconds) {
      stats.droppedDebtMs += (elapsedSeconds - maxDebtSeconds) * 1000;
      elapsedSeconds = maxDebtSeconds;
    }
    accumulatorSeconds += Math.max(0, elapsedSeconds);

    // The normal budget is target/display updates per visible frame, plus two
    // slots for ordinary timer jitter. The hard cap prevents pathological work.
    const maxSteps = Math.min(32, Math.max(2, Math.ceil(targetHz / activeDisplayHz) + 2));
    let steps = Math.floor((accumulatorSeconds + fixedStepSeconds * 0.000001) / fixedStepSeconds);
    if (steps > maxSteps) {
      const droppedSteps = steps - maxSteps;
      stats.droppedDebtMs += droppedSteps * fixedStepSeconds * 1000;
      accumulatorSeconds -= droppedSteps * fixedStepSeconds;
      steps = maxSteps;
    }

    let completed = 0;
    for (let index = 0; index < steps; index++) {
      if (!invoke(receiver, method, fixedStepSeconds, scale)) break;
      completed++;
    }
    accumulatorSeconds = Math.max(0, accumulatorSeconds - completed * fixedStepSeconds);

    // If invocation failed, do not retain an ever-growing debt for a method
    // that is no longer valid after navigation.
    if (completed !== steps) accumulatorSeconds = 0;

    scope.__dawnTickDt = fixedStepSeconds;
    scope.__dawnTickSteps = completed;
    stats.mode = "fixed-display-phase";
    stats.lastSteps = completed;
    stats.simulationSteps += completed;
    return completed;
  };

  const getStats = () => ({
    ...stats,
    droppedDebtMs: Math.round(stats.droppedDebtMs * 1000) / 1000,
    accumulatorMs: Math.round(accumulatorSeconds * 1000000) / 1000,
  });

  return { advance, reset, observePresentation, getStats };
}

module.exports = { createSimulationClock };
