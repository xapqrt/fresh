"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyPollingRate,
  installRawMouse,
  pollingProfileForRate,
} = require("../src/preload/game/raw-mouse");

class FakeTarget {
  constructor(parent = null) {
    this.parent = parent;
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

  invoke(type, event) {
    for (const handler of this.listeners.get(type) || []) {
      if (event.__immediateStopped) break;
      handler.call(this, event);
    }
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    if (this.parent) this.parent.invoke(event.type, event);
    if (!event.__propagationStopped) this.invoke(event.type, event);
    return true;
  }

  dispatchTrustedMouseMove(event) {
    event.type = "mousemove";
    event.target = this;
    event.isTrusted = true;
    if (this.parent) this.parent.invoke("mousemove", event);
    if (!event.__propagationStopped) this.invoke("mousemove", event);
  }
}

const makeEvent = (properties = {}) => ({
  movementX: 0,
  movementY: 0,
  pointerType: "mouse",
  timeStamp: 1,
  isTrusted: true,
  stopImmediatePropagation() {
    this.__immediateStopped = true;
  },
  stopPropagation() {
    this.__propagationStopped = true;
  },
  preventDefault() {
    this.defaultPrevented = true;
  },
  ...properties,
});

function createEnvironment({ rawLockResult } = {}) {
  let clock = 1;
  const windowObject = new FakeTarget();
  const documentObject = new FakeTarget();
  windowObject.onpointerrawupdate = null;
  windowObject.performance = { now: () => clock };

  class FakeMouseEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
      this.cancelable = Boolean(init.cancelable);
      this.clientX = init.clientX || 0;
      this.clientY = init.clientY || 0;
      this.screenX = init.screenX || 0;
      this.screenY = init.screenY || 0;
      this.buttons = init.buttons || 0;
      this.isTrusted = false;
      // Deliberately ignore movementX/Y, as the real MouseEventInit does.
    }

    stopImmediatePropagation() {
      this.__immediateStopped = true;
    }

    stopPropagation() {
      this.__propagationStopped = true;
    }
  }

  const pointerLockCalls = [];
  class FakeElement extends FakeTarget {
    constructor() {
      super(windowObject);
    }
  }
  FakeElement.prototype.requestPointerLock = function (options) {
    pointerLockCalls.push(options);
    if (typeof rawLockResult === "function") return rawLockResult(options, pointerLockCalls.length);
    return Promise.resolve();
  };

  windowObject.MouseEvent = FakeMouseEvent;
  windowObject.Element = FakeElement;
  windowObject.PointerEvent = class FakePointerEvent {};
  windowObject.PointerEvent.prototype.getCoalescedEvents = () => [];

  const lockElement = new FakeElement();
  documentObject.pointerLockElement = lockElement;

  return {
    windowObject,
    documentObject,
    lockElement,
    pointerLockCalls,
    now: () => clock,
    setNow: (value) => { clock = value; },
    emitRaw(properties) {
      const event = makeEvent(properties);
      event.type = "pointerrawupdate";
      event.target = lockElement;
      windowObject.invoke("pointerrawupdate", event);
      return event;
    },
    emitNative(properties) {
      const event = makeEvent(properties);
      lockElement.dispatchTrustedMouseMove(event);
      return event;
    },
  };
}

test("classifies common polling rates and widens mismatch tolerance at high rate", () => {
  assert.equal(classifyPollingRate(8), 125);
  assert.equal(classifyPollingRate(1), 1000);
  assert.equal(classifyPollingRate(0.5), 2000);
  assert.equal(classifyPollingRate(0.125), 8000);
  assert.equal(pollingProfileForRate(8000).mismatchLimit, 10);
  assert.ok(pollingProfileForRate(8000).reconciliationWindowMs < pollingProfileForRate(500).reconciliationWindowMs);
});

test("mirrors raw deltas and suppresses only the later duplicate native move", () => {
  const env = createEnvironment();
  const settings = { high_rate_mouse: true, raw_mouse_input: false };
  const api = installRawMouse({
    windowObject: env.windowObject,
    documentObject: env.documentObject,
    settings,
    now: env.now,
  });
  const gameDeltas = [];
  env.lockElement.addEventListener("mousemove", (event) => {
    gameDeltas.push([event.movementX, event.movementY, event.isTrusted]);
  });

  env.setNow(10);
  env.emitRaw({ movementX: 7, movementY: -3, timeStamp: 9.5 });
  env.setNow(11);
  const native = env.emitNative({ movementX: 7, movementY: -3, timeStamp: 9.5 });

  assert.deepEqual(gameDeltas, [[7, -3, false]]);
  assert.equal(native.__immediateStopped, true);
  assert.equal(api.getStats().syntheticMouseMoves, 1);
  assert.equal(api.getStats().suppressedMouseMoves, 1);
  api.destroy();
});

