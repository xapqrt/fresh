# Dawn Client — Electron 12 → 28/30 Migration Specification

## Executive Summary

| Metric | Electron 12.2.3 (Current) | Electron 28 LTS | Electron 30 (Latest) |
|--------|---------------------------|------------------|---------------------|
| **Chrome** | 89 | 120 | 122 |
| **V8** | 10.2 | 12.5 | 13.0 |
| **Node.js** | 14.16 | 18.18 | 20.9 |
| **LTS Until** | ❌ Ended | ~May 2025 | ~Nov 2025 |
| **WebGPU** | ❌ | ✅ (flag) | ✅ (flag) |
| **WASM SIMD/Threads** | ❌ | ✅ | ✅ |
| **Sparkplug** | ❌ | ✅ | ✅ |

**Recommendation: Electron 28 LTS** — stable, LTS support, all perf gains. Electron 30 adds marginal gains (WASM GC experimental) with shorter support window.

---

## Breaking Changes Analysis (P0 — Must Fix)

### 1. `contextIsolation: true` Default (Electron 12+)
**Impact:** ALL preload scripts (`src/preload/game.js`, `src/preload/game/bhop.js`)
**Current:** `nodeIntegration: true`, `contextIsolation: false` in `src/windows/game.js:28-34`
**Required:** Full `contextBridge` rewrite — expose only needed APIs via `contextBridge.exposeInMainWorld()`

### 2. `protocol.registerFileProtocol` / `registerBufferProtocol` Removed (Electron 24+)
**Impact:** `src/addons/swapper.js:7-12` — custom `dawnclient://` protocol
**Required:** Migrate to `protocol.handle()` with `Response` streams

### 3. `webRequest` API Deprecated (MV3 / Electron 24+)
**Impact:** `src/addons/swapper.js:79` (resource swapping) + `src/addons/adblock.js` (ad blocking)
**Required:** Migrate to `declarativeNetRequest.updateDynamicRules()`

### 4. `webviewTag` Deprecated (Electron 24+)
**Impact:** `src/windows/game.js:33` — `webviewTag: true`
**Required:** Replace with `<webview>` → `<WebContentsView>` or `BrowserView` (separate process)

### 5. `sandbox: true` Default (Electron 20+)
**Impact:** Preloads use `fs`, `path`, `os` — blocked in sandbox
**Required:** Move file/OS ops to main process via IPC

---

## File-by-File Migration Plan

### `src/main.js` — Main Process Entry
**Changes:**
- Add `app.enableSandbox()` before `app.whenReady()`
- Add Electron 28+ command-line switches (see switches section)
- Register `protocol.handle('dawnclient', handler)` for swapper
- Register `declarativeNetRequest` dynamic rules for adblock + swapper
- Move file/OS operations from preload to main (IPC handlers)

### `src/windows/game.js` — Game Window Creation
**Changes (lines 25-45):**
```javascript
webPreferences: {
  nodeIntegration: false,        // was true
  contextIsolation: true,        // was false
  sandbox: true,                 // was false
  preload: path.join(__dirname, '../preload/game.js'),
  backgroundThrottling: false,
  nativeWindowOpen: true,
  webviewTag: false,             // was true - REMOVE or migrate to BrowserView
  webSecurity: false,
  // Electron 28+:
  enablePreferredSizeMode: true,
}
```

### `src/preload/game.js` — Main Preload (FULL REWRITE)
**Current:** Uses `require('fs')`, `require('path')`, `require('os')`, direct `ipcRenderer.send`
**New:** `contextBridge.exposeInMainWorld('dawnAPI', { ... })` with typed IPC wrappers

