"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { installFocusRecovery } = require("../src/preload/game/focus-recovery");

class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    this.listeners.set(type, handlers.filter((candidate) => candidate !== handler));
  }

  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      if (event.immediateStopped) break;
      handler(event);
    }
  }
}

const mouseEvent = (properties = {}) => ({
  button: 0,
  ctrlKey: false,
  defaultPrevented: false,
  propagationStopped: false,
  immediateStopped: false,
  preventDefault() { this.defaultPrevented = true; },
  stopPropagation() { this.propagationStopped = true; },
  stopImmediatePropagation() { this.immediateStopped = true; },
  ...properties,
});

function createEnvironment() {
  let clock = 100;
  const windowObject = new FakeTarget();
  windowObject.performance = { now: () => clock };
  const documentObject = new FakeTarget();
  let exitPointerLockCalls = 0;
  documentObject.pointerLockElement = {};
  documentObject.exitPointerLock = () => {
    exitPointerLockCalls++;
    documentObject.pointerLockElement = null;
  };
  const ipc = new EventEmitter();
  let mouseResets = 0;
  let telemetryTimestamp = null;
  const recovery = installFocusRecovery({
    windowObject,
    documentObject,
    ipc,
    mouseInput: { reset: () => { mouseResets++; } },
    now: () => clock,
    platform: "darwin",
    isInMatch: () => true,
    resetTelemetryClock: (timestamp) => { telemetryTimestamp = timestamp; },
  });

  return {
    windowObject,
    documentObject,
    ipc,
    recovery,
    setNow: (value) => { clock = value; },
    get mouseResets() { return mouseResets; },
    get exitPointerLockCalls() { return exitPointerLockCalls; },
    get telemetryTimestamp() { return telemetryTimestamp; },
  };
}

test("blur/focus clears transient input and resets the game-loop clock", () => {
  const env = createEnvironment();
  env.windowObject.emit("blur");
  assert.equal(env.mouseResets, 1);
  assert.equal(env.exitPointerLockCalls, 1);
  assert.equal(env.windowObject.__lastMainDelta, 100);

  env.setNow(1350);
  env.windowObject.emit("focus");
  assert.equal(env.mouseResets, 2);
  assert.equal(env.telemetryTimestamp, 1350);
  assert.equal(env.recovery.getStats().lastAwayMs, 1250);
  env.recovery.destroy();
});

test("duplicate native and IPC focus notifications collapse to one reset", () => {
  const env = createEnvironment();
  env.windowObject.emit("blur");
  env.setNow(110);
  env.ipc.emit("dawn-focus-reset", {}, { phase: "blur" });
  assert.equal(env.mouseResets, 1);

  env.setNow(500);
  env.ipc.emit("dawn-focus-reset", {}, { phase: "focus", awayMs: 400 });
  env.setNow(510);
  env.windowObject.emit("focus");
  assert.equal(env.mouseResets, 2);
  assert.equal(env.recovery.getStats().lastAwayMs, 400);
  env.recovery.destroy();
});

test("macOS Control+primary context action is blocked without remapping the left button", () => {
  const env = createEnvironment();
  const observedButtons = [];
  env.documentObject.addEventListener("mousedown", (event) => observedButtons.push(event.button));

  const leftDown = mouseEvent({ button: 0, ctrlKey: true });
  env.documentObject.emit("mousedown", leftDown);
  assert.deepEqual(observedButtons, [0]);
  assert.equal(leftDown.defaultPrevented, false);

  const controlPrimaryContext = mouseEvent({ button: 0, ctrlKey: true });
  env.documentObject.emit("contextmenu", controlPrimaryContext);
  assert.equal(controlPrimaryContext.defaultPrevented, true);
  assert.equal(controlPrimaryContext.immediateStopped, true);
  assert.equal(env.recovery.getStats().contextMenusNormalized, 1);

  const realRightClick = mouseEvent({ button: 2, ctrlKey: false });
  env.documentObject.emit("contextmenu", realRightClick);
  assert.equal(realRightClick.defaultPrevented, false);
  assert.equal(realRightClick.immediateStopped, false);
  env.recovery.destroy();
});
