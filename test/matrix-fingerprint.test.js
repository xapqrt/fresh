"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { NumericMatrixDeduper, scaleSignatureKey } = require("../src/preload/game/matrix-fingerprint");

const matrix = (x = 1, y = 1, z = 1, tx = 0, ty = 0, tz = 0) => {
  const value = new Float32Array(16);
  value[0] = x;
  value[5] = y;
  value[10] = z;
  value[12] = tx;
  value[13] = ty;
  value[14] = tz;
  value[15] = 1;
  return value;
};

test("numeric scale signatures preserve the former two-decimal identity", () => {
  assert.equal(scaleSignatureKey(1.399, 1.404, 1.4), scaleSignatureKey(1.4, 1.4, 1.4));
  assert.notEqual(scaleSignatureKey(1.4, 1.4, 1.4), scaleSignatureKey(1.41, 1.4, 1.4));
});

test("numeric matrix deduper detects rounded duplicates without string keys", () => {
  const deduper = new NumericMatrixDeduper(4);
  const first = matrix(1, 2, 3, 0.1, 0.2, 0.3);
  const roundedDuplicate = matrix(1.0004, 2.0004, 3.0004, 0.10004, 0.20004, 0.30004);
  const distinct = matrix(1.002, 2, 3, 0.1, 0.2, 0.3);

  assert.equal(deduper.seen(first), false);
  assert.equal(deduper.seen(roundedDuplicate), true);
  assert.equal(deduper.seen(distinct), false);
  deduper.clear();
  assert.equal(deduper.seen(first), false);
});
