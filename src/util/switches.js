const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

function applySwitches() {
  let in_process_gpu = false;
  let use_angle_opengl = false;
  let use_angle_metal = false;
  let fps_cap = 0;
  let hasExplicitInProcessGpu = false;
  let hasExplicitAngleMetal = false;
  let forceMetal = false;
  try {
    const configPath = path.join(app.getPath("userData"), "config.json");
    if (fs.existsSync(configPath)) {
      const stored = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (stored && stored.settings) {
        if (typeof stored.settings.in_process_gpu === "boolean") {
          in_process_gpu = stored.settings.in_process_gpu;
          hasExplicitInProcessGpu = true;
        }
        use_angle_opengl = !!stored.settings.use_angle_opengl;
        if (typeof stored.settings.use_angle_metal === "boolean") {
          use_angle_metal = stored.settings.use_angle_metal;
          hasExplicitAngleMetal = true;
        }
        if (typeof stored.settings.forceMetal === "boolean") {
          forceMetal = stored.settings.forceMetal;
        }
        fps_cap = parseInt(stored.settings.fps_cap, 10) || 0;
      }
      // also accept top-level keys (config.json is sometimes written flat)
      if (stored && typeof stored.use_angle_metal === "boolean") {
        use_angle_metal = stored.use_angle_metal;
        hasExplicitAngleMetal = true;
      }
      if (stored && typeof stored.in_process_gpu === "boolean") {
        in_process_gpu = stored.in_process_gpu;
        hasExplicitInProcessGpu = true;
      }
      if (stored && typeof stored.forceMetal === "boolean") {
        forceMetal = stored.forceMetal;
      }
      if (stored && typeof stored.fps_cap === "number") {
        fps_cap = stored.fps_cap;
      }
    }
  } catch (e) {}

  // Machine-model gating: default Metal + in-process-gpu ON for non-M4 Apple
  // Silicon. M4 machines have a known blue-screen / stuck-on-splash risk with
  // ANGLE Metal on Electron 12 (surface-creation failures). The user can still
  // override via config.json.
  // forceMetal=true bypasses the M4 exclusion (user opt-in for M4).
  if (process.platform === "darwin") {
    const cpuModel = (os.cpus()[0]?.model) || "";
    const isM4 = /M4/.test(cpuModel);
    if (!isM4 || forceMetal) {
      if (!hasExplicitAngleMetal) use_angle_metal = true;
      if (!hasExplicitInProcessGpu) in_process_gpu = true;
    }
  }

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
  const rasterThreads = Math.min(os.cpus().length, 4);
  app.commandLine.appendSwitch("num-raster-threads", String(rasterThreads));
  if (process.platform === "darwin") {
    app.commandLine.appendSwitch("enable-features", "VaapiIgnoreDriverChecks,ScreenCaptureKit,AsyncWheelEvents,VizDisplayCompositor");
    app.commandLine.appendSwitch("enable-gpu-memory-buffer-video-frames");
    // Disable touch/tablet input paths we never use — trims the event pipeline.
    app.commandLine.appendSwitch("disable-features", "TouchpadAndTouchscreenEvents");
  } else {
    app.commandLine.appendSwitch("enable-features", "VaapiIgnoreDriverChecks");
  }
  app.commandLine.appendSwitch("force-color-profile", "srgb");
  app.commandLine.appendSwitch("renderer-process-limit", "1");
  app.commandLine.appendSwitch("max-active-webgl-contexts", "1");
  app.commandLine.appendSwitch("canvas-msaa-sample-count", "0");

  if (in_process_gpu) {
    app.commandLine.appendSwitch("in-process-gpu");
  }
  // ANGLE backend A/B (Apple Silicon GPU path). Pick ONE:
  //  - use_angle_metal : ANGLE over Metal (usually lowest present latency)
  //  - use_angle_opengl: ANGLE over OpenGL-on-Metal translation
  //  - neither         : Chromium's default (ANGLE/GL on Apple Silicon)
  // Test both in-game; keep the one that feels snappier / renders clean.
  if (use_angle_metal) {
    app.commandLine.appendSwitch("use-gl", "angle");
    app.commandLine.appendSwitch("use-angle", "metal");
  } else if (use_angle_opengl) {
    app.commandLine.appendSwitch("use-gl", "angle");
    app.commandLine.appendSwitch("use-angle", "gl");
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
  app.commandLine.appendSwitch("js-flags", "--max-old-space-size=2048 --expose-gc --optimize-for-size");
  app.commandLine.appendSwitch("audio-output-sample-rate", "48000");
  app.commandLine.appendSwitch("audio-buffer-size", "512");

  app.commandLine.appendSwitch("disable-gpu-watchdog");   // prevent GPU process reset after sustained load (lag after several matches)
  app.commandLine.appendSwitch("disable-hang-monitor");
  app.commandLine.appendSwitch("gpu-process-priority", "high");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

  app.allowRendererProcessReuse = true;
}

module.exports = {
  applySwitches,
};
