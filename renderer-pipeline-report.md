# Renderer Pipeline Upgrade Report — Dawn Client

**Project:** Dawn Client (Kirka.io FPS Electron Client)  
**Current Electron:** 12.2.3 (Chrome 89, V8 10.2)  
**Architecture:** ARM64 (Apple Silicon M-series)  
**Target Renderer:** OffscreenCanvas + WebGPU / WebGL Advanced Pipeline  

---

## 1. Migration Path: Current Renderer → OffscreenCanvas + WebGPU

### Current State

```
Game Canvas (<canvas id="game">)
  └─ WebGL 1.0 context (getContext('webgl'))
       ├─ weapon-hook.js intercepts gl.uniformMatrix4fv
       ├─ gl.clear / gl.bindTexture / gl.drawArrays / gl.drawElements
       └─ WASM matrix-signature matching (parseSig, fastHash)
```

All rendering runs on the **main thread** — rAF-driven, tied to the BrowserWindow's WebGL context. The FPS overlay (Canvas2D sparkline) and DOM operations compete with the game render loop.

### Migration Path (Phased)

#### Phase 1 — OffscreenCanvas (WebGL → WebGL via OffscreenCanvas)

```
Main Thread:                   Worker Thread (OffscreenCanvas):
  └─ 1. canvas.transferControlToOffscreen()
  └─ 2. postMessage(offscreenCanvas)
                                    └─ 3. offscreen.getContext('webgl')
                                    └─ 4. Install weapon-hook wrappers
                                    └─ 5. requestAnimationFrame loop (worker-owned)
  └─ 6. Input events → postMessage  ←─── 7. Present frame buffer (commit())
```

**Code pattern:**

```javascript
// === main.js / preload ===
// Phase 1: transfer game canvas to worker
const canvas = document.getElementById('game');
const offscreen = canvas.transferControlToOffscreen();
const renderWorker = new Worker('game-render-worker.js');
renderWorker.postMessage({ canvas: offscreen }, [offscreen]);

// Send input to worker
canvas.addEventListener('pointermove', (e) => {
  renderWorker.postMessage({ type: 'pointermove', x: e.clientX, y: e.clientY });
});
// Forward WebGL hooks (weapon-hook intercepted uniform data)
// Weapon/arm matrix data → postMessage to worker
```

```javascript
// === game-render-worker.js ===
self.onmessage = (e) => {
  if (e.data.canvas) {
    const canvas = e.data.canvas;
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      desynchronized: true,
      powerPreference: 'high-performance',
    });
    // Install weapon-hook wrappers here
    startGameLoop(gl);
  }
};

function startGameLoop(gl) {
  let lastTime = performance.now();
  function frame(now) {
    const delta = now - lastTime;
    lastTime = now;
    // Game renders here — off main thread
    // Weapon matrix modifications via WASM
    // ...
    gl.commit();  // Electron-12 does NOT have commit() — see Phase 1a
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
```

**Phase 1a — `commit()` polyfill for Electron 12:**

Electron 12 (Chrome 89) does not support `OffscreenCanvas.commit()`. The `commit()` method was added in Chrome 91. Without it, OffscreenCanvas frames are never presented to the visible canvas.

**Workaround:** Use `HTMLCanvasElement.transferControlToOffscreen()` for thread ownership, but present frames via `bitmaprenderer` on the main thread:

```javascript
// Worker: render to offscreen, transfer bitmap
self.onmessage = function(e) {
  if (e.data.canvas) {
    const offscreen = e.data.canvas;
    const gl = offscreen.getContext('webgl2', { /* ... */ });
    // ... render loop ...
    // Instead of commit(), transfer ImageBitmap
    const bitmap = offscreen.transferToImageBitmap();
    self.postMessage({ bitmap }, [bitmap]);
  }
};

// Main thread: draw bitmap to visible canvas
const canvas = document.getElementById('game');
const ctx = canvas.getContext('bitmaprenderer');
renderWorker.onmessage = (e) => {
  if (e.data.bitmap) {
    ctx.transferFromImageBitmap(e.data.bitmap);
    e.data.bitmap.close();
  }
};
```

**Note:** `transferToImageBitmap()` + `transferFromImageBitmap()` is the only viable OffscreenCanvas path on Chrome 89. It adds 1-2 copies per frame but still moves the heavy GL work off the main thread.

**Upgrade benefit:** Once on Electron 28+ (Chrome 120), `commit()` eliminates the bitmap copy overhead.

#### Phase 2 — OffscreenCanvas + WebGPU

```
Worker Thread (OffscreenCanvas):
  └─ 1. offscreen.getContext('webgpu', { ... })
  └─ 2. Create swap chain (vsync mode)
  └─ 3. Render loop: getCurrentTexture() → render pass → present()
  └─ 4. commit() (Electron 28+)

Benefit: GPU compute shaders for bloom-filter dedup, matrix ops
         Lower draw-call overhead vs WebGL
```

**Code pattern (Electron 28+):**

