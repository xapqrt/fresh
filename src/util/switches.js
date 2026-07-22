const { app } = require("electron");
const fs = require("fs");
const path = require("path");

function applySwitches() {
  // Read optional overrides from config
  let use_angle_metal = false;
  let use_angle_opengl = false;
  let in_process_gpu = false;

  try {
    const configPath = path.join(app.getPath("userData"), "config.json");
    if (fs.existsSync(configPath)) {
      const stored = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const s = stored?.settings || stored || {};
      if (typeof s.use_angle_metal === "boolean") use_angle_metal = s.use_angle_metal;
      if (typeof s.use_angle_opengl === "boolean") use_angle_opengl = s.use_angle_opengl;
      if (typeof s.in_process_gpu === "boolean") in_process_gpu = s.in_process_gpu;
    }
  } catch (e) {}

  // ─── GPU ───────────────────────────────────────────────────────────────────
  // On macOS Apple Silicon, Chromium already picks Metal by default and runs
  // at full GPU performance. Adding flags like --enable-gpu-rasterization,
  // --enable-zero-copy, --ignore-gpu-blocklist or --num-raster-threads can
  // CRASH the GPU process and cause Chromium to fall back to SwiftShader
  // software rendering (~2-5 FPS). Do NOT add them unconditionally.
  
  app.commandLine.appendSwitch("high-dpi-support", "1");

  if (process.platform === "darwin") {
    // Only enable ANGLE explicitly if the user opted in via settings
    if (use_angle_metal && !use_angle_opengl) {
      app.commandLine.appendSwitch("use-gl", "angle");
      app.commandLine.appendSwitch("use-angle", "metal");
    }
  }

  if (in_process_gpu) {
    // In-process GPU skips the GPU sandbox — useful for debugging only
    app.commandLine.appendSwitch("in-process-gpu");
  }

  // ─── Throttling / backgrounding ─────────────────────────────────────────
  // These are safe and prevent Chrome from throttling rAF/timers when the
  // window is backgrounded or occluded.
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

  // ─── Features ────────────────────────────────────────────────────────────
  app.commandLine.appendSwitch("enable-features",
    "ParallelDownloading");
  app.commandLine.appendSwitch("disable-features",
    "CalculateNativeWinOcclusion,PaintHolding,IntensiveWakeUpThrottling,BackForwardCache,Translate,MediaRouter");
  // Prevent Chromium from permanently disabling GPU acceleration after repeated
  // Metal GPU process crashes (common on Apple Silicon with heavy WebGL). Without
  // this, Chrome gives up on the GPU after ~3 crashes and falls back to SwiftShader
  // software rendering (2-5 FPS) until the app is restarted.
  app.commandLine.appendSwitch("disable-gpu-process-crash-limit");

  // ─── V8 / JS ─────────────────────────────────────────────────────────────
  // Only safe, well-supported flags. --max-old-space-size gives the game
  // heap room. --sparkplug enables Sparkplug tier-1 JIT. --expose-gc lets us
  // trigger GC between matches. --turbo-fast-api-calls enables fast V8 API
  // call paths for DOM/WebGL (available since V8 10.x / Electron 28).
  // --max-semi-space-size=64 gives the young-generation scavenger more room
  // so minor GCs are less frequent during gameplay.
  // Excluded (unsafe on kirka.io):
  //   --sharedarraybuffer  (requires Cross-Origin-Isolation headers)
  //   --wasm-threads       (same — kirka.io doesn't set COOP/COEP)
  app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096 --max-semi-space-size=64 --sparkplug --turbo-fast-api-calls --expose-gc");

  // ─── Audio ───────────────────────────────────────────────────────────────
  app.commandLine.appendSwitch("audio-output-sample-rate", "48000");
  app.commandLine.appendSwitch("audio-buffer-size", "512");
}

module.exports = { applySwitches };
