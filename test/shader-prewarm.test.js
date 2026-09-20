"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { prewarmWebGLContext } = require("../src/preload/game/shader-prewarm");

const createGl = ({ compile = true, link = true } = {}) => {
  const calls = [];
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    createShader(type) { calls.push(["createShader", type]); return { type }; },
    shaderSource(shader, source) { calls.push(["shaderSource", shader.type, source]); },
    compileShader(shader) { calls.push(["compileShader", shader.type]); },
    getShaderParameter() { return compile; },
    getShaderInfoLog() { return "compile error"; },
    createProgram() { calls.push(["createProgram"]); return {}; },
    attachShader() { calls.push(["attachShader"]); },
    linkProgram() { calls.push(["linkProgram"]); },
    getProgramParameter() { return link; },
    getProgramInfoLog() { return "link error"; },
    deleteProgram() { calls.push(["deleteProgram"]); },
    deleteShader() { calls.push(["deleteShader"]); },
  };
  return { gl, calls };
};

test("shader prewarm compiles, links, and releases a minimal program", () => {
  const { gl, calls } = createGl();
  let timestamp = 10;
  const result = prewarmWebGLContext(gl, true, () => timestamp++);

  assert.equal(result.ok, true);
  assert.equal(result.webgl2, true);
  assert.equal(calls.filter(([name]) => name === "compileShader").length, 2);
  assert.equal(calls.filter(([name]) => name === "linkProgram").length, 1);
  assert.equal(calls.filter(([name]) => name === "deleteShader").length, 2);
  assert.match(calls.find(([name]) => name === "shaderSource")[2], /#version 300 es/);
});

test("shader prewarm fails open and still releases partial resources", () => {
  const { gl, calls } = createGl({ compile: false });
  const result = prewarmWebGLContext(gl, false, () => 10);

  assert.equal(result.ok, false);
  assert.match(result.reason, /compile error/);
  assert.equal(calls.filter(([name]) => name === "deleteShader").length, 1);
});
