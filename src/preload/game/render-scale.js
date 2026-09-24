"use strict";

const normalizeRenderScale = (value) => {
  if (value === undefined || value === null || value === "") return 1;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(1, Math.max(0.7, numeric / 100)) : 1;
};
const scaledDimension = (value, scale) => Math.max(1, Math.round(Math.max(1, Number(value) || 1) * scale));
const shouldScaleViewport = (requested, drawingBuffer, scale) =>
  scale < 0.999 && Number(requested) > Number(drawingBuffer) + 1;

/**
 * Lowers only the game canvas backing store. The canvas width/height getters
 * continue to expose the game's logical size, while default-framebuffer
 * viewport/scissor calls larger than the real buffer are mapped down. UI DOM
 * remains native-resolution. Default 100% is an exact no-op.
 */
function installRenderScale(options = {}) {
  const windowObject = options.windowObject || globalThis.window;
  const CanvasClass = options.CanvasClass || windowObject?.HTMLCanvasElement;
  if (!CanvasClass?.prototype) return { supported: false, update: () => {}, getStats: () => ({ supported: false }) };

  const prototype = CanvasClass.prototype;
  const widthDescriptor = Object.getOwnPropertyDescriptor(prototype, "width");
  const heightDescriptor = Object.getOwnPropertyDescriptor(prototype, "height");
  const nativeGetContext = prototype.getContext;
  if (!widthDescriptor?.get || !widthDescriptor?.set || !heightDescriptor?.get || !heightDescriptor?.set || typeof nativeGetContext !== "function") {
    return { supported: false, update: () => {}, getStats: () => ({ supported: false }) };
  }

  let scale = normalizeRenderScale(options.getScale?.() ?? 100);
  const canvases = new Set();
  const allContexts = new Set();
  const contexts = new WeakSet();
  const states = new WeakMap();
  let changes = 0;
  let scaledViewportCalls = 0;

  const applyBackingSize = (canvas, state) => {
    const displayWidth = Number(canvas.clientWidth);
    const displayHeight = Number(canvas.clientHeight);
    const hadInlineWidth = Boolean(canvas.style?.width) && !state.lockedCssWidth;
    const hadInlineHeight = Boolean(canvas.style?.height) && !state.lockedCssHeight;
    widthDescriptor.set.call(canvas, scaledDimension(state.logicalWidth, scale));
    heightDescriptor.set.call(canvas, scaledDimension(state.logicalHeight, scale));

    // A canvas with no CSS sizing normally derives its layout size from the
    // backing store. Lock only dimensions that actually shrank; stylesheet-
    // sized/fullscreen canvases retain their responsive CSS untouched.
    if (scale < 0.999 && canvas.style) {
      if (!hadInlineWidth && Number.isFinite(displayWidth) && displayWidth > 0 && Math.abs(Number(canvas.clientWidth) - displayWidth) > 1) {
        canvas.style.width = `${displayWidth}px`;
        state.lockedCssWidth = true;
      }
      if (!hadInlineHeight && Number.isFinite(displayHeight) && displayHeight > 0 && Math.abs(Number(canvas.clientHeight) - displayHeight) > 1) {
        canvas.style.height = `${displayHeight}px`;
        state.lockedCssHeight = true;
      }
    } else if (scale >= 0.999 && canvas.style) {
      if (state.lockedCssWidth) canvas.style.width = "";
      if (state.lockedCssHeight) canvas.style.height = "";
      state.lockedCssWidth = false;
      state.lockedCssHeight = false;
    }
    canvas.dataset && (canvas.dataset.dawnRenderScale = String(Math.round(scale * 100)));
  };

  const trackCanvas = (canvas) => {
    if (states.has(canvas)) return states.get(canvas);
    const state = {
      logicalWidth: widthDescriptor.get.call(canvas),
      logicalHeight: heightDescriptor.get.call(canvas),
      lockedCssWidth: false,
      lockedCssHeight: false,
      activated: false,
    };
    states.set(canvas, state);
    canvases.add(canvas);
    return state;
  };

  const activateCanvas = (canvas, state = trackCanvas(canvas)) => {
    if (state.activated) {
      applyBackingSize(canvas, state);
      return state;
    }
    // Refresh dimensions captured while the native 100% path was active.
    state.logicalWidth = widthDescriptor.get.call(canvas);
    state.logicalHeight = heightDescriptor.get.call(canvas);
    try {
      Object.defineProperty(canvas, "width", {
        configurable: true,
        enumerable: true,
        get: () => state.logicalWidth,
        set: (value) => {
          state.logicalWidth = Math.max(1, Number(value) || 1);
          widthDescriptor.set.call(canvas, scaledDimension(state.logicalWidth, scale));
          if (state.lockedCssWidth && canvas.style) canvas.style.width = `${state.logicalWidth}px`;
        },
      });
      Object.defineProperty(canvas, "height", {
        configurable: true,
        enumerable: true,
        get: () => state.logicalHeight,
        set: (value) => {
          state.logicalHeight = Math.max(1, Number(value) || 1);
          heightDescriptor.set.call(canvas, scaledDimension(state.logicalHeight, scale));
          if (state.lockedCssHeight && canvas.style) canvas.style.height = `${state.logicalHeight}px`;
        },
      });
      state.activated = true;
      applyBackingSize(canvas, state);
    } catch (error) {}
    return state;
  };

  const hookContext = (gl) => {
    if (!gl || contexts.has(gl) || typeof gl.viewport !== "function") return;
    contexts.add(gl);
    let defaultFramebuffer = true;
    let logicalDefaultCoordinates = false;
    const nativeViewport = gl.viewport.bind(gl);
    const nativeScissor = typeof gl.scissor === "function" ? gl.scissor.bind(gl) : null;
    const nativeBindFramebuffer = typeof gl.bindFramebuffer === "function" ? gl.bindFramebuffer.bind(gl) : null;

    if (nativeBindFramebuffer) {
      gl.bindFramebuffer = (target, framebuffer) => {
        if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) defaultFramebuffer = framebuffer == null;
        return nativeBindFramebuffer(target, framebuffer);
      };
    }

    const shouldMapRect = (x, y, width, height, isViewport) => {
      if (!defaultFramebuffer || scale >= 0.999) return false;
      const oversized =
        shouldScaleViewport(width, gl.drawingBufferWidth, scale) ||
        shouldScaleViewport(height, gl.drawingBufferHeight, scale);
      if (isViewport) {
        if (oversized) logicalDefaultCoordinates = true;
        else if (
          Math.abs(Number(x)) <= 1 &&
          Math.abs(Number(y)) <= 1 &&
          Math.abs(Number(width) - Number(gl.drawingBufferWidth)) <= 1 &&
          Math.abs(Number(height) - Number(gl.drawingBufferHeight)) <= 1
        ) {
          logicalDefaultCoordinates = false;
        }
      }
      return oversized || logicalDefaultCoordinates;
    };

    gl.viewport = (x, y, width, height) => {
      if (!shouldMapRect(x, y, width, height, true)) return nativeViewport(x, y, width, height);
      scaledViewportCalls++;
      return nativeViewport(
        Math.round(x * scale),
        Math.round(y * scale),
        Math.round(width * scale),
        Math.round(height * scale),
      );
    };
    if (nativeScissor) {
      gl.scissor = (x, y, width, height) => {
        if (!shouldMapRect(x, y, width, height, false)) return nativeScissor(x, y, width, height);
        scaledViewportCalls++;
        return nativeScissor(
          Math.round(x * scale),
          Math.round(y * scale),
          Math.round(width * scale),
          Math.round(height * scale),
        );
      };
    }
  };

  const patchedGetContext = function (type, attributes) {
    const isGameWebGL = this.id === (options.canvasId || "game") && (type === "webgl" || type === "webgl2");
    const state = isGameWebGL ? trackCanvas(this) : null;
    if (state && scale < 0.999) activateCanvas(this, state);
    const context = nativeGetContext.call(this, type, attributes);
    if (isGameWebGL && context && !allContexts.has(context)) allContexts.add(context);
    if (isGameWebGL && scale < 0.999) hookContext(context);
    return context;
  };
  prototype.getContext = patchedGetContext;

  const update = (value) => {
    const next = normalizeRenderScale(value);
    if (next === scale) return false;
    scale = next;
    changes++;
    for (const canvas of canvases) {
      const state = states.get(canvas);
      if (!state) continue;
      if (next < 0.999) activateCanvas(canvas, state);
      else if (state.activated) applyBackingSize(canvas, state);
    }
    if (next < 0.999) for (const context of allContexts) hookContext(context);
    // Let the engine refresh projection and viewport state after the backing
    // buffer changes. This uses its normal resize path rather than rebuilding GL.
    try { windowObject.dispatchEvent(new windowObject.Event("resize")); } catch (error) {}
    return true;
  };

  return {
    supported: true,
    update,
    destroy() {
      if (prototype.getContext === patchedGetContext) prototype.getContext = nativeGetContext;
    },
    getStats: () => ({
      supported: true,
      scalePercent: Math.round(scale * 100),
      canvases: canvases.size,
      changes,
      scaledViewportCalls,
    }),
  };
}

module.exports = { installRenderScale, normalizeRenderScale, scaledDimension, shouldScaleViewport };
