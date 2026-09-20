"use strict";

/**
 * Reset renderer-local timing/input state around native window focus changes.
 * Main-process key/button releases repair Chromium's trusted input state; this
 * companion clears queued raw deltas and prevents one hidden interval from
 * becoming a large game-loop delta on resume.
 */
function installFocusRecovery(options = {}) {
  const windowObject = options.windowObject || globalThis.window;
  const documentObject = options.documentObject || globalThis.document;
  const ipc = options.ipc || null;
  const mouseInput = options.mouseInput || null;
  const now = options.now || (() => windowObject.performance.now());
  const platform = options.platform || "";
  const isInMatch = options.isInMatch || (() => false);
  const resetTelemetryClock = options.resetTelemetryClock || (() => {});

  if (!windowObject || !documentObject || typeof windowObject.addEventListener !== "function") {
    return { supported: false, destroy: () => {}, getStats: () => ({ supported: false }) };
  }

  const stats = {
    supported: true,
    blurCount: 0,
    focusCount: 0,
    resetCount: 0,
    contextMenusNormalized: 0,
    lastAwayMs: 0,
    maxAwayMs: 0,
    lastPhase: "installed",
    lastResetAt: now(),
  };
  let blurredAt = 0;
  let lastHandledPhase = "";
  let lastHandledAt = -Infinity;

  const reset = (phase, detail = {}) => {
    const timestamp = now();
    // BrowserWindow and DOM focus events describe the same transition. Main's
    // IPC can arrive on either side, so collapse only near-identical repeats.
    if (phase === lastHandledPhase && timestamp - lastHandledAt < 50) return false;
    lastHandledPhase = phase;
    lastHandledAt = timestamp;

    windowObject.__lastMainDelta = timestamp;
    windowObject.__dawnTickDt = 0;
    resetTelemetryClock(timestamp);
    try { mouseInput?.reset?.(); } catch (error) {}

    if (phase === "blur") {
      stats.blurCount++;
      blurredAt = timestamp;
      // Pointer lock should normally be released by Chromium on focus loss.
      // Explicitly end it as well so a stale lock cannot retain button state.
      try {
        if (documentObject.pointerLockElement && typeof documentObject.exitPointerLock === "function") {
          documentObject.exitPointerLock();
        }
      } catch (error) {}
    } else if (phase === "focus") {
      stats.focusCount++;
      const awayMs = Number(detail.awayMs);
      stats.lastAwayMs = Number.isFinite(awayMs)
        ? Math.max(0, awayMs)
        : blurredAt > 0
          ? Math.max(0, timestamp - blurredAt)
          : 0;
      stats.maxAwayMs = Math.max(stats.maxAwayMs, stats.lastAwayMs);
      blurredAt = 0;
    }

    stats.resetCount++;
    stats.lastPhase = phase;
    stats.lastResetAt = timestamp;
    return true;
  };

  const onBlur = () => reset("blur");
  const onFocus = () => reset("focus");
  const onIpcReset = (_event, detail = {}) => reset(detail.phase, detail);
  const onContextMenu = (event) => {
    // WebKit/Chromium on macOS emits Control+primary click as button=0 plus a
    // contextmenu event. Suppress only that synthetic secondary action during
    // a match. A real right click remains button=2 and passes untouched, while
    // the original primary mousedown/up/click continue to the game unchanged.
    if (platform !== "darwin" || !isInMatch()) return;
    if (!event.ctrlKey || Number(event.button) !== 0) return;
    stats.contextMenusNormalized++;
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    if (typeof event.stopPropagation === "function") event.stopPropagation();
  };

  windowObject.addEventListener("blur", onBlur, true);
  windowObject.addEventListener("focus", onFocus, true);
  documentObject.addEventListener("contextmenu", onContextMenu, true);
  ipc?.on?.("dawn-focus-reset", onIpcReset);
  windowObject.__dawnFocusRecovery = stats;

  const destroy = () => {
    windowObject.removeEventListener("blur", onBlur, true);
    windowObject.removeEventListener("focus", onFocus, true);
    documentObject.removeEventListener("contextmenu", onContextMenu, true);
    ipc?.removeListener?.("dawn-focus-reset", onIpcReset);
    if (windowObject.__dawnFocusRecovery === stats) delete windowObject.__dawnFocusRecovery;
  };

  return {
    supported: true,
    reset,
    getStats: () => ({ ...stats }),
    destroy,
  };
}

module.exports = { installFocusRecovery };
