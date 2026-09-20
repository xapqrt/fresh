"use strict";

const { round, summarizeSeries } = require("../../util/perf-metrics");

const ACTIVE_INTERVAL_MAX_MS = 100;
const RATE_STALE_MS = 250;
const NATIVE_FALLBACK_MS = 50;
const ROLLING_INTERVALS = 256;
// Enough for a full 30-second run at ~1 kHz without dynamic Array growth.
// Higher-polling devices retain a representative prefix and report overflow.
const MAX_CAPTURE_SAMPLES = 32768;

const boolSetting = (settings, key, fallback) =>
  typeof settings?.[key] === "boolean" ? settings[key] : fallback;

const createRateTracker = () => ({
  intervals: new Float32Array(ROLLING_INTERVALS),
  count: 0,
  index: 0,
  lastMovingAt: 0,
});

const recordRate = (tracker, timestamp, moving) => {
  if (!moving) return;
  if (tracker.lastMovingAt) {
    const interval = timestamp - tracker.lastMovingAt;
    if (interval > 0 && interval <= ACTIVE_INTERVAL_MAX_MS) {
      tracker.intervals[tracker.index] = interval;
      tracker.index = (tracker.index + 1) % tracker.intervals.length;
      if (tracker.count < tracker.intervals.length) tracker.count++;
    }
  }
  tracker.lastMovingAt = timestamp;
};

const estimateRate = (tracker, timestamp) => {
  if (!tracker.count || !tracker.lastMovingAt || timestamp - tracker.lastMovingAt > RATE_STALE_MS) return 0;
  const values = new Array(tracker.count);
  const start = tracker.count === tracker.intervals.length ? tracker.index : 0;
  for (let index = 0; index < tracker.count; index++) {
    values[index] = tracker.intervals[(start + index) % tracker.intervals.length];
  }
  values.sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  return median > 0 ? Math.round(1000 / median) : 0;
};

const createCaptureStream = () => ({
  events: 0,
  movingEvents: 0,
  coalescedSamples: 0,
  deltaX: 0,
  deltaY: 0,
  absoluteDelta: 0,
  lastMovingAt: 0,
  intervalsMs: new Float32Array(MAX_CAPTURE_SAMPLES),
  intervalCount: 0,
  eventAgeMs: new Float32Array(MAX_CAPTURE_SAMPLES),
  eventAgeCount: 0,
  overflowSamples: 0,
});

const getCoalescedCount = (event) => {
  if (typeof event?.getCoalescedEvents !== "function") return 1;
  try {
    const events = event.getCoalescedEvents();
    return events && Number.isFinite(events.length) && events.length ? events.length : 1;
  } catch (error) {
    return 1;
  }
};

const recordCaptureEvent = (stream, event, timestamp, includeCoalesced) => {
  stream.events++;
  const movementX = Number(event?.movementX) || 0;
  const movementY = Number(event?.movementY) || 0;
  const moving = movementX !== 0 || movementY !== 0;

  if (includeCoalesced) stream.coalescedSamples += getCoalescedCount(event);
  stream.deltaX += movementX;
  stream.deltaY += movementY;
  stream.absoluteDelta += Math.abs(movementX) + Math.abs(movementY);

  if (!moving) return;
  stream.movingEvents++;
  if (stream.lastMovingAt) {
    const interval = timestamp - stream.lastMovingAt;
    if (interval > 0 && interval <= ACTIVE_INTERVAL_MAX_MS) {
      if (stream.intervalCount < stream.intervalsMs.length) {
        stream.intervalsMs[stream.intervalCount++] = interval;
      } else {
        stream.overflowSamples++;
      }
    }
  }
  stream.lastMovingAt = timestamp;

  const eventTimestamp = Number(event?.timeStamp);
  const eventAge = timestamp - eventTimestamp;
  if (Number.isFinite(eventTimestamp) && eventTimestamp > 0 && eventAge >= 0 && eventAge < 1000) {
    if (stream.eventAgeCount < stream.eventAgeMs.length) {
      stream.eventAgeMs[stream.eventAgeCount++] = eventAge;
    } else {
      stream.overflowSamples++;
    }
  }
};

