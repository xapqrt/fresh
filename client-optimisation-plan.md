# Client Optimisation & Upgrade Plan

What we can do to Dawn Client next, **apart from bhop work** (see
`bundle-research-report.md` for the bundle/cache research this plan is based on).

Priorities: **P0** = correctness bugs, **P1** = perf (branch goal), **P2** = features/upgrades.

> **Status (all items implemented 2026-07-31)**: 1, 3, 4, 5, 6 → `src/main.js`
> (`PATCH_VERSION` const, `.p<N>`-suffixed cache files, `pruneBundleCache()`,
> `PATCHES` needle registry, `applyPatches()` + `patchAndCache()`,
> `warmBundleCache()` during splash, `[dawn-patch] … in Xms` log, chunk filter).
> 2 → `__patchMeta` appended to every patched file (preload readout pending).
> 7 → dead zoom patch removed. 8 → `bhopSlider` (1–5) + `bhopMult` needles patched,
> `bhop_mult` setting + menu entry + `applyBhopMult()` in `src/preload/game.js`.
> 9 → `chunk-*.js` routed through dawn-patch. 10 → `__antiSpam` hook (arm/clear)
> + blind-pulse throttle in `src/preload/game/bhop.js`.

---

## P0 — Fix the patch pipeline (it's silently lying to us)

### 1. Patch version in the cache key
- **Why**: `dawn-patch` serves the disk-cached patched bundle forever
  (`max-age=31536000, immutable`, keyed by URL filename). After any patch code change the
  old bundle keeps being served until `~/Library/Application Support/dawn-client/bundle-cache/app.*.js`
  is manually deleted. This caused the dead-onGround bug to linger.
- **Fix**: add `?v=<PATCH_VERSION>` to the redirect URL in
  `src/main.js:406` (e.g. `dawn-patch://bundle/app.js?v=3&url=...`). Bump the constant
  whenever patch rules change. `_cacheKey` already keys by URL filename, so include the
  version in the served filename (`app.<ver>.js` or `app.<hash>.js`).
- **Bonus**: on app launch, prune `bundle-cache/` files older than N days / versions not
  in the current build.

### 2. Surface patch status to the renderer
- **Why**: patch success/failure only logs to the main-process console. A user with a
  stale bundle or a game update (bundle hash changes → obfuscation may change → patterns
  miss) silently loses features.
- **Fix**: append `window.__patchMeta = {zoom, onGround, patchVersion}` to the patched
  bundle (already appending a `// dawn-patch:` comment line — make it data). Preload
  reads it, shows a small indicator in the menu ("hooks active" / "outdated client —
  re-download").

### 3. Patch-needle registry + startup self-check
- **Why**: needles like `f5['a'][hF]` (zoom, dead) and `iP[da8(0x55bf)]...` (onGround,
  live) are hand-maintained; a game update silently breaks them.
- **Fix**: keep an array of `{name, needle, replacement}` in one module; log a single
  summary `[dawn-patch] OK (2/2)` or `MISSING: zoom` on every serve. Optionally store the
  game bundle's content hash so we can detect "game updated — re-verify needles".

---

## P1 — Performance (this branch's goal)

### 4. Preload bundle during splash screen
- **Why**: first `dawn-patch` request blocks game startup on a multi-MB `fetch()` +
  string patching of the bundle (string ops over a ~6.5MB file).
- **Fix**: in `createWindow`, immediately `_cacheGet`/warm the known bundle URL (the
  redirect already knows the URL) before the game window loads. Since the protocol serves
  the cached copy after the first hit, warming during splash removes most of the stall.

### 5. Avoid re-patching on every cold start
- **Why**: patching runs on cache miss; if cache is pruned (P0-1) we pay the cost again.
- **Fix**: store patched output keyed by `(bundleUrl, patchVersion)` — the current
  `_cacheKey` does this per-URL already; just make sure the version suffix (P0-1) is part
  of the filename so we never re-patch an old-version cached file.

### 6. Measure the actual overhead
- **Why**: the branch is `perf/nuclear-overhaul`; we've never measured patch latency or
  bhop polling cost.
- **Fix**: use the existing F9 frame-time logger (`toggleFrameTimeLogger` in
  `src/preload/game.js`) to compare frame times with/without the bhop hook; log
  `[dawn-patch] fetch+patch took Xms` from the protocol handler.

---

## P2 — Upgrades unlocked by the research

### 7. Fix the dead zoom patch (or remove it)
- **Why**: `f5['a'][hF]` has 0 occurrences in the current bundle — the zoom hook is dead
  code writing globals nobody reads.
- **Fix**: either remove the block, or re-anchor it to the real scope logic. We now know
  scope input lives at `0x2d9c` (`"scope"`) and scope handling is near the input edge
  handler (~3037194) — find the actual `f5['a'][hF]` successor with `show-ctx.js` on
  `state['scope']` or `iO['scope']` reads and patch the real FOV/zoom multiplier.

### 8. Native bhop multiplier override (settings patch)
- **Why**: the game's built-in bhop (passive speed boost, default ON, multiplier 1.5,
  slider 1–3) is a *client-side setting* saved via `localStorage` `createOptions`
  (byte 1284829) — same store we already manage.
- **Fix**: patch `createOptions` read/write to clamp `wnNMwWmW` to our chosen value (or
  extend the slider range by patching the UI at 1897338). This rides the *native* system
  — no extra pulses needed. (This is bhop-adjacent; included because it's a settings
  patch, not a bhop-logic change.)

### 9. Lazy-chunk interception
- **Why**: `onBeforeRequest` only rewrites `app.*.js`. The game lazy-loads hex-named
  chunks (`chunk-6d6174726978` = `chunk-matrix`, plus physics/render chunks) — some
  server-relevant logic lives there.
- **Fix**: extend the URL filter to `*://kirka.io/assets/js/*.js` and route all through
  dawn-patch with the same needle registry. Enables future patches on non-app chunks
  (e.g. render loop → true FPS uncap, network code → interpolation tweaks) without
  guessing in the giant app bundle.

### 10. Better anti-spam awareness in the preload
- **Why**: the game eats a jump if 2 presses land within ~2 ticks (`wNWmWwM` counter).
  Our bhop catch-up loop (max 8 toggles/frame) can trip it on slow frames.
- **Fix**: expose the counter via the same `window.__onGround`-style hook (it's
  `player.input['wNWmWwM']`, 0x6627) and let bhop.js throttle pulses when the counter is
  armed. Turns a guessed cadence into a state-aware one. (Core bhop logic stays in
  bhop.js; this is just feeding it better data.)

---

## Quick wins checklist

| # | item | effort | value |
|---|---|---|---|
| 1 | cache-key versioning | S | high (bug) |
| 2 | `__patchMeta` to renderer | S | medium |
| 3 | needle registry + self-check | S | high |
| 4 | warm cache at splash | S | medium |
| 5 | version-suffixed cache filenames | S | high (with 1) |
| 6 | patch latency logging | XS | medium |
| 7 | fix/remove dead zoom patch | M | low (dead) |
| 8 | native bhop multiplier override | M | high |
| 9 | lazy-chunk interception | M | high |
| 10 | anti-spam counter hook | M | high |

**Recommended order**: 1+5 together (one small refactor), then 2+3 (observability), then
6 (measure), then 9, then 10/8.
