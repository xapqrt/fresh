const { app } = require("electron");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ UNCAP SWITCHES ARE A RESEARCH INSTRUMENT ON THIS MACHINE — READ BEFORE
// TOUCHING.
//
// Measured on this machine (M4 MacBook Air, 60Hz panel, ANGLE Metal) via
// Chromium compositor traces (viz/benchmark/cc) on 2026-09-17:
//
//   --disable-gpu-vsync   → GPU process calls [metalLayer nextDrawable] faster
//                           than WindowServer flips; all 3 drawables stay
//                           occupied, GPU thread blocks ~16.6ms/call → 99.8%
//                           of presented frames dropped (2.7 FPS on screen
//                           while rAF reported 650).
//   --disable-frame-rate-limit → 3K WebGL canvas pumped at 700–1000 engine
//                           FPS saturated the M4 GPU command ring → 1.6 FPS
//                           presented, 9,582 dropped frames in 5s, 200ms
//                           spikes.
//
// The old client (zVipexx/dawn-client, Electron 10 = Chromium 85, x64/Rosetta)
// ran those SAME two flags and coexisted with healthy 60Hz presentation —
// so the regression is inside Chromium 85→128, not in the game. The
// "engine_profile" setting below is the A/B rig for finding a configuration
// that restores the old ~500Hz engine rate with clean presentation, natively
// (arm64, no Rosetta). Full protocol: RESEARCH-UNCAP-MACOS.md.
//
// On a 60Hz panel the verified optimum presentation is EXACTLY 60.0 swaps,
// 0 drops, ~0.35ms jitter. "stock" is that state. Every uncap* profile is
// experimental: measure presented FPS with a compositor trace before
// believing it.
//
// Independent of all of the above: kirka's main loop is a self-scheduling
// setTimeout (NOT rAF), so "Logic Tick Rate" (window.__dawnTickMul)
// overclocks the game's internal simulation without touching the compositor
// at all — that is the version-independent path to the old-client feel.
// ─────────────────────────────────────────────────────────────────────────────

function applySwitches() {
  let _useAngleOverride = null;
  let in_process_gpu = false;
  let num_raster_threads = null;
  let engine_profile = "stock";

  try {
    const configPath = path.join(app.getPath("userData"), "config.json");
    if (fs.existsSync(configPath)) {
      const stored = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const s = stored?.settings || stored || {};
      if (s.use_angle_opengl === true) _useAngleOverride = 'opengl';
      else if (s.use_angle_metal === true) _useAngleOverride = 'metal';
      if (typeof s.in_process_gpu === "boolean") in_process_gpu = s.in_process_gpu;
      if (typeof s.num_raster_threads === "number") num_raster_threads = s.num_raster_threads;
      if (typeof s.engine_profile === "string") engine_profile = s.engine_profile;
    }
  } catch (e) {}

  app.commandLine.appendSwitch("high-dpi-support", "1");
  app.commandLine.appendSwitch("user-agent",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");


  if (num_raster_threads !== null && num_raster_threads > 0) {
    app.commandLine.appendSwitch("num-raster-threads",
      String(Math.min(Math.max(num_raster_threads | 0, 1), 8)));
  }

  // ── Low-latency / high-fps graphics pipeline ─────────────────────────────
  // Safe on macOS ANGLE Metal (the M4 Air path) + Windows D3D. Zero-copy and
  // GPU rasterization cut texture-upload and tile-raster overhead. Raw
  // pointer input + pointer-lock options remove one frame of mouse-look
  // latency and disable OS pointer acceleration in lock. Canvas OOP
  // rasterization moves canvas work to the GPU process (less main-thread
  // contention). Force sRGB kills an unnecessary color-management pass.
  app.commandLine.appendSwitch("enable-zero-copy");
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("enable-features",
    "ParallelDownloading,RawPointerEvents,PointerLockOptions,CanvasOopRasterization");
  app.commandLine.appendSwitch("force-color-profile", "srgb");
  app.commandLine.appendSwitch("disable-touch-events");
  // Raise the GPU watchdog timeout so a long frame (common at 480Hz tick
  // on the M4) doesn't kill the GPU process mid-match.
  app.commandLine.appendSwitch("gpu-watchdog-timeout-seconds", "60");
  // Ensure the renderer's timer resolution doesn't get clamped to 15ms by
  // background-throttling heuristics during pointer-lock.
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

  // ── Engine profile (restart required) ─────────────────────────────────────
  // Profiles that start with "uncap" add the old client's two flags.
  // Variants change the presentation path so one of them may survive on
  // modern Chromium without the nextDrawable deadlock:
  //   uncap_gl          → ANGLE GL backend (CGL present, no CAMetalLayer ring)
  //   uncap_ipgpu       → GPU work in the browser process (different thread model)
  //   uncap_gum         → + --max-gum-fps (worked on M2 Pro/120Hz per haxball)
  //   uncap_legacy_skia → legacy Skia compositing path
  const uncap = engine_profile === "uncap" || engine_profile.startsWith("uncap_");
  if (uncap) {
    app.commandLine.appendSwitch("disable-frame-rate-limit");
    app.commandLine.appendSwitch("disable-gpu-vsync");
    if (engine_profile === "uncap_gum") app.commandLine.appendSwitch("max-gum-fps", "9999");
  }
  if (in_process_gpu || engine_profile === "uncap_ipgpu") {
    app.commandLine.appendSwitch("in-process-gpu");
  }

  // ── GPU backend ───────────────────────────────────────────────────────────
  if (engine_profile === "uncap_gl") {
    // Native GL (CGL) presentation path instead of the CAMetalLayer
    // drawable ring that deadlocks under uncap on Chromium 128.
    app.commandLine.appendSwitch("use-angle", "gl");
  } else if (process.platform === "darwin" && _useAngleOverride !== 'opengl') {
    app.commandLine.appendSwitch("use-gl", "angle");
    app.commandLine.appendSwitch("use-angle", "metal");
  }

  // Disable features we don't want running (these regress input latency or
  // cause throttling). Add UseSkiaRenderer for the legacy-skia profile.
  let _df = "CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,BackForwardCache," +
    "Translate,MediaRouter,TrackingPrevention,ThirdPartyStoragePartitioning," +
    "Tpcd,TpcdMitigations";
  if (engine_profile === "uncap_legacy_skia") _df += ",UseSkiaRenderer";
  app.commandLine.appendSwitch("disable-features", _df);

  app.commandLine.appendSwitch("disable-gpu-process-crash-limit");

  app.commandLine.appendSwitch("disable-background-timer-throttling");

  app.commandLine.appendSwitch("disable-blink-features",
    "ThirdPartyStoragePartitioning,TrustedTypes");

  app.commandLine.appendSwitch("v8-cache-options", "code");
  app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096 --sparkplug --turbo-fast-api-calls --expose-gc");

  app.commandLine.appendSwitch("audio-output-sample-rate", "48000");
  app.commandLine.appendSwitch("audio-buffer-size", "512");
}

module.exports = { applySwitches };