**Exposed API Surface:**
```javascript
contextBridge.exposeInMainWorld('dawnAPI', {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.send('settings:set', key, value),
  
  // Navigation
  navigate: (url) => ipcRenderer.send('navigate', url),
  reload: () => ipcRenderer.send('reload'),
  
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  fullscreen: (flag) => ipcRenderer.send('window:fullscreen', flag),
  
  // DevTools
  toggleDevTools: () => ipcRenderer.send('devtools:toggle'),
  
  // Screenshots
  screenshot: () => ipcRenderer.send('screenshot'),
  
  // RPC / Discord
  updateRPC: (data) => ipcRenderer.send('rpc:update', data),
  
  // Menu events
  onMenuAction: (callback) => ipcRenderer.on('menu:action', callback),
})
```

### `src/preload/game/bhop.js` — Bhop Preload
**Current Issue:** Uses `window.__onGround`, `performance.now()` in preload context
**Fix:** Move bhop logic to main process (already done in commit d9d60b0) — this preload should only expose IPC for settings

### `src/addons/swapper.js` — Resource Swapping (MAJOR REWRITE)
**Current (lines 7-12):**
```javascript
protocol.registerFileProtocol('dawnclient', (request, callback) => {
  const url = request.url.replace('dawnclient://', '')
  callback({ path: path.join(__dirname, '..', '..', 'resources', url) })
})
```

**New (Electron 28+):**
```javascript
const { protocol } = require('electron')
const fs = require('fs')
const path = require('path')

protocol.handle('dawnclient', (request) => {
  const url = request.url.replace('dawnclient://', '')
  const filePath = path.join(__dirname, '..', '..', 'resources', url)
  const stream = fs.createReadStream(filePath)
  return new Response(stream, {
    headers: { 'Content-Type': getMimeType(filePath) }
  })
})
```

**Swapper Rules → DeclarativeNetRequest (lines 79-120):**
```javascript
const { session } = require('electron')

async function updateSwapperRules(proxyUrls) {
  const rules = proxyUrls.map((url, idx) => ({
    id: idx + 1000,
    priority: 1,
    action: { 
      type: 'redirect', 
      redirect: { url: url.replace(/^https?:/, 'dawnclient:') } 
    },
    condition: { 
      urlFilter: url, 
      resourceTypes: ['script', 'xmlhttprequest', 'sub_frame'] 
    }
  }))
  await session.defaultSession.declarativeNetRequest.updateDynamicRules({
    addRules: rules,
    removeRuleIds: rules.map(r => r.id)
  })
}
```

### `src/addons/adblock.js` — Ad Blocking
**Current:** `session.webRequest.onBeforeRequest`
**New:** `declarativeNetRequest` static rules (load from JSON) + dynamic rules for runtime additions

```json
// resources/adblock-rules.json
[
  { "id": 1, "priority": 1, "action": { "type": "block" }, "condition": { "urlFilter": "||googletagmanager.com/*", "resourceTypes": ["script", "xmlhttprequest"] } },
  { "id": 2, "priority": 1, "action": { "type": "block" }, "condition": { "urlFilter": "||cloudflareinsights.com/*", "resourceTypes": ["script", "xmlhttprequest"] } },
  { "id": 3, "priority": 1, "action": { "type": "block" }, "condition": { "urlFilter": "||adinplay.com/*", "resourceTypes": ["script", "xmlhttprequest", "sub_frame"] } }
]
```

### `src/addons/customReqScripts.js` — Market/Inventory Hooks
**Current:** Injected via `webContents.executeJavaScript` — **works unchanged** (runs in renderer context)
**Verify:** MutationObserver, fetch, XHR patching all work with `contextIsolation: true`

### `src/addons/opener.js` — Link Handling
**Current:** `webContents.on('will-navigate')` + custom protocol handling
**Verify:** Works with `webPreferences.nativeWindowOpen: true`

### `src/windows/menu.js` — Menu Template
**Current:** Builds template dynamically — **works unchanged**

### `src/addons/rpc.js` — Discord RPC
**Current:** Singleton with `destroy()` — **works unchanged** (main process)

