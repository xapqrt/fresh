"use strict";

const numeric = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseHexColor = (value) => {
  let normalized = String(value || "#FFFFFF").replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(normalized)) normalized = normalized.split("").map((part) => part + part).join("");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return { packed: 0xffffff, r: 255, g: 255, b: 255 };
  const packed = Number.parseInt(normalized, 16);
  return { packed, r: (packed >>> 16) & 255, g: (packed >>> 8) & 255, b: packed & 255 };
};

const changedTransform = (part) =>
  Math.abs(part.scale - 1) > 0.00001 ||
  Math.abs(part.offsetX) > 0.00001 ||
  Math.abs(part.offsetY) > 0.00001 ||
  Math.abs(part.offsetZ) > 0.00001 ||
  Math.abs(part.rotationX) > 0.00001 ||
  Math.abs(part.rotationY) > 0.00001 ||
  Math.abs(part.rotationZ) > 0.00001;

const compilePart = (settings, prefix) => {
  const rotationX = numeric(settings[`${prefix}_rotation_x`], 0);
  const rotationY = numeric(settings[`${prefix}_rotation_y`], 0);
  const rotationZ = numeric(settings[`${prefix}_rotation_z`], 0);
  return {
    scale: numeric(settings[`${prefix}_size`], 1),
    offsetX: numeric(settings[`${prefix}_offset_x`], 0),
    offsetY: numeric(settings[`${prefix}_offset_y`], 0),
    offsetZ: numeric(settings[`${prefix}_offset_z`], 0),
    rotationX,
    rotationY,
    rotationZ,
    rotationXRad: rotationX * Math.PI / 180,
    rotationYRad: rotationY * Math.PI / 180,
    rotationZRad: rotationZ * Math.PI / 180,
  };
};

/** Compile dynamic setting keys and colors outside uniformMatrix4fv's hot path. */
function compileCustomizationState(settings, requestedWeaponId) {
  const weaponId = requestedWeaponId || settings.active_weapon || "vita";
  const weapon = compilePart(settings, `${weaponId}_weapon`);
  const leftArm = compilePart(settings, `${weaponId}_left_arm`);
  const rightArm = compilePart(settings, `${weaponId}_right_arm`);

  weapon.wireframe = settings.weapon_wireframe === true;
  weapon.colorEnabled = settings.weapon_color === true;
  weapon.rainbow = settings.weapon_rainbow === true;
  weapon.color = parseHexColor(settings.weapon_color_hex);

  const armShared = {
    wireframe: settings.arm_wireframe === true,
    colorEnabled: settings.arm_color === true,
    rainbow: settings.arm_rainbow === true,
    color: parseHexColor(settings.arm_color_hex),
  };
  Object.assign(leftArm, armShared);
  Object.assign(rightArm, armShared);

  const inspectDuration = Math.max(1, numeric(settings[`${weaponId}_inspect_duration`], numeric(settings.inspect_duration, 700)));
  const weaponActive = changedTransform(weapon) || weapon.wireframe || weapon.colorEnabled;
  const armsActive = changedTransform(leftArm) || changedTransform(rightArm) || armShared.wireframe || armShared.colorEnabled;

  return {
    weaponId,
    weapon,
    arms: { left: leftArm, right: rightArm },
    inspectDuration,
    active: weaponActive || armsActive,
  };
}

module.exports = { compileCustomizationState, parseHexColor };
