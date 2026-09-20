# Research: Uncapped Engine FPS on macOS, Native arm64

**Goal:** reproduce the old client's ~500 FPS engine experience (the aimer.pro-grade
aim feel) on this repo — natively on Apple Silicon, **no Rosetta 2**, with healthy
presentation (no 2.7 FPS horror).

**Machine under test:** M4 MacBook Air, 3078×1933, **fixed 60Hz panel (no ProMotion)**.

---

## 1. Ground truth (what "500fps" actually was)

The original client (`zVipexx/dawn-client`) runs **Electron 10.4.7 = Chromium 85
(x64 only → Rosetta on M4)** and its entire "unlimited FPS" feature is:

```js
if (settings.unlimited_fps) {
  app.commandLine.appendSwitch("disable-frame-rate-limit");
  app.commandLine.appendSwitch("disable-gpu-vsync");
}
```

On Chromium 85 those two flags made the compositor's BeginFrame source run uncapped,
so the game's loop ticked at ~500Hz while macOS presented at a healthy 60Hz.

**Why 500Hz engine feels better (this is real, not a counter illusion):**
with 60Hz logic, your aim/mouse state is consumed once per 16.6ms; at 500Hz logic it
is consumed every 2ms. Prediction, recoil, hit-registration state and bhop ground-state
granularity are all 25× fresher. The screen still shows 60 — the *internal simulation*
is what got faster. aimer.pro's overlay works identically: its aim loop is never
vsynced. **On a 60Hz panel, no software can display more than 60 frames — the win is
always state-freshness, never visible smoothness.** (Visible 120/240 requires an
external high-refresh monitor; then everything below doubles in value.)

## 2. The regression (measured on this machine, 2026-09-17)

Same two flags on Electron 32 (Chromium 128) + ANGLE Metal:

| Symptom | Cause |
|---|---|
| rAF reports 650 FPS, screen shows 2.7 FPS | `--disable-gpu-vsync` → GPU process calls `[CAMetalLayer nextDrawable]` faster than WindowServer flips; all 3 drawables stay occupied; the call **blocks the GPU thread ~16.6ms**; compositor commits stall; WindowServer drops 99.8% of frames (6,116 dropped in 3s) |
| 1.6 FPS in 3D matches, 200ms spikes | `--disable-frame-rate-limit` → 3K WebGL pumped at 700–1000 engine FPS saturates the M4 GPU command ring |

So: the flags are fine on Chromium 85, fatal on 128. The break is inside
Chromium's macOS compositor/presentation path, **somewhere between Chrome 85 and 128**.

## 3. Independent paths

### Path A — Logic Tick Rate (SHIPPED, compositor-independent)

Kirka's main loop is a **self-scheduling `setTimeout`** (see the `gameLoopDeltaFix`
patch needle: `setTimeout(1/iM * timescale)`) — **not rAF**. setTimeout is never gated
by the display link, so overclocking it cannot touch macOS presentation:

- Menu → Performance → **Logic Tick Rate** 60/120/240/480 (live, no restart).
- Mechanism: the patched loop divides its reschedule interval by
  `window.__dawnTickMul` (rate/60). 480 → the loop runs at ~480Hz; the compositor
  just presents the freshest canvas at 60Hz — exactly the old-client split.
- This IS the 500fps-feel mechanism, version-independent, Rosetta-free, and immune to
  every Chromium compositor change.

**Test A (30 min):** stock profile, tick 240 → 480. Per step check:
1. Menu patch status: `gameLoopDeltaFix` = *applied*.
2. In-match: in-game FPS counter should climb toward the tick rate; **world speed must
   stay normal** (if it runs 2× fast the tick uses a fixed dt → back to 60, report it).