### `src/util/switches.js` — Electron Command Line Switches
**Update for Electron 28+:**
```javascript
const switches = [
  // GPU / Rendering
  '--use-angle=metal',
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
  '--enable-zero-copy',
  '--enable-gpu-rasterization',
  '--enable-accelerated-2d-canvas',
  '--enable-accelerated-video-decode',
  
  // V8 / JS Performance
  '--js-flags=--max-old-space-size=4096 --sparkplug --wasm-simd --wasm-threads --no-turbo-inlining --memory-pressure-off',
  
  // Background throttling
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  
  // Renderer limits
  '--renderer-process-limit=1',
  '--max-active-webgl-contexts=1',
  '--force-color-profile=srgb',
  '--disable-gpu-watchdog',
  
  // M4 Metal (opt-in via config)
  // '--use-angle=metal' (already above)
]
```

---

## Electron 28+ Command Line Switches (Add to `src/main.js` before `app.whenReady()`)

```javascript
const { app } = require('electron')

// Enable sandbox (required for contextIsolation)
app.enableSandbox()

// Performance switches
app.commandLine.appendSwitch('disable-gpu-vsync')
app.commandLine.appendSwitch('disable-frame-rate-limit')
app.commandLine.appendSwitch('use-angle', 'metal')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096 --sparkplug --wasm-simd --wasm-threads --no-turbo-inlining --memory-pressure-off')

// Background throttling
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

// Renderer limits
app.commandLine.appendSwitch('renderer-process-limit', '1')
app.commandLine.appendSwitch('max-active-webgl-contexts', '1')
app.commandLine.appendSwitch('force-color-profile', 'srgb')
app.commandLine.appendSwitch('disable-gpu-watchdog')

// Force Metal on M4 (opt-in via config.forceMetal)
// app.commandLine.appendSwitch('use-angle', 'metal') // already above
```

---

## Phased Implementation Plan

### Phase 0: Quick Wins (30 min) — **Do First, Works on Electron 12**
- [ ] Add all Electron 28+ switches to `src/main.js` (before `app.whenReady()`)
- [ ] Add `app.enableSandbox()` 
- [ ] Fix quit bug: clear bhop interval on window close in `src/windows/game.js`
- [ ] Fix `performance.now()` error in `src/preload/game/bhop.js`
- [ ] Test: 240 FPS cap, bhop, quit, hotkeys all work

### Phase 1: Preload Rewrite (3-4 hours)
- [ ] Rewrite `src/preload/game.js` with `contextBridge`
- [ ] Remove `nodeIntegration: true`, set `contextIsolation: true`, `sandbox: true` in `game.js`
- [ ] Add IPC handlers in `src/main.js` for all exposed APIs
- [ ] Move `fs`/`path`/`os` operations from preload to main process
- [ ] Test: settings, navigation, window controls, devtools, screenshot

### Phase 2: Protocol + webRequest Migration (4-5 hours)
- [ ] Replace `protocol.registerFileProtocol` → `protocol.handle` in `swapper.js`
- [ ] Migrate swapper rules to `declarativeNetRequest.updateDynamicRules()`
- [ ] Migrate adblock to `declarativeNetRequest` (static JSON + dynamic)
- [ ] Remove all `session.webRequest.onBeforeRequest` listeners
- [ ] Test: skin swapping, ad blocking, resource loading

### Phase 3: Electron 28 Upgrade (2-3 hours)
- [ ] `npm install electron@28 --save-dev`
- [ ] `npm rebuild` (native modules — none expected)
- [ ] Test full app: game loads, bhop works, menu works, settings persist
- [ ] Fix any deprecation warnings
- [ ] Verify 240 FPS cap, Metal GPU, WASM SIMD active

### Phase 4: Electron 30 Evaluation (Optional, 2 hours)
- [ ] `npm install electron@30 --save-dev`
- [ ] Test WebGPU (`navigator.gpu.requestAdapter()`)
- [ ] Benchmark: WASM SIMD, frame times, memory
- [ ] Decide: stay on 28 LTS or move to 30

