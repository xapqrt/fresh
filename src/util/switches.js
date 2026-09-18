const { app } = require("electron");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ DO NOT re-add compositor-uncap switches on macOS.
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
//   --max-gum-fps=N       → same class of "out-run vsync" flooding; the one
//                           reported working (haxball, M2 Pro MBP) is a
//                           120Hz ProMotion panel — the Air has no such headroom.
//   --max-semi-space-size=128 → 50–100ms stop-the-world scavenge pauses.
//   --disable-features=PaintHolding → swapchain buffer contention.
//
// The verified-smooth target on a 60Hz panel is EXACTLY 60.0 presented
// swaps/sec with 0 drops and ~0.35ms jitter. Any "uncap" on this hardware
// can only make it worse. If a 120/240Hz external display is attached,
// revisit max-gum-fps with a compositor trace before enabling it.
// ─────────────────────────────────────────────────────────────────────────────

function applySwitches() {
  let _useAngleOverride = null;
  let in_process_gpu = false;
  let num_raster_threads = null;

  try {
    const configPath = path.join(app.getPath("userData"), "config.json");
    if (fs.existsSync(configPath)) {
      const stored = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const s = stored?.settings || stored || {};
      if (s.use_angle_opengl === true) _useAngleOverride = 'opengl';
      else if (s.use_angle_metal === true) _useAngleOverride = 'metal';
      if (typeof s.in_process_gpu === "boolean") in_process_gpu = s.in_process_gpu;
      if (typeof s.num_raster_threads === "number") num_raster_threads = s.num_raster_threads;
    }
  } catch (e) {}

  app.commandLine.appendSwitch("high-dpi-support", "1");
  app.commandLine.appendSwitch("user-agent",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");


  if (num_raster_threads !== null && num_raster_threads > 0) {
    app.commandLine.appendSwitch("num-raster-threads",
      String(Math.min(Math.max(num_raster_threads | 0, 1), 8)));
  }

  if (process.platform === "darwin" && _useAngleOverride !== 'opengl') {
    app.commandLine.appendSwitch("use-gl", "angle");
    app.commandLine.appendSwitch("use-angle", "metal");
  }

  if (in_process_gpu) {
    app.commandLine.appendSwitch("in-process-gpu");
  }

  app.commandLine.appendSwitch("disable-gpu-process-crash-limit");

  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

  app.commandLine.appendSwitch("enable-features", "ParallelDownloading");
  app.commandLine.appendSwitch("disable-features",
    "CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,BackForwardCache,Translate,MediaRouter,TrackingPrevention,ThirdPartyStoragePartitioning,Tpcd,TpcdMitigations");

  app.commandLine.appendSwitch("disable-blink-features",
    "ThirdPartyStoragePartitioning,TrustedTypes");

  app.commandLine.appendSwitch("v8-cache-options", "code");
  app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096 --sparkplug --turbo-fast-api-calls --expose-gc");

  app.commandLine.appendSwitch("audio-output-sample-rate", "48000");
  app.commandLine.appendSwitch("audio-buffer-size", "512");
}

module.exports = { applySwitches };