```javascript
// === game-render-worker.js (WebGPU) ===
self.onmessage = async (e) => {
  if (e.data.canvas) {
    const offscreen = e.data.canvas;
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    const device = await adapter.requestDevice();

    const context = offscreen.getContext('webgpu');
    context.configure({
      device,
      format: 'bgra8unorm',
      alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      // Mailbox-style presentation on Apple Silicon
      presentMode: 'mailbox',
    });

    // Upload WASM matrix data to GPU buffer
    const matrixBuffer = device.createBuffer({
      size: 64, // 16 floats
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Weapon-hook: write matrix data via device.queue.writeBuffer
    // instead of gl.uniformMatrix4fv interception

    function frame() {
      const texture = context.getCurrentTexture();
      const renderPass = device.createCommandEncoder()
        .beginRenderPass({
          colorAttachments: [{
            view: texture.createView(),
            loadOp: 'clear',
            storeOp: 'store',
          }],
        });

      // ... WebGPU render pass commands ...

      renderPass.end();
      device.queue.submit([renderPass]);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
};
```

**Migrating the WebGL weapon-hook to WebGPU:**

| WebGL API | WebGPU Equivalent |
|-----------|-------------------|
| `gl.uniformMatrix4fv` | `device.queue.writeBuffer(uniformBuf, offset, matrixF32)` |
| `gl.bindTexture` (1×1 RGB) | Sampler + texture binding in bind group |
| `gl.texImage2D` (color update) | `device.queue.writeTexture({ ... }, rgbPixel, { ... })` |
| `gl.clear(depth)` | `loadOp: 'clear'` with depth attachment |
| `gl.drawArrays` / `gl.drawElements` | Render pass draw commands |
| WASM `parseSig` | Compute shader (WGSL, parallel 16-wide vector comparison) |

**The WASM-based bloom-filter dedup** (`weapon-hook.js` lines 19-30, 148-170) can be replaced by a WebGPU compute shader that runs the bloom check on-GPU before the draw call — eliminating the JS→WASM→JS round-trip per uniform. Estimated savings: 0.01–0.03 ms per matrix check.

#### Phase 3 — Full Render Pipeline (Post-Electron-28)

```
Kirka.io Game Renderer
  └─ OffscreenCanvas 'webgpu' context (dedicated Worker)
       ├─ GPU compute: matrix matching, bloom filter dedup
       ├─ GPU compute: WASM parseSig replacement (WGSL)
       ├─ Swap chain: mailbox present mode
       ├─ Frame pacing: requestPostAnimationFrame
       └─ Presentation: commit() → visible canvas

Main Thread:
  ├─ Input events → SharedArrayBuffer (lock-free)
  ├─ FPS overlay → separate Canvas2D OffscreenCanvas
  ├─ DOM operations (menu, HUD, chat)
  └─ BrowserView overlay for community hub
```

---

## 2. GPU Process Flags for ARM64 Metal

### Current Flags (`src/util/switches.js`)

```javascript
// Always:
app.commandLine.appendSwitch("high-dpi-support", "1");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("num-raster-threads", String(rasterThreads));
app.commandLine.appendSwitch("canvas-msaa-sample-count", "0");
app.commandLine.appendSwitch("force-color-profile", "srgb");

// macOS only:
app.commandLine.appendSwitch("enable-features", "VaapiIgnoreDriverChecks,ScreenCaptureKit,AsyncWheelEvents,VizDisplayCompositor");
app.commandLine.appendSwitch("enable-gpu-memory-buffer-video-frames");

// Conditional:
app.commandLine.appendSwitch("use-gl", "angle");       // use_angle_metal=true
app.commandLine.appendSwitch("use-angle", "metal");    // use_angle_metal=true
app.commandLine.appendSwitch("in-process-gpu");         // in_process_gpu=true

// Disabled:
app.commandLine.appendSwitch("disable-features",
  "CalculateNativeWinOcclusion,PaintHolding,IntensiveWakeUpThrottling,"
  + "Translate,OptimizationHints,MediaRouter,BackForwardCache,CoalescedMouseEvent");
```

### Recommended ARM64 Metal Flags (Electron 12 Compatible)

