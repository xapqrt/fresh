# DAWN CLIENT — FULL PROJECT HANDOFF BRIEF

> **For the incoming agent:** Read this ENTIRELY before touching any code. This repo has a long, painful history of "fixes" that broke more than they fixed. Most of the hard-won knowledge is below. Respect the guardrail. Respect what already works.

---

## 0. WHAT THIS PROJECT IS

- **Dawn Client** = an Electron wrapper around **kirka.io** (browser FPS game), built for **Apple Silicon (arm64) macOS**, targeting a **240Hz external monitor** with goals: **0 stutter, 0 input lag, 0 jitter, solid 240fps**.
- Base upstream: `https://github.com/zVipexx/dawn-client` (remote `origin`). Our fork: `https://github.com/xapqrt/fresh` (remote `fresh`).
- **Working runtime: Electron 12.2.3 / Chromium 89** (arm64). This is the "e12" line. There is ALSO an "e10" x64 line (Electron 10.4.7) that the user abandoned because it stuttered / dropped inputs on their M-series Mac. **Do not regress to e10.** The user explicitly moved back to e12.
- Repo path: `~/Documents/code/dawn-fresh`. Built app installs to `/Applications/Dawn Client.app`. There is also a standalone `/Applications/Dawn Recorder.app` (ScreenCaptureKit, separate project, NOT in this repo's main flow).

---

## 1. BRANCH STATE (verified)

| Branch | Purpose | HEAD |
|---|---|---|
| `upgrade-e12-arm64` | **MAIN working client.** This is what ships to `/Applications/Dawn Client.app`. | `6c48ecb` |
| `test/menu-enabled` | EXPERIMENTAL. Re-enables the full Dawn menu (Discord RPC, gallery, swapper, auto-opener, userscripts). Built to a SEPARATE app `/Applications/Dawn Client (Menu Test).app`. NOT merged to main. | `7ee5f06` |
| `main` | Local only, stale (points at e10-era history). Do not use. | — |
| `origin/main` (`zVipexx/dawn-client`) | Upstream. Login works there but it's Electron 10 / different arch. Reference only. | — |

**Push remote = `fresh`** (`https://github.com/xapqrt/fresh`). `origin` is the upstream (read-only reference, do not push there).

**Current checked-out branch when this brief was written: `test/menu-enabled`.** If you intend to work on the shipping client, `git checkout upgrade-e12-arm64` first.

---

## 2. THE GUARDRAIL (DO NOT VIOLATE — `autoloop.sh` line 14, enforced lines 64-89)

```
HARD CONSTRAINTS (never violate):
Do NOT add or enable --disable-frame-rate-limit, --disable-gpu-vsync,
or --in-process-gpu (the latter only allowed inside the existing
'if (in_process_gpu)' gate, which stays default-off).
Do NOT reintroduce setFrameRate().
```

`autoloop.sh` is a research/optimization orchestrator (drives `opencode`). It **actively blocks commits** if those flags appear in `src/` or `setFrameRate` is found — it reverts the files and skips. So:

- ❌ **Never** add `--disable-gpu-vsync`, `--disable-frame-rate-limit`, or unconditional `--in-process-gpu`.
- ❌ **Never** reintroduce `setFrameRate()`.
- These are the ONLY levers that would force a *mathematically constant* 240fps, and they are banned because they cause crashes / black screens / GL per-frame errors on Apple Silicon. **The 235–240 float is the hard ceiling of Electron 12's vsync on macOS.** Accept it.
- `autoloop.sh` ALSO says: "Do NOT run npm build/start. Make minimal justified changes, report a diff-style list, and run `node -c` on any modified .js files." Honor this in automated loops.

---

## 3. WHAT WORKS NOW (DO NOT BREAK)

On `upgrade-e12-arm64` (shipping build), verified stable:

1. **Login (Google / Discord / YouTube) works.** Two fixes made this possible:
   - `protocol.registerSchemesAsPrivileged([https, dawn-patch])` added to `src/main.js` (was MISSING on e12 → blank login page / CSP block).
   - `Array.prototype.at` / `String.prototype.at` **polyfill** added at the TOP of `src/preload/game.js`. **Chromium 89 lacks `.at()` but kirka.io's bundle uses it heavily** (`t.entries.at is not a function` crash). This polyfill is the single most important login fix. **Do not remove it.**
   - OAuth flow uses upstream-proven `new-window` → `shell.openExternal(url)` in `src/windows/game.js` (line 165). kirka.io's auth is a redirect flow that completes in the system browser and the game window picks up the session. **Do not "improve" this with in-app popups** (see §4).
2. **Stable 240Hz, no post-match lag.** `src/util/switches.js`:
   - `--disable-gpu-watchdog` + `--disable-hang-monitor` → stops Chromium resetting the GPU process after sustained load (the "laggy after 4-5 matches" symptom).
   - `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows`.
   - macOS: `NSAppSleepDisabled=true` in `electron-builder.yml` `extendInfo` + `app.disableAppNap()` / `disableSuddenTermination()` in `main.js`.
3. **Snappy mouse.** `switches.js`:
   - **Coalesced mouse events DISABLED** (`CoalescedMouseEvent` in `disable-features`, and the old `enable-coalesced-mouse` flag removed). macOS coalescing batches/averages pointer moves → aim latency. This was a real "mouse not snappy" fix. **Keep it off.**
   - `--disable-features=...,Translate,OptimizationHints,MediaRouter,BackForwardCache` (trimmed event/feature overhead).
   - `webPreferences.backgroundThrottling: false` on the game window (`src/windows/game.js`).
   - `VizDisplayCompositor` enabled on darwin.
4. **BHop (bunny-hop) is responsive and stall-free.** `src/preload/game/bhop.js`:
   - Reads ground state from `window.__onGround` (a page global, NOT CDP polling — lightweight).
   - Jump dispatched via **CDP `Input.dispatchKeyEvent`** through the attached debugger (`_bhopDebugger` in `windows/game.js`), relayed from preload via IPC `dawn-bhop-key` (handler in `windows/game.js` ~line 95). This bypasses the page event pipeline → lower latency than synthetic DOM `KeyboardEvent`s.
   - **Decoupled strafe timing**: `_strafeSwitch()` flips `a`/`d` on its own `~130ms` timer (`_strafeSwitchMs`) independent of the jump pulse (air-control).
   - **Critical stall fix**: `_pulseStrafe()` / `_strafeSwitch()` NEVER send a synthetic keyup for a key the user is *physically holding* (`_aDown`/`_dDown`) → prevents the "stall in that direction" bug.
   - Key-code table hoisted to module scope (`_KEY_CODES`) → no per-keypress allocation.
5. **ANGLE-Metal GPU backend** on by default (`use_angle_metal: true` in `defaults.json`; applied in `switches.js` as `--use-gl=angle --use-angle=metal`). Renders clean, no GL errors (opaque splash mitigates the old `GL_TEXTURE_RECTANGLE_ARB` per-frame error — see §4).
6. **GPU + renderer process priority pinned** in `windows/game.js` `ready-to-show`: GPU pid → `setPriority(-12)`, renderer pid → `setPriority(-10)`. (Was buggy/self-conflicting before `6c48ecb` — now fixed to a single `-10`.)
7. **Opaque splash** (`src/util/switches.js` / splash module uses `#07070a` opaque background, NOT transparent). Transparent splash caused per-frame GL errors on Metal. Keep opaque.

---

## 4. WHAT WAS TRIED, BROKE THINGS, AND MUST NOT BE REPEATED

| Attempt | What happened | Lesson |
|---|---|---|
| **Hijack `requestAnimationFrame` in preload with a `setTimeout` clamp + `Object.defineProperty(..., {writable:false})`** (commit `457e3cf`, later reverted `1f0718f`) | Made the game render PARTIALLY (WebGL swap desynced) AND **hung the renderer so the app couldn't quit**. | NEVER wrap/trap rAF in page JS. It breaks WebGL presentation and freezes the renderer process. The "constant 240" goal must be done at the native display-link level (impossible from a separate addon — see §6), NOT in preload JS. |
| **In-app OAuth popup** (`setWindowOpenHandler` returning `action:"allow"` for auth URLs, navigating a child window) | "Everything broke" — kirka's OAuth expects the system-browser redirect flow; in-app popups broke the round-trip and likely cleared session. | Use upstream-proven `new-window` → `shell.openExternal`. Do not "fix" login with in-app popups. |
| **Broken `setWindowOpenHandler` + diagnostic click/iframe loggers + autoclick pollers + broad webRequest logging** (an earlier commit, since reverted) | Client wouldn't even open / tons of JS errors. | Minimal, justified changes only. No scattershot logging. |
| **ANGLE-Metal WITHOUT opaque splash** (earlier) | Per-frame `GL_TEXTURE_RECTANGLE_ARB` errors / instability on some M4 configs. | Metal is fine NOW only because the splash is opaque. If you touch the splash, keep it opaque. |
| **`--disable-gpu-vsync` / `--disable-frame-rate-limit`** | Banned by guardrail (§2); historically caused crashes/black screens. | Never. |
| **Hardcoded fake User-Agent `Chrome/138 / Electron/10.4.7`** (was in `windows/game.js` on the e10 line) | False feature-detection → kirka enables code paths Chromium 89 can't run → instability/dropped input. Fixed to honest `Chrome/89.0.4389.128 / Electron/12.2.3`. | Keep the UA honest to the real runtime. |

---

## 5. KNOWN DEAD / INERT CONFIG (confusing, harmless, decide later)

- **`performance_mode: true`** in `defaults.json` — **never read anywhere in code.** The README touts it as a feature; in e12 it does nothing. Either implement it or remove it (removing is safer).
- **`fps_cap: 240`** in `defaults.json` — **inert.** The rAF clamp that read it was removed (broke rendering, §4). The key sits in config doing nothing. The 240 cap is achieved via the monitor's vsync, not this key.
- **`dawn-patch.js` protocol layer** referenced in older optimization rounds — **does not exist in e12.** That patch system was stripped. Any "audit dawn-patch.js" task is moot.
- **`use_angle_opengl`** key exists (toggle for ANGLE-over-GL vs Metal). Currently Metal is default. User can A/B test by setting `use_angle_metal:false` + `use_angle_opengl:true` in `config.json`.

---

## 6. WHAT MIGHT BE BETTER (open research, NO easy win)

1. **Truly constant 240fps** — IMPOSSIBLE safely on Electron 12. Chromium owns its internal `CVDisplayLink`; a separate native addon cannot pace it, and `--disable-gpu-vsync` is banned. A native N-API addon was prototyped and discarded (can't reach Chromium's display link). **Accept the 235–240 float.** It "feels" constant because jitter/lag around it are eliminated.
2. **Menu re-enable (test build only)** — `src/preload/menu.js` is a FULLY CODED but ORPHANED menu (Discord RPC, Pack/Chest Auto Opener, Gallery, Resource Swapper, Userscripts, ScreenRec UI, settings panel). It was never `require()`d or instantiated in e12. On `test/menu-enabled` it's lazily `new Menu()`-ed on `DOMContentLoaded` and wired to `toggle-menu` IPC. **Status: builds + launches clean as a separate app, but NOT A/B tested in real gameplay yet.** Risk: menu does one-time DOM injection on init (~1-2ms) and zero per-frame cost unless open; but it's untested for input-latency regressions. User must playtest before merging to main.
3. **BHop frame-perfect timing** — currently jumps on next rAF tick after `window.__onGround` flips true. Could hook the game's actual jump function for frame-exact hops. Marginal, needs reverse-engineering kirka's globals.
4. **GC on match-end** — long multi-hour sessions could accumulate renderer heap. A `gc()` hook on match-end (if a match-end global is exposed) would fully kill drift. Currently unimplemented (low priority; `max-old-space-size=2048 --expose-gc` flags are set but `gc()` isn't called).
5. **`performance_mode` implementation** — if you implement it, keep it guardrail-safe (no forbidden flags). Suggested: when on, it could tighten compositor settings already partially covered.

---

## 7. BUILD / RUN REFERENCE

- **Build:** `npm run build` (electron-builder, outputs `build/dawn-client-setup-mac-1.1.8-arm64.dmg`). Requires Electron 12.2.3 arm64 in `node_modules` (install via `npm install --no-save electron@12.2.3` if missing — the repo may have e10's electron from the abandoned line).
- **Install over main app:** mount DMG, `rm -rf "/Applications/Dawn Client.app"`, `cp -R` from mount, `codesign --force --deep --sign -` (ad-hoc, since `hardenedRuntime:false`). Then `open "/Applications/Dawn Client.app"`.
- **Validate before committing:** `node -c` on every modified `.js`; JSON-parse `defaults.json`.
- **The autoloop.sh loop** expects to drive `opencode` for rounds 5–8 (those are DONE). If you run it, it will enforce §2 and block forbidden flags.
- **Recorder** (`src/preload/game/recorder.js`) writes to `~/Movies/dawn-client/` but the main-process `save-recording` handler in `windows/game.js` points to `~/Movies/clips/dawn-<ts>.webm` and they're in separate processes (unwired). The standalone `/Applications/Dawn Recorder.app` is the working screen-recorder — leave it alone.

---

## 8. TL;DR FOR THE NEXT AGENT

- Work on `upgrade-e12-arm64` for the shipping client. `test/menu-enabled` is an experimental separate app — don't merge without user playtest.
- Login, 240Hz, snappy mouse, stall-free bhop, Metal, priority pins = DONE and STABLE. Don't re-touch what works.
- The `.at()` polyfill and `registerSchemesAsPrivileged` are load-bearing for login. Never remove.
- Guardrail (§2) is absolute: no `--disable-gpu-vsync`, no `--disable-frame-rate-limit`, no unconditional `--in-process-gpu`, no `setFrameRate()`.
- The rAF-clamp and in-app-OAuth-popup "fixes" were disasters (§4). Don't repeat.
- Constant 240 is a hard ceiling — stop trying to force it.
- `performance_mode` and `fps_cap` keys are dead config; either implement or remove, don't be fooled by them.
- When in doubt: make minimal changes, `node -c` everything, build, install to the SEPARATE test app first, let the user playtest, THEN touch main.
