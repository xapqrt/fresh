const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

function applySwitches() {
  let in_process_gpu = false;
  let use_angle_opengl = false;
  try {
    const configPath = path.join(app.getPath("userData"), "config.json");
    if (fs.existsSync(configPath)) {
      const stored = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (stored && stored.settings) {
        in_process_gpu = !!stored.settings.in_process_gpu;
        use_angle_opengl = !!stored.settings.use_angle_opengl;
      }
    }
  } catch (e) {}

  app.commandLine.appendSwitch("use-gl", "angle");
  // use-angle must be set ONCE; metal is the stable backend on Apple Silicon.
  app.commandLine.appendSwitch("use-angle", use_angle_opengl ? "opengl" : "metal");

  app.commandLine.appendSwitch("high-dpi-support", "1");
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("enable-zero-copy");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  // NOTE: removed enable-native-gpu-memory-buffers, enable-accelerated-2d-canvas,
  // CanvasOop, MetalOnlyGraphics, force-gpu-mem-available-mb — these destabilized
  // the GPU process (surface-creation failures -> GPU crash) on Electron 12 / Apple Silicon.
  const rasterThreads = Math.min(os.cpus().length, 4);
  app.commandLine.appendSwitch("num-raster-threads", String(rasterThreads));
  app.commandLine.appendSwitch("enable-features", "VaapiIgnoreDriverChecks");
  app.commandLine.appendSwitch("force-color-profile", "srgb");
  app.commandLine.appendSwitch("canvas-msaa-sample-count", "0");

  if (in_process_gpu) {
    app.commandLine.appendSwitch("in-process-gpu");
  }

  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-features",
    "CalculateNativeWinOcclusion,PaintHolding,IntensiveWakeUpThrottling,Translate,OptimizationHints,MediaRouter,BackForwardCache");
  app.commandLine.appendSwitch("js-flags", "--max-old-space-size=512");
  app.commandLine.appendSwitch("audio-output-sample-rate", "48000");
  app.commandLine.appendSwitch("audio-buffer-size", "512");

  app.allowRendererProcessReuse = true;
}

module.exports = {
  applySwitches,
};