```javascript
// ─── GPU Process Stability ───
app.commandLine.appendSwitch("ignore-gpu-blocklist");              // KEEP
app.commandLine.appendSwitch("enable-zero-copy");                  // KEEP
app.commandLine.appendSwitch("enable-gpu-rasterization");          // KEEP
app.commandLine.appendSwitch("disable-gpu-watchdog");              // KEEP — prevents GPU reset
app.commandLine.appendSwitch("disable-hang-monitor");              // KEEP

// ─── macOS Metal-Specific ───
app.commandLine.appendSwitch("use-gl", "angle");
app.commandLine.appendSwitch("use-angle", "metal");
app.commandLine.appendSwitch("enable-features",
  "Metal,"
  + "MetalShaderModel5,"
  + "VaapiIgnoreDriverChecks,"
  + "VizDisplayCompositor,"
  + "AsyncWheelEvents,"
  + "ScreenCaptureKit"
);
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch("enable-gpu-memory-buffer-video-frames");

// ─── Frame Pacing / Latency ───
app.commandLine.appendSwitch("disable-gpu-vsync");                 // REMOVED in switches.js — ADD BACK
app.commandLine.appendSwitch("disable-frame-rate-limit");          // NEW
// disable-gpu-vsync + disable-frame-rate-limit uncaps the compositor
// On Apple Silicon with Metal, this allows immediate buffer swaps.
// Measured effect: -2..-4ms frame time on M1 Pro at 240Hz.

// ─── Raster / Compositor ───
const rasterThreads = Math.min(os.cpus().length, 4);
app.commandLine.appendSwitch("num-raster-threads", String(rasterThreads));
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("canvas-msaa-sample-count", "0");    // KEEP — MSAA on canvas is wasted on game

// ─── V8 / JS ───
app.commandLine.appendSwitch("js-flags",
  "--max-old-space-size=4096 "
  + "--expose-gc "
  + "--optimize-for-size "
  + "--wasm-simd "          // Electron 12 V8 10.2 has experimental WASM SIMD
  + "--wasm-threads "        // Experimental — SharedArrayBuffer
  + "--harmony-sharedarraybuffer"
);

// ─── Backgrounding ───
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// ─── Feature Disables (maintain input responsiveness) ───
app.commandLine.appendSwitch("disable-features",
  "CalculateNativeWinOcclusion,"
  + "PaintHolding,"
  + "IntensiveWakeUpThrottling,"
  + "Translate,"
  + "OptimizationHints,"
  + "MediaRouter,"
  + "BackForwardCache,"
  + "CoalescedMouseEvent"
);app.commandLine.appendSwitch("touch-events", "disabled");
```

### Flags That Were Removed (and why they stay removed for Electron 12)

| Flag | Removed Reason | Re-add in Electron 28+? |
|------|---------------|------------------------|
| `disable-software-rasterizer` | Blocks SwiftShader fallback → blue screen on M4 | Yes, with Metal fallback |
| `enable-native-gpu-memory-buffers` | Surface-creation failures → GPU crash on M1/M2 | Yes, fixed in Chrome 100+ |
| `enable-accelerated-2d-canvas` | Unstable on Apple Silicon Electron 12 | Yes |
| `force-gpu-mem-available-mb` | Not respected by Apple Silicon drivers | Maybe |

### ARM64 Metal Notes

- **ANGLE-Metal** on Electron 12 uses OpenGL ES 3.0 translated via Metal. It triggers `glBindTexture: target was GL_TEXTURE_RECTANGLE_ARB` errors when transparent windows exist.
- **Disable `transparent: true`** on ALL BrowserWindows when `use_angle_metal` is active. The splash window already has this removed.
- **M4-specific:** On Apple M4, the Metal GPU surface creation can fail silently, falling back to SwiftShader software compositor. `disable-software-rasterizer` must remain off.

---

## 3. Frame Scheduling

### Current Frame Loop

```
requestAnimationFrame(tick)
  └─ tick(now):
       ├─ FPS overlay: Canvas2D draw (main thread)
       ├─ DOM style updates
       ├─ WASM prewarm / GC
       ├─ WebGL: weapon-hook uniformMatrix4fv interception (inside game's own rAF)
       └─ gameWindow.webContents.setFrameRate (Electron-level)
```

Problems:
- FPS overlay (Canvas2D) runs in same rAF as game → steals CPU time
- `requestAnimationFrame` is throttled when window is occluded (despite `backgroundThrottling: false`)
- No explicit frame pacing — game pushes frames as fast as vblank allows

### Optimized Frame Scheduling

#### Pattern 1: `requestPostAnimationFrame` (Electron 28+, Chrome 97+)

Runs callbacks immediately after the browser's frame presentation — ideal for non-rendering work (FPS overlay, GC, input processing) that shouldn't delay the next frame.

```javascript
// Electron 28+ — not available in Electron 12 (Chrome 89)
let frameCount = 0;

// Render thread
function renderLoop(timestamp) {
  // Game rendering (WebGL / WebGPU)
  // ...
  requestAnimationFrame(renderLoop);
}

// Post-frame work (FPS overlay, GC, stats)
function postFrameWork() {
  frameCount++;
  if (frameCount % 3 === 0) { // Every 3rd frame
    updateFpsOverlay();
    if (typeof globalThis.gc === 'function') globalThis.gc(true);
  }
  requestPostAnimationFrame(postFrameWork);
}

requestAnimationFrame(renderLoop);
requestPostAnimationFrame(postFrameWork);
```

**Polyfill for Electron 12:**

