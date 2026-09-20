"use strict";

const { round, summarizeSeries } = require("../../util/perf-metrics");

const ACTIVE_INTERVAL_MAX_MS = 100;
const RATE_STALE_MS = 250;
const ROLLING_INTERVALS = 256;
const KNOWN_POLLING_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];

const classifyPollingRate = (intervalMs) => {
  const measuredHz = intervalMs > 0 ? 1000 / intervalMs : 0;
  if (!Number.isFinite(measuredHz) || measuredHz < 60) return 0;
  let closest = KNOWN_POLLING_RATES[0];
  let distance = Math.abs(measuredHz - closest);
  for (let index = 1; index < KNOWN_POLLING_RATES.length; index++) {
    const candidateDistance = Math.abs(measuredHz - KNOWN_POLLING_RATES[index]);
    if (candidateDistance < distance) {
      closest = KNOWN_POLLING_RATES[index];
      distance = candidateDistance;
    }
  }
  return closest;
};

const pollingProfileForRate = (rateHz) => {
  const rate = Number(rateHz) || 1000;
  if (rate >= 8000) return { reconciliationWindowMs: 20, mismatchLimit: 10, deltaTolerance: 0.12 };
  if (rate >= 4000) return { reconciliationWindowMs: 24, mismatchLimit: 8, deltaTolerance: 0.1 };
  if (rate >= 2000) return { reconciliationWindowMs: 32, mismatchLimit: 6, deltaTolerance: 0.08 };
  if (rate >= 1000) return { reconciliationWindowMs: 40, mismatchLimit: 4, deltaTolerance: 0.05 };
  return { reconciliationWindowMs: 50, mismatchLimit: 3, deltaTolerance: 0.02 };
};
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
  reset: () => {},
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
  const platform = options.platform || (typeof process !== "undefined" ? process.platform : "");
  const isInMatch = options.isInMatch || (() => {
    const pathname = documentObject.location?.pathname || windowObject.location?.pathname || "";
    return pathname.startsWith("/games") || pathname.startsWith("/hub/ranked");
  });

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
  let pendingRawLastAt = 0;
  let consecutiveMovementMismatches = 0;
  let lastRawAt = 0;
  let lastRawSampleAt = 0;
  let rawIntervalEwma = 1;
  let rawIntervalSamples = 0;
  let pollingRateHz = 1000;
  let pollingProfile = pollingProfileForRate(pollingRateHz);
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
    lateReconciliations: 0,
    lockChanges: 0,
    focusResets: 0,
    normalizedControlClicks: 0,
    pollingProfileChanges: 0,
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

  const updatePollingProfile = (timestamp, moving) => {
    if (!moving) return;
    if (lastRawSampleAt) {
      const interval = timestamp - lastRawSampleAt;
      if (interval > 0.05 && interval <= 16) {
        // An EWMA ignores occasional event-loop stalls while adapting within a
        // few dozen samples when a different mouse/polling mode is selected.
        rawIntervalEwma = rawIntervalSamples
          ? rawIntervalEwma * 0.9 + interval * 0.1
          : interval;
        rawIntervalSamples++;
        if (rawIntervalSamples >= 16 && rawIntervalSamples % 8 === 0) {
          const classified = classifyPollingRate(rawIntervalEwma);
          if (classified && classified !== pollingRateHz) {
            pollingRateHz = classified;
            pollingProfile = pollingProfileForRate(classified);
            state.pollingProfileChanges++;
          }
        }
      }
    }
    lastRawSampleAt = timestamp;
  };

  const resetBridgeState = (countFocusReset = true) => {
    rawActiveForLock = false;
    bridgeDisabledForLock = false;
    pendingRawX = 0;
    pendingRawY = 0;
    pendingRawEvents = 0;
    pendingRawLastAt = 0;
    consecutiveMovementMismatches = 0;
    lastRawAt = 0;
    lastRawSampleAt = 0;
    lastNativeAt = 0;
    state.pointerLocked = isPointerLocked();
    if (countFocusReset) {
      state.focusResets++;
      if (capture) capture.bridge.focusResets++;
    }
  };

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
    updatePollingProfile(timestamp, moving);
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
      pendingRawLastAt = timestamp;
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
      const sampleTolerance = pollingProfile.deltaTolerance * Math.sqrt(Math.max(1, pendingRawEvents));
      const axisMatches = (raw, native) =>
        Math.abs(raw - native) <= Math.max(sampleTolerance, Math.abs(raw) * 0.01, Math.abs(native) * 0.01);
      const movementMatches = axisMatches(pendingRawX, nativeX) && axisMatches(pendingRawY, nativeY);
      const reconciliationAge = pendingRawLastAt ? timestamp - pendingRawLastAt : 0;
      const lateReconciliation = reconciliationAge > pollingProfile.reconciliationWindowMs;
      if (movementMatches) {
        state.movementMatches++;
        consecutiveMovementMismatches = 0;
        if (capture) capture.bridge.movementMatches++;
      } else {
        state.movementMismatches++;
        if (lateReconciliation) {
          // A delayed compatibility aggregate can cross a batching boundary.
          // Reconcile its delta, but do not punish the bridge as if the current
          // polling profile had produced a prompt mismatched pair.
          state.lateReconciliations++;
          if (capture) capture.bridge.lateReconciliations++;
          consecutiveMovementMismatches = 0;
        } else {
          consecutiveMovementMismatches++;
        }
        if (capture) capture.bridge.movementMismatches++;
      }

      // Tolerance controls mismatch classification only. Always reconcile even
      // a sub-unit difference so adjusted high-rate input keeps exactly the
      // same total movement as Chromium's native compatibility event.
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

      // Repeated prompt differences imply that this platform does not pair raw
      // and compatibility movement as expected. Fall back for this lock.
      if (consecutiveMovementMismatches >= pollingProfile.mismatchLimit) {
        bridgeDisabledForLock = true;
        rawActiveForLock = false;
        if (capture) capture.bridge.disabledAfterMismatch = true;
      }
      pendingRawX = 0;
      pendingRawY = 0;
      pendingRawEvents = 0;
      pendingRawLastAt = 0;
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
    state.lockChanges++;
    resetBridgeState(false);
    if (capture) capture.pointerLockChanges++;
  };

  const onWindowFocusChange = () => resetBridgeState(true);
  const onContextMenu = (event) => {
    // Chromium reports macOS Control+primary-click as button 0 followed by a
    // contextmenu event. Swallow only that secondary action in a match; the
    // original primary mousedown/up remain untouched, and a real right click
    // (button 2) still reaches Kirka normally.
    if (platform !== "darwin" || !isInMatch()) return;
    if (!event.ctrlKey || Number(event.button) !== 0) return;
    state.normalizedControlClicks++;
    if (capture) capture.bridge.normalizedControlClicks++;
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    if (typeof event.stopPropagation === "function") event.stopPropagation();
  };

  addListener(windowObject, "pointerrawupdate", onRawPointer, true);
  addListener(windowObject, "mousemove", onMouseMove, true);
  addListener(windowObject, "pointermove", onPointerMove, true);
  addListener(windowObject, "blur", onWindowFocusChange, true);
  addListener(windowObject, "focus", onWindowFocusChange, true);
  addListener(documentObject, "visibilitychange", onWindowFocusChange, true);
  addListener(documentObject, "pointerlockchange", onPointerLockChange, true);
  addListener(documentObject, "contextmenu", onContextMenu, true);

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
        lateReconciliations: 0,
        focusResets: 0,
        normalizedControlClicks: 0,
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
      bridge: {
        ...result.bridge,
        pollingRateHz,
        pollingIntervalMs: round(rawIntervalEwma, 3),
        reconciliationWindowMs: pollingProfile.reconciliationWindowMs,
        mismatchLimit: pollingProfile.mismatchLimit,
      },
      inputAgeAtFrameMs: summarizeSeries(result.inputAgeAtFrameMs.subarray(0, result.inputAgeCount), 3),
      inputAgeSourceFrames: result.sourceFrames,
      overflowSamples: result.overflowSamples,
      unadjustedMovement: { ...state.unadjusted },
    };
  };

  const getStats = () => {
    const timestamp = now();
    const rawFresh = lastRawAt > 0 && timestamp - lastRawAt <= pollingProfile.reconciliationWindowMs;
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
      lateReconciliations: state.lateReconciliations,
      pollingRateHz,
      pollingIntervalMs: round(rawIntervalEwma, 3),
      reconciliationWindowMs: pollingProfile.reconciliationWindowMs,
      mismatchLimit: pollingProfile.mismatchLimit,
      pollingProfileChanges: state.pollingProfileChanges,
      focusResets: state.focusResets,
      normalizedControlClicks: state.normalizedControlClicks,
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

  return {
    supported: true,
    startCapture,
    finishCapture,
    sampleFrame,
    getStats,
    reset: () => resetBridgeState(true),
    destroy,
  };
}

module.exports = {
  classifyPollingRate,
  installRawMouse,
  pollingProfileForRate,
  summarizeCaptureStream,
};
