const { app } = require("electron");
const fs = require("fs");
const path = require("path");

function applySwitches() {
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

  app.commandLine.appendSwitch("high-dpi-support", "1");

  if (process.platform === "darwin") {
    if (use_angle_metal && !use_angle_opengl) {
      app.commandLine.appendSwitch("use-gl", "angle");
      app.commandLine.appendSwitch("use-angle", "metal");
    }
  }

  if (in_process_gpu) {
    app.commandLine.appendSwitch("in-process-gpu");
  }

  app.commandLine.appendSwitch("disable-gpu-process-crash-limit");

  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

  // ─── Features ────────────────────────────────────────────────────────────
  app.commandLine.appendSwitch("enable-features",
    "ParallelDownloading,CanvasOopRasterization");
  app.commandLine.appendSwitch("disable-features",
    "CalculateNativeWinOcclusion,PaintHolding,IntensiveWakeUpThrottling,BackForwardCache,Translate,MediaRouter");


  app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096 --max-semi-space-size=64 --sparkplug --turbo-fast-api-calls --expose-gc --cache=code");

  app.commandLine.appendSwitch("audio-output-sample-rate", "48000");
  app.commandLine.appendSwitch("audio-buffer-size", "512");
}

module.exports = { applySwitches };
