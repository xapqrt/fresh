const { app } = require("electron");

function applySwitches(settings) {
  const fpsCap = settings.fps_cap ?? 0;
  if (fpsCap > 0) {
    app.commandLine.appendSwitch("frame-rate-limit", String(fpsCap));
  } else {
    app.commandLine.appendSwitch("disable-frame-rate-limit");
    app.commandLine.appendSwitch("disable-gpu-vsync");
  }

  // ANGLE Metal backend — native arm64 draw calls
  app.commandLine.appendSwitch("use-angle", "metal");

  // Force GPU rendering everywhere
  app.commandLine.appendSwitch("ignore-gpu-blacklist");
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("force-gpu-rasterization");
  // enable-oop-rasterization intentionally omitted — IPC overhead on unified memory
  app.commandLine.appendSwitch("enable-accelerated-2d-canvas");
  app.commandLine.appendSwitch("num-raster-threads", "4");
  app.commandLine.appendSwitch("enable-native-gpu-memory-buffers");
  app.commandLine.appendSwitch("enable-webgl-draft-extensions");

  app.commandLine.appendSwitch("enable-webgl");
  // Remove throttling
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-background-timer-throttling");

  // Remove safety overhead
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-gpu-driver-bug-workarounds");
  app.commandLine.appendSwitch("disable-breakpad");
  app.commandLine.appendSwitch("disable-crash-reporter");

  // V8 — small semi-space for quick young-gen GC, concurrent marking + sweeping
  // max-semi-space-size=128: smaller young gen = faster GC pauses (less frame drop)
  // max-old-space-size=4096: generous old gen for game heap
  app.commandLine.appendSwitch("js-flags", "--expose-gc --max-semi-space-size=128 --max-old-space-size=4096 --concurrent_marking --concurrent_sweeping --optimize_for_size");

  // Kill all non-essential browser features
  app.commandLine.appendSwitch("disable-logging");
  app.commandLine.appendSwitch("disable-smooth-scrolling");
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  app.commandLine.appendSwitch("disable-features", "Autofill,TranslateUI,MediaRouter,PasswordManager,SignInPromo,ChromeWhatsNewUI,NetworkTimeService");

  // Remove IPC overhead
  app.commandLine.appendSwitch("disable-ipc-flooding-protection");

  app.allowRendererProcessReuse = true;
}

module.exports = {
  applySwitches,
};
