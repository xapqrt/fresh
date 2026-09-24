"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createAssetPrewarmer, selectPrewarmCandidates } = require("../src/preload/game/asset-prewarm");

test("asset prewarm prioritizes combat assets and obeys count/byte budgets", () => {
  const entries = [
    { name: "https://kirka.io/assets/background.png", decodedBodySize: 700000 },
    { name: "https://kirka.io/assets/weapon-rifle.png", decodedBodySize: 300000 },
    { name: "https://kirka.io/assets/hit.mp3", decodedBodySize: 400000 },
    { name: "https://kirka.io/assets/app.js", decodedBodySize: 10 },
  ];
  const result = selectPrewarmCandidates(entries, [], { maxBytes: 750000, maxCount: 2 });
  assert.deepEqual(result.candidates.map(({ url }) => url), [
    "https://kirka.io/assets/weapon-rifle.png",
    "https://kirka.io/assets/hit.mp3",
  ]);
  assert.equal(result.estimatedBytes, 700000);
  assert.equal(selectPrewarmCandidates(entries, [], { maxBytes: 0, maxCount: 0 }).candidates.length, 0);
});

test("asset prewarm deduplicates DOM/settings extras", () => {
  const url = "https://kirka.io/crosshair.png";
  const result = selectPrewarmCandidates([{ name: url, transferSize: 100 }], [url], { maxBytes: 1000, maxCount: 5 });
  assert.equal(result.candidates.length, 1);
});

test("asset prewarm cancellation aborts the in-flight decode", async () => {
  let idleCallback;
  let image;
  class PendingImage {
    constructor() { image = this; }
    set src(value) { this.currentSrc = value; }
    get src() { return this.currentSrc; }
    removeAttribute(name) { if (name === "src") this.currentSrc = ""; }
  }
  const prewarmer = createAssetPrewarmer({
    windowObject: {
      performance: { getEntriesByType: () => [{ name: "https://kirka.io/assets/weapon.png", transferSize: 100 }] },
    },
    documentObject: { visibilityState: "visible", querySelectorAll: () => [] },
    ImageClass: PendingImage,
    requestIdle: (callback) => { idleCallback = callback; return 1; },
    cancelIdle: () => {},
    timeoutMs: 1000,
  });

  prewarmer.start();
  idleCallback();
  assert.equal(image.src, "https://kirka.io/assets/weapon.png");
  prewarmer.cancel();
  await Promise.resolve();
  assert.equal(image.src, "");
  assert.equal(prewarmer.getStats().cancelled, 1);
  assert.equal(prewarmer.getStats().active, false);
});