3. F9 logger + feel: bhop consistency and aim should tighten; CPU should rise but stay
   sane (< ~60% one-core). Visual smoothness must be unchanged (it's compositor-driven).
4. Battery/thermals over a longer session.

### Path A2 — Device-rate aim input (SHIPPED, presentation-safe)

A fast game loop cannot consume mouse samples that never reach it. Chromium may align
or coalesce ordinary pointer movement with rendering, so the client now listens for
`pointerrawupdate` while pointer-locked and mirrors each early delta into Kirka's existing
`mousemove` input path:

- **High-Rate Aim Input** is on by default and is live-toggleable.
- The later compatibility `mousemove` carrying the same aggregate is suppressed exactly
  once, preventing doubled sensitivity.
- Raw/native movement totals are compared continuously. Differences are corrected, and
  three consecutive mismatches disable the bridge for that pointer lock so native input
  always remains the safe fallback.
- **Unadjusted Mouse** is a separate opt-in. It requests
  `requestPointerLock({ unadjustedMovement: true })` to bypass the macOS acceleration
  curve, then retries plain pointer lock if Chromium reports it unsupported.
- F9 shows raw/native event rates. The repeatable benchmark records both streams, bridge
  validation, and event-to-render input age under `renderer.mouseInput`.

This improves input freshness and consistency but does not create more than 60 visible
updates on the built-in panel. It deliberately leaves the verified stock compositor path
untouched.

### Path B — Engine Profile A/B (the uncap flags, done right)

Menu → Performance → **Engine Profile** (restart required). Each profile is a
hypothesis about how to make the uncap flags coexist with healthy presentation on
modern Chromium:

| Profile | Hypothesis |
|---|---|
| `uncap` | Control — the old flags verbatim. Expected to reproduce the 2.7 FPS failure on 32. |
| `uncap_gl` | ANGLE GL backend presents via CGL, not the CAMetalLayer drawable ring that deadlocks. The blocking mechanism disappears by construction. |
| `uncap_ipgpu` | GPU work in the browser process — different thread model; the nextDrawable block may no longer stall renderer commits. |
| `uncap_gum` | + `--max-gum-fps=9999` (the haxball M2 **Pro/120Hz** config — that panel had headroom to uncapped into; on a 60Hz Air it may just flood). |
| `uncap_legacy_skia` | `--disable-features=UseSkiaRenderer` → legacy draw/present path that predates the modern compositor rework. |

**Pass criterion per profile (do NOT trust the in-game counter):**
1. Compositor trace (same method as 2026-09-17): `Display::DrawAndSwap` count over a
   10s **in-match** window ÷ 10. Pass = 59–60 swaps, 0 dropped frames.
   Quick-and-dirty: macOS Activity Monitor → "Frames per Second" for the GPU process
   while in a match, or the F9 logger's *stutter/hitch* counts staying flat vs stock.
2. Engine rate: in-game counter should be >> 60 (that's the whole point).
3. No 200ms spikes, no thermal throttle.

A profile that shows high engine FPS **and** 60.0 clean presented swaps wins Path B.

### Path C — Electron version bisect (the direct answer to "old Electron, no Rosetta")

Every Electron from ~v12 onward ships **native arm64 macOS builds**, so Rosetta was
only ever a consequence of picking Electron 10. The bisect finds the newest Chromium
where the uncap flags still behave like they did in 85:

```
32 (128, broken) → 30 (126) → 28 (120) → 26 (116) → 24 (114)
→ 22 (108) → 20 (104) → 18 (100) → 16 (96) → 14 (93) → 12 (89, baseline-era)
```

Per version: `npm i -D electron@<v>` → run with profile `uncap` → compositor trace
in a match → record (presented FPS, dropped frames, engine FPS). First clean version
winning = ship it arm64. Known suspect windows in Chromium history: new Skia renderer
(~M106), GPU-process present refactor (M100–M115), ANGLE/Metal rework (M90–M110).

**API floor for this codebase:** `protocol.handle()` (dawn-patch + dawnclient) needs
Electron **25+**. If the clean version lands below 25, revert those two registrations
to `registerFileProtocol` (both exist in git history) and re-test — ~1h of work.

### Path D (nuclear, only if A+B+C all fail)

Headless Chromium running kirka (uncapped, no WindowServer involvement) + a tiny
native Swift sidecar that receives raw canvas frames over a pipe and blits them into
its own `CAMetalLayer` at display rate. Uncapped engine guaranteed; cost is +2–5ms
latency and audio routing. Weeks of work — do not start before A/B/C are exhausted.

## 4. Decision tree

1. **Test A + A2 first.** Use tick 480 with High-Rate Aim Input, then run the benchmark
   while aiming normally. Raw Hz should exceed native mousemove Hz, movement mismatches
   should stay at zero, and presentation should remain ~60 clean rAF FPS.
2. A/B **Unadjusted Mouse** separately; keep the mode that feels consistent after matching
   in-game sensitivity. It changes acceleration, not display refresh.
3. Run Path B profiles (an evening). If any wins → ship it as an opt-in profile.
4. Bisect (Path C) over a day or two of spare time → the cleanest "true uncapped
   rAF" native client ever made for this game.
5. A + C can combine: native-Electron-<N> with uncap profile + tick 240 = old feel
   plus finer bhop timing.

## 5. What is deliberately NOT done

- No `--disable-frame-rate-limit` without measurement — on this panel it can only
  flood the GPU ring (measured: 1.6 FPS).
- No chasing "visible > 60 FPS" — the panel physically cannot present it. The goal is
  engine rate + latency. A 240Hz external monitor changes that math entirely; if one
  is ever attached, re-run Path B (headroom to uncapped into = the haxball case).
- No Rosetta builds, ever, again — the whole point is native arm64.