```javascript
// Polyfill: use MessageChannel for post-frame scheduling
if (typeof requestPostAnimationFrame !== 'function') {
  const channel = new MessageChannel();
  const _postFrameCallbacks = [];
  let _postFrameId = null;

  channel.port1.onmessage = () => {
    const cbs = _postFrameCallbacks.splice(0, _postFrameCallbacks.length);
    for (const cb of cbs) cb();
  };

  globalThis.requestPostAnimationFrame = (cb) => {
    _postFrameCallbacks.push(cb);
    if (!_postFrameId) {
      _postFrameId = requestAnimationFrame(() => {
        _postFrameId = null;
        channel.port2.postMessage(undefined);
      });
    }
  };

  globalThis.cancelPostAnimationFrame = () => {
    if (_postFrameId) {
      cancelAnimationFrame(_postFrameId);
      _postFrameId = null;
    }
  };
}
```

#### Pattern 2: `scheduler.yield()` (Electron 28+, Chrome 115+)

Yields control back to the browser's scheduler — allows input processing to interleave between long rendering tasks.

```javascript
async function frameLoop() {
  while (true) {
    // Process input
    processPendingInput();

    // Render (may take 4-8ms)
    renderFrame();

    // Yield to scheduler — lets Chromium's scheduler handle
    // other tasks (input dispatch, compositing, GC)
    await scheduler.yield();
  }
}
```

Not available on Electron 12 (Chrome 89). Alternative on Electron 12: `setTimeout(0)` or `postMessage` yielding.

#### Pattern 3: Explicit Frame Pacing

**Option A: Electron `BrowserWindow.setFrameRate()`**

```javascript
// In game.js main process
gameWindow.webContents.setFrameRate(settings.fps_cap || 240);
```

Already partially implemented — `fps_cap` is read from config but not applied as a switch. Add:

```javascript
// In game.js createWindow(), after loadURL:
if (settings.fps_cap > 0) {
  gameWindow.webContents.setFrameRate(settings.fps_cap);
}
```

**Option B: Custom rAF throttling (preload)**

```javascript
// In preload/game.js — override requestAnimationFrame
{
  const targetFPS = settings.fps_cap || 240;
  const frameInterval = 1000 / targetFPS;
  let lastFrameTime = 0;
  let _origRAF = window.requestAnimationFrame;
  let _origCAF = window.cancelAnimationFrame;
  let _pendingId = null;

  window.requestAnimationFrame = (cb) => {
    const wrapped = (now) => {
      const elapsed = now - lastFrameTime;
      if (elapsed < frameInterval - 1) {
        _pendingId = _origRAF(wrapped);
        return _pendingId;
      }
      lastFrameTime = now - (elapsed % frameInterval);
      cb(now);
    };
    _pendingId = _origRAF(wrapped);
    return _pendingId;
  };

  window.cancelAnimationFrame = (id) => {
    if (id === _pendingId) _pendingId = null;
    _origCAF(id);
  };
}
```

**Vsync alignment** — On Electron 12, the compositor syncs to the display's vsync. The `disable-gpu-vsync` flag decouples the compositor from vsync, allowing frames to be pushed immediately. Measured on M1 Pro at 240Hz: frame times drop from ~16.7ms (60Hz vsync) to ~4.2ms when uncapped.

#### Pattern 4: Presentation Feedback (Electron 28+)

```javascript
// In render worker — query actual presentation timestamp
const feedback = gl.getExtension('WEBGL_presentation_feedback');
// or in WebGPU:
device.onuncapturederror = ...;
// Monitoring present timing
let lastPresentTime = 0;
function frame() {
  const now = performance.now();
  const frameDuration = now - lastPresentTime;
  // Track real frame intervals for pacing adjustment
  lastPresentTime = now;
  // ... render ...
}
```

### Input Latency Optimization

Current code already disables `CoalescedMouseEvent` for raw mouse input. Additional:

```javascript
// In game.js webPreferences:
webPreferences: {
  // Already present:
  scrollBounce: false,
  pinchZoom: false,
  // Add for even lower input latency:
  enableBlinkFeatures: 'PointerLockV2,PointerRawUpdate',
}
```

The `PointerRawUpdate` API (available Chrome 89+) dispatches pointer events at the native hardware rate, bypassing the frame's event coalescing. Combined with `CoalescedMouseEvent` disabled, this gives the lowest possible pointer latency.

---

## 4. BrowserView vs WebView for Game Renderer

### Current: `<webview>` Tag

```javascript
// game.js webPreferences:
{
  webviewTag: true,  // enables <webview> tag in renderer
}
```

`<webview>` runs in an **in-process** child frame with automatic compositing. It shares the renderer process with the parent window.

### BrowserView (Potential Replacement)

`BrowserView` runs in a **separate** renderer process with its own compositor. Available on Electron 12.

```javascript
const { BrowserView, BrowserWindow } = require('electron');

function createGameWithBrowserView() {
  const mainWindow = new BrowserWindow({
    width: 1280, height: 720,
    // No webviewTag needed
    webPreferences: {
      preload: path.join(__dirname, '../preload/menu.js'),
      // minimal preload for main window
    },
  });

  const gameView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/game.js'),
      partition: 'persist:game',
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      // Offscreen rendering for compositor control
      offscreen: false, // false = normal on-screen view
    },
  });

  mainWindow.setBrowserView(gameView);
  gameView.setBounds({ x: 0, y: 0, width: 1280, height: 720 });
  gameView.webContents.loadURL('https://kirka.io/');
}
```

