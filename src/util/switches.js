const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

function applySwitches() {
  let in_process_gpu = false;
  let use_angle_opengl = false;
  let use_angle_metal = false;
  let fps_cap = 0;
  try {
    const configPath = path.join(app.getPath("userData"), "config.json");
    if (fs.existsSync(configPath)) {
      const stored = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (stored && stored.settings) {
        in_process_gpu = !!stored.settings.in_process_gpu;
        use_angle_opengl = !!stored.settings.use_angle_opengl;
        use_angle_metal = !!stored.settings.use_angle_metal;
        fps_cap = parseInt(stored.settings.fps_cap, 10) || 0;
      }
      // also accept top-level keys (config.json is sometimes written flat)
      if (stored && typeof stored.use_angle_metal === "boolean") {
        use_angle_metal = stored.use_angle_metal;
      }
      if (stored && typeof stored.in_process_gpu === "boolean") {
        in_process_gpu = stored.in_process_gpu;
      }
      if (stored && typeof stored.fps_cap === "number") {
        fps_cap = stored.fps_cap;
      }
    }
  } catch (e) {}

  // NOTE: ANGLE-Metal is gated behind stored.settings.use_angle_metal (default false).
  // On Electron 12 / Apple Silicon it can cause
  // 'glBindTexture: target was GL_TEXTURE_RECTANGLE_ARB' + 'failed to create surface'
  // GL errors -> splash stuck on blue screen. Enable only by setting
  // "use_angle_metal":true in config.json (no rebuild needed).

  app.commandLine.appendSwitch("high-dpi-support", "1");
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("enable-zero-copy");
  // NOTE: removed disable-software-rasterizer — this blocked SwiftShader compositor
  // fallback on Apple Silicon when the Metal GPU surface fails, causing the "blue
  // screen / stuck on splash" bug on M4. Without this flag, the compositor falls
  // back to software tiles while WebGL keeps hardware GPU acceleration.
  // NOTE: removed enable-native-gpu-memory-buffers, enable-accelerated-2d-canvas,
  // CanvasOop, MetalOnlyGraphics, force-gpu-mem-available-mb — these destabilized
  // the GPU process (surface-creation failures -> GPU crash) on Electron 12 / Apple Silicon.
  app.commandLine.appendSwitch("disable-gpu-vsync");
  app.commandLine.appendSwitch("disable-frame-rate-limit");
  const rasterThreads = Math.min(os.cpus().length, 4);
  app.commandLine.appendSwitch("num-raster-threads", String(rasterThreads));
  if (process.platform === "darwin") {
    app.commandLine.appendSwitch("enable-features", "VaapiIgnoreDriverChecks,ScreenCaptureKit,AsyncWheelEvents,VizDisplayCompositor");
    app.commandLine.appendSwitch("enable-gpu-memory-buffer-video-frames");
  } else {
    app.commandLine.appendSwitch("enable-features", "VaapiIgnoreDriverChecks");
  }
  app.commandLine.appendSwitch("force-color-profile", "srgb");
  app.commandLine.appendSwitch("canvas-msaa-sample-count", "0");

  if (in_process_gpu) {
    app.commandLine.appendSwitch("in-process-gpu");
  }
  if (use_angle_metal) {
    app.commandLine.appendSwitch("use-gl", "angle");
    app.commandLine.appendSwitch("use-angle", "metal");
  }

  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  // NOTE: do NOT enable coalesced mouse events — macOS batches/averages pointer
  // moves between frames, which adds aim latency in a fast FPS. Deliver raw,
  // un-batched mouse moves for the snappiest input.
  app.commandLine.appendSwitch("disable-features",
    "CalculateNativeWinOcclusion,PaintHolding,IntensiveWakeUpThrottling,Translate,OptimizationHints,MediaRouter,BackForwardCache,CoalescedMouseEvent");
  app.commandLine.appendSwitch("touch-events", "disabled");
  app.commandLine.appendSwitch("disable-features",
    "CalculateNativeWinOcclusion,PaintHolding,IntensiveWakeUpThrottling,Translate,OptimizationHints,MediaRouter,BackForwardCache");
  app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096 --sparkplug --no-turbo-inlining --memory-pressure-off --wasm-simd --wasm-threads --expose-gc --sharedarraybuffer");
  app.commandLine.appendSwitch("audio-output-sample-rate", "48000");
  app.commandLine.appendSwitch("audio-buffer-size", "512");



  app.allowRendererProcessReuse = true;
}

module.exports = {
  applySwitches,
};
