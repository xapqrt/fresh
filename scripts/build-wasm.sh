#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/../src/wasm"
cargo build --release --target wasm32-unknown-unknown
node "$(dirname "$0")/embed-wasm.js" \
  "target/wasm32-unknown-unknown/release/dawn_wasm.wasm" \
  "$(dirname "$0")/../src/wasm/dawn_wasm.js"
echo "WASM build complete"
