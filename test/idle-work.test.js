"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createIdleWorkQueue } = require("../src/preload/game/idle-work");

test("idle work queue stages startup jobs and pauses while suspended", () => {
  const callbacks = [];
  const runs = [];
  const queue = createIdleWorkQueue({
    scope: { setTimeout, clearTimeout },
    requestIdle: (callback) => { callbacks.push(callback); return callbacks.length; },
    cancelIdle: () => {},
  });
  queue.add(() => runs.push(1));
  queue.add(() => runs.push(2));
  queue.suspend();
  callbacks.shift()({ timeRemaining: () => 10 });
  assert.deepEqual(runs, []);
  queue.resume();
  callbacks.shift()({ timeRemaining: () => 10 });
  assert.deepEqual(runs, [1, 2]);
});
