"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { compileCustomizationState, parseHexColor } = require("../src/preload/game/customization-state");

test("customization state precompiles weapon, arm, duration, and color values", () => {
  const state = compileCustomizationState({
    vita_weapon_size: "1.25",
    vita_weapon_offset_x: "0.1",
    vita_left_arm_rotation_y: "15",
    weapon_color: true,
    weapon_color_hex: "#12ABEF",
    arm_wireframe: true,
    vita_inspect_duration: "575",
  }, "vita");

  assert.equal(state.weapon.scale, 1.25);
  assert.equal(state.weapon.offsetX, 0.1);
  assert.equal(state.weapon.color.packed, 0x12abef);
  assert.equal(state.arms.left.rotationY, 15);
  assert.equal(state.arms.left.rotationYRad, Math.PI / 12);
  assert.equal(state.inspectDuration, 575);
  assert.equal(state.active, true);
});

test("stock customization compiles to an inactive hot-path state", () => {
  const state = compileCustomizationState({}, "scar");
  assert.equal(state.active, false);
  assert.deepEqual(parseHexColor("not-a-color"), { packed: 0xffffff, r: 255, g: 255, b: 255 });
});
