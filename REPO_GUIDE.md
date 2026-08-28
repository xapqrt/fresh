# Dawn Client — Deep Repository Guide

> **Purpose:** single-source reference for any future agent / human that needs to understand, modify, debug, or extend this repo. Covers architecture, file-by-file behaviour, invariants, pitfalls, and cookbook for changes. Read this before touching code.
>
> **Last verified:** 2026-07-31 against `d2e46c5` + local uncommitted changes (see § Build & Dev).
> **Runtime:** Electron `32.2.0` (`package.json:15`), Chromium 128, Node 20, `electron-store 8.2.0`.

---

## Table of Contents

1. [What This App Is](#1-what-this-app-is)
2. [Tech Stack & Requirements](#2-tech-stack--requirements)
3. [Repository Layout](#3-repository-layout)
4. [High-Level Architecture Diagram](#4-high-level-architecture-diagram)
5. [Boot Sequence](#5-boot-sequence)
6. [Main Process — `src/main.js`](#6-main-process--srcmainjs)
7. [Electron Switches — `src/util/switches.js`](#7-electron-switches--srcutilswitchesjs)
8. [Defaults & Settings — `src/util/defaults.json`](#8-defaults--settings--srcutildefaultsjson)
9. [Preload — `src/preload/game.js` (Monolith)](#9-preload--srcpreloadgamejs-monolith)
10. [Bhop Hook — `src/preload/game/bhop.js`](#10-bhop-hook--srcpreloadgamebhopjs)
11. [Menu — `src/preload/game/menu.js`](#11-menu--srcpreloadgamemenujs)
12. [Splash Preload — `src/preload/splash.js`](#12-splash-preload--srcpreloadsplashjs)
13. [WebGL Weapon Pipeline — `src/webgl/`](#13-webgl-weapon-pipeline--srcwebgl)
14. [WASM Bridge — `src/wasm/`](#14-wasm-bridge--srcwasm)
15. [Addons — `src/addons/`](#15-addons--srcaddons)
16. [Utility Modules — `src/util/`](#16-utility-modules--srcutil)
17. [Assets — `src/assets/`](#17-assets--srcassets)
18. [Tools — `tools/`](#18-tools--tools)
19. [Settings & Persistence](#19-settings--persistence)
20. [IPC Contract (Main ↔ Preload ↔ Renderer)](#20-ipc-contract-main--preload--renderer)
21. [Filesystem Locations (`userData`)](#21-filesystem-locations-userdata)
22. [Build, Run, Package](#22-build-run-package)
23. [Bundle Patch Pipeline — Deep Dive](#23-bundle-patch-pipeline--deep-dive)
24. [Resource Swapper — Deep Dive](#24-resource-swapper--deep-dive)
25. [Kirka Bundle Research Summary](#25-kirka-bundle-research-summary)
26. [Electron 32 Migration Context](#26-electron-32-migration-context)
27. [Known Invariants & Pitfalls](#27-known-invariants--pitfalls)
28. [Cookbook — How To Make Changes](#28-cookbook--how-to-make-changes)
29. [Debugging & Verification](#29-debugging--verification)
30. [Git State & Uncommitted Work](#30-git-state--uncommitted-work)
31. [Glossary](#31-glossary)

---

## 1. What This App Is

Dawn Client is an **unofficial Electron wrapper for Kirka.io** (browser FPS). It replaces the browser with a tuned Chromium window that:

- **Patches the game's JS bundle at the network layer** (`dawn-patch://` protocol) to expose `window.__onGround` / `window.__antiSpam` for bhop and patch health.
- **Intercepts asset requests** (`dawnclient://` + `webRequest` redirects) to swap skins / sounds / textures from disk.
- **Injects a large preload script** (`src/preload/game.js`, ~6327 lines) that adds menus, weapon customisation (WebGL hook), community browser, opener, custom skin links, etc.
- **Provides Discord RPC, auto-opener, custom CSS, userscripts**, and the bhop state machine that drives synthetic key events from the main process.

It is **not** a fork of Kirka's server code — it is a client-side overlay that works via protocol interceptions, CSS/JS injection, and WebGL interception.

---

## 2. Tech Stack & Requirements

| Layer | Tech | File |
|-------|------|------|
| Desktop shell | Electron `32.2.0` | `package.json:15` |
| Packaging | `electron-builder 26` | `electron-builder.yml:1` |
| State | `electron-store 8.2.0` | `src/main.js:6,16` |
| WASM helper | Rust `cdylib` → embedded `Uint8Array` | `src/wasm/src/lib.rs:1`, `src/wasm/dawn_wasm.js:1` |
| Renderer injection | Preload (`nodeIntegration:false, contextIsolation:false, sandbox:false`) | `src/main.js:451-464` |
| Build targets | `dmg (arm64 mac)`, `nsis (win)`, `AppImage/tar.gz (linux)` | `electron-builder.yml:12-34` |
| Node used | 20 (Electron 32) | `MIGRATION_SPEC.md:1` |

No native modules beyond Electron/Electron-store. No `native` rebuild needed for 32.

---

## 3. Repository Layout

```
dawn-fresh/
├── package.json                  # name dawn-client 1.1.8, scripts start/build/build:wasm
├── electron-builder.yml          # dmg/nsis/AppImage, icons, output build/
├── src/
│   ├── main.js                   # ★ main process entry (802 lines)
│   ├── util/
│   │   ├── switches.js           # Chromium / V8 flags
│   │   ├── defaults.json         # default_settings + allowed_urls
│   │   └── nav-cache.js          # renderer require-cache survivors (Map)
│   ├── preload/
│   │   ├── game.js               # ★ 6327-line renderer monolith (injected into kirka.io)
│   │   ├── splash.js             # contextBridge for splash status
│   │   └── game/
│   │       ├── bhop.js           # bhop state machine (rAF, synthetic keys)
│   │       └── menu.js           # Menu class (~2947 lines)
│   ├── webgl/
│   │   ├── weapon-hook.js        # uniformMatrix4fv interceptor (331 lines)
│   │   ├── mat-utils.js          # applyZ/X/YSpin + hsvToRgb
│   │   └── arm-sigs.js           # packed sigs → arm/weapon discrimination
│   ├── wasm/
│   │   ├── src/lib.rs            # parse_sig + fast_hash (no_std)
│   │   ├── Cargo.toml            # cdylib, opt-level 3 LTO
│   │   ├── dawn_wasm.js          # auto-generated embedded bytes + JS glue
│   │   └── target/...            # build artefacts (gitignored in prod)
│   ├── addons/
│   │   ├── opener.js             # pack/chest auto-opener (971 lines)
│   │   ├── browser.js            # Community Hub browser (KCH data, 706 lines)
│   │   ├── swappermenu.js        # skin/sound file pickers + previews
│   │   ├── gallery.js            # stub (local gallery folder opener)
│   │   ├── customReqScripts.js   # no-op hook point (kept for compat)
│   │   └── Custom Skin Link.js   # Array.isArray wrapper skin patch (577 lines)
│   └── assets/
│       ├── html/
│       │   ├── menu.html         # Dawn menu DOM (1152+ lines)
│       │   └── splash.html       # splash window chrome + status
│       ├── css/
│       │   ├── menu.css          # theming + layout (2800+ lines)
│       │   └── rickandmorty.css  # extra theme
│       ├── img/                  # icon.png/.ico/.icns/banner
│       └── mp3/item.mp3
├── tools/
│   ├── bundle-decode/            # decode-strings.js, decode-idx.js, show-ctx.js, BUNDLE_FINDINGS.md
│   └── dawn-recorder/            # recorder helper (untracked in some branches)
├── scripts/
│   ├── build-wasm.sh             # cargo build + embed
│   └── embed-wasm.js             # wasm bytes → dawn_wasm.js
├── assets/splash.html            # built splash (also in src/assets/html)
├── .github/workflows/build.yml   # CI build
└── docs (root mds):
    ├── README.md                 # user-facing features, hotkeys, download
    ├── bundle-research-report.md # consolidated bundle knowledge (201 lines)
    ├── client-optimisation-plan.md # P0/P1/P2 plan (status tracked at top)
    ├── MIGRATION_SPEC.md         # Electron 12→28/30 upgrade plan (371 lines)
    └── REPO_GUIDE.md             # ← this file
```

> `assets/`, `blockchain`, `maps.json`, `badges.json`, `changelogs.json`, `css.json`, `news.json`, `clans.json`, `openerlist.json` at root are **data/content** fetched at runtime.

---

## 4. High-Level Architecture Diagram

```
 ┌──────────────────────────────────────────────────────────────┐
 │ Electron Main (src/main.js)                                  │
 │  applySwitches() ──► protocol.handle(dawn-patch)              │
 │                    protocol.handle(dawnclient)                │
 │                    session.webRequest.onBeforeRequest         │
 │                    ipcMain handlers (settings, bhop, files)   │
 │                    BrowserWindow: splash + game               │
 │                    synthetic key injection (sendInputEvent)   │
 └──────────────┬────────────────────────┬──────────────────────┘
                │ IPC                    │ sendInputEvent / webRequest
                ▼                        ▼
 ┌─────────────────────────┐  ┌──────────────────────────┐
 │ Splash Window            │  │ Game Window (kirka.io)    │
 │ splash.html +            │  │ preload/game.js           │
 │ preload/splash.js        │  │  ├─ Menu (menu.js+html/css)│
 │ (status only)            │  │  ├─ bhop.js (rAF loop)    │
 │                          │  │  ├─ webgl/weapon-hook.js  │
 │                          │  │  ├─ addons/* (browser,    │
 │                          │  │  │  opener, swapper, CSL) │
 │                          │  │  └─ custom userscripts    │
 │                          │  │       ↕ game DOM/Canvas   │
 │                          │  │  Kirka bundle (patched via│
 │                          │  │  dawn-patch, exposes      │
 │                          │  │  window.__onGround etc)   │
 └─────────────────────────┘  └──────────────────────────┘
```

---

## 5. Boot Sequence

1. **Privilege registration** `src/main.js:9-12` — `dawn-patch://` + `dawnclient://` registered as `bypassCSP, secure, standard, corsEnabled`.
2. **Switches** `src/main.js:14` → `src/util/switches.js:5` — reads `~/Library/Application Support/dawn-client/config.json` for `use_angle_*`, `in_process_gpu`, `num_raster_threads`, `low_latency`, then appends Chromium flags.
3. **Store** `src/main.js:16-26` — `electron-store` loads `settings`; missing keys are backfilled from `defaults.json:2`.
4. **Single instance** `src/main.js:34-44` — second launch focuses existing window.
5. **`app.on('ready')`** `src/main.js:753-771`:
   - `initGame()` `src/main.js:733-751` → `pruneBundleCache()` → `createSplashWindow()` + `warmBundleCache()` (parallel, never gates) + `createWindow()` → `splash.close()` on `did-finish-load`.
   - OS priority `os.setPriority(-10)`, disable App Nap / sudden termination on macOS.
   - Global shortcuts `F8` / `Shift+F8` → `toggle-menu`.
6. **SplashWindow** `src/main.js:415-440` — 400×300, `alwaysOnTop`, `preload/splash.js`, `contextIsolation:true`.
7. **`warmBundleCache()`** `src/main.js:362-376` — fetches `settings.base_url` (`https://kirka.io/`), regex `assets/js/(app.<hash>.js)`, if not cached: `patchAndCache()`.
8. **GameWindow** `src/main.js:442-654` — 1280×720, hidden until `ready-to-show`, `preload/game.js`, `webSecurity:false`, `backgroundThrottling:false`, `pointerLockV2`, `desynchronized:true` via weapon-hook.
9. **Preload** `src/preload/game.js:69` — on `DOMContentLoaded`: instantiate `Menu`, call `opener()`, `editResourceSwapper()`, `initGallery()`, `installBhopHook()`, plus patch-status + perf overlays.
10. **Protocol / webRequest** active from `initPatchProtocol()` `src/main.js:378` and `initResourceSwapper()` `src/main.js:246` before `loadURL()`.

---

## 6. Main Process — `src/main.js`

**File:** `src/main.js:1` (802 lines) — the only place that may use `fs/path/os/shell/session/protocol` directly (preload is renderer).

### 6.1 Imports & Globals

- `src/main.js:1` imports `app, BrowserWindow, session, protocol, ipcMain, globalShortcut, shell`.
- `PRELOAD_PATH` `src/main.js:236` → `src/preload/game.js`; `SPLASH_PRELOAD` `src/main.js:237` → `src/preload/splash.js`.
- `gameWindow` / `splashWindow` singletons + `getGameWindow()` accessor `src/main.js:28-30`.

### 6.2 Synthetic Key Tracking (Bhop transport)

```js
// src/main.js:56-79
_syntheticKeys: Set
_lastBhopFlush
releaseSyntheticKeys() // sends keyUp for each held synthetic key
ipcMain.on("bhop-keys", (_, events) => { sendInputEvent({keyCode, type}) })
setInterval 500ms → if idle >1500ms flush
```

Preload batches `{key, down}[]` via `_queueKey` / `_flushKeys` (`bhop.js:45-52`), main replays them with `webContents.sendInputEvent`. **KeyCode mapping:** `src/main.js:105` `key.length===1 ? key.toUpperCase() : key` — `q`→`Q`, `Shift`→`Shift`.

### 6.3 File / Folder IPC (new, uncommitted)

Added in local diff (`git diff src/main.js`):

- `src/main.js:124-126` `_customDir/_scriptsDir/_galleryDir` (`userData/custom`, `scripts`, `gallery`).
- `src/main.js:128-191` handlers:
  - `get-sounds-path` / `get-scripts-path` (sync returns path, creates dir)
  - `open-*-folder` → `shell.openPath`
  - `save-skin-local` / `save-skin-from-buffer` / `save-sound` → copy/write into `custom/`, fire `save-sound-success/error`.
  - `update-settings` (bulk merge validated against `defaults.json`) and `reset-juice-settings` (`store.set(defaults)` + `reload`).
- Cleanup on `closed` `src/main.js:566-571`.

### 6.4 Bundle Patch Cache

- **Memory + disk** `src/main.js:198-233`:
  - `_bundleCache: Map`
  - `_cacheDir()` → `<userData>/bundle-cache`
  - `_cacheKey(url)` → `<filename>.p<PATCH_VERSION>` — FNV-1a of `JSON.stringify(PATCHES)` `src/main.js:312-320`.
  - `pruneBundleCache()` deletes stale `*.p*`.
  - `_cacheGet/_cacheSet` (atomic write via `.tmp` + `rename`) `src/main.js:213-233`.
  - `_inflightFetches` dedupe `src/main.js:338` — warmup + game race share one fetch.

### 6.5 Patch Registry

```js
// src/main.js:293-309
const PATCHES = [
  { name:'onGround', needle:"iP[da8(0x3d56)]=iP[da8(0x55bf)],iP[da8(0x55bf)]=this[da8(0x55bf)]",
    replacement:"iP[da8(0x3d56)]=iP[da8(0x55bf)],iP[da8(0x55bf)]=window.__onGround=!!this[da8(0x55bf)]" },
  { name:'antiSpam', needle:"this[bWR(0x6627)]=0x1", replacement:"window.__antiSpam=(this[bWR(0x6627)]=0x1)" },
  { name:'antiSpamClear', needle:"this['wNWmWwM']=!0x1", replacement:"window.__antiSpam=(this['wNWmWwM']=!0x1)" },
];
```

- `applyPatches(code)` `src/main.js:322-333` → `{code, meta:{version, applied[], missing[]}}`.
- `patchAndCache(url)` `src/main.js:339-357` → `fetchText(url)` → `applyPatches` → append `//# sourceURL` + `window.__patchMeta` `src/main.js:346`.

**Invariants:** needles must be **unique** in bundle (1× occurrence, verified with `show-ctx.js`). Missing needles are **non-fatal** — recorded in `meta.missing` only.

### 6.6 `dawn-patch` Protocol

`initPatchProtocol()` `src/main.js:378-413`:

```js
protocol.handle('dawn-patch', async (request) => {
  target = new URL(request.url).searchParams.get('url')
  if (_cacheGet(target)) return Response(cache, { 'Cache-Control': 'public, max-age=31536000, immutable' })
  code = await patchAndCache(target); return Response(code)
})
```

### 6.7 Resource Swapper (`dawnclient://`)

`initResourceSwapper()` `src/main.js:246-287`:

- Walks `custom/` recursively, builds `normMap: cleanBase → absolutePath` `src/main.js:253-260`.
- `clean` = `basename.replace(/\.mp3\.mp3/i,".mp3").replace(/_/g,"").toLowerCase()` — handles `___hit___.mp3` vs `__hit__.mp3`.
- `protocol.handle('dawnclient', req => Response(fs.readFileSync(decodeURIComponent(url))))` `src/main.js:275-284`.

### 6.8 Window Creation

- `createSplashWindow()` `src/main.js:415-440` — 400×300 frameless, `preload/splash.js`.
- `createWindow()` `src/main.js:442-654`:
  - `webPreferences` `src/main.js:451-464` — `preload/game.js`, `nodeIntegration:false, contextIsolation:false, sandbox:false, webSecurity:false, pointerLockV2, backgroundThrottling:false`, `enableBlinkFeatures:'PointerLockV2,PointerRawUpdate'`.
  - `ready-to-show` → `show()`, `os.setPriority(-10)`, `auto_fullscreen` `src/main.js:470-479`.
  - `did-finish-load` → heap log, `DAWN_SHOOT` screenshot `src/main.js:482-502`.
  - `render-process-gone` → reload after 2s `src/main.js:504-516`.
  - `unresponsive` → reload **only if not in match** `src/main.js:518-530`.
  - `did-fail-load` → exponential backoff `2000*2^(n-1)` max 15000ms `src/main.js:532-540`.
  - `did-start-navigation` → `releaseSyntheticKeys()` `src/main.js:542-544`.
  - URL tracking `src/main.js:548-560` → `send("url-change")`, `matchEnded()` on leave-match.
  - `before-input-event` → menu keybind via `matchesKeybindMain()` `src/main.js:46-52,579-593`.

### 6.9 Request Interception (Game Bundle + Assets)

`src/main.js:599-631`:

```js
bundleFilter = ['*://kirka.io/assets/js/app.*.js', '*://kirka.io/assets/js/chunk-*.js']
proxyFilter = flatMap(proxyDomains, d => [`*://${d}/*`, `*://*.${d}/*`]) // kirka.io, snipers.io, ask101...
allUrls = [...bundleFilter.urls, ...proxyFilter.urls]
session.webRequest.onBeforeRequest({urls: allUrls}, (details, cb) => {
  if (/kirka\.io\/assets\/js\/(app\.\w+\.js|chunk-...)/.test(url)) redirect to dawn-patch://...
  if (customFiles[cleanBase]) redirect to dawnclient://...
  else cb({cancel:false})
})
```

**Proxy domains** mirror `defaults.json:99-105` allowed_urls.

### 6.10 Lifecycle & Watchdogs

- `_navIsMatch(url)` `src/main.js:657-662` — pathname `/games` or `/hub/ranked`.
- `matchEnded()` `src/main.js:674-699` — throttle 3s, force `gc(true)`, redirect to `base_url` / reload.
- `startMemoryWatchdog()` `src/main.js:710-728` — every 30s, `getProcessMemoryInfo()`; soft 2GB → `gc`, hard 3.5GB → reload (only outside match).
- `child-process-gone` GPU → reload `src/main.js:775-793`, debounce `_gpuRecovering`.
- `before-quit` → `releaseSyntheticKeys`, `unregisterAll` `src/main.js:795-798`.
- `window-all-closed` → `quit()` `src/main.js:800`.

---

## 7. Electron Switches — `src/util/switches.js`

**File:** `src/util/switches.js:1` (63 lines). Called before `app.whenReady`.

| Switch | Value | Why |
|--------|-------|-----|
| `high-dpi-support 1` | | retina |
| `user-agent` | Chrome/128 Mac | bypass bot checks `src/util/switches.js:25` |
| `num-raster-threads` | from `config.json` (1-8) `src/util/switches.js:28-31` | |
| `use-gl angle` + `use-angle metal` | on darwin unless `use_angle_opengl` `src/util/switches.js:33-36` | Metal renderer |
| `in-process-gpu` | if `config.json:in_process_gpu` `src/util/switches.js:38-40` | debugging |
| `disable-gpu-process-crash-limit` | | |
| `disable-background-timer-throttling`, `disable-renderer-backgrounding`, `disable-backgrounding-occluded-windows` | `src/util/switches.js:44-46` | keep game tick alive in background |
| `enable-features ParallelDownloading,CanvasOopRasterization` | `src/util/switches.js:48` | |
| `disable-features CalculateNativeWinOcclusion,PaintHolding,...` | `src/util/switches.js:50` | remove throttling / occlusion |
| `disable-blink-features ThirdPartyStoragePartitioning,TrustedTypes` | `src/util/switches.js:53` | |
| `v8-cache-options code` | `src/util/switches.js:56` | |
| `js-flags --max-old-space-size=4096 --max-semi-space-size=128 --sparkplug --turbo-fast-api-calls --expose-gc` | `src/util/switches.js:57` | heap + JIT + GC expose |
| `audio-output-sample-rate 48000`, `audio-buffer-size 512` | `src/util/switches.js:59-60` | low audio latency |

Config source: `<userData>/config.json` → `settings` or root object `src/util/switches.js:13-22`.

---

## 8. Defaults & Settings — `src/util/defaults.json`

**File:** `src/util/defaults.json:1` (106 lines).

- `default_settings` ~100 keys (visual, HUD, weapon, performance, bhop, menu). Selected critical:
  - `bhop_enabled:true, bhop_jump:"KeyQ", bhop_toggle:"Shift"` `src/util/defaults.json:78-80`
  - `weapon_*`, `arm_*`, `universal_settings`, `menu_keybind:"ShiftRight"`, `inspect_keybind:"KeyZ"`, `base_url:"https://kirka.io/"`
  - Removed in local diff: `fps_cap` (now uncapped via switches / unthrottled).
- `allowed_urls` 5 proxies `src/util/defaults.json:99-105`.

Backfill logic `src/main.js:21-25` mutates `settings` if missing or type mismatch, then persists.

---

## 9. Preload — `src/preload/game.js` (Monolith)

**File:** `src/preload/game.js:1` (~6327 lines). Runs in **renderer** with full `fs/path` access because `contextIsolation:false`. Loaded for every navigation to `base_url`.

### 9.1 Guard & Userscripts

```js
// src/preload/game.js:21-38
settings = ipcRenderer.sendSync("get-settings")
if (!location.href.startsWith(base_url)) { delete window.process; delete window.require; return }
else { for each .js in scriptsPath (ipc get-scripts-path) require(script) }
```

### 9.2 Helpers

- `observeForElement(selector, fn, target)` `src/preload/game.js:40-59` — `MutationObserver` childList+subtree.
- `originalConsole` capture + restore on `DOMContentLoaded` `src/preload/game.js:61-74`.

### 9.3 `DOMContentLoaded` Main (~6250 lines)

- Instantiate `Menu` `src/preload/game.js:76-78`, expose `window.__dawnMenu`.
- `opener()`, `customReqScripts()`, `editResourceSwapper()`, `initGallery()` `src/preload/game.js:80-83`.
- `installBhopHook(() => settings)` `src/preload/game.js:86`.
- `window.__loadDawnPatchStatus` `src/preload/game.js:90-103` — reads `window.__patchMeta` → `#dawn-patch-status`.
- Perf mode toggle `src/preload/game.js:107-114` → `#juice-menu > .menu.perf-mode`.
- **F9 frame-time overlay** `src/preload/game.js:118-155` — rAF histogram 120 samples, `min/max/avg + FPS`.
- IPC: `toggle-menu` `src/preload/game.js:159-163`, `settings-updated → Object.assign(settings)` `src/preload/game.js:168`.
- **Customisations fetch** `src/preload/game.js:172-198` — `badges.json` + `clans.json` from GitHub raw, merge `localEntry` (`juice-customizations`) if `local_customizations`.
- Then **~5900 lines** of game DOM feature injections (grouped below).

### 9.4 Feature Groups Inside `game.js` (large)

| Region | Lines | What |
|--------|-------|------|
| Room presets | 410-822 | `dawn-room-presets` in localStorage, scrape/apply modal (`vm--container`), drag reorder, share/import, collapsible panel injected into create-room modal |
| Settings slider inputs | 824-890 | replaces `.value` div with `<input type=number>`, syncs slider ↔ input, per-tab |
| Theme + UI features | 892-1064 | `loadTheme` (`@import css_link / advanced_css`), `applyUIFeatures` → dynamic `<style #juice-styles-ui-features>` for perm_crosshair/tablist/hide_chat/interface etc., reacts to `juice-settings-changed` |
| Weapon/arm inspect | 1065-1485+ | per-weapon keyframe functions (`inspectKeyframes_vita/rev/mac10/ar9/...` + arm variants), latched sig detection, `weapon-hook.js` wiring, durations `src/webgl/weapon-hook.js:37` |
| + many more | — | lobby keybind reminder, lobby news cards, Discord button, etc. (see grep expansion) |

> **If adding a feature:** append inside `DOMContentLoaded` after line 168, or factor into `src/addons/` and call from there (preferred — keeps `game.js` from growing further).

---

## 10. Bhop Hook — `src/preload/game/bhop.js`

**File:** `src/preload/game/bhop.js:1` (221 lines). Pure renderer state machine; the only privileged op is `ipcRenderer.send('bhop-keys')`.

### State

```js
_shiftDown, _aDown, _dDown, _bhopOn, _qDownPhys, _phase, _strafeKey, _strafePhysDown,
_lastToggle, _toggleCode, _jumpChar, _wasAirborne, _lastPress, _retryGroundedMs=90,
_holdMs=4, _jitterMs=0.2, _jitterAccum, _pendingKeys[]
```

### Config Reading

`_readKeys()` `src/preload/game/bhop.js:27-36` — `getSettings().bhop_toggle` → `ShiftLeft/ControlLeft/AltLeft`, `bhop_jump` → `q/w`. `_enabled()` `src/preload/game/bhop.js:38-43` checks `bhop_enabled !== false`.

### Ground / AntiSpam Poll

- `_pollGround()` `src/preload/game/bhop.js:55-61` → `window.__onGround` (boolean or null).
- `_pollAntiSpam()` `src/preload/game/bhop.js:63-69` → `window.__antiSpam`.

Both set by `PATCHES` in main (`onGround` every physics tick at `src/main.js:297`, antiSpam at keydown `src/main.js:302` and clear `src/main.js:307`).

### Synthetic Key Batch

`_queueKey(key,down)` `src/preload/game/bhop.js:45-47` pushes to `_pendingKeys`; `_flushKeys()` `src/preload/game/bhop.js:49-52` `ipcRenderer.send('bhop-keys', keys)`.

### Tick Logic ` _tick(now)` (rAF)

Three branches `src/preload/game/bhop.js:89-146`:

1. **`grounded===true`** — land path: if `wasAirborne || now-lastPress>=90` and `!antiSpam`, press jump (`_sendJump(true)`), hold 4ms+ jitter, strafe pulse. Else if still holding past `holdMs+jitter`, release.
2. **`grounded===false`** — in air: release if phase 1, mark airborne, wait.
3. **`grounded===null` (blind fallback)** — timed 4ms cadence, catch-up loop up to 8 toggles/frame `src/preload/game/bhop.js:132-144` (anti-spam aware).

Uses `queueMicrotask(_flushKeys)` to batch within frame.

### Strafe Assist

`_pulseStrafe(now)` `src/preload/game/bhop.js:78-87` → if `strafeKey` (`a`/`d` latched at start) not physically held, emit `keyUp+keyDown` throttled 25ms.

### Start/Stop

`_start()` `src/preload/game/bhop.js:148-160` → latch strafe key, reset `phase/wasAirborne/lastPress`, `requestAnimationFrame(_tick)`. `_stop()` `src/preload/game/bhop.js:162-175` → cancel rAF, release jump/strafe, flush.

### Input Listeners

`keydown/keyup (capture)` `src/preload/game/bhop.js:179-216`:

- Ignores `!isTrusted || repeat`, bails inside `INPUT/TEXTAREA/contentEditable`.
- `ControlLeft` when toggle isn't Control synthesises `Shift` press (allows Ctrl as dedicated crouch).
- `_toggleCode` press → `_start()`, release → `_stop()`.
- `a/d` tracks directional hold + updates `strafeKey`.
- `Escape` → `_reset()`, `blur` → `_reset()`.

**Local diff:** `ShiftLeft` → `Shift` string `src/preload/game/bhop.js:184,201,204` (main now handles bare `Shift`).

---

## 11. Menu — `src/preload/game/menu.js`

**File:** `src/preload/game/menu.js:1` (2947 lines). Class `Menu`.

### Constructor `src/preload/game/menu.js:9-64`

- Loads `settings` sync, reads `menu.css` + `menu.html` from disk, `createMenu()` `src/preload/game/menu.js:66-77` → injected `div#juice-menu`, style prepend, `document.body.appendChild`.
- Caches `tabToContentMap`, `weaponIds` + `restingSigToWeaponId` (scale sig → weapon), `weaponSettings = loadWeaponSettings()`, `selectedWeapon`, `universalModeActive` etc., publishes `window.dawnWeaponConfig`.

### `init()` `src/preload/game/menu.js:79-143`

Calls ~29 steps (`setVersion`, `setUser`, `setKeybind`, `dragMenu`, `resizeMenu`, … `bindWeaponOptions`, `handleButtons`), then `initBrowser(menu)`, then restores `localStorage` for tab/innerTab/selector/weapon selection.

### Key Subsystems (abbrev.)

- **Global weapon config** `src/preload/game/menu.js:155-201` — `window.dawnWeaponConfig = { universal, wireframe, colorEnabled, colorHex, rgb, inspectKeybind, getSettings(id), getArmSettings(id, side) }` + `dawn-weapon-config-updated` event.
- **`bindWeaponOptions()`** `src/preload/game/menu.js:203-827` — ~624 lines:
  - Per-weapon vs universal vs arm (`leftarm/rightarm`) modes, mirror checkbox, sliders + number inputs (size, offset XYZ, rotation XYZ, inspect duration), reset/import/export, localStorage `dawn_weapon_config` persistence.
  - Accessors `getActiveConfig / getWeaponConfig / setWeaponConfig / getArmSettings / setArmSettings` handle mirroring.
  - `loadWeaponSettings()` `src/preload/game/menu.js:829-905` backfills defaults (`defaultArmSettings`, `defaultWeaponSettings`, `defaultUniversalSettings`) and migrates legacy `weapon_size` etc.
- **Appearance / theme** `handleAppearance`, `setTheme` etc.
- **Drag + resize** `dragMenu()` / `resizeMenu()` `src/preload/game/menu.js:942-1180` — titlebar drag, 8 resize handles, `localStorage["menu-position"/"menu-size"]`.
- **Local gradient / badges / profile bg** `setLocalGradient` etc. — editors for `local_customizations`.

---

## 12. Splash Preload — `src/preload/splash.js`

**File:** `src/preload/splash.js:1` (7 lines) — minimal `contextBridge`:

```js
contextBridge.exposeInMainWorld("splashAPI", { onShow: cb => ipcRenderer.on("splash-show", cb) })
```

Main sends `splash-show` once `ready-to-show` `src/main.js:436`.

---

## 13. WebGL Weapon Pipeline — `src/webgl/`

### `arm-sigs.js:1` (47 lines)

- `SCALE=100` `src/webgl/arm-sigs.js:1`
- `packSig(s0,s1,s2)` → `round(s*100)<<20 | <<10 |` — identifies model by matrix scale.
- `ARM_SIGS` list + `isArmSig(sig)`, `getArmType(sig, weaponId, tx)` handles tomahawk ambig via `tx`.

### `mat-utils.js:1` (55 lines)

- `applyZSpin(mat, angle)`, `applyXSpin`, `applyYSpin` `src/webgl/mat-utils.js:1-35` — scale-preserving rotations (decompose/recompose).
- `hsvToRgb(hue)` `src/webgl/mat-utils.js:38-53` — for rainbow weapon color.

### `weapon-hook.js:1` (331 lines) — core interception

- Uses `wasm.getScratchBuf()` `src/webgl/weapon-hook.js:5-6` (`Float32Array(16)` at WASM offset 0) and bloom filter `src/webgl/weapon-hook.js:12-30` to dedupe per-draw matrices.
- `hookWebGL()` `src/webgl/weapon-hook.js:301-326` — patches `HTMLCanvasElement.prototype.getContext` to catch game canvas (`#game`, `#gameCanvas`, or first large webgl), then `ctx` wrappers.
- `_installWrappers(gl)` `src/webgl/weapon-hook.js:112-299`:
  - 1×1 `rgbTexture` for solid-color weapons.
  - Wraps `clear`, `bindTexture`, `uniformMatrix4fv`, `drawArrays/drawElements`.
  - In `uniformMatrix4fv` `src/webgl/weapon-hook.js:133-286`:
    - Bail if `window.__weaponModsActive===false` or `!_enableMods`.
    - Skip non-affine, non-256 clear mask, bloom duplicate.
    - `_parseSig()` via WASM `src/webgl/weapon-hook.js:106` → `isArmSig` → branches:
      - **Weapon path** `src/webgl/weapon-hook.js:175-249` — apply `size, offset, inspect keyframes` (spin Z/X/Y), optional solid color / rainbow texture.
      - **Arm path** `src/webgl/weapon-hook.js:251-285` — per-arm size/offset/rotation + arm inspect fns.
  - `INSPECT_DURATIONS` `src/webgl/weapon-hook.js:37-40`
  - State: `_gameContext`, `_hooked`, `_inspectStart/_inspectingWeaponId`, `_weaponConfig`, `_enableMods`, draw counters `src/webgl/weapon-hook.js:6-67`.
  - `setWeaponConfig(config, inspectFns, armFns)` `src/webgl/weapon-hook.js:70-79` — called from `game.js:???` after `dawnWeaponConfig` ready.

---

## 14. WASM Bridge — `src/wasm/`

### Rust `src/wasm/src/lib.rs:1` (48 lines)

```rust
#![no_std]
parse_sig(offset:i32) -> i32 // reads 9 f32s (mat rows 0,1,2 at cols 0..2), sqrt lengths → packSig
fast_hash(offset:i32) -> i32 // 12 f32s hashed
```

- `libm::sqrtf`, `panic -> unreachable`.
- Built as `cdylib` `src/wasm/Cargo.toml:6`.

### JS Glue `src/wasm/dawn_wasm.js:1` (30 lines, auto-generated)

- Embeds `Uint8Array` bytes, `WebAssembly.Module/Memory`, `getScratchBuf()→Float32Array(16)` at offset 0, `parseSig(0)`, `fastHash(0)`.
- `scripts/build-wasm.sh:1` (`cargo build --release --target wasm32-unknown-unknown`) + `scripts/embed-wasm.js:1` (bytes→js).

---

## 15. Addons — `src/addons/`

### `opener.js` (971 lines)

- `fetchOpenerList()` from `raw.githubusercontent.com/zVipexx/dawn-client/main/openerlist.json` `src/addons/opener.js:2-10`.
- `addOpenerList()` `src/addons/opener.js:12-24` populates `#opener` select with chests/cards + All.
- `executeCardScript(cards)` / `executeChestScript(chests)` `src/addons/opener.js:50-914` — Kirka API automation:
  - Fetches `microwaves.json` translations, reverses map, enumerates `bvl` spreadsheet, inventory via `api2.kirka.io/api/{inventory}` with `Bearer localStorage.token`.
  - Opens cards/chests sequentially every 2000ms, handles rarity backup, notifications, confetti, summary.
- `opener()` `src/addons/opener.js:932-969` wires `#opener` change → start_*.

Called from `game.js:80`.

### `browser.js` (706 lines) — Community Hub

- `dataUrls` `src/addons/browser.js:8-18` — KCH (`imnotkoolkid/KCH/main/data`) + extra Dawn `css.json/maps.json`.
- `getData(key)` `src/addons/browser.js:22-55` — fetch + normalize, cached, merges cssExtra.
- `convert(item,type)` `src/addons/browser.js:74-168`; `filterItems` sorts featured; `isInstallType/hasDirectLink`.
- `applyCss/removeCss` `src/addons/browser.js:187-200` → `ipcRenderer.send("update-setting", css_link/css_enabled)` + `juice-settings-changed`.
- `applyCrosshair/Texture/Skybox/KillIcon` `src/addons/browser.js:202-268` — localStorage keys (`SETTINGS___SETTING/...`) + style injection.
- `installSounds/uninstallSounds` `src/addons/browser.js:274-290` via `soundsDir = ipcRenderer.sendSync("get-sounds-path")`.
- `isInstalled(type,item)` `src/addons/browser.js:292-318`.
- `renderCards(container,items,type)` `src/addons/browser.js:390-625` — builds community cards with Install/Uninstall, link copy, preview, lightbox.
- `initBrowser(menu)` `src/addons/browser.js:627-705` — wires sidebar selectors, search, `loadSection(key)`.

Requires `fs,path,os,shell` — runs in preload (fs allowed).

### `swappermenu.js` (309 lines)

- `filePathOf(file)` `src/addons/swappermenu.js:4-7` → `webUtils.getPathForFile(file)` (Electron 32 fix for removed `File.path`).
- `editResourceSwapper()` `src/addons/swappermenu.js:86-307`:
  - Skin: `#skin-file` / drag-drop / `#file-url` (fetch→blob) → `previewImage()`, store `filePath` or `buffer`; `#save-skin` → `ipcRenderer.send("save-skin-local"/"save-skin-from-buffer", skinname, ...)`.
  - Sound: similar plus `showSoundPreview()` (play/pause, volume slider).
  - `skinname/soundname` maps select values to hashed filenames (`__texture__.xxx__.webp`, `__hit__.xxx__.mp3` etc.).

### `gallery.js` (4 lines)

Stub `initGallery = () => {}` `src/addons/gallery.js:1` — folder opened via IPC `open-gallery-folder`.

### `customReqScripts.js` (5 lines)

No-op placeholder `customReqScripts = (settings) => {}` `src/addons/customReqScripts.js:3` — userscripts already loaded at preload top.

### `Custom Skin Link.js` (577 lines)

- Patched `Array.isArray` wrapper `src/addons/Custom Skin Link.js:469-577`:
  - `WeakMap _patchMeta`, `WeakSet _pendingReuploads`, `getCurrentSkinUrl()`, `_isIngame()` (desktop-game-interface exists, cached 500ms true).
  - `_cslIsArrayWrapper(arg)` checks `arg.map.image` 64/42/32 dims, muzzle exclusion, then swaps `image.src` to custom skin if `csl_enabled`, throttled 250ms, `needsUpdate=true`.
  - `_cslPatchInstalled` toggles wrapper only when enabled `_syncCslPatch()` `src/addons/Custom Skin Link.js:566-573`.

---

## 16. Utility Modules — `src/util/`

- `nav-cache.js:1` (10 lines) — `Map` `_navCache`, `navCacheGet/Set`, survives navigations because renderer process persists.
- `switches.js` / `defaults.json` covered above.

---

## 17. Assets — `src/assets/`

- `html/menu.html:1` — Dawn menu structure: sidebar tabs (ui/game/browse/performance/client/about/changelogs), content panels `#ui-options`, `#game-options` with inner tabs (visual/weapons/combat), `#browse-options` (community/gallery), etc. ~1152+ lines.
- `html/splash.html:1` — 500×500 splash, gradient, icon, version, status container.
- `css/menu.css:1` — ~2800 lines: themes (`dark/light/dawn/glass/dusk/custom`) via CSS vars, menu grid layout, perf-mode stripping, sidebar, sliders, lightbox, gradient editor, badges, room presets, nickname modal.
- `css/rickandmorty.css` — alt theme.
- `img/icon.png/.ico/.icns`, `banner.png`, etc.

---

## 18. Tools — `tools/`

### `bundle-decode/`

From `bundle-research-report.md:62-73`:

- `decode-strings.js <bundle.js> strings.json matches.txt` — extracts `var dqP=[...]` table (28k entries) + rotator simulation → `0xfd` offset.
- `decode-idx.js strings.json 0x4484 0x55bf ...` — hex idx → string.
- `show-ctx.js <bundle.js> "<needle>" [before] [after]` — context dump.
- `BUNDLE_FINDINGS.md` — raw dump (superseded by research report).

### `dawn-recorder/` — screen recorder helper (presence varies by branch).

---

## 19. Settings & Persistence

| Store | Location | Keys |
|-------|----------|------|
| `electron-store` | `<userData>/config.json` via `Store` `src/main.js:16` | object `{ settings: { ...default_settings } }` `src/main.js:17-26` |
| `localStorage` | `localStorage` in renderer (per `base_url`) | `user-id`, `juice-customizations`, `juice-clans`, `juice-menu-tab`, `menu-position/size`, `dawn_weapon_config`, `dawn-room-presets`, `csl_*`, `SETTINGS___SETTING/...` (Kirka's own) |

**Settings flow:** main owns canonical `settings` object → `ipcRenderer.sendSync("get-settings")` `src/preload/game.js:21` / `src/preload/game/menu.js:11` → mutations via `ipcMain.on("update-setting", k,v)` `src/main.js:83` + `settings-updated` broadcast `src/main.js:87` → preload `Object.assign(settings,s)` `src/preload/game.js:168`. Bulk import via `update-settings` `src/main.js:171`.

**Weapon settings:** stored separately in `localStorage["dawn_weapon_config"]` `src/preload/game/menu.js:879-904`; legacy per-weapon keys migrated.

---

## 20. IPC Contract (Main ↔ Preload ↔ Renderer)

**Sync (returnValue):**

| Channel | Dir | Payload | Main Behaviour |
|---------|-----|---------|----------------|
| `get-settings` | preload→main sync | — | `e.returnValue = settings` `src/main.js:82` |
| `get-sounds-path` | sync | — | returns `_customDir` `src/main.js:128` |
| `get-scripts-path` | sync | — | `mkdir` + return `_scriptsDir` `src/main.js:129-132` |

**Async send:**

| Channel | Dir | Payload | Main |
|---------|-----|---------|------|
| `update-setting` | preload→main | `key, value` | merge store + broadcast `src/main.js:83` |
| `update-settings` | →main | `obj` | validated bulk merge `src/main.js:171` |
| `reset-juice-settings` | →main | — | reset + reload `src/main.js:184` |
| `bhop-keys` | preload→main | `[{key, down}]` | `sendInputEvent` `src/main.js:101` |
| `save-skin-local` | →main | `skinname, filePath` | `copyFileSync` `src/main.js:146` |
| `save-skin-from-buffer` | →main | `skinname, buffer` | `writeFileSync` `src/main.js:152` |
| `save-sound` | →main | `soundname, path` | copy + `save-sound-success/error` `src/main.js:159` |
| `open-*-folder` (4) | →main | — | `shell.openPath` `src/main.js:140-144` |

**Main → preload events:**

| Event | Payload | Listener |
|-------|---------|----------|
| `settings-updated` | `settings` | `src/preload/game.js:168` `Object.assign` |
| `toggle-menu` | — | `src/preload/game.js:159` `Menu.toggle()` |
| `splash-show` | — | `src/preload/splash.js:4` |
| `url-change` | `url` | `game.js` feature router (added local diff) |
| `save-sound-success/error` | msg | `swappermenu.js:237` |

**Debug:** `dump-cookies` handle `src/main.js:90-99` (invoked, not sent).

---

## 21. Filesystem Locations (`userData`)

`app.getPath("userData")` — platform:

- macOS: `~/Library/Application Support/dawn-client/`
- Win: `%APPDATA%/dawn-client/`
- Linux: `~/.config/dawn-client/`

Subdirs:

| Path | Created By |
|------|------------|
| `config.json` | `electron-store` `src/main.js:16` |
| `bundle-cache/app.<hash>.js.p<ver>` | `_cacheSet` `src/main.js:222` |
| `custom/` (skins/sounds/textures) | `initResourceSwapper` `src/main.js:247`, saves `src/main.js:146-163` |
| `scripts/` (userscripts *.js) | `get-scripts-path` `src/main.js:130` |
| `gallery/` (local images) | `open-gallery-folder` `src/main.js:126` |

---

## 22. Build, Run, Package

```bash
npm install                 # electron 32.2.0 + electron-store 8
npm run start               # electron . → src/main.js
npm run build               # electron-builder --mac --arm64 → build/
npm run build:wasm          # bash scripts/build-wasm.sh → cargo + embed
```

Env helpers:

- `DAWN_DEBUG=1 npm start` → 10s cookie dump `src/main.js:635-643`.
- `DAWN_SHOOT=/tmp/shot.png npm start` → capturePage after 9s `src/main.js:491-498`.

CI: `.github/workflows/build.yml` (not detailed here).

WASM rebuild flow: `scripts/build-wasm.sh:4-7` → `cargo build --release --target wasm32-unknown-unknown` → `node scripts/embed-wasm.js <in> <out>`.

---

## 23. Bundle Patch Pipeline — Deep Dive

Full detail in `bundle-research-report.md:1`. Summary + impl links:

- **Request rewriting:** `session.webRequest.onBeforeRequest` `src/main.js:608-631` maps `kirka.io/assets/js/app.*.js|chunk-*.js` → `dawn-patch://bundle/<file>?url=<orig>`.
- **Handler:** `protocol.handle('dawn-patch')` `src/main.js:383-409` serves cached or `patchAndCache`.
- **Patching:** `PATCHES` `src/main.js:293` → `applyPatches` `src/main.js:322` → append `window.__patchMeta` `src/main.js:346`.
- **Caching:** filename-suffixed `*.p<PATCH_VERSION>` `src/main.js:200`, pruned on startup `src/main.js:201-212`, immutable `Cache-Control` `src/main.js:395`.
- **Warmup:** `warmBundleCache()` `src/main.js:362` during splash.
- **Health:** `window.__patchMeta` `src/main.js:346` → menu `window.__loadDawnPatchStatus()` `src/preload/game.js:90`.

**Cache invalidation rule:** any edit to `PATCHES` array changes `PATCH_VERSION` (FNV-1a) `src/main.js:312-320` → old cache never served.

---

## 24. Resource Swapper — Deep Dive

- **Scan:** `initResourceSwapper()` `src/main.js:246-287` walks `custom/` once at startup → `normMap`.
- **Normalization:** `src/main.js:258-259` `clean=basename.replace(/\.mp3\.mp3/,".mp3").replace(/_/g,"").toLowerCase()` — handles Kirka's `___hit___.xxx.mp3`.
- **Protocol:** `protocol.handle('dawnclient')` `src/main.js:275-284` serves file bytes; missing → 404.
- **Redirect:** `onBeforeRequest` `src/main.js:619-627` normalizes request basename same way and looks up `normMap` → `dawnclient://<encodedAbsPath>`.
- **Save paths:** UI file drops / URL fetch → `ipcRenderer.send("save-skin-local"/"save-skin-from-buffer"/"save-sound")` → `custom/` with exact game basename `src/addons/swappermenu.js:166-306`.

---

## 25. Kirka Bundle Research Summary

Source `bundle-research-report.md:1` (currently `app.662a34fb.js` ~6.5MB, 28k string table at 4801260, rotator 388 steps, offset 0xfd).

| Area | Decoded | Patch Anchor |
|------|---------|--------------|
| `player.input` 0x127a | `WnmNwMwW` held, `wwWnNWmM` pressed, `WwWNn` prev, `wNWmWwM` antiSpam(0x6627) `bundle-research-report.md:78` | antiSpam `this[bWR(0x6627)]=0x1` |
| `player.physics` 0x1a0d | `wwNmMWnW` onGround(0x55bf), `wNWmwMWn` vy `-0.15` coyote, `WwWNmwn` inAir `bundle-research-report.md:111` | onGround `iP[da8(0x3d56)]=...` at 4354766 |
| Input edge | `X['wwWnNWmM']=!!held&&!prev` then `prev=held` at 3037194 | — |
| Jump gate | `if(dt>0 && !inAir && pressed && (onGround||vy in [-0.15,0)) && !dashLocked){vy=0x3e7; inAir=true}` at 4348619 | — |
| Native bhop | `bhop` 0x613b default ON, mult `wnNMwWmW` 1–3 default 1.5; crouch+jump within 250ms boost | removed by design (see optimisation plan §8) |
| String table | `dqP` at 4801260 (1.7M chars), aliases `dqO/cAH/...` `bundle-research-report.md:54` | — |

Dead patches: `zoom` (`f5['a'][hF]`) had 0 occurrences — removed `client-optimisation-plan.md:9`.

**Tooling:** `tools/bundle-decode/decode-strings.js`, `decode-idx.js`, `show-ctx.js`.

---

## 26. Electron 32 Migration Context

Active spec `MIGRATION_SPEC.md:1` (recommended target Electron 28 LTS → 30, Chrome 120→122). Since we already run Electron 32, the relevant breaking changes are **already applied or deferred**:

- `contextIsolation:true` default — **intentionally kept false** `src/main.js:454` (requires full `contextBridge` rewrite, see spec §1).
- `protocol.registerFileProtocol` removed — **done**: now `protocol.handle` `src/main.js:275,383`.
- `webRequest` vs `declarativeNetRequest` — **not yet migrated** (spec §3), current still `webRequest` `src/main.js:608`.
- `webviewTag` — `src/main.js:451` no `webviewTag:true` (removed).
- `sandbox:true` default — **kept false** `src/main.js:455` because preload uses `fs/path`.
- Planned switches for 28+ were added to `src/util/switches.js:56-60`.
- Phased plan (quick wins → preload rewrite → protocol migration → upgrade → OffscreenCanvas) in `MIGRATION_SPEC.md:256-340`.

---

## 27. Known Invariants & Pitfalls

1. **Bundle cache poisoning** — old `app.*.js.p*` served forever; fix is `PATCH_VERSION` suffix; manual delete `bundle-cache/` still needed if version logic missed.
2. **`window.__onGround` nullability** — `bhop.js` must handle `null` (blind rAF fallback) `src/preload/game/bhop.js:54-61,125-144`; main's antiSpam similarly `src/preload/game/bhop.js:63`.
3. **`_onGround` overwrite per-tick** — patch writes `window.__onGround=!!this[da8(0x55bf)]` `src/main.js:297` every physics tick; consumers must poll, not event.
4. **Underscore normalization** — swapper must strip `_` *both* sides `src/main.js:258,623`; otherwise `___hit___.mp3` never matches.
5. **`Array.isArray` wrapper cost** — wrapper installed only when `csl_enabled` `src/addons/Custom Skin Link.js:566`; never leave globally patched for non-users.
6. **WeakMap for textures** — `_patchMeta` `src/addons/Custom Skin Link.js:476` prevents unbounded growth (per-match textures).
7. **Memory watchdog** — only reloads **outside** match (`!_navIsMatch`) `src/main.js:719-724`; never auto-reload mid-match.
8. **Synthetic key leak** — `releaseSyntheticKeys()` on `blur`, `did-start-navigation`, `render-process-gone`, `before-quit` `src/main.js:60,504,542,575,795`; interval flush after 1500ms `src/main.js:73-79`.
9. **`contextIsolation:false` dependence** — `src/preload/game.js:5,8,9` and addons use `fs/path/ipcRenderer` directly; flipping to true without rewriting all to `contextBridge` breaks everything.
10. **Electron argument injection:** `user-agent` hardcoded Chrome/128 `src/util/switches.js:25`; `high-dpi-support` required for retina.
11. **Inspect animation timing** — `weapon-hook.js` `INSPECT_DURATIONS` and menu `inspectDuration` diverge; `game.js` keyframe functions + `weapon-hook.js:226` must agree.
12. **Search isolation** — menu search input shouldn't trigger game listeners; ensure `isTrusted` + `repeat` guards remain `src/preload/game/bhop.js:180`.

---

## 28. Cookbook — How To Make Changes

### A. Add a new menu toggle / setting

1. Add key + default to `src/util/defaults.json:2`.
2. Add HTML in `src/assets/html/menu.html` (copy `.option` with `data-setting="your_key"`).
3. If visual, extend `applyUIFeatures()` `src/preload/game.js:918` (push CSS rule conditional on `settings.your_key`) and include key in `relevantSettings` array `src/preload/game.js:1032`.
4. If behaviour, add `document.addEventListener('juice-settings-changed', ...)` or `ipcRenderer.on('settings-updated')` handler.
5. Test: `ipcRenderer.send('update-setting','your_key',value)` persists via `store` `src/main.js:83`.

### B. Add a new bundle patch (new `window.__*` signal)

1. Find needle with `tools/bundle-decode/show-ctx.js` + verify uniqueness (1× occurrence) + `node --check` on patched bundle.
2. Add entry to `PATCHES` `src/main.js:293` `{name, needle, replacement}` (replacement should mirror `window.__yourSignal=...` pattern).
3. `PATCH_VERSION` auto-bumps (FNV of needle JSON) — no manual step.
4. Delete `bundle-cache` once or bump will prune next launch.
5. Expose to renderer via `window.__yourSignal` and poll in `bhop.js` or relevant feature.
6. Surface health: add to `window.__patchMeta` already, check `window.__loadDawnPatchStatus` `src/preload/game.js:90`.

### C. Modify weapon/arm behaviour

- Edit `src/webgl/weapon-hook.js:112-286` (matrix hook) or `src/webgl/mat-utils.js` (spin) or `src/webgl/arm-sigs.js` (sig table).
- For UI, edit `src/preload/game/menu.js:203-827` `bindWeaponOptions()` + defaults `src/preload/game/menu.js:829`.
- Persisted via `localStorage["dawn_weapon_config"]`, pushed to hook via `setWeaponConfig()` `src/webgl/weapon-hook.js:70`.
- WASM `parse_sig` change → `cargo build` + `scripts/build-wasm.sh`.

### D. Replace resource swapper matching

- Only touch `initResourceSwapper()` `src/main.js:246` (`registerFile`/`normMap`) and the `onBeforeRequest` normalizer `src/main.js:621`; keep them in sync.
- Filenames must remain exact game hashes (`__texture__.xxxx__.webp` etc.) `src/addons/swappermenu.js:179-203`.

### E. Touch bhop

- Edit only `src/preload/game/bhop.js`; transport stays in `src/main.js:101-118`.
- Keep `holdMs 4 + jitter 0.2`, `retryGroundedMs 90`, antiSpam-aware, strafe pulse 25ms — validated against Kirka's `wNWmWwM` gate.
- Verify: ground hook emits `0/1` per tick; simulate slow frame (8 toggles cap) shouldn't trip antiSpam.

### F. Electron upgrade

Follow phases `MIGRATION_SPEC.md:256-340` in order: 0 quick wins → 1 contextBridge → 2 protocol/declarativeNetRequest → 3 bump electron → 4 evaluation.

### G. Add a community browser category

Add entry to `dataUrls` + `convert` + `apply/remove` + `isInstalled` + `renderCards` install branch in `src/addons/browser.js`.

---

## 29. Debugging & Verification

| Goal | Command / Check |
|------|-----------------|
| Run | `npm start` (or `DAWN_DEBUG=1 DAWN_SHOOT=/tmp/a.png npm start`) |
| Verify bundle patched | Menu → About → `#dawn-patch-status` should be `v… applied [onGround,antiSpam,…] missing [—]`; or `window.__patchMeta` in DevTools `src/preload/game.js:93` |
| Verify onGround signal | In-game console `window.__onGround` toggles `0/1` on jump/land; `window.__antiSpam` toggles `true/false` |
| Frame-time | `F9` overlay `src/preload/game.js:119`, or `performance.now()` samples |
| Memory | `[mem] heap after load` `src/main.js:487`, watchdog logs `[mem] renderer RSS …` `src/main.js:719` |
| Patch latency | `[dawn-patch] patched … in Xms` `src/main.js:348` |
| Reset everything | `rm -rf ~/Library/Application\ Support/dawn-client/bundle-cache` + `localStorage.clear()` + `config.json` reset |
| Check IPC listeners leak | Ensure `gameWindow.on("closed")` removes all `ipcMain` listeners `src/main.js:564-571` |
| Test stuck keys | Hold Shift-bhop then blur window → keys must release `src/main.js:575` |
| WASM | `npm run build:wasm && npm start` |

---

## 30. Git State & Uncommitted Work

Checked at guide generation (`git log --oneline -5`):

```
d2e46c5 everything working rn
27170bd fix: bhop jump key is Space, not Q — Q is crouch in Kirka
501ec18 improve: auto patch-cache invalidation, patch-health readout, …
```

**Uncommitted modifications** (`git status --short`):

```
 M src/assets/html/menu.html
 M src/main.js
 M src/preload/game.js
 M src/preload/game/bhop.js
 M src/util/defaults.json
```

Key diff highlights:

- `src/main.js` — adds `shell`, bulk folder/save IPC + `DAWN_SHOOT` + `url-change` events + `applyFrameCap` removal `package.json:???`.
- `src/preload/game.js` — large (~6500 insertions) feature additions (room presets, slider, theme, etc. — the monolith expansion).
- `src/preload/game/bhop.js` — `ShiftLeft` → `Shift` string `src/preload/game/bhop.js:184,201`.
- `src/util/defaults.json` — removes `fps_cap` line.
- **Untracked:** `src/addons/browser.js`, `customReqScripts.js`, `gallery.js`, `opener.js`, `swappermenu.js`, `src/preload/game/menu.js` (moved from `src/preload/`? counted as new in this worktree).

> Before committing: run `npm start`, assert no `ipcMain` listener leaks (window close/reopen 3×), no `File.path` errors ( Electron 32 ), and `window.__onGround` still 0/1 in-game.

---

## 31. Glossary

- **`dawn-patch://`** — custom protocol that serves *patched* Kirka bundles (memory+disk cache) instead of origin.
- **`dawnclient://`** — custom protocol serving absolute files from `custom/` (swapper).
- **Needle** — unique literal substring in the minified bundle used as patch anchor; replaced with instrumented version.
- **`PATCH_VERSION`** — FNV-1a hash of `PATCHES` JSON; appended to cache filenames to auto-invalidate.
- **NormMap / clean** — underscore-stripped, lowercased basename mapping for swapper file matching.
- **Bloom filter** — 32-word generation-tagged dedupe for matrices in `weapon-hook.js` to skip duplicate `uniformMatrix4fv` calls.
- **Sig** — packed scale vector `round(s*100)<<20|<<10|` identifying weapon vs arm model in WebGL matrices.
- **`window.__onGround / __antiSpam / __patchMeta`** — globals injected by patched bundle for renderer consumption.
- **`dawn_weapon_config`** — `localStorage` JSON for per-weapon / universal weapon settings.
- **`KCH`** — Kirka Community Hub (`imnotkoolkid/KCH`) — source of community content `src/addons/browser.js:6`.

---

*End of REPO_GUIDE.md — keep updated when adding needles, IPC channels, switches, or `defaults.json` keys.*
