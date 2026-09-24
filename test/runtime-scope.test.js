"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { RuntimeScope } = require("../src/preload/game/runtime-scope");

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
}

test("runtime scope suspends, resumes, and finally removes route work", () => {
  const scope = new RuntimeScope("match");
  const target = new Target();
  let observes = 0;
  let disconnects = 0;
  const observer = { observe: () => observes++, disconnect: () => disconnects++ };

  scope.listen(target, "change", () => {});
  scope.observe(observer, {}, { childList: true });
  assert.equal(target.listeners.size, 1);
  assert.equal(observes, 1);

  scope.suspend();
  assert.equal(target.listeners.size, 0);
  assert.equal(disconnects, 1);
  scope.resume();
  assert.equal(target.listeners.size, 1);
  assert.equal(observes, 2);

  scope.cleanup();
  assert.equal(target.listeners.size, 0);
  assert.equal(disconnects, 2);
  assert.equal(scope.getStats().closed, true);
});

test("non-suspendable recovery listeners remain attached until cleanup", () => {
  const scope = new RuntimeScope();
  const target = new Target();
  scope.listen(target, "resume", () => {}, undefined, false);
  scope.suspend();
  assert.equal(target.listeners.has("resume"), true);
  scope.cleanup();
  assert.equal(target.listeners.has("resume"), false);
});

test("runtime scope owns timeouts, intervals, and animation frames", () => {
  let nextId = 0;
  const pending = { timeouts: new Map(), intervals: new Map(), frames: new Map() };
  const scheduler = {
    setTimeout(callback) { const id = ++nextId; pending.timeouts.set(id, callback); return id; },
    clearTimeout(id) { pending.timeouts.delete(id); },
    setInterval(callback) { const id = ++nextId; pending.intervals.set(id, callback); return id; },
    clearInterval(id) { pending.intervals.delete(id); },
    requestAnimationFrame(callback) { const id = ++nextId; pending.frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { pending.frames.delete(id); },
  };
  const scope = new RuntimeScope("match", scheduler);
  scope.setTimeout(() => {}, 10);
  scope.setInterval(() => {}, 10);
  scope.requestAnimationFrame(() => {});
  assert.deepEqual(Object.values(pending).map((entries) => entries.size), [1, 1, 1]);

  scope.suspend();
  assert.deepEqual(Object.values(pending).map((entries) => entries.size), [0, 0, 0]);
  scope.resume();
  assert.deepEqual(Object.values(pending).map((entries) => entries.size), [1, 1, 1]);
  scope.cleanup();
  assert.deepEqual(Object.values(pending).map((entries) => entries.size), [0, 0, 0]);
  assert.deepEqual(
    { timeouts: scope.getStats().timeouts, intervals: scope.getStats().intervals, animationFrames: scope.getStats().animationFrames },
    { timeouts: 1, intervals: 1, animationFrames: 1 },
  );
});