const summarizeCaptureStream = (stream) => {
  const intervals = summarizeSeries(stream.intervalsMs.subarray(0, stream.intervalCount), 3);
  return {
    events: stream.events,
    movingEvents: stream.movingEvents,
    coalescedSamples: stream.coalescedSamples,
    estimatedActiveHz: intervals.p50 > 0 ? Math.round(1000 / intervals.p50) : 0,
    intervalMs: intervals,
    eventAgeMs: summarizeSeries(stream.eventAgeMs.subarray(0, stream.eventAgeCount), 3),
    movement: {
      x: round(stream.deltaX, 2),
      y: round(stream.deltaY, 2),
      absolute: round(stream.absoluteDelta, 2),
    },
    overflowSamples: stream.overflowSamples,
  };
};

const unsupportedApi = (reason) => ({
  supported: false,
  reason,
  startCapture: () => false,
  finishCapture: () => null,
  sampleFrame: () => {},
  getStats: () => ({ supported: false, reason }),
  destroy: () => {},
});

/**
 * Give Kirka device-rate pointer samples without changing its private input API.
 *
 * Chromium may align/coalesce normal pointer movement with rendering.
 * pointerrawupdate arrives earlier and at the highest rate the renderer can
 * service. While pointer-locked, each raw delta is mirrored as a mousemove so
 * the game's existing mouse-look listener sees it. The later trusted,
 * coalesced mousemove is suppressed to avoid applying the same delta twice.
 *
 * Raw pointer-lock (unadjustedMovement) is separate and user-selectable: it
 * removes OS acceleration, while the high-rate bridge itself preserves the
 * movement values Chromium supplied.
 */
