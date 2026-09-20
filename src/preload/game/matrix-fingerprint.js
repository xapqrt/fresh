"use strict";

const quantize = (value, scale) => Math.round((Number(value) || 0) * scale);

const scaleSignatureKey = (x, y, z) => {
  const a = quantize(x, 100);
  const b = quantize(y, 100);
  const c = quantize(z, 100);
  // Scale magnitudes in this hook are small and positive. Base 1024 keeps the
  // three rounded components in one exact Number without string allocation.
  return a * 1048576 + b * 1024 + c;
};

class NumericMatrixDeduper {
  constructor(capacity = 96) {
    this.capacity = Math.max(1, capacity | 0);
    this.hashes = new Int32Array(this.capacity);
    this.values = new Int32Array(this.capacity * 6);
    this.count = 0;
  }

  clear() {
    this.count = 0;
  }

  seen(matrix) {
    const q0 = quantize(matrix[0], 1000);
    const q1 = quantize(matrix[5], 1000);
    const q2 = quantize(matrix[10], 1000);
    const q3 = quantize(matrix[12], 10000);
    const q4 = quantize(matrix[13], 10000);
    const q5 = quantize(matrix[14], 10000);

    let hash = 0x811c9dc5;
    hash = Math.imul(hash ^ q0, 0x01000193);
    hash = Math.imul(hash ^ q1, 0x01000193);
    hash = Math.imul(hash ^ q2, 0x01000193);
    hash = Math.imul(hash ^ q3, 0x01000193);
    hash = Math.imul(hash ^ q4, 0x01000193);
    hash = Math.imul(hash ^ q5, 0x01000193);

    for (let entry = 0; entry < this.count; entry++) {
      if (this.hashes[entry] !== hash) continue;
      const offset = entry * 6;
      if (
        this.values[offset] === q0 &&
        this.values[offset + 1] === q1 &&
        this.values[offset + 2] === q2 &&
        this.values[offset + 3] === q3 &&
        this.values[offset + 4] === q4 &&
        this.values[offset + 5] === q5
      ) return true;
    }

    if (this.count < this.capacity) {
      const offset = this.count * 6;
      this.hashes[this.count] = hash;
      this.values[offset] = q0;
      this.values[offset + 1] = q1;
      this.values[offset + 2] = q2;
      this.values[offset + 3] = q3;
      this.values[offset + 4] = q4;
      this.values[offset + 5] = q5;
      this.count++;
    }
    return false;
  }
}

module.exports = { NumericMatrixDeduper, scaleSignatureKey };
