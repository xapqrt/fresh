"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  InputStateGuard,
  MODIFIER_KEY_CODES,
  keyCodeFromInput,
} = require("../src/util/input-state-guard");

test("focus recovery releases Control when its key-up was lost during a desktop switch", () => {
  let clock = 1000;
  const guard = new InputStateGuard(() => clock);
  guard.record({ type: "keyDown", code: "ControlLeft", key: "Control" });
  guard.record({ type: "keyDown", code: "KeyW", key: "w" });

  const blurred = guard.blur();
  assert.ok(blurred.releaseKeys.includes("Control"));
  assert.ok(blurred.releaseKeys.includes("W"));

  clock = 2250;
  const focused = guard.focus();
  assert.equal(focused.hadBlur, true);
  assert.equal(focused.awayMs, 1250);
  assert.ok(focused.releaseKeys.includes("Control"));
  assert.ok(focused.releaseKeys.includes("W"));
});

test("every modifier is sanitized even if its key-down was missed", () => {
  const guard = new InputStateGuard(() => 10);
  guard.blur();
  const focused = guard.focus();

  for (const modifier of MODIFIER_KEY_CODES) {
    assert.ok(focused.releaseKeys.includes(modifier));
  }
});

test("DOM codes map to Electron sendInputEvent key codes", () => {
  assert.equal(keyCodeFromInput({ code: "ControlRight", key: "Control" }), "Control");
  assert.equal(keyCodeFromInput({ code: "KeyQ", key: "q" }), "Q");
  assert.equal(keyCodeFromInput({ code: "ArrowLeft", key: "ArrowLeft" }), "Left");
  assert.equal(keyCodeFromInput({ code: "Space", key: " " }), "Space");
});
