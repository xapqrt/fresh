"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createDataIndex } = require("../src/preload/game/data-index");

const createStorage = (values) => ({
  getItem: (key) => values[key] ?? null,
});

test("data index parses each customization source once and provides map lookups", () => {
  const values = {
    nicknames: JSON.stringify({
      ABC: { original: "Alpha", nickname: "Ace" },
      META: { original: "A+B", nickname: "C.D" },
    }),
    "juice-customizations": JSON.stringify([{ shortId: "ABC", badges: ["a.png"] }]),
    "juice-clans": JSON.stringify([{ clan: "FAST", animated: true }]),
  };
  const index = createDataIndex(createStorage(values));

  assert.equal(index.nickname("ABC").nickname, "Ace");
  assert.equal(index.findNickname("Alpha").shortId, "ABC");
  assert.equal(index.replaceNicknames("Alpha#ABC joined"), "Ace#ABC joined");
  assert.equal(index.replaceNicknames("Ace#ABC joined"), "Ace#ABC joined");
  assert.equal(index.replaceNicknames("A+B#META joined"), "C.D#META joined");
  assert.equal(index.customization("ABC").badges[0], "a.png");
  assert.equal(index.clan("FAST").animated, true);
  index.nickname("ABC");
  assert.deepEqual(index.getStats().parseCounts, { nicknames: 1, customizations: 1, clans: 1 });

  values.nicknames = JSON.stringify({ ABC: { original: "Alpha", nickname: "After" } });
  index.invalidate("nicknames");
  assert.equal(index.nickname("ABC").nickname, "After");
  assert.equal(index.getStats().parseCounts.nicknames, 2);
});

test("data index fails open for malformed storage", () => {
  const index = createDataIndex(createStorage({ nicknames: "{broken", "juice-customizations": "null" }));
  assert.equal(index.nickname("missing"), undefined);
  assert.deepEqual(index.customizations().list, []);
});
