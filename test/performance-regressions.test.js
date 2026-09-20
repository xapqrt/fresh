"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("chat processing uses one route-scoped mutation observer instead of per-message observers", () => {
  const source = fs.readFileSync(path.join(root, "src/preload/game.js"), "utf8");
  const start = source.indexOf("// One route-scoped observer handles every message/text mutation.");
  const end = source.indexOf("const updateMessages", start);
  assert.ok(start >= 0 && end > start);
  const section = source.slice(start, end);

  assert.equal((section.match(/new MutationObserver/g) || []).length, 1);
  assert.match(section, /chatObserver\.disconnect\(\)/);
  assert.doesNotMatch(source, /observedMessages|observeEndMessage|observeMessage\s*=/);
});

test("warm bundle metadata survives cache pruning and revalidates in background", () => {
  const source = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  assert.match(source, /f === 'last-bundle-url\.txt'/);
  assert.match(source, /setTimeout\(\(\) => \{ void revalidateBundleCache\(base, lastUrl\); \}, 250\)/);
  assert.match(source, /void _cacheSet\(targetScriptUrl, finalCode\)/);
});

test("generated fixed-step and adaptive-interpolation bundle patches are valid JavaScript", () => {
  const source = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const replacementFor = (name) => {
    const block = source.match(new RegExp(`name: '${name}'[\\s\\S]*?replacement: ("(?:\\\\.|[^"\\\\])*")`));
    assert.ok(block, `missing ${name} patch`);
    return JSON.parse(block[1]);
  };

  for (const name of ["gameLoopFixedStep", "adaptiveInterpolation"]) {
    const replacement = replacementFor(name);
    assert.doesNotThrow(() => new Function("iM", "iL", "dhc", "deT", "v", "j0", "window", "performance", `${replacement};`));
  }

  const fixed = replacementFor("gameLoopFixedStep");
  const calls = [];
  const game = { clock: {}, update: (delta) => calls.push(delta) };
  const windowObject = {
    speed: 1,
    __dawnTickMul: 8,
    __dawnDisplayHz: 60,
    __dawnFixedStep: true,
    __dawnSimulationClock: require("../src/preload/game/simulation-clock").createSimulationClock({ scope: {}, now: () => 100 }),
  };
  const dhc = (code) => ({ 0x6857: "clock", 0x2eb5: "now", 0x3918: "update", 0x243e: "speed" })[code];
  new Function("iM", "iL", "dhc", "window", "performance", `${fixed};`)(60, game, dhc, windowObject, { now: () => 100 });
  assert.equal(calls.length, 1);
  assert.ok(Math.abs(calls[0] - 1 / 480) < 1e-9);

  const stockCalls = [];
  game.update = (delta) => stockCalls.push(delta);
  windowObject.__dawnTickMul = 1;
  windowObject.__dawnSimulationClock = require("../src/preload/game/simulation-clock").createSimulationClock({ scope: {}, now: () => 110 });
  new Function("iM", "iL", "dhc", "window", "performance", `${fixed};`)(80, game, dhc, windowObject, { now: () => 110 });
  assert.equal(stockCalls[0], 1 / 80);

  const adaptive = replacementFor("adaptiveInterpolation");
  const interpWindow = {
    __dawnInterpDelayMs: 33,
    __dawnInterpolation: { select: () => 2 },
  };
  const deT = (code) => ({ 0x4015: "prefs", 0x6857: "timestamp" })[code];
  const snapshots = [{ timestamp: 100 }, { timestamp: 133 }, { timestamp: 166 }];
  new Function("v", "j0", "deT", "window", `${adaptive};`)({ a: { prefs: { game: { WwNmWMw: false } } } }, snapshots, deT, interpWindow);
  assert.equal(interpWindow.__dawnInterpSnapshots, 2);
});
