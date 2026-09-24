"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createMutationBatcher } = require("../src/preload/game/mutation-batcher");

class FakeObserver {
  constructor(callback) { this.callback = callback; FakeObserver.instance = this; this.observed = 0; }
  observe() { this.observed++; }
  disconnect() { this.observed = 0; }
}

test("mutation batcher runs each dirty task once per mutation burst", () => {
  const queued = [];
  const runs = [];
  const batcher = createMutationBatcher({
    MutationObserverClass: FakeObserver,
    enqueue: (callback) => queued.push(callback),
    onMutations: (_mutations, mark) => { mark("players"); mark("players"); mark("killfeed"); },
  });
  batcher.register("players", () => runs.push("players"));
  batcher.register("killfeed", () => runs.push("killfeed"));
  batcher.observe({}, { childList: true });

  FakeObserver.instance.callback([{}, {}, {}]);
  assert.equal(queued.length, 1);
  queued.shift()();
  assert.deepEqual(runs.sort(), ["killfeed", "players"]);
  assert.equal(batcher.getStats().coalescedMarks, 1);
});

test("mutation batcher disconnects while suspended and refreshes tasks on resume", () => {
  const queued = [];
  let runs = 0;
  const batcher = createMutationBatcher({ MutationObserverClass: FakeObserver, enqueue: (callback) => queued.push(callback) });
  batcher.register("all", () => runs++).observe({}, { subtree: true });
  batcher.suspend();
  assert.equal(FakeObserver.instance.observed, 0);
  batcher.resume(true);
  assert.equal(FakeObserver.instance.observed, 1);
  queued.shift()();
  assert.equal(runs, 1);
  batcher.destroy();
});

test("mutation batcher cancels a pending animation-frame enqueue on suspend", () => {
  let cancelledHandle = null;
  const batcher = createMutationBatcher({
    MutationObserverClass: FakeObserver,
    enqueue: () => 42,
    cancelEnqueue: (handle) => { cancelledHandle = handle; },
  });
  batcher.register("players", () => {}).mark("players");
  batcher.suspend();
  assert.equal(cancelledHandle, 42);
  assert.equal(batcher.getStats().dirty, 0);
});
