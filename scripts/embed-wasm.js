const fs = require("fs");
const path = require("path");

const wasmPath = process.argv[2];
const outPath = process.argv[3];

const buf = fs.readFileSync(wasmPath);
const bytes = Array.from(buf);
let js = "// Auto-generated from Rust WASM compile\n";
js += "const _wasmBytes = new Uint8Array([" + bytes.join(",") + "]);\n";
js += `
let _wasmInstance = null;
let _wasmMemory = null;

function _ensureWasm() {
  if (_wasmInstance) return;
  const mod = new WebAssembly.Module(_wasmBytes);
  const mem = new WebAssembly.Memory({ initial: 1 });
  _wasmInstance = new WebAssembly.Instance(mod, { env: { memory: mem } });
  _wasmMemory = mem;
}

function getScratchBuf() {
  _ensureWasm();
  return new Float32Array(_wasmMemory.buffer, 0, 16);
}

function parseSig(offset) {
  _ensureWasm();
  return _wasmInstance.exports.parse_sig(offset) >>> 0;
}

function fastHash(offset) {
  _ensureWasm();
  return _wasmInstance.exports.fast_hash(offset) >>> 0;
}

module.exports = { getScratchBuf, parseSig, fastHash };
`;
fs.writeFileSync(outPath, js);
console.log(`Wrote ${buf.length} bytes to ${outPath}`);
