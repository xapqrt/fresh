"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  installRenderScale,
  normalizeRenderScale,
  scaledDimension,
  shouldScaleViewport,
} = require("../src/preload/game/render-scale");

test("render scale is bounded to the safe 70-100 percent range", () => {
  assert.equal(normalizeRenderScale(0), 0.7);
  assert.equal(normalizeRenderScale(50), 0.7);
  assert.equal(normalizeRenderScale(85), 0.85);
  assert.equal(normalizeRenderScale(120), 1);
  assert.equal(scaledDimension(1920, 0.75), 1440);
  assert.equal(scaledDimension(1, 0.7), 1);
});

test("only logical default-framebuffer viewports larger than the backing store need scaling", () => {
  assert.equal(shouldScaleViewport(1920, 1440, 0.75), true);
  assert.equal(shouldScaleViewport(1440, 1440, 0.75), false);
  assert.equal(shouldScaleViewport(1920, 1920, 1), false);
});

test("native 100 percent leaves canvas properties and WebGL methods untouched", () => {
  const nativeViewport = () => {};
  class NativeCanvas {
    constructor() { this._width = 800; this._height = 600; this.id = "game"; }
    get width() { return this._width; }
    set width(value) { this._width = value; }
    get height() { return this._height; }
    set height(value) { this._height = value; }
    getContext() {
      if (!this.context) {
        this.context = {
          viewport: nativeViewport,
          scissor() {},
          bindFramebuffer() {},
          get drawingBufferWidth() { return 800; },
          get drawingBufferHeight() { return 600; },
        };
      }
      return this.context;
    }
  }
  const api = installRenderScale({
    CanvasClass: NativeCanvas,
    windowObject: { HTMLCanvasElement: NativeCanvas, Event: class {}, dispatchEvent() {} },
    getScale: () => 100,
  });
  const canvas = new NativeCanvas();
  const gl = canvas.getContext("webgl");
  assert.equal(Object.hasOwn(canvas, "width"), false);
  assert.equal(Object.hasOwn(canvas, "height"), false);
  assert.equal(gl.viewport, nativeViewport);
  assert.equal(canvas._width, 800);
  api.destroy();
});

test("render-scale installer keeps logical canvas size while mapping the real WebGL buffer", () => {
  const viewportCalls = [];
  const scissorCalls = [];
  class Canvas {
    constructor() {
      this._width = 1920;
      this._height = 1080;
      this.id = "game";
      this.dataset = {};
      this.style = {};
    }
    get width() { return this._width; }
    set width(value) { this._width = value; }
    get height() { return this._height; }
    set height(value) { this._height = value; }
    get clientWidth() { return this.style.width ? parseFloat(this.style.width) : this._width; }
    get clientHeight() { return this.style.height ? parseFloat(this.style.height) : this._height; }
    getContext() {
      const canvas = this;
      return {
        FRAMEBUFFER: 1,
        DRAW_FRAMEBUFFER: 2,
        get drawingBufferWidth() { return canvas._width; },
        get drawingBufferHeight() { return canvas._height; },
        viewport: (...args) => viewportCalls.push(args),
        scissor: (...args) => scissorCalls.push(args),
        bindFramebuffer: () => {},
      };
    }
  }
  const windowObject = {
    HTMLCanvasElement: Canvas,
    Event: class { constructor(type) { this.type = type; } },
    dispatchEvent: () => {},
  };
  const api = installRenderScale({ windowObject, getScale: () => 80 });
  const canvas = new Canvas();
  const gl = canvas.getContext("webgl");

  assert.equal(canvas.width, 1920);
  assert.equal(canvas._width, 1536);
  assert.equal(canvas.style.width, "1920px");
  assert.equal(canvas.style.height, "1080px");
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.scissor(10, 20, 100, 50);
  assert.deepEqual(viewportCalls[0], [0, 0, 1536, 864]);
  assert.deepEqual(scissorCalls[0], [8, 16, 80, 40]);
  api.update(100);
  assert.equal(canvas._width, 1920);
  assert.equal(canvas.style.width, "");
  assert.equal(canvas.style.height, "");
  api.destroy();
});