test("adapts reconciliation profile to the delivered mouse polling rate", () => {
  const env = createEnvironment();
  const api = installRawMouse({
    windowObject: env.windowObject,
    documentObject: env.documentObject,
    settings: { high_rate_mouse: true },
    now: env.now,
  });

  for (let index = 0; index < 32; index++) {
    env.setNow(10 + index * 0.5);
    env.emitRaw({ movementX: 1 });
    env.emitNative({ movementX: 1 });
  }

  const stats = api.getStats();
  assert.equal(stats.pollingRateHz, 2000);
  assert.equal(stats.mismatchLimit, 6);
  assert.equal(stats.reconciliationWindowMs, 32);
  api.destroy();
});

test("polling tolerance never drops a small native movement difference", () => {
  const env = createEnvironment();
  const api = installRawMouse({
    windowObject: env.windowObject,
    documentObject: env.documentObject,
    settings: { high_rate_mouse: true },
    now: env.now,
  });
  const gameDeltas = [];
  env.lockElement.addEventListener("mousemove", (event) => gameDeltas.push(event.movementX));

  env.setNow(10);
  env.emitRaw({ movementX: 1 });
  env.setNow(11);
  env.emitNative({ movementX: 1.04 });

  assert.equal(api.getStats().movementMatches, 1);
  assert.equal(api.getStats().correctionMouseMoves, 1);
  assert.ok(Math.abs(gameDeltas.reduce((sum, value) => sum + value, 0) - 1.04) < 1e-9);
  api.destroy();
});

test("passes native input with no pending raw delta and reconciles a delayed aggregate", () => {
  const env = createEnvironment();
  const api = installRawMouse({
    windowObject: env.windowObject,
    documentObject: env.documentObject,
    settings: { high_rate_mouse: true },
    now: env.now,
  });
  const gameDeltas = [];
  env.lockElement.addEventListener("mousemove", (event) => gameDeltas.push(event.movementX));

  env.setNow(100);
  env.emitNative({ movementX: 4 });
  env.setNow(101);
  env.emitRaw({ movementX: 2 });
  env.setNow(200); // delayed native aggregate includes more than the raw sample
  env.emitNative({ movementX: 5 });

  // Raw 2 was already delivered, so the bridge emits only the missing 3 and
  // suppresses the aggregate 5. Total movement remains native-equivalent.
  assert.deepEqual(gameDeltas, [4, 2, 3]);
  assert.equal(gameDeltas.reduce((sum, value) => sum + value, 0), 9);
  assert.equal(api.getStats().passedNativeMouseMoves, 1);
  assert.equal(api.getStats().correctionMouseMoves, 1);
  api.destroy();
});

test("live high-rate setting disables the bridge without disabling native input", () => {
  const env = createEnvironment();
  const settings = { high_rate_mouse: false };
  const api = installRawMouse({
    windowObject: env.windowObject,
    documentObject: env.documentObject,
    settings,
    now: env.now,
  });
  const gameDeltas = [];
  env.lockElement.addEventListener("mousemove", (event) => gameDeltas.push(event.movementX));

  env.setNow(10);
  env.emitRaw({ movementX: 8 });
  env.setNow(11);
  env.emitNative({ movementX: 8 });
  assert.deepEqual(gameDeltas, [8]);

  settings.high_rate_mouse = true;
  env.setNow(20);
  env.emitRaw({ movementX: 3 });
  env.setNow(21);
  env.emitNative({ movementX: 3 });
  assert.deepEqual(gameDeltas, [8, 3]);
  api.destroy();
});

test("falls back to trusted native movement after repeated raw/native mismatches", () => {
  const env = createEnvironment();
  const api = installRawMouse({
    windowObject: env.windowObject,
    documentObject: env.documentObject,
    settings: { high_rate_mouse: true },
    now: env.now,
  });
  const gameDeltas = [];
  env.lockElement.addEventListener("mousemove", (event) => gameDeltas.push(event.movementX));

  for (let index = 0; index < 4; index++) {
    env.setNow(10 + index * 2);
    env.emitRaw({ movementX: 1 });
    env.setNow(11 + index * 2);
    env.emitNative({ movementX: 3 });
  }
  assert.equal(api.getStats().bridgeDisabledForLock, true);

  env.setNow(20);
  env.emitRaw({ movementX: 4 }); // ignored by the disabled bridge
  env.setNow(21);
  env.emitNative({ movementX: 4 });

  assert.deepEqual(gameDeltas, [1, 2, 1, 2, 1, 2, 1, 2, 4]);
  assert.equal(gameDeltas.reduce((sum, value) => sum + value, 0), 16);
  api.destroy();
});

