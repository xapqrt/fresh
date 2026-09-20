"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createSimulationClock } = require("../src/preload/game/simulation-clock");

const receiver = () => ({
  deltas: [],
  update(delta) {
    this.deltas.push(delta);
  },
});

test("fixed-step clock subdivides display time at the selected simulation rate", () => {
  const scope = {};
  const clock = createSimulationClock({ scope, now: () => 100 });
  const target = receiver();

  assert.equal(clock.advance(target, "update", 1, 100, 480, 240, true), 1);
  assert.equal(clock.advance(target, "update", 1, 100 + 1000 / 240, 480, 240, true), 2);
  assert.equal(target.deltas.length, 3);
  for (const delta of target.deltas) assert.ok(Math.abs(delta - 1 / 480) < 1e-9);
  assert.equal(scope.__dawnRemoteClockScale, 1);
  assert.equal(clock.getStats().mode, "fixed-display-phase");
});

test("stock 60 Hz keeps the bundle's measured variable delta", () => {
  const clock = createSimulationClock({ scope: {}, now: () => 100 });
  const target = receiver();

  clock.advance(target, "update", 1, 100, 60, 60, true, 0.012345);
  assert.equal(target.deltas[0], 0.012345);
  assert.equal(clock.getStats().mode, "variable-60");
});

test("fixed-step clock drops stale debt instead of replaying a long hitch", () => {
  const scope = {};
  const clock = createSimulationClock({ scope, now: () => 100 });
  const target = receiver();

  clock.advance(target, "update", 1, 100, 480, 60, true);
  const steps = clock.advance(target, "update", 1, 300, 480, 60, true);

  assert.ok(steps <= 10);
  assert.ok(clock.getStats().droppedDebtMs > 100);
});

test("resume reset rebases the clock without a catch-up burst", () => {
  const scope = {};
  const clock = createSimulationClock({ scope, now: () => 1000 });
  const target = receiver();

  clock.advance(target, "update", 1, 100, 960, 60, true);
  clock.reset(5000);
  const steps = clock.advance(target, "update", 1, 5000 + 1000 / 960, 960, 60, true);

  assert.equal(steps, 1);
  assert.equal(clock.getStats().resets, 1);
});

test("legacy escape hatch preserves the previous divided variable delta", () => {
  const scope = {};
  const clock = createSimulationClock({ scope, now: () => 100 });
  const target = receiver();

  clock.advance(target, "update", 1, 100, 480, 60, false);
  clock.advance(target, "update", 1, 116, 480, 60, false);

  assert.ok(Math.abs(target.deltas[1] - 0.002) < 1e-9);
  assert.equal(scope.__dawnRemoteClockScale, 8);
  assert.equal(clock.getStats().mode, "legacy-variable");
});

test("presentation samples refine the active display cadence", () => {
  const clock = createSimulationClock({ scope: {}, now: () => 100 });
  clock.observePresentation(100);
  clock.observePresentation(100 + 1000 / 240);
  clock.observePresentation(100 + 2000 / 240);

  assert.ok(Math.abs(clock.getStats().observedDisplayHz - 240) < 1);
});