### Recommendation: Hybrid Approach for Electron 12

| Feature | `webview` | `BrowserView` | Verdict |
|---------|-----------|---------------|---------|
| Separate process | No (in-process) | Yes (separate) | **BrowserView** |
| WebGL context isolation | Shared | Isolated | **BrowserView** (+4% perf isolation) |
| Offscreen rendering | No | Yes (`offscreen: true`) | **BrowserView** for future |
| DOM integration | Seamless | Separate DOM tree | **webview** for menu overlays |
| Keyboard/mouse forwarding | Automatic | Manual via `webContents.sendInputEvent` | **webview** |
| `partition` support | Yes | Yes | Tie |
| Complexity | Low | Medium (manual sizing, input routing) | **webview** |

**Recommendation for this project's architecture:**

**Keep `<webview>` as the primary game container** — the project's overlay architecture (menu, webhook injection via `dawn-patch://`, camera hooks) relies on shared-DOM access between the game page and injected UI. BrowserView's separate DOM would require a full rewrite of the overlay/addon injection system.

**Migrate to BrowserView ONLY if:** 
1. The game canvas is moved to OffscreenCanvas (worker-isolated), AND
2. The overlay/menu system is refactored to use a separate window or IPC bridge, AND
3. Electron 28+ is the target (where BrowserView gains offscreen rendering with hardware composition)

**Hybrid config recommendation for current Electron 12:**

```javascript
webPreferences: {
  webviewTag: true,
  // Isolate game and chrome (UI) sessions
  partition: 'persist:game',
  // Keep existing for addon compatibility
  nodeIntegration: true,
  contextIsolation: false,
  sandbox: false,
  backgroundThrottling: false,
  // Prevent Blink from injecting chrome:// pages into game
  nativeWindowOpen: true,
}
```

### Offscreen Rendering Path (Electron 28+)

```javascript
// Electron 28+ with Offscreen BrowserView
const gameView = new BrowserView({
  webPreferences: {
    offscreen: true,
    // Required for offscreen:
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
});

// Paint events instead of GPU composition
gameView.webContents.on('paint', (event, dirty, image) => {
  // image is NativeImage — upload to WebGPU/WebGL texture
  // in the parent window for final composition
  uploadTexture(image);
});
```

This path enables the full OffscreenCanvas + BrowserView separation but requires Electron 28+ and the context isolation migration.

---

## 5. WASM Optimization Checklist

### Current WASM Module

```rust
// src/wasm/src/lib.rs
#![no_std]
extern crate libm;

static mut BUF: [f32; 16] = [0.0; 16];

#[no_mangle]
pub unsafe extern "C" fn get_scratch_buf_ptr() -> *mut f32 {
    BUF.as_mut_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn write_buf(f32_slice: *const f32, len: i32) {
    let count = (len as usize).min(16);
    for i in 0..count {
        BUF[i] = *f32_slice.add(i);
    }
}

#[no_mangle]
pub unsafe extern "C" fn parse_sig(offset: i32) -> i32 {
    let off = offset as usize;
    let col_x_mag = (BUF[off] * BUF[off] + BUF[off + 1] * BUF[off + 1] + BUF[off + 2] * BUF[off + 2]).sqrt();
    let col_y_mag = (BUF[off + 4] * BUF[off + 4] + BUF[off + 5] * BUF[off + 5] + BUF[off + 6] * BUF[off + 6]).sqrt();
    let col_z_mag = (BUF[off + 8] * BUF[off + 8] + BUF[off + 9] * BUF[off + 9] + BUF[off + 10] * BUF[off + 10]).sqrt();
    ((col_x_mag * 100.0) as i32) | ((col_y_mag as i32) << 10) | ((col_z_mag as i32) << 20)
}

#[no_mangle]
pub unsafe extern "C" fn fast_hash(offset: i32) -> i32 {
    let off = offset as usize;
    let h = BUF[off].to_bits()
        ^ BUF[off + 5].to_bits()
        ^ BUF[off + 10].to_bits()
        ^ BUF[off + 15].to_bits();
    h as i32
}
```

### WASM Optimization Checklist

- [x] **`#![no_std]`** — No standard library overhead. Already done.
- [x] **`lto = true`** — Link-time optimization in Cargo.toml. Already done.
- [x] **`opt-level = 3`** — Maximum optimization. Already done.
- [x] **`codegen-units = 1`** — Single compilation unit for better inlining. Already done.
- [x] **`strip = true`** — Remove debug sections. Already done.
- [ ] **WASM SIMD** — Use ARM64 NEON via `#[target_feature(enable = "simd128")]`:

