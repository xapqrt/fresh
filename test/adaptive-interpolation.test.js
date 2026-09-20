"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createAdaptiveInterpolation } = require("../src/preload/game/adaptive-interpolation");

const feed = (controller, state, count, arrivalDelta, serverDelta = 33, manualDelay = 33) => {
  let selected = 1;
  for (let index = 0; index < count; index++) {
    state.now += arrivalDelta;
    state.server += serverDelta;
    selected = controller.select(16, state.server, manualDelay, state.now);
  }
  return selected;
};

test("adaptive interpolation adds buffering after sustained packet jitter", () => {
  const state = { now: 100, server: 1000, enabled: true };
  const controller = createAdaptiveInterpolation({
    now: () => state.now,
    enabled: () => state.enabled,
  });

  feed(controller, state, 12, 33);
  assert.equal(controller.getStats().extraSnapshots, 0);

  const selected = feed(controller, state, 12, 73);
  assert.equal(selected, 3);
  assert.ok(controller.getStats().p95JitterMs >= 39);
  assert.equal(controller.getStats().extraSnapshots, 2);
});

test("adaptive interpolation respects the manual floor, buffer size, and off switch", () => {
  const state = { now: 100, server: 1000, enabled: true };
  const controller = createAdaptiveInterpolation({
    now: () => state.now,
    enabled: () => state.enabled,
  });

  feed(controller, state, 12, 33, 33, 99);
  assert.equal(controller.select(16, state.server, 99, state.now), 3);

  feed(controller, state, 12, 80, 33, 99);
  assert.ok(controller.select(4, state.server + 33, 99, state.now + 80) <= 3);
  assert.equal(controller.select(1, state.server + 66, 99, state.now + 160), 1);

  state.enabled = false;
  assert.equal(controller.select(16, state.server + 66, 33, state.now + 160), 1);
});

test("adaptive interpolation ignores duplicate and older per-player snapshots", () => {
  let timestamp = 100;
  const controller = createAdaptiveInterpolation({ now: () => timestamp });

  controller.select(16, 1000, 33, timestamp);
  timestamp += 1;
  controller.select(16, 967, 33, timestamp);
  controller.select(16, 1000, 33, timestamp);
  assert.equal(controller.getStats().samples, 0);

  timestamp += 33;
  controller.select(16, 1033, 33, timestamp);
  assert.equal(controller.getStats().samples, 1);
});

test("adaptive interpolation reset discards pre-resume network history", () => {
  const state = { now: 100, server: 1000 };
  const controller = createAdaptiveInterpolation({ now: () => state.now });
  feed(controller, state, 16, 75);
  assert.ok(controller.getStats().samples > 0);

  controller.reset();
  const stats = controller.getStats();
  assert.equal(stats.samples, 0);
  assert.equal(stats.extraSnapshots, 0);
  assert.equal(stats.resets, 1);
});
