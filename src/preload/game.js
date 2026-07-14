const { ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");

require("../addons/Custom Skin Link");

const scriptsPath = ipcRenderer.sendSync("get-scripts-path");
const scripts = fs.readdirSync(scriptsPath);

let settings = ipcRenderer.sendSync("get-settings");
const base_url = settings.base_url;

document.addEventListener("juice-settings-changed", ({ detail }) => {
  if (detail && detail.setting !== undefined) settings[detail.setting] = detail.value;
});

if (!window.location.href.startsWith(base_url)) {
  delete window.process;
  delete window.require;
  return;
} else {
  scripts.forEach((script) => {
    if (!script.endsWith(".js")) return;
    const scriptPath = path.join(scriptsPath, script);
    try {
      require(scriptPath);
    } catch (error) {
      console.error(`Error loading script ${script}:`, error);
    }
  });
}

const runGC = () => { if (typeof gc === "function") gc(); };
let _gcTimer = null;
let _previousUrl;

const { installBhopHook } = require('./game/bhop');
const { installRapidFire } = require('./game/rapidfire');

installBhopHook();
installRapidFire(settings);

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  trace: console.trace.bind(console),
};

window.addEventListener("DOMContentLoaded", async () => {
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.info = originalConsole.info;
  console.trace = originalConsole.trace;

  const s1 = document.createElement("style"); s1.id = "juice-styles-theme"; document.head.appendChild(s1);
  const s2 = document.createElement("style"); s2.id = "juice-styles-custom"; document.head.appendChild(s2);
  window.updateTheme = () => {
    const link = settings.css_link;
    s1.innerHTML = (link && settings.css_enabled) ? `@import url("${link.replace(/\\/g, "/")}");` : "";
    s2.innerHTML = settings.advanced_css || "";
  };
  window.updateTheme();

  function findCamera(instance) {
    for (const key of Object.getOwnPropertyNames(instance)) {
      try {
        const val = instance[key];
        if (!val || typeof val !== "object") continue;
        const names = Object.getOwnPropertyNames(val);
        const hasFov = names.some(k => {
          const desc = Object.getOwnPropertyDescriptor(val, k);
          if (!desc?.get) return false;
          try {
            const v = desc.get.call(val);
            return typeof v === "number" && v >= 40 && v <= 150;
          } catch (e) { return false; }
        });
        const hasZoom = names.includes("zoom");
        if (hasFov && hasZoom) return val;
      } catch (e) { }
    }
    return null;
  }

  window.ads_power = 1;
  const setAdsPower = (multiplier) => {
    window.ads_power = multiplier;

    const interval = setInterval(() => {
      if (!window.__zoomInstance) return;
      const cam = findCamera(window.__zoomInstance);
      if (!cam) return;
      clearInterval(interval);

      const fovKey = Object.getOwnPropertyNames(cam).find(key => {
        const desc = Object.getOwnPropertyDescriptor(cam, key);
        if (!desc?.get) return false;
        try {
          const val = desc.get.call(cam);
          return typeof val === "number" && val >= 40 && val <= 150;
        } catch (e) { return false; }
      });

      if (!fovKey) return;

      const desc = Object.getOwnPropertyDescriptor(cam, fovKey);
      const origGet = desc.get;
      const origSet = desc.set;

      const defaultFov = parseFloat(localStorage.getItem("SETTINGS___SETTING/CAMERA___SETTING/MAIN_FOV___SETTING")?.replace(/"/g, "")) || 100;

      let ads = false;

      Object.defineProperty(cam, fovKey, {
        get() { return origGet.call(this); },
        set(v) {
          if (v === defaultFov) {
            ads = false;
            origSet.call(this, v);
            return;
          }

          if (v < defaultFov) {
            ads = true;
          }

          if (ads) {
            const weaponConfig = window.dawnWeaponConfig;
            let adsPower = window.ads_power;

            if (weaponConfig) {
              const weaponId = weaponConfig.universalModeActive ? "universal" : (window.currentWeaponId || "vita");
              const cfg = weaponConfig.getSettings(weaponId);
              adsPower = cfg.adsPower ?? window.ads_power;
            }

            const zoomDelta = Math.abs(defaultFov - v);
            const curved = Math.pow(adsPower, 0.4);
            const newFov = defaultFov - zoomDelta * curved;
            origSet.call(this, Math.max(1, Math.min(179, newFov)));
          } else {
            origSet.call(this, v);
          }
        },
        configurable: true,
        enumerable: true
      });
    }, 100);
  };

  document.addEventListener("juice-settings-changed", ({ detail }) => {
    const { setting, value } = detail;
    if (setting === "ads_power") {
      settings.ads_power = value;
      setAdsPower(value);
    } else if (setting === "css_link" || setting === "css_enabled" || setting === "advanced_css") {
      settings[setting] = value;
      if (window.updateTheme) window.updateTheme();
    } else if (setting !== undefined) {
      settings[setting] = value;
    }
  });

  ipcRenderer.on("url-change", (_, url) => {
    window._currentUrl = url;

    if (url.startsWith(`${base_url}games`) || url.startsWith(`${base_url}hub/ranked`)) {
      setAdsPower(settings.ads_power);
    }

    const inGame = url.startsWith(`${base_url}games`) || url.startsWith(`${base_url}hub/ranked`);
    const wasInGame = _previousUrl && (_previousUrl.startsWith(`${base_url}games`) || _previousUrl.startsWith(`${base_url}hub/ranked`));

    if (inGame && !_gcTimer) {
      runGC();
      _gcTimer = setInterval(runGC, 15000);
    } else if (!inGame && _gcTimer) {
      clearInterval(_gcTimer);
      _gcTimer = null;
      runGC();
    }
    _previousUrl = url;
  });

  const handleInitialLoad = () => {
    const url = window.location.href;
    if (url.startsWith(`${base_url}games`) || url.startsWith(`${base_url}hub/ranked`)) {
      setAdsPower(settings.ads_power);
    }
    _previousUrl = url;
  };

  handleInitialLoad();
});