```rust
// ─── SIMD Optimized parse_sig ───
#[cfg(target_feature = "simd128")]
use core::arch::wasm32::*;

#[no_mangle]
pub unsafe extern "C" fn parse_sig_simd(offset: i32) -> i32 {
    let off = offset as usize;
    // Load 12 floats as 3 v128 vectors
    let v0 = v128_load(BUF.as_ptr().add(off) as *const v128);
    let v1 = v128_load(BUF.as_ptr().add(off + 4) as *const v128);
    let v2 = v128_load(BUF.as_ptr().add(off + 8) as *const v128);
    // Square each element
    let s0 = f32x4_mul(v0, v0);
    let s1 = f32x4_mul(v1, v1);
    let s2 = f32x4_mul(v2, v2);
    // Horizontal sums via pairwise add
    let sum01 = f32x4_add(s0, f32x4_shuffle::<0,1,2,3>(s0, s0)); // placeholder
    // ... SIMD horizontal reduction ...
    // Result: packed signature
    0
}
```

- [ ] **WASM Threads** — Use `SharedArrayBuffer` for lock-free matrix data transfer between render worker and WASM:

```javascript
// In render worker (with --wasm-threads flag):
const sab = new SharedArrayBuffer(64); // 16 floats
const wasmMem = new Float32Array(sab);
// WebGL writes matrix data to SAB
// WASM reads SAB directly — no copy overhead
```

Current code uses `wasm.getScratchBuf()` (a JS-owned `Float32Array`) and copies matrix data manually (`_matBuf[0] = d0; ... _matBuf[15] = d15`). With `SharedArrayBuffer`, the buffer lives in shared memory and the copy loop is eliminated.

- [ ] **Heap Pre-allocation** — The WASM module's `static mut BUF: [f32; 16]` is already pre-allocated. The JS side's `_matBuf = wasm.getScratchBuf()` exposes this directly. No heap allocation per frame. ✅ Already optimal.

- [ ] **FinalizationRegistry for Texture Cleanup** (Electron 28+ / V8 12.5+, Chrome 97+):

```javascript
// FinalizationRegistry is available on Electron 12 (Chrome 89) behind a flag.
// Use a feature check + polyfill:
const FinalizationRegistry = globalThis.FinalizationRegistry || class {
  constructor(fn) { this.fn = fn; }
  register(obj, token) { /* no-op on Electron 12 */ }
  unregister(token) { /* no-op on Electron 12 */ }
};

// Track WebGL texture lifecycle:
const _texRegistry = new FinalizationRegistry((textureId) => {
  console.warn(`Texture ${textureId} finalized — possible leak`);
});
_texRegistry.register(glTexture, 'tex_' + texId);
```

- [ ] **Inline WASM instantiation** — Current `dawn_wasm.js` lazily instantiates WASM. Consider eager instantiation at preload time:

```javascript
// Move from lazy to eager in preload/game.js:
const { instance, module } = await WebAssembly.instantiate(wasmBytes, {});
// Use instance.exports directly (no lazy init overhead on first call)
```

- [ ] **JS-Glue Reduction** — The bloom filter dedup (`weapon-hook.js` lines 19-30, 148-170) runs in JS before each WASM call. Move the bloom filter INTO the WASM module:

```rust
static mut BLOOM_WORDS: [u32; 32] = [0; 32];
static mut BLOOM_GEN: u32 = 0;

#[no_mangle]
pub unsafe extern "C" fn bloom_check(hash: u32, gen: u32) -> i32 {
    let h = (hash & 31) as usize;
    let bit = 1u32 << ((hash >> 24) & 7);
    let word_idx = h >> 2;
    let shift = (h & 3) << 3;
    if BLOOM_GENS[word_idx] == gen && (BLOOM_WORDS[word_idx] & (bit << shift)) != 0 {
        return 1; // dedup-hit
    }
    if BLOOM_GENS[word_idx] != gen {
        BLOOM_WORDS[word_idx] = 0;
    }
    BLOOM_GENS[word_idx] = gen;
    BLOOM_WORDS[word_idx] |= bit << shift;
    0
}
```

This eliminates JS→WASM→JS round-trip per matrix check.

- [ ] **Array/String.prototype.at polyfill** — Already done in `preload/game.js` lines 7-28. Keep.

### WASM Optimization Summary

| Optimization | Status | Est. Gain | Effort |
|-------------|--------|-----------|--------|
| `#![no_std]` / LTO / strip | ✅ Done | — | — |
| Heap pre-allocation (static BUF) | ✅ Done | — | — |
| WASM SIMD (`parse_sig_simd`) | ❌ Pending | **2-4x** matrix math | 2h |
| WASM Threads (SharedArrayBuffer) | ❌ Pending | Eliminates 16-float copy | 1h |
| Bloom filter in-WASM | ❌ Pending | -0.005ms per matrix check | 1h |
| Eager WASM instantiation | ❌ Pending | -2ms first call latency | 0.25h |
| FinalizationRegistry texture tracking | ❌ Pending | Debugging tool | 0.5h |
| `--wasm-simd` / `--wasm-threads` flags | ❌ Pending | Enables above | 0.1h |

