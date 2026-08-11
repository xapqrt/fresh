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

  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

  app.commandLine.appendSwitch("enable-features",
    "ParallelDownloading,CanvasOopRasterization");
  app.commandLine.appendSwitch("disable-features",
    "CalculateNativeWinOcclusion,PaintHolding,IntensiveWakeUpThrottling,BackForwardCache,Translate,MediaRouter,TrackingPrevention,ThirdPartyStoragePartitioning,Tpcd,TpcdMitigations");

  app.commandLine.appendSwitch("disable-blink-features",
    "ThirdPartyStoragePartitioning,TrustedTypes");

  app.commandLine.appendSwitch("v8-cache-options", "code");
  app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096 --max-semi-space-size=128 --sparkplug --turbo-fast-api-calls --expose-gc");

  app.commandLine.appendSwitch("audio-output-sample-rate", "48000");
  app.commandLine.appendSwitch("audio-buffer-size", "512");
}

module.exports = { applySwitches };
