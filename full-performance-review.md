# Full Performance Review & Overhaul Plan — Dawn Client

**Baseline:** Electron 32.2.0 (Chromium 128, V8 12.4) · branch `perf/nuclear-overhaul`
**Scope:** everything client-side — startup, bundle pipeline, frame pipeline, input/bhop,
WebGL hook, WASM, addons, menu, memory, Chromium switches, packaging.
**Audit date:** 2026-08-03

> **Implementation status (2026-08-03):** P0-1 (performance_mode toggle), P0-2 (dead
> settings removed), P0-3 (run-app pin), P0-4 (conditional Array.isArray patch),
> P1-1 (safe GPU flags), P1-2 (low_latency, default ON) are all **implemented**.
> Remaining: P1-3 (settings debounce), P1-4 (CSS passes), P1-5 (warm-start index
> cache), P2 items.

> ⚠️ **Docs drift:** `input-latency-report.md`, `electron-upgrade-report.md` and
> `renderer-pipeline-report.md` describe **Electron 12.2.3** (Chrome 89). The client has
> since moved to **Electron 32.2.0** and already implements the bulk of their
> recommendations (sendInputEvent over CDP, ANGLE/Metal, background-throttling off,
> `--expose-gc`, `sparkplug`, V8 cache, `setFrameRate` fps cap, `disable-features`
> cleanups, `desynchronized: true` canvas, PointerLockV2 + PointerRawUpdate). **Treat
> those three reports as historical only** — do not re-apply their "add these flags"
> checklists blindly. This report supersedes them.

---

## 0. Scorecard — what's already good

| Area | Status | Evidence |
|---|---|---|
| Startup | ✅ | Splash window paints ~50ms; game window loads immediately; bundle cache warmed **in parallel** (never gates startup) |
| Bundle cache | ✅ | Versioned keys (`.p2`), atomic tmp+rename writes, startup prune, in-flight fetch dedupe, `AbortSignal.timeout(15s)` |
| Patch registry | ✅ | Needle→replacement array with per-patch applied/missing status, `__patchMeta` appended |
| FPS cap | ✅ | `webContents.setFrameRate()` 30–240, live-updates on setting change |
| Input latency | ✅ | bhop keys batched per frame → `sendInputEvent` (fastest Electron path, no CDP) |
| Backgrounding | ✅ | `backgroundThrottling:false`, `disable-background-timer-throttling`, `disable-renderer-backgrounding`, `disable-backgrounding-occluded-windows` |
| Feature disables | ✅ | `CalculateNativeWinOcclusion`, `PaintHolding`, `IntensiveWakeUpThrottling`, `BackForwardCache`, `Translate`, `MediaRouter` all off |
| GPU crash recovery | ✅ | `child-process-gone` → reload; renderer `render-process-gone` → reload; `unresponsive` → reload |
| Renderer memory | ✅ | RSS watchdog (soft 2GB → GC, hard 3.5GB → reload outside match) + `--expose-gc` |
| Process priority | ✅ | `os.setPriority(-10)` on main + renderer, App Nap + sudden termination disabled |
| WebGL hook | ✅ | Lazily installed only when weapon mods enabled; WASM sig matching + bloom-filter dedup; `desynchronized:true` canvas |
| Custom Skin Link | ✅ | WeakMap bookkeeping (no leak), throttled re-patch (250ms), forced re-upload after decode, cached in-game check (500ms) |
| Menu | ✅ | Injected once from disk via nav-cache, `display:none` when closed (no paint cost), lazy `loading` on remote images |
| JS engine | ✅ | `--max-old-space-size=4096 --max-semi-space-size=128 --sparkplug --turbo-fast-api-calls --expose-gc`, `v8-cache-options code` |
| Audio | ✅ | 48kHz sample rate, 512 buffer |
| Dependencies | ✅ | `discord-rpc` + `lamejs` removed; `electron-store` only |

**This client is in good shape.** The remaining work is: hot-path overhead in the
skin-link `Array.isArray` patch, dead settings, a few valid GPU flags that were dropped,
settings write amplification, and stale docs.

---

## 1. Audit findings

### 1.1 Startup & bundle pipeline — GOOD, two micro-gaps

- `warmBundleCache()` fetches the index HTML **every launch** even when the bundle is
  already cached (it must, to discover the hashed `app.<hash>.js` URL). Cost: one small
  request on warm starts. Could be eliminated with a cached copy of the last-known index.
- `pruneBundleCache()` runs `readdirSync` on every startup — fine (tiny dir).
- `_cacheSet` disk write is async (write tmp → rename) ✅.

**Gap:** none blocking. Micro-opt: cache the parsed index / bundle URL from last run so
warm starts skip the HTML fetch entirely (fail open to the live fetch).