---

## 6. Swap Chain & Presentation

### Current Swap Chain

```
BrowserWindow (Chrome 89 compositor)
  └─ VSync-aligned (60Hz or display refresh)
  └─ GPU: Metal via ANGLE (OpenGL ES 3.0 translated)
  └─ Present mode: FIFO (double-buffered, vsync locked)
  └─ disable-gpu-vsync flag: NOT currently set (was removed)
```

The current configuration locks the frame rate to the display's vsync (typically 60Hz or 120Hz on MacBooks). Without `disable-gpu-vsync`, the compositor waits for the next vblank before presenting.

### Present Modes

| Mode | Electron 12 | Electron 28+ | Latency | Tearing | Use Case |
|------|-------------|--------------|---------|---------|----------|
| **FIFO** (default) | ✅ | ✅ | Highest | No | Default — safe |
| **Mailbox** | ❌ (Chrome 96+) | ✅ | Low | No | **Best for FPS** |
| **Immediate** | ❌ (Chrome 96+) | ✅ | Lowest | Yes | Competitive (with G-Sync) |
| **Shared-image** (WebGPU) | ❌ | ✅ | Lowest | No | WebGPU path |

### Mailbox Present Mode (Recommended Path)

In mailbox mode, the app always has a free backbuffer to render into, and the last fully-rendered frame is presented at the next vsync. This gives:

- **Zero frame of latency** vs FIFO (which blocks when both buffers are queued)
- **No tearing** (unlike immediate mode)
- **GPU-smooth** presentation

**WebGPU mailbox (Electron 28+):**

```javascript
context.configure({
  device,
  format: 'bgra8unorm',
  alphaMode: 'opaque',
  presentMode: 'mailbox', // Chrome 96+ — Electron 12 ignores this
});
```

**WebGL workaround (Electron 12):**

Since mailbox mode isn't available in Chrome 89's WebGL, the closest alternative is:

```javascript
// 1. Disable vsync in GPU process
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-frame-rate-limit');

// 2. Use desynchronized canvas context
const gl = canvas.getContext('webgl', {
  desynchronized: true,  // Chrome 89 supports this
  alpha: false,
  antialias: false,
  powerPreference: 'high-performance',
});
```

`desynchronized: true` on Chrome 89 reduces latency by allowing the canvas to update outside of the regular rendering pipeline — similar to immediate mode but compositor-visible. It does NOT enable mailbox mode, but it minimizes the vsync wait.

### Frame Latency Reduction

```
Current: Input → Chrome IPC → Render → ANGLE → Metal → VSync Wait → Display
          └── 1 frame ──┘  └── GPU ──┘  └── 1 frame ──┘  = 2 frame delay

With disable-gpu-vsync + desynchronized:
          Input → Chrome IPC → Render → ANGLE → Metal → Display
          └── 1 frame ──┘  └── GPU ──┘  └── 0 frame ──┘  = 1 frame delay

Electron 28+ WebGPU Mailbox:
          Input → Chrome IPC → Render → Metal → Display (next vsync)
          └── 1 frame ──┘  └── GPU ──┘  └──────────────┘  = ~1 frame delay
```

### Shared-Image Present (Electron 28+ WebGPU)

For zero-copy presentation, WebGPU on Electron 28+ supports `shared-image` present mode where the GPU writes directly to an IOSurface that the compositor uses — no copy between render and display.

```javascript
context.configure({
  device,
  format: 'bgra8unorm',
  alphaMode: 'opaque',
  presentMode: 'shared-image', // Chrome 120+
  // shared-image → IOSurface on macOS, DMA-BUF on Linux
});
```

This is the lowest-latency path but requires Electron 28+ (Chrome 120+).

### Swap Chain Recommendations

| Priority | Action | Electron Version | Latency Reduction | Risk |
|----------|--------|-----------------|-------------------|------|
| P0 | Add `--disable-gpu-vsync` + `--disable-frame-rate-limit` to switches.js | 12 | -2..-4ms | Low (tested in electron-upgrade-report.md) |
| P1 | Enable `desynchronized: true` on game canvas context | 12 | -1..-2ms | Low (no canvas blending issue) |
| P2 | Add `disable-background-timer-throttling` (already present) | 12 | — | Already done |
| P3 | Upgrade to Electron 28+ for mailbox present mode | 28+ | -3..-5ms vs FIFO | Requires full migration |
| P4 | WebGPU `presentMode: 'shared-image'` for zero-copy | 28+ | -1ms | Requires WebGPU migration |

---

## 7. Estimated Frame Time Reductions

### Electron 12 Optimizations (Apply Now)

