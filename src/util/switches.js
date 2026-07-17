const { app } = require("electron");
const fs = require("fs");
const path = require("path");

function applySwitches() {
  let unlimited_fps = false;
  let in_process_gpu = false;
  try {
    const configPath = path.join(app.getPath("userData"), "config.json");
    if (fs.existsSync(configPath)) {
      const stored = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (stored && stored.settings) {
        unlimited_fps = !!stored.settings.unlimited_fps;
        in_process_gpu = !!stored.settings.in_process_gpu;
      }
    }
  } catch (e) {}

  if (unlimited_fps) {
    app.commandLine.appendSwitch("disable-frame-rate-limit");
    app.commandLine.appendSwitch("disable-gpu-vsync");
  }

  app.commandLine.appendSwitch("high-dpi-support", "1");
  app.commandLine.appendSwitch("ignore-gpu-blacklist");
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("enable-zero-copy");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("enable-native-gpu-memory-buffers");
  app.commandLine.appendSwitch("force-gpu-mem-available-mb", "4096");
  app.commandLine.appendSwitch("enable-webgl-image-chromium");
  app.commandLine.appendSwitch("force-color-profile", "srgb");
  app.commandLine.appendSwitch("canvas-msaa-sample-count", "0");
  app.commandLine.appendSwitch("disable-2d-canvas-clip-aa");

  if (in_process_gpu) {
    app.commandLine.appendSwitch("in-process-gpu");
  }

  app.commandLine.appendSwitch("js-flags", "--expose-gc");
  app.commandLine.appendSwitch("disable-features",
    "CalculateNativeWinOcclusion," +
    "VizDisplayCompositor," +
    "EnableVizPollForCompletion");

  app.allowRendererProcessReuse = true;
}

module.exports = {
  applySwitches,
};