test("focus and visibility transitions clear pending raw reconciliation", () => {
  const env = createEnvironment();
  const api = installRawMouse({
    windowObject: env.windowObject,
    documentObject: env.documentObject,
    settings: { high_rate_mouse: true },
    now: env.now,
  });
  const gameDeltas = [];
  env.lockElement.addEventListener("mousemove", (event) => gameDeltas.push(event.movementX));

  env.setNow(10);
  env.emitRaw({ movementX: 5 });
  env.windowObject.invoke("blur", makeEvent());
  env.setNow(20);
  const afterBlur = env.emitNative({ movementX: 2 });

  env.setNow(30);
  env.emitRaw({ movementX: 4 });
  env.documentObject.invoke("visibilitychange", makeEvent());
  env.setNow(40);
  const afterVisibilityChange = env.emitNative({ movementX: 3 });

  assert.deepEqual(gameDeltas, [5, 2, 4, 3]);
  assert.equal(afterBlur.__immediateStopped, undefined);
  assert.equal(afterVisibilityChange.__immediateStopped, undefined);
  assert.equal(api.getStats().focusResets, 2);
  api.destroy();
});

test("macOS Control+primary context action is blocked only in matches while real right click passes", () => {
  const env = createEnvironment();
  let inMatch = true;
  const api = installRawMouse({
    windowObject: env.windowObject,
    documentObject: env.documentObject,
    settings: { high_rate_mouse: true },
    now: env.now,
    platform: "darwin",
    isInMatch: () => inMatch,
  });

  const controlPrimary = makeEvent({ button: 0, buttons: 1, ctrlKey: true });
  env.documentObject.invoke("contextmenu", controlPrimary);
  assert.equal(controlPrimary.defaultPrevented, true);
  assert.equal(controlPrimary.__immediateStopped, true);
  assert.equal(api.getStats().normalizedControlClicks, 1);

  const realRightClick = makeEvent({ button: 2, buttons: 2, ctrlKey: false });
  env.documentObject.invoke("contextmenu", realRightClick);
  assert.equal(realRightClick.defaultPrevented, undefined);
  assert.equal(realRightClick.__immediateStopped, undefined);

  inMatch = false;
  const menuControlClick = makeEvent({ button: 0, buttons: 1, ctrlKey: true });
  env.documentObject.invoke("contextmenu", menuControlClick);
  assert.equal(menuControlClick.defaultPrevented, undefined);
  assert.equal(menuControlClick.__immediateStopped, undefined);
  assert.equal(api.getStats().normalizedControlClicks, 1);
  api.destroy();
});

test("requests unadjusted pointer lock and falls back only when unsupported", async () => {
  const unsupported = Object.assign(new Error("unsupported"), { name: "NotSupportedError" });
  const env = createEnvironment({
    rawLockResult(options, callNumber) {
      if (callNumber === 1 && options?.unadjustedMovement) return Promise.reject(unsupported);
      return Promise.resolve("locked");
    },
  });
  const api = installRawMouse({
    windowObject: env.windowObject,
    documentObject: env.documentObject,
    settings: { high_rate_mouse: true, raw_mouse_input: true },
    now: env.now,
  });

  const result = await env.lockElement.requestPointerLock({ navigationUI: "hide" });
  assert.equal(result, "locked");
  assert.deepEqual(env.pointerLockCalls, [
    { navigationUI: "hide", unadjustedMovement: true },
    { navigationUI: "hide" },
  ]);
  assert.equal(api.getStats().unadjusted.fallbacks, 1);
  assert.equal(api.getStats().unadjusted.status, "plain-fallback");
  api.destroy();
});

test("benchmark capture reports raw/native rates, bridge use, and render input age", () => {
  const env = createEnvironment();
  const api = installRawMouse({
    windowObject: env.windowObject,
    documentObject: env.documentObject,
    settings: { high_rate_mouse: true, raw_mouse_input: false },
    now: env.now,
  });
  assert.equal(api.startCapture(), true);

  for (const timestamp of [10, 12, 14]) {
    env.setNow(timestamp);
    env.emitRaw({ movementX: 1, timeStamp: timestamp - 0.25, getCoalescedEvents: () => [1] });
    env.setNow(timestamp + 0.5);
    env.emitNative({ movementX: 1, timeStamp: timestamp - 0.25 });
  }
  env.setNow(15);
  api.sampleFrame(15);
  env.setNow(20);
  const report = api.finishCapture();

  assert.equal(report.support.pointerRawUpdate, true);
  assert.equal(report.rawPointerUpdate.events, 3);
  assert.equal(report.rawPointerUpdate.estimatedActiveHz, 500);
  assert.equal(report.bridge.syntheticMouseMoves, 3);
  assert.equal(report.bridge.suppressedNativeMouseMoves, 3);
  assert.equal(report.inputAgeSourceFrames.raw, 1);
  assert.equal(report.inputAgeAtFrameMs.p50, 1);
  api.destroy();
});
