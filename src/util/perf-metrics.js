"use strict";

const finiteValues = (values) => values.filter((value) => Number.isFinite(value));
const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const percentileFromSorted = (sorted, percentile) => {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1));
  return sorted[index];
};

const average = (values) => {
  if (!values.length) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
};

const summarizeSeries = (input, digits = 2) => {
  const values = finiteValues(input);
  if (!values.length) {
    return { samples: 0, first: 0, last: 0, delta: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    first: round(values[0], digits),
    last: round(values[values.length - 1], digits),
    delta: round(values[values.length - 1] - values[0], digits),
    min: round(sorted[0], digits),
    max: round(sorted[sorted.length - 1], digits),
    avg: round(average(values), digits),
    p50: round(percentileFromSorted(sorted, 0.5), digits),
    p95: round(percentileFromSorted(sorted, 0.95), digits),
    p99: round(percentileFromSorted(sorted, 0.99), digits),
  };
};

const averageWorstFraction = (sorted, fraction) => {
  if (!sorted.length) return 0;
  const count = Math.max(1, Math.ceil(sorted.length * fraction));
  let total = 0;
  for (let index = sorted.length - count; index < sorted.length; index++) total += sorted[index];
  return total / count;
};

const summarizeFrameTimes = (input, targetFps = 60) => {
  const values = finiteValues(input).filter((value) => value > 0);
  if (!values.length) {
    return {
      ready: false,
      samples: 0,
      targetFps: round(targetFps, 2),
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const avgFrameTime = average(values);
  const p99FrameTime = percentileFromSorted(sorted, 0.99);
  const expectedFrameTime = 1000 / Math.max(1, targetFps || 60);
  const slowThreshold = expectedFrameTime * 1.5;
  const hitchThreshold = Math.max(50, expectedFrameTime * 3);
  let variance = 0;
  let over20 = 0;
  let over33 = 0;
  let over50 = 0;
  let over100 = 0;
  let slowFrames = 0;
  let hitches = 0;

  for (const value of values) {
    const delta = value - avgFrameTime;
    variance += delta * delta;
    if (value > 20) over20++;
    if (value > 33.333) over33++;
    if (value > 50) over50++;
    if (value > 100) over100++;
    if (value > slowThreshold) slowFrames++;
    if (value > hitchThreshold) hitches++;
  }

  const worstOnePercentMs = averageWorstFraction(sorted, 0.01);
  const worstPointOnePercentMs = averageWorstFraction(sorted, 0.001);

  return {
    ready: true,
    samples: values.length,
    durationSeconds: round(values.reduce((sum, value) => sum + value, 0) / 1000, 2),
    targetFps: round(targetFps, 2),
    expectedFrameTimeMs: round(expectedFrameTime, 2),
    avgFps: round(1000 / avgFrameTime, 1),
    onePercentLowFps: round(1000 / worstOnePercentMs, 1),
    pointOnePercentLowFps: round(1000 / worstPointOnePercentMs, 1),
    avgFrameTimeMs: round(avgFrameTime, 2),
    minFrameTimeMs: round(sorted[0], 2),
    maxFrameTimeMs: round(sorted[sorted.length - 1], 2),
    p50FrameTimeMs: round(percentileFromSorted(sorted, 0.5), 2),
    p95FrameTimeMs: round(percentileFromSorted(sorted, 0.95), 2),
    p99FrameTimeMs: round(p99FrameTime, 2),
    jitterMs: round(Math.sqrt(variance / values.length), 2),
    slowFrameThresholdMs: round(slowThreshold, 2),
    slowFrames,
    slowFramePercent: round((slowFrames / values.length) * 100, 2),
    hitchThresholdMs: round(hitchThreshold, 2),
    hitches,
    framesOver20Ms: over20,
    framesOver33Ms: over33,
    framesOver50Ms: over50,
    framesOver100Ms: over100,
  };
};

module.exports = {
  round,
  summarizeSeries,
  summarizeFrameTimes,
};
