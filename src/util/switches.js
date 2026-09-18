const { app } = require("electron");
const fs = require("fs");
const path = require("path");

function applySwitches() {
  let _useAngleOverride = null;
  let in_process_gpu = false;
  let num_raster_threads = null;
  let low_latency = false; // opt-in via settings — risky on many setups

  try {
    const configPath = path.join(app.getPath("userData"), "config.json");
    if (fs.existsSync(configPath)) {
      const stored = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const s = stored?.settings || stored || {};
      if (s.use_angle_opengl === true) _useAngleOverride = 'opengl';
      else if (s.use_angle_metal === true) _useAngleOverride = 'metal';
      if (typeof s.in_process_gpu === "boolean") in_process_gpu = s.in_process_gpu;
      if (typeof s.num_raster_threads === "number") num_raster_threads = s.num_raster_threads;
      if (typeof s.low_latency === "boolean") low_latency = s.low_latency;
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

  // Safe GPU-path flags (vetted for Electron 32 / Apple Silicon — see
  // full-performance-review.md §1.2). Unknown switches are ignored by
  // Chromium, so these are no-ops worst case.
  app.commandLine.appendSwitch("enable-zero-copy");
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  // Kill P3→sRGB color-space conversion overhead on Apple displays.
  app.commandLine.appendSwitch("force-color-profile", "srgb");

  // Opt-in low-latency mode: uncap the compositor. Saves ~2–8ms of
  // frame-present latency on 120/240Hz displays, at the cost of screen
  // tearing on fixed-refresh (non-VRR) panels. Restart required —
  // switches are read before app ready. max-gum-fps is the switch that
  // actually lets Chromium produce frames faster than vsync on macOS
  // (verified working on M2 Electron for WebGL games); without it the
  // two flags below are largely no-ops on Apple Silicon.
  if (low_latency) {
    app.commandLine.appendSwitch("disable-gpu-vsync");
    app.commandLine.appendSwitch("disable-frame-rate-limit");
    app.commandLine.appendSwitch("max-gum-fps", "9999");
  }

  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

  app.commandLine.appendSwitch("enable-features", "ParallelDownloading");
  app.commandLine.appendSwitch("disable-features",
    "CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,BackForwardCache,Translate,MediaRouter,PaintHolding,OptimizationHints,TrackingPrevention,ThirdPartyStoragePartitioning,Tpcd,TpcdMitigations");

  app.commandLine.appendSwitch("disable-blink-features",
    "ThirdPartyStoragePartitioning,TrustedTypes");

  app.commandLine.appendSwitch("v8-cache-options", "code");
  app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096 --max-semi-space-size=128 --sparkplug --turbo-fast-api-calls --expose-gc");

  app.commandLine.appendSwitch("audio-output-sample-rate", "48000");
  app.commandLine.appendSwitch("audio-buffer-size", "512");
}

module.exports = { applySwitches };
