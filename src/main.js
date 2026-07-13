const { app, protocol } = require("electron");
const { initSplash } = require("./windows/splash");
const dns = require("dns");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { applySwitches } = require("./util/switches");
const { default_settings } = require("./util/defaults.json");

// Boost process priority to reduce input/render latency
try { execSync(`renice -20 ${process.pid} 2>/dev/null`); } catch (e) {}
try { os.setPriority(process.pid, -20); } catch (e) {}
if (process.platform === "darwin") {
  try { execSync(`taskpolicy -N -p ${process.pid} 2>/dev/null || true`); } catch (e) {}
}

// Read settings early so we can apply command-line switches BEFORE app.ready
let settings = default_settings;
try {
  const userDataPath = app.getPath("userData");
  const configPath = path.join(userDataPath, "config.json");
  if (fs.existsSync(configPath)) {
    const stored = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (stored && stored.settings) {
      settings = { ...default_settings, ...stored.settings };
    }
  }
} catch (e) {
  // Fall back to defaults
}

// Apply switches BEFORE app.ready (appendSwitch is a no-op after ready)
applySwitches(settings);

// Register privileged schemes BEFORE app.ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'https', privileges: { bypassCSP: true, secure: true, supportFetchAPI: true } },
  { scheme: 'dawn-patch', privileges: { bypassCSP: true, secure: true, supportFetchAPI: true } }
]);

// Pre-resolve game/CDN domains to cut DNS latency
const preResolve = [
  "kirka.io", "snipers.io", "ask101math.com", "fpsiogame.com",
  "cloudconverts.com", "discord.com", "cdn.discordapp.com",
  "cdn.kirka.io", "fonts.googleapis.com",
];
for (const d of preResolve) {
  dns.resolve(d, () => {});
  dns.resolve4(d, () => {});
  dns.resolve6(d, () => {});
}

app.on("ready", async () => {
  initSplash();
});

app.on("window-all-closed", () => app.quit());
