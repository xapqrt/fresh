"use strict";

const SNAPSHOT_MS = 33;
const SAMPLE_COUNT = 64;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Tracks when a new server snapshot becomes visible to the interpolation
 * buffer. It increases buffering quickly when arrival jitter rises and lowers
 * it only after a sustained stable period, avoiding a 33/66 ms flap.
 */
function createAdaptiveInterpolation(options = {}) {
  const now = options.now || (() => performance.now());
  const enabled = options.enabled || (() => true);

  const jitterSamples = new Float32Array(SAMPLE_COUNT);
  const jitterScratch = new Float32Array(SAMPLE_COUNT);
  let jitterCount = 0;
  let jitterIndex = 0;
  let lastSnapshotId = null;
  let lastSnapshotAt = 0;
  let lastServerTimestamp = 0;
  let extraSnapshots = 0;
  let highJitterSamples = 0;
  let stableSamples = 0;
  let changes = 0;
  let resets = 0;
  let lastP95JitterMs = 0;
  let selectedSnapshots = 1;
  let lastBaseSnapshots = 1;

  const reset = () => {
    jitterCount = 0;
    jitterIndex = 0;
    lastSnapshotId = null;
    lastSnapshotAt = 0;
    lastServerTimestamp = 0;
    extraSnapshots = 0;
    highJitterSamples = 0;
    stableSamples = 0;
    lastP95JitterMs = 0;
    selectedSnapshots = 1;
    lastBaseSnapshots = 1;
    resets++;
  };

  const recordJitter = (value) => {
    if (!Number.isFinite(value) || value < 0 || value > 500) return;
    jitterSamples[jitterIndex] = value;
    jitterIndex = (jitterIndex + 1) % jitterSamples.length;
    if (jitterCount < jitterSamples.length) jitterCount++;
  };

  const jitterPercentile = (fraction) => {
    if (!jitterCount) return 0;
    const start = jitterCount === jitterSamples.length ? jitterIndex : 0;
    for (let index = 0; index < jitterCount; index++) {
      jitterScratch[index] = jitterSamples[(start + index) % jitterSamples.length];
    }
    // The window is only 64 entries. In-place insertion sort avoids allocating
    // an Array plus a sorted copy on every network snapshot.
    for (let index = 1; index < jitterCount; index++) {
      const value = jitterScratch[index];
      let cursor = index - 1;
      while (cursor >= 0 && jitterScratch[cursor] > value) {
        jitterScratch[cursor + 1] = jitterScratch[cursor];
        cursor--;
      }
      jitterScratch[cursor + 1] = value;
    }
    return jitterScratch[Math.min(jitterCount - 1, Math.floor((jitterCount - 1) * fraction))];
  };

  const updateSnapshot = (snapshotId, timestamp) => {
    const numericId = Number(snapshotId);
    const id = Number.isFinite(numericId) ? numericId : String(snapshotId ?? "");
    if (id === "" || id === lastSnapshotId) return;
    // The selector can run once per remote player in the same render task.
    // Ignore duplicate/older player buffers so they cannot look like a burst of
    // zero-millisecond network arrivals and falsely raise interpolation.
    if (typeof id === "number" && lastServerTimestamp && id <= lastServerTimestamp) return;

    const arrivalAt = Number.isFinite(Number(timestamp)) ? Number(timestamp) : now();
    if (lastSnapshotAt) {
      const arrivalDelta = arrivalAt - lastSnapshotAt;
      let expectedDelta = SNAPSHOT_MS;
      if (typeof id === "number" && Number.isFinite(lastServerTimestamp)) {
        const serverDelta = id - lastServerTimestamp;
        if (serverDelta >= 5 && serverDelta <= 250) expectedDelta = serverDelta;
      }
      recordJitter(Math.abs(arrivalDelta - expectedDelta));
    }

    lastSnapshotId = id;
    lastSnapshotAt = arrivalAt;
    lastServerTimestamp = typeof id === "number" ? id : 0;

    if (jitterCount < 8) return;
    lastP95JitterMs = jitterPercentile(0.95);

    let wantedExtra = 0;
    // Adaptive targets are deliberately limited to the requested 33/66/99 ms
    // tiers. A larger manual delay remains a floor, but jitter never piles an
    // unbounded additive delay on top of it.
    if (lastP95JitterMs >= 40) wantedExtra = 2;
    else if (lastP95JitterMs >= 12) wantedExtra = 1;

    if (wantedExtra > extraSnapshots) {
      highJitterSamples++;
      stableSamples = 0;
      // Raise protection after three confirmed snapshots, so a single delayed
      // packet cannot permanently add interpolation latency.
      if (highJitterSamples >= 3) {
        extraSnapshots = wantedExtra;
        highJitterSamples = 0;
        changes++;
      }
    } else if (wantedExtra < extraSnapshots) {
      stableSamples++;
      highJitterSamples = 0;
      // Require roughly four seconds of stable 30 Hz snapshots before lowering.
      if (stableSamples >= 120) {
        extraSnapshots--;
        stableSamples = 0;
        changes++;
      }
    } else {
      highJitterSamples = 0;
      stableSamples = 0;
    }
  };

  const select = (bufferLength, latestSnapshotId, manualDelayMs = 33, timestamp = now()) => {
    updateSnapshot(latestSnapshotId, timestamp);
    const availableSnapshots = Math.max(1, Math.floor(Number(bufferLength) || 1));
    const baseSnapshots = clamp(Math.round((Number(manualDelayMs) || 33) / SNAPSHOT_MS), 1, 6);
    lastBaseSnapshots = baseSnapshots;
    const adaptiveTarget = enabled() ? 1 + extraSnapshots : 1;
    // This is a count back from the buffer end: 1 selects the newest snapshot,
    // 2 the previous snapshot, and so on. The manual value is a floor; adaptive
    // jitter protection chooses at most the 99 ms (three-snapshot) tier.
    selectedSnapshots = clamp(Math.max(baseSnapshots, adaptiveTarget), 1, availableSnapshots);
    return selectedSnapshots;
  };

  const getStats = () => ({
    enabled: Boolean(enabled()),
    samples: jitterCount,
    p95JitterMs: Math.round(lastP95JitterMs * 100) / 100,
    extraSnapshots: enabled() ? Math.max(0, selectedSnapshots - lastBaseSnapshots) : 0,
    selectedSnapshots,
    selectedDelayMs: selectedSnapshots * SNAPSHOT_MS,
    changes,
    resets,
  });

  return { select, reset, getStats };
}

module.exports = { createAdaptiveInterpolation };