### 1.2 Frame pipeline / Chromium switches — GOOD, some dropped flags

Current (`src/util/switches.js`): ANGLE/Metal on macOS, `num-raster-threads` (default 4,
configurable), optional `in-process-gpu`, `disable-gpu-process-crash-limit`, backgrounding
disables, `ParallelDownloading` + `CanvasOopRasterization`, feature disables, V8 flags,
audio flags. UA pinned to Chrome 128 (matches Electron 32's Chromium).

**Dropped since the earlier reports** (either never re-added or deliberately removed):

| Flag | Verdict |
|---|---|
| `disable-gpu-vsync` / `disable-frame-rate-limit` | **Opt-in only.** Uncaps the compositor; real latency win (2–8ms) but causes screen tearing on non-VRR displays. Make it a `low_latency` setting, default off. |
| `enable-zero-copy` | Valid on Electron 32; helps texture path. Safe to add. |
| `enable-gpu-rasterization` | Safe to add on Chromium 128. |
| `force-color-profile=srgb` | Safe, kills colour-space conversion overhead. |
| `canvas-msaa-sample-count=0` | **Skip** — game sets its own MSAA; forcing 0 may degrade weapon quality. |
| `ignore-gpu-blocklist` | **Skip** — re-enables SwiftShader fallback; earlier reports note a blue-screen risk on M4. Not needed on Apple Silicon (Metal is not blocklisted). |
| `disable-gpu-watchdog` / `disable-hang-monitor` | Risky; keep watchdog (it already recovers crashes). |
| `disable-software-rasterizer` | **Keep off** — removing it caused a blue screen on M4. |
| `touch-events disabled` | Safe; no touch device in a desktop game. |

### 1.3 Input path & bhop — GOOD

Path: renderer `keydown` → per-frame batching → `ipcRenderer.send('bhop-keys')` →
main `webContents.sendInputEvent()`. This is the recommended low-latency path
(sendInputEvent ≈ 2–3× faster than CDP). State machine is grounded via `__onGround` /
`__antiSpam` bundle hooks, hold 4ms + jitter, strafe pulse throttled to ≥25ms, stuck-key
watchdog 1.5s, Escape/blur resets. ✅

**Observations (non-blocking):**
- `_readKeys()` runs on every keydown — trivial.
- The `setInterval(500ms)` synthetic-key watchdog wakes the main process every 500ms even
  when idle — negligible, but could be `setTimeout` re-armed on key press for a fully idle
  main loop.
- Renderer bhop loop only runs while Shift held ✅.

### 1.4 WebGL weapon hook — GOOD, feature-gated

`getContext` wrapper installs the heavy `uniformMatrix4fv` wrapper **only** when weapon
mods are enabled (`_needsModProcessing()`), so default config has ~zero hook cost. When
enabled: bloom filter avoids repeat WASM `parse_sig` per identical matrix per draw-call
batch; scratch buffer lives in WASM memory (zero-copy); rgb re-upload throttled to every
3rd frame; hex parse cached. ✅

**Observation:** the `getContext` monkeypatch itself runs on every canvas in the page —
it's a cheap `id/width/height` check, fine.

### 1.5 Custom Skin Link — GOOD logic, ONE hot-path issue (P1)

The `Array.isArray` monkeypatch **replaces the global builtin for the entire game**:

```js
Array.isArray = function(arg) {
  if (!arg || !arg.map || !arg.map.image) return oldIsArr.call(Array, arg);
  ...
```

Three.js and the game call `Array.isArray` extremely often (every material, attribute,
buffer check). Even the fast path adds a JS call + two property lookups on every single
invocation — **and it stays installed even when the skin link feature is disabled.**
This is the single biggest hot-path overhead in the client.

**Fix (P1):** install the patch only while `localStorage.csl_enabled === "true"`;
restore the original otherwise. Listen to `storage`/`change` on the csl checkbox to
install/uninstall live. Saves a measurable fraction of a frame on all users who never
touch the feature.

### 1.6 Menu & CSS — GOOD, minor polish

- Menu is 1,387 lines of static HTML + injected `<style>`; container `display:none` when
  closed → zero paint/composite cost. `willChange:transform` on a hidden element is
  harmless. ✅
- Remote images now `loading="lazy"` ✅.
- **Minor:** menu.css `@import`s two remote font CSS files (`Satoshi`, nameless font) —
  render-blocking for the menu stylesheet and FOIT risk. Add `preconnect`/`font-display`
  or accept the tradeoff. Non-blocking for gameplay (menu is closed during matches).
- `loadCustomCSS()` runs 4× per page load (DOMContentLoaded, load, +2s, +5s) — idempotent
  but each pass removes/re-inserts `<style>` nodes (cheap style recalc). Trim to load +
  one delayed pass, or only re-run when game CSS is detected.

### 1.7 Memory & GC — GOOD

Watchdog every 30s via `getProcessMemoryInfo` (RSS), GC nudge >2GB, reload >3.5GB outside
match; `matchEnded` forces GC + logs heap. `_forceGC` uses `--expose-gc` ✅.

**Gap (P2):** watchdog tracks only the **renderer** RSS. The **GPU process** (`app.getAppMetrics()`
→ `gpu` pid) can also leak textures over long sessions. Add a GPU-process RSS check to the
same timer.

### 1.8 Settings — dead options (P0 cleanup)

Confirmed **no JS reads these** — they exist in `defaults.json` + menu only:

- `skip_loading` (menu.html:835) — dead
- `rave_mode` (menu.html:143) — dead
- `performance_mode` (defaults, `true`) — **advertised but does nothing.** Users toggle it
  expecting perf changes.

**Fix (P0):** either implement `performance_mode` (see §2.4) or remove the dead entries.
Implementing it gives the client a genuine gamer-facing perf toggle.

### 1.9 Settings write amplification (P1)

`update-setting` → `store.set("settings", settings)` writes the whole JSON file
synchronously on every change. Sliders dispatch `change` (not `input`), so drags are OK,
but rapid toggles can still pile up file writes + `settings-updated` broadcasts of the
full object. **Fix:** debounce the disk write (~250ms) and broadcast; keep the in-memory
update immediate.

### 1.10 Packaging & docs

- `run-app` falls back to installing `electron@32.4.0` while `package.json` pins
  `32.2.0` — version drift. Align on one.
- Three stale reports (§ header) actively mislead future perf work. Fold their still-valid
  ideas into this report and mark them deprecated (P2 docs task).

---

## 2. Implementation plan (gamer terms)

Priority = effort/value. "Gamer terms" = FPS, input ms, load time, stutter, memory creep.

### P0 — Quick wins (low effort, high clarity)

**P0-1. Implement `performance_mode` (real toggle)**
- File: `src/preload/game.js` + `src/assets/css/menu.css` + `src/assets/html/menu.html`.
- When ON: add `perf-mode` class to the menu root → CSS disables all `transition: 0.3s`,
  `@keyframes` (rave, animated-gradient, rotate), `backdrop-filter`, and box-shadow
  gradients; menu opens/stays static. Also skip the F9 frame-time logger by default.
- Gamer impact: smoother menu open/close on low-end GPUs; removes a "why does my setting
  do nothing" complaint.
- Effort: S.

**P0-2. Remove dead settings** — `skip_loading`, `rave_mode` (or wire rave to the
existing hue-rotate keyframes). Effort: XS.

**P0-3. Fix `run-app` Electron version pin** to `32.2.0` (match package.json). Effort: XS.

**P0-4. Conditional `Array.isArray` patch (see §1.5)** — this is the top hot-path fix;
elevated to P0. Effort: S (see snippet in §3.1).

### P1 — Core performance

**P1-1. Re-add the safe GPU flags**
- `src/util/switches.js`: add `enable-zero-copy`, `enable-gpu-rasterization`,
  `force-color-profile=srgb`, `touch-events=disabled`. Keep `ignore-gpu-blocklist` and
  `disable-software-rasterizer` OFF (M4 blue-screen history).
- Gamer impact: slightly lower GPU-process overhead on texture uploads; stable.
- Effort: XS.

**P1-2. New `low_latency` setting (opt-in uncap)**
- `defaults.json` + menu slider/toggle + `switches.js`: when on, append
  `disable-gpu-vsync` + `disable-frame-rate-limit` (note: switches must be set before
  app ready; implement as a restart-required toggle that persists to config.json which
  `switches.js` already reads).
- Gamer impact: 2–8ms input/frame latency cut on 144/240Hz VRR displays. Tearing risk on
  60Hz fixed-refresh — hence opt-in. Effort: M.

**P1-3. Debounce settings persistence + broadcast**
- `src/main.js` `update-setting`: write-through to memory immediately; debounce
  `store.set` and the `settings-updated` renderer broadcast (~250ms). Effort: S.

**P1-4. Trim `loadCustomCSS` passes** — drop the +2s/+5s re-injections; keep `load` +
one delayed pass gated on whether game CSS appeared. Effort: XS.

**P1-5. Warm-start index cache**
- Cache the last seen `app.<hash>.js` URL (in the versioned cache dir) so warm launches
  skip the index fetch; fall back to live fetch on miss/error. Effort: S.

### P2 — Advanced / hardening

**P2-1. GPU-process memory in watchdog** — `app.getAppMetrics()` GPU pid RSS in the same
30s timer; reload (outside match) on GPU leak. Effort: S.

**P2-2. `will-navigate` guard** — prevent the game window from navigating away to stray
links; route `shell.openExternal` for non-game domains. Effort: S.

**P2-3. Kill the idle 500ms interval** — re-arm a `setTimeout` watchdog only while
synthetic keys exist. Effort: XS.

**P2-4. Font loading** — `preconnect` to font hosts + `font-display: swap` in menu.css to
remove FOIT on first menu open. Effort: XS.

**P2-5. Match-end reset option** — full navigate-to-base reload after every match is the
memory hammer (correct) but costs 2–5s lobby load. Add a `soft_match_reset` setting:
`location.reload()` in place vs navigate home. Effort: S.

**P2-6. Deprecate stale reports** — add a banner to the three Electron-12-era docs
pointing at this file. Effort: XS.

### P3 — Stretch (only after P0–P2)

- **Main-process bhop loop** (from the old input report): move the 4ms key-toggle timing
  into main (`sendInputEvent` directly) so the renderer rAF isn't the clock. Only worth it
  if measured bhop latency still exceeds ~1 frame.
- **OffscreenCanvas pipeline** (from the old renderer report): the game owns its canvas —
  this is a game-bundle-level change, out of scope for the client; revisit only if we ever
  ship renderer-side post-processing.
- **Electron minor bump** to 33/34 for newer V8 — no pressing need on 32; re-evaluate
  when 32 reaches EOL.
- **WASM module reuse** — `dawn_wasm.js` embeds bytes; compiling once per page load is
  already cheap (~1ms). Cache the `WebAssembly.Module` across reloads if it ever shows up
  in profiles.

---

## 3. Concrete snippets

### 3.1 P0-4 — conditional skin-link patch (`src/addons/Custom Skin Link.js`)

```js
// Keep the original wrapper; install it ONLY while the feature is enabled.
const _origIsArray = Array.isArray;

function _installCslPatch() {
  if (Array.isArray === _cslIsArrayWrapper) return; // already installed
  Array.isArray = _cslIsArrayWrapper;
}
function _uninstallCslPatch() {
  if (Array.isArray === _cslIsArrayWrapper) Array.isArray = _origIsArray;
}

// Call on boot + whenever the csl_enabled checkbox changes:
function _syncPatch() {
  if (localStorage.csl_enabled === "true") _installCslPatch();
  else _uninstallCslPatch();
}
```

The wrapper body stays identical — but users with skin link off now pay **zero**
overhead instead of a wrapper call on every `Array.isArray` in the game.

### 3.2 P1-3 — debounced settings write (`src/main.js`)

```js
let _settingsSaveTimer = null;
ipcMain.on("update-setting", (e, key, value) => {
  settings[key] = value;
  if (key === "fps_cap" && gameWindow && !gameWindow.isDestroyed()) applyFrameCap(gameWindow, value);
  clearTimeout(_settingsSaveTimer);
  _settingsSaveTimer = setTimeout(() => {
    store.set("settings", settings);
    if (gameWindow && !gameWindow.isDestroyed()) gameWindow.webContents.send("settings-updated", settings);
  }, 250);
});
```

### 3.3 P0-1 — performance_mode CSS gate (`src/assets/css/menu.css`)

```css
.menu.perf-mode, .menu.perf-mode * {
  transition: none !important;
  animation: none !important;
  backdrop-filter: none !important;
}
```

---

## 4. Validation / measurement plan

| What | How | Success |
|---|---|---|
| Startup time | `[perf] app ready` → `[perf] game did-finish-load` delta | unchanged (already good); confirm no regression |
| Patch pipeline | `[dawn-patch] … in Xms` log on cold + warm cache | warm ≈ 0ms, cold < 2s |
| Frame times | F9 frame-time logger (already built) in lobby + in match | avg FT unchanged after P0-4; 1% lows not worse |
| Input latency | Compare bhop key → on-screen jump with `DAWN_DEBUG=1` + frame logger | P1-2 opt-in shows measurable drop on 240Hz |
| Memory | `[mem] heap after match:` logs + watchdog warnings across 10 matches | no hard reloads triggered mid-session |
| Skin-link overhead | With CSL off: profile `Array.isArray` call count in a 2-min match (DevTools) | patch uninstalled → 0 wrapper calls |
| GPU flags | `app.getGPUInfo('basic')` log or DevTools `chrome://gpu` equivalent | zero-copy + gpu-rasterization enabled, no SwiftShader |

**Order of implementation:** P0-4 → P0-1/2/3 → P1-1/3/4 → P1-2 (needs playtest) →
P2 cleanups. Re-measure frame times after each P1 change; roll back any flag that shows
1% low regression.

---

*Supersedes: input-latency-report.md, electron-upgrade-report.md, renderer-pipeline-report.md (Electron-12 era).*