function installRawMouse(options = {}) {
  const windowObject = options.windowObject || globalThis.window;
  const documentObject = options.documentObject || globalThis.document;
  const settings = options.settings || {};
  const now = options.now || (() => windowObject.performance.now());

  if (!windowObject || !documentObject || typeof windowObject.addEventListener !== "function") {
    return unsupportedApi("DOM event APIs unavailable");
  }
  if (typeof windowObject.MouseEvent !== "function") {
    return unsupportedApi("MouseEvent unavailable");
  }

  const syntheticEvents = new WeakSet();
  const rawRate = createRateTracker();
  const nativeRate = createRateTracker();
  const pointerRate = createRateTracker();
  const listeners = [];
  let capture = null;
  let rawActiveForLock = false;
  let bridgeDisabledForLock = false;
  let pendingRawX = 0;
  let pendingRawY = 0;
  let pendingRawEvents = 0;
  let consecutiveMovementMismatches = 0;
  let lastRawAt = 0;
  let lastNativeAt = 0;
  let pointerLockPatched = false;
  let nativeRequestPointerLock = null;
  let patchedRequestPointerLock = null;

  const state = {
    supported: "onpointerrawupdate" in windowObject,
    pointerLocked: Boolean(documentObject.pointerLockElement),
    rawEvents: 0,
    syntheticMouseMoves: 0,
    correctionMouseMoves: 0,
    nativeMouseMoves: 0,
    suppressedMouseMoves: 0,
    passedNativeMouseMoves: 0,
    movementMatches: 0,
    movementMismatches: 0,
    lockChanges: 0,
    unadjusted: {
      attempts: 0,
      accepted: 0,
      fallbacks: 0,
      status: "not-requested",
      lastError: null,
    },
  };

  const highRateEnabled = () => boolSetting(settings, "high_rate_mouse", true);
  const unadjustedEnabled = () => boolSetting(settings, "raw_mouse_input", false);
  const isPointerLocked = () => Boolean(documentObject.pointerLockElement);
  const isMoving = (event) => (Number(event?.movementX) || 0) !== 0 || (Number(event?.movementY) || 0) !== 0;

  const addListener = (target, type, handler, listenerOptions) => {
    target.addEventListener(type, handler, listenerOptions);
    listeners.push([target, type, handler, listenerOptions]);
  };

  const createSyntheticMouseMove = (
    sourceEvent,
    movementX = Number(sourceEvent.movementX) || 0,
    movementY = Number(sourceEvent.movementY) || 0,
  ) => {
    const event = new windowObject.MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: windowObject,
      detail: Number(sourceEvent.detail) || 0,
      screenX: Number(sourceEvent.screenX) || 0,
      screenY: Number(sourceEvent.screenY) || 0,
      clientX: Number(sourceEvent.clientX) || 0,
      clientY: Number(sourceEvent.clientY) || 0,
      button: Number(sourceEvent.button) || 0,
      buttons: Number(sourceEvent.buttons) || 0,
      ctrlKey: Boolean(sourceEvent.ctrlKey),
      shiftKey: Boolean(sourceEvent.shiftKey),
      altKey: Boolean(sourceEvent.altKey),
      metaKey: Boolean(sourceEvent.metaKey),
      relatedTarget: sourceEvent.relatedTarget || null,
    });

    // movementX/Y are not members of MouseEventInit, so Chromium ignores
    // them when passed to the constructor. Shadow the prototype getters on
    // this synthetic event; otherwise the game receives a perfectly valid
    // mousemove whose delta is always zero.
    Object.defineProperties(event, {
      movementX: { configurable: true, enumerable: true, value: movementX },
      movementY: { configurable: true, enumerable: true, value: movementY },
      mozMovementX: { configurable: true, value: movementX },
      mozMovementY: { configurable: true, value: movementY },
      webkitMovementX: { configurable: true, value: movementX },
      webkitMovementY: { configurable: true, value: movementY },
    });
    syntheticEvents.add(event);
    return event;
  };

  const onRawPointer = (event) => {
    if (!isPointerLocked()) return;
    if (event.pointerType && event.pointerType !== "mouse") return;

    const timestamp = now();
    const moving = isMoving(event);
    state.supported = true;
    state.rawEvents++;
    recordRate(rawRate, timestamp, moving);
    if (capture) recordCaptureEvent(capture.rawPointer, event, timestamp, true);

    if (!highRateEnabled() || bridgeDisabledForLock || !moving) return;

    const target = documentObject.pointerLockElement;
    if (!target || typeof target.dispatchEvent !== "function") return;

    try {
      const mouseMove = createSyntheticMouseMove(event);
      target.dispatchEvent(mouseMove);
      // Suppress the later coalesced native event only after the replacement
      // event was created and dispatched successfully. A platform-specific
      // MouseEvent quirk must always fail open to normal aiming.
      rawActiveForLock = true;
      lastRawAt = timestamp;
      pendingRawX += Number(event.movementX) || 0;
      pendingRawY += Number(event.movementY) || 0;
      pendingRawEvents++;
      state.syntheticMouseMoves++;
      if (capture) capture.bridge.syntheticMouseMoves++;
    } catch (error) {
      rawActiveForLock = false;
      bridgeDisabledForLock = true;
      lastRawAt = 0;
      state.bridgeError = error?.message || String(error);
    }
  };

  const onMouseMove = (event) => {
    if (!isPointerLocked()) return;
    if (syntheticEvents.has(event)) return;
    // Do not interfere with synthetic events from the game/client itself.
    if (event.isTrusted === false) return;

    const timestamp = now();
    const moving = isMoving(event);
    lastNativeAt = timestamp;
    state.nativeMouseMoves++;
    recordRate(nativeRate, timestamp, moving);
    if (capture) recordCaptureEvent(capture.nativeMouse, event, timestamp, false);

    // A pending raw delta was already delivered to the game. Suppress exactly
    // one later compatibility mousemove carrying that same movement, even if
    // it was delayed by a long JS task. Requiring pending data (rather than a
    // timer alone) prevents an unrelated native event from being swallowed.
    if (pendingRawEvents > 0) {
      const nativeX = Number(event.movementX) || 0;
      const nativeY = Number(event.movementY) || 0;
      const axisMatches = (raw, native) =>
        Math.abs(raw - native) <= Math.max(0.01, Math.abs(raw) * 0.01, Math.abs(native) * 0.01);
      const movementMatches = axisMatches(pendingRawX, nativeX) && axisMatches(pendingRawY, nativeY);
      if (movementMatches) {
        state.movementMatches++;
        consecutiveMovementMismatches = 0;
        if (capture) capture.bridge.movementMatches++;
      } else {
        state.movementMismatches++;
        consecutiveMovementMismatches++;
        if (capture) capture.bridge.movementMismatches++;

        // The raw movement is already applied. Reconcile any difference before
        // suppressing the native aggregate so total sensitivity remains equal
        // to Chromium's native path even when event grouping differs.
        const correctionX = nativeX - pendingRawX;
        const correctionY = nativeY - pendingRawY;
        if (correctionX !== 0 || correctionY !== 0) {
          try {
            const target = documentObject.pointerLockElement;
            target?.dispatchEvent(createSyntheticMouseMove(event, correctionX, correctionY));
            state.syntheticMouseMoves++;
            state.correctionMouseMoves++;
            if (capture) {
              capture.bridge.syntheticMouseMoves++;
              capture.bridge.correctionMouseMoves++;
            }
          } catch (error) {
            state.bridgeError = error?.message || String(error);
          }
        }

        // Repeated differences imply that this Chromium/platform combination
        // does not pair raw and compatibility movement as expected. Revert to
        // trusted native events for the remainder of this pointer lock.
        if (consecutiveMovementMismatches >= 3) {
          bridgeDisabledForLock = true;
          rawActiveForLock = false;
          if (capture) capture.bridge.disabledAfterMismatch = true;
        }
      }
      pendingRawX = 0;
      pendingRawY = 0;
      pendingRawEvents = 0;
      state.suppressedMouseMoves++;
      if (capture) capture.bridge.suppressedNativeMouseMoves++;
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      return;
    }

    state.passedNativeMouseMoves++;
    if (capture) capture.bridge.passedNativeMouseMoves++;
  };

  const onPointerMove = (event) => {
    if (!capture || !isPointerLocked() || event.isTrusted === false) return;
    const timestamp = now();
    recordRate(pointerRate, timestamp, isMoving(event));
    recordCaptureEvent(capture.pointerMove, event, timestamp, true);
  };

  const onPointerLockChange = () => {
    state.pointerLocked = isPointerLocked();
    state.lockChanges++;
    rawActiveForLock = false;
    bridgeDisabledForLock = false;
    pendingRawX = 0;
    pendingRawY = 0;
    pendingRawEvents = 0;
    consecutiveMovementMismatches = 0;
    lastRawAt = 0;
    lastNativeAt = 0;
    if (capture) capture.pointerLockChanges++;
  };

  addListener(windowObject, "pointerrawupdate", onRawPointer, true);
  addListener(windowObject, "mousemove", onMouseMove, true);
  addListener(windowObject, "pointermove", onPointerMove, true);
  addListener(documentObject, "pointerlockchange", onPointerLockChange, true);

  const pointerLockPrototype = windowObject.Element?.prototype;
  if (pointerLockPrototype && typeof pointerLockPrototype.requestPointerLock === "function") {
    nativeRequestPointerLock = pointerLockPrototype.requestPointerLock;
    const callNative = (element, requestOptions, hasOptions) =>
      hasOptions ? nativeRequestPointerLock.call(element, requestOptions) : nativeRequestPointerLock.call(element);
    const canFallback = (error) => !error || error.name === "NotSupportedError" || error.name === "TypeError";

    patchedRequestPointerLock = function dawnRequestPointerLock(requestOptions) {
      const hasOptions = arguments.length > 0;
      if (!unadjustedEnabled()) return callNative(this, requestOptions, hasOptions);

      state.unadjusted.attempts++;
      state.unadjusted.status = "requesting";
      state.unadjusted.lastError = null;
      const rawOptions = Object.assign({}, requestOptions || {}, { unadjustedMovement: true });

      const fallback = (error) => {
        state.unadjusted.lastError = error?.name || error?.message || String(error || "unsupported");
        if (!canFallback(error)) {
          state.unadjusted.status = "rejected";
          throw error;
        }
        state.unadjusted.fallbacks++;
        state.unadjusted.status = "plain-fallback";
        return callNative(this, requestOptions, hasOptions);
      };

      let result;
      try {
        result = callNative(this, rawOptions, true);
      } catch (error) {
        return fallback(error);
      }

      if (result && typeof result.then === "function") {
        return result.then((value) => {
          state.unadjusted.accepted++;
          state.unadjusted.status = "accepted";
          return value;
        }, fallback);
      }

      // Legacy implementations signal success through pointerlockchange and
      // return undefined. Chromium 128 returns a Promise, but keep this path
      // compatible rather than treating an unknown result as a failure.
      state.unadjusted.accepted++;
      state.unadjusted.status = "accepted-legacy";
      return result;
    };
    try {
      pointerLockPrototype.requestPointerLock = patchedRequestPointerLock;
      pointerLockPatched = pointerLockPrototype.requestPointerLock === patchedRequestPointerLock;
    } catch (error) {
      state.unadjusted.status = "patch-unavailable";
      state.unadjusted.lastError = error?.message || String(error);
    }
  }

  const startCapture = () => {
    if (capture) return false;
    capture = {
      startedAt: now(),
      rawPointer: createCaptureStream(),
      pointerMove: createCaptureStream(),
      nativeMouse: createCaptureStream(),
      bridge: {
        syntheticMouseMoves: 0,
        correctionMouseMoves: 0,
        suppressedNativeMouseMoves: 0,
        passedNativeMouseMoves: 0,
        movementMatches: 0,
        movementMismatches: 0,
        disabledAfterMismatch: false,
      },
      pointerLockChanges: 0,
      pointerLockedFrames: 0,
      sourceFrames: { raw: 0, native: 0 },
      inputAgeAtFrameMs: new Float32Array(MAX_CAPTURE_SAMPLES),
      inputAgeCount: 0,
      overflowSamples: 0,
    };
    return true;
  };

  const sampleFrame = (_frameTimestamp) => {
    if (!capture || !isPointerLocked()) return;
    capture.pointerLockedFrames++;
    const timestamp = now();
    const useRaw = highRateEnabled() && rawActiveForLock && lastRawAt > 0 && timestamp - lastRawAt <= RATE_STALE_MS;
    const inputTimestamp = useRaw ? lastRawAt : lastNativeAt;
    if (!inputTimestamp || timestamp - inputTimestamp > RATE_STALE_MS) return;

    // rAF's supplied timestamp can precede callbacks that ran in the same
    // frame task; performance.now() here is the comparable event-loop clock.
    const age = timestamp - inputTimestamp;
    if (Number.isFinite(age) && age >= 0 && age < 1000) {
      if (capture.inputAgeCount < capture.inputAgeAtFrameMs.length) {
        capture.inputAgeAtFrameMs[capture.inputAgeCount++] = age;
      } else {
        capture.overflowSamples++;
      }
      capture.sourceFrames[useRaw ? "raw" : "native"]++;
    }
  };

  const finishCapture = () => {
    if (!capture) return null;
    const result = capture;
    capture = null;
    return {
      durationSeconds: round((now() - result.startedAt) / 1000, 2),
      support: {
        pointerRawUpdate: state.supported,
        coalescedEvents: typeof windowObject.PointerEvent?.prototype?.getCoalescedEvents === "function",
        pointerLockOptions: pointerLockPatched,
      },
      settings: {
        highRateMouse: highRateEnabled(),
        unadjustedMovement: unadjustedEnabled(),
      },
      pointerLock: {
        lockedAtFinish: isPointerLocked(),
        changes: result.pointerLockChanges,
        renderedFramesLocked: result.pointerLockedFrames,
      },
      rawPointerUpdate: summarizeCaptureStream(result.rawPointer),
      pointerMove: summarizeCaptureStream(result.pointerMove),
      nativeMouseMove: summarizeCaptureStream(result.nativeMouse),
      bridge: result.bridge,
      inputAgeAtFrameMs: summarizeSeries(result.inputAgeAtFrameMs.subarray(0, result.inputAgeCount), 3),
      inputAgeSourceFrames: result.sourceFrames,
      overflowSamples: result.overflowSamples,
      unadjustedMovement: { ...state.unadjusted },
    };
  };

  const getStats = () => {
    const timestamp = now();
    const rawFresh = lastRawAt > 0 && timestamp - lastRawAt <= NATIVE_FALLBACK_MS;
    return {
      supported: state.supported,
      pointerLocked: isPointerLocked(),
      highRateEnabled: highRateEnabled(),
      unadjustedEnabled: unadjustedEnabled(),
      bridgeActive: highRateEnabled() && !bridgeDisabledForLock && rawActiveForLock && rawFresh,
      bridgeDisabledForLock,
      rawHz: estimateRate(rawRate, timestamp),
      pointerMoveHz: estimateRate(pointerRate, timestamp),
      nativeMouseHz: estimateRate(nativeRate, timestamp),
      rawEvents: state.rawEvents,
      syntheticMouseMoves: state.syntheticMouseMoves,
      correctionMouseMoves: state.correctionMouseMoves,
      suppressedMouseMoves: state.suppressedMouseMoves,
      passedNativeMouseMoves: state.passedNativeMouseMoves,
      movementMatches: state.movementMatches,
      movementMismatches: state.movementMismatches,
      unadjusted: { ...state.unadjusted },
    };
  };

  const destroy = () => {
    for (const [target, type, handler, listenerOptions] of listeners) {
      target.removeEventListener(type, handler, listenerOptions);
    }
    listeners.length = 0;
    if (pointerLockPatched && pointerLockPrototype.requestPointerLock === patchedRequestPointerLock) {
      pointerLockPrototype.requestPointerLock = nativeRequestPointerLock;
    }
    capture = null;
  };

  return { supported: true, startCapture, finishCapture, sampleFrame, getStats, destroy };
}

module.exports = {
  installRawMouse,
  summarizeCaptureStream,
};
