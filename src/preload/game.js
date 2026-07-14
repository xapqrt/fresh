const { ipcRenderer } = require("electron");

require("../addons/Custom Skin Link");
const { installBhopHook } = require("./game/bhop");
installBhopHook();

let settings = ipcRenderer.sendSync("get-settings");
const base_url = settings.base_url;

document.addEventListener("juice-settings-changed", ({ detail }) => {
  if (detail && detail.setting !== undefined) settings[detail.setting] = detail.value;
});

if (!window.location.href.startsWith(base_url)) {
  delete window.process;
  delete window.require;
  return;
}

const runGC = () => { if (typeof gc === "function") gc(); };
let _previousUrl;

window.addEventListener("DOMContentLoaded", () => {
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
  let _cachedPow = 1;
  let _cachedPowInput = 1;
  let _zoomInterval = null;

  const setAdsPower = (multiplier) => {
    window.ads_power = multiplier;
    _cachedPow = Math.pow(multiplier, 0.4);
    _cachedPowInput = multiplier;

    if (_zoomInterval !== null) {
      clearInterval(_zoomInterval);
      _zoomInterval = null;
    }

    _zoomInterval = setInterval(() => {
      if (!window.__zoomInstance) return;
      const cam = findCamera(window.__zoomInstance);
      if (!cam) return;
      clearInterval(_zoomInterval);
      _zoomInterval = null;

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
            let adsPower = _cachedPowInput;

            if (weaponConfig) {
              const weaponId = weaponConfig.universalModeActive ? "universal" : (window.currentWeaponId || "vita");
              const cfg = weaponConfig.getSettings(weaponId);
              adsPower = cfg.adsPower ?? _cachedPowInput;
            }

            const curved = adsPower === _cachedPowInput ? _cachedPow : Math.pow(adsPower, 0.4);
            const zoomDelta = Math.abs(defaultFov - v);
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

    if (inGame && !wasInGame) {
      runGC();
    } else if (!inGame && wasInGame) {
      runGC();
    }
    _previousUrl = url;
  });

  const handleInitialLoad = () => {
    const url = window.location.href;
    if (url.startsWith(`${base_url}games`) || url.startsWith(`${base_url}hub/ranked`)) {
      setAdsPower(settings.ads_power);
      runGC();
    }
    _previousUrl = url;
  };

  handleInitialLoad();
});