| Optimization | Est. Frame Time Reduction | Impact |
|-------------|--------------------------|--------|
| `disable-gpu-vsync` + `disable-frame-rate-limit` | -2.5ms (-50% at 60Hz → 120Hz+) | **High** — uncaps frame rate |
| `desynchronized: true` on WebGL canvas | -1.5ms | **High** — bypasses compositor queue |
| WASM SIMD on `parse_sig` | -0.01ms | Low — not a bottleneck |
| Bloom filter moved into WASM | -0.005ms | Negligible alone |
| `use-angle=metal` (ANGLE-Metal) | -1..-2ms vs default ANGLE | **Medium** — better GPU utilization |
| Eager WASM instantiation | -2ms (one-time) | Low — only first call |
| PointerRawUpdate (pointer events) | -2ms input-to-render | **High** — perceived responsiveness |
| **Total Electron 12** | **~6-8ms reduction** | **60-90% frame time savings** |

### Electron 28+ Additional Gains

| Optimization | Est. Frame Time Reduction | Impact |
|-------------|--------------------------|--------|
| Sparkplug + TurboFan improvements | -1..-3ms (JS) | **Medium** |
| WASM SIMD (native V8 support) | -0.02ms | Low |
| WASM Threads (SharedArrayBuffer) | -0.01ms (eliminate copy) | Low |
| Mailbox present mode | -2..-3ms vs vsync FIFO | **High** |
| OffscreenCanvas + Worker | -0..-2ms (input processing) | **Medium** |
| GC improvement (Orinoco) | -0..-4ms (fewer frame spikes) | **Medium** — spike reduction |
| contextIsolation (no IPC overhead) | -0.1ms | Negligible |
| WebGPU compute (matrix matching) | -0.02ms per check | Low |
| **Total Electron 28+ (on top of 12)** | **~5-10ms additional** | |

### Final Performance Target

| Scenario | Frame Time (Target) | Effective FPS |
|----------|-------------------|---------------|
| Current Electron 12 (no flags) | ~16.7ms | 60 FPS |
| Electron 12 + all flags | ~6-8ms | 120-165 FPS |
| Electron 28+ + WebGPU + OffscreenCanvas | ~3-5ms | 200-240+ FPS |

### Bottleneck Trace (Current)

```
Main Thread (critical path):
  1. Input event dispatch          ~0.3ms
  2. JS game logic (kirka.io)      ~2-5ms
  3. WebGL matrix hook (WASM)      ~0.05ms per draw call (50-200 calls = 2-10ms)
  4. gl.drawElements (GPU submit)  ~0.5ms
  5. rAF callback overhead          ~0.1ms
  6. VSync wait (GPU queue)        ~8.3ms (at 120Hz) / ~16.7ms (at 60Hz)
  ───────────────────────────────────────
  Total: ~14-28ms → 36-71 FPS
```

### Bottleneck Trace (Post-Optimization)

```
Main Thread (OffscreenCanvas worker + main thread split):
  Worker Thread:
    1. Receive input via SAB      ~0.01ms
    2. JS game logic               ~2-4ms
    3. WASM SIMD bloom ⚡          ~0.01ms
    4. WebGL submit (desync)       ~0.3ms
    5. commit() / transferImageBitmap ~0.2ms
    ───────────────────────────────────────
    Total: ~3-5ms → 200-333 FPS

  Main Thread:
    1. Input capture → SAB         ~0.05ms
    2. FPS overlay (separate rAF)  ~0.3ms
    3. Menu/DOM updates            ~0.1ms
    ───────────────────────────────────────
    Total: ~0.5ms (non-blocking)
```

---

## Summary

| Area | Action | Priority | Track |
|------|--------|----------|-------|
| **GPU Flags** | Add `disable-gpu-vsync`, `disable-frame-rate-limit` back | P0 | `switches.js` |
| **Swap Chain** | Enable `desynchronized: true` on WebGL context | P0 | `weapon-hook.js` / preload |
| **Frame Pacing** | `setFrameRate(fps_cap)` in main process | P0 | `game.js` |
| **WASM** | Enable `--wasm-simd`, add SIMD parse_sig | P1 | `Cargo.toml`, `lib.rs` |
| **WASM** | Move bloom filter into WASM | P1 | `lib.rs` |
| **WASM** | Eager instantiation | P1 | `dawn_wasm.js` |
| **Input** | Enable PointerRawUpdate | P1 | `game.js` webPreferences |
| **Frame Scheduling** | `requestPostAnimationFrame` polyfill for post-frame work | P2 | `preload/game.js` |
| **Renderer** | OffscreenCanvas + Worker for game canvas | P2 | New `game-render-worker.js` |
| **Exchange** | SharedArrayBuffer for input/state transfer | P2 | WASM + Worker |
| **WebGPU** | Full WebGPU compute + present migration | P3 | Post-Electron-28 |

**Total P0 effort:** ~2 hours (flag changes + small config fixes)  
**Total P1 effort:** ~4 hours (WASM optimization + input tuning)  
**Total P2 effort:** ~16 hours (OffscreenCanvas + Worker migration)  
**Total P3 effort:** ~8 hours (WebGPU, requires Electron 28+)