### Phase 5: OffscreenCanvas + WebWorker (Post-Upgrade, 16+ hours)
- [ ] Create `src/worker/offscreen-worker.js` with `OffscreenCanvas`
- [ ] Transfer canvas via `canvas.transferControlToOffscreen()`
- [ ] Inject COOP/COEP headers for `SharedArrayBuffer` (kirka.io doesn't serve — use `webRequest.onHeadersReceived`)
- [ ] Move bloom filter + `parse_sig` to WASM worker
- [ ] WebGPU compute shaders for matrix matching

---

## Testing Checklist Per Phase

| Feature | Phase 0 | Phase 1 | Phase 2 | Phase 3 |
|---------|---------|---------|---------|---------|
| App launches | ✅ | ✅ | ✅ | ✅ |
| Game loads (kirka.io) | ✅ | ✅ | ✅ | ✅ |
| 240 FPS cap | ✅ | ✅ | ✅ | ✅ |
| Bhop (space hold) | ✅ | ✅ | ✅ | ✅ |
| Skin swapper | ❌ | ❌ | ✅ | ✅ |
| AdBlock | ❌ | ❌ | ✅ | ✅ |
| Settings persist | ✅ | ✅ | ✅ | ✅ |
| Menu (F8) | ✅ | ✅ | ✅ | ✅ |
| Hotkeys (F2/F4/F5/F11/F12) | ✅ | ✅ | ✅ | ✅ |
| Quit (Cmd+Q) | ✅ | ✅ | ✅ | ✅ |
| DevTools (F12) | ✅ | ✅ | ✅ | ✅ |
| Screenshot (F2) | ✅ | ✅ | ✅ | ✅ |
| Discord RPC | ✅ | ✅ | ✅ | ✅ |
| No JS errors | ❌ (perf) | ✅ | ✅ | ✅ |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `contextBridge` IPC surface incomplete | Medium | High | Map all current `ipcRenderer.send/on/invoke` calls before rewrite |
| `declarativeNetRequest` rule limit (30k) | Low | Medium | Swapper + adblock < 500 rules total |
| `webviewTag` removal breaks game UI | Low | High | Game uses `<iframe>` not `<webview>` — verify |
| Metal GPU instability on M4 | Low | Medium | Keep `forceMetal` config opt-in, default off |
| Native module rebuild fails | Low | High | No native modules in package.json — safe |

---

## Performance Targets (Post-Migration)

| Metric | Electron 12 (Current) | Electron 28 Target |
|--------|----------------------|-------------------|
| JS Heap Limit | ~1.4 GB | 4+ GB |
| WASM SIMD Speedup | 1x | 2-4x (matrix ops) |
| Frame Time Variance | High (GC spikes) | Low (Orinoco GC) |
| Startup Time | Baseline | -15% (Sparkplug) |
| GPU Frame Present | VSYNC forced | `mailbox` mode (WebGPU) |

---

## Quick Start Commands

```bash
# Phase 0: Quick wins (current Electron 12)
cd /Users/xapqrt/Documents/code/dawn-fresh
# Edit src/main.js - add switches + enableSandbox
# Edit src/windows/game.js - fix quit bug
# Edit src/preload/game/bhop.js - fix performance error
npm start

# Phase 1-3: Full migration
npm install electron@28 --save-dev
npm rebuild
# ... implement phases above ...
npm start
```

---

## References

- [Electron 28 Breaking Changes](https://www.electronjs.org/docs/latest/breaking-changes#280)
- [Electron 30 Breaking Changes](https://www.electronjs.org/docs/latest/breaking-changes#300)
- [contextBridge API](https://www.electronjs.org/docs/latest/api/context-bridge)
- [protocol.handle](https://www.electronjs.org/docs/latest/api/protocol#protocolhandlescheme-handler)
- [declarativeNetRequest](https://www.electronjs.org/docs/latest/api/declarative-net-request)
- [WebContentsView (webviewTag replacement)](https://www.electronjs.org/docs/latest/api/web-contents-view)
- [Electron Timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)