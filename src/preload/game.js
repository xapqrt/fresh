const { ipcRenderer } = require("electron");
const os = require("os");

try { os.setPriority(process.pid, -10); } catch (e) {}

let settings = ipcRenderer.sendSync("get-settings");
const base_url = settings.base_url;

if (!window.location.href.startsWith(base_url)) {
  delete window.process;
  delete window.require;
  return;
}

const { installBhopHook } = require("./game/bhop");
installBhopHook();
require("../addons/Custom Skin Link");

// Pre-warm V8 hot paths during lobby so Rosetta JIT translation cost is paid before the match
const prewarmHotPaths = () => {
  try {
    const wasm = require("../wasm/dawn_wasm");
    const buf = wasm.getScratchBuf();
    for (let i = 0; i < 600; i++) {
      for (let j = 0; j < 16; j++) buf[j] = i * 0.001 + j;
      wasm.fastHash(0);
      wasm.parseSig(0);
    }
  } catch (e) { /* WASM prewarm non-critical */ }
  for (let i = 0; i < 900; i++) Math.pow(i / 900 * 2 + 0.5, 0.4);
};

const schedulePrewarmHotPaths = () => {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => prewarmHotPaths(), { timeout: 1500 });
    return;
  }

  setTimeout(prewarmHotPaths, 750);
};

let _previousUrl;

// GC management — run full GC in lobby/menus to prevent mid-game pauses
let _gcTimer = null;
const _gc = typeof gc === 'function' ? () => { try { gc(true); } catch (e) {} } : () => {};
const _isMatch = (url) => {
  try { const p = new URL(url).pathname; return p.startsWith('/games') || p.startsWith('/hub/ranked'); }
  catch (e) { return false; }
};
const _startGc = () => {
  if (_gcTimer !== null) return;
  _gc();
  _gcTimer = setInterval(_gc, 60000);
};
const _stopGc = () => {
  if (_gcTimer !== null) { clearInterval(_gcTimer); _gcTimer = null; }
};

window.addEventListener("DOMContentLoaded", () => {
  const s1 = document.createElement("style"); s1.id = "juice-styles-theme"; document.head.appendChild(s1);
  const s2 = document.createElement("style"); s2.id = "juice-styles-custom"; document.head.appendChild(s2);
  window.updateTheme = () => {
    const link = settings.css_link;
    s1.textContent = (link && settings.css_enabled) ? `@import url("${link.replace(/\\/g, "/")}");` : "";
    s2.textContent = settings.advanced_css || "";
  };
  window.updateTheme();

  let _cachedCamera = null;

  function findCamera(instance) {
    if (_cachedCamera) return _cachedCamera;
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
        if (hasFov && hasZoom) { _cachedCamera = val; return val; }
      } catch (e) { }
    }
    return null;
  }

  window.ads_power = 1;
  let _cachedPow = 1;
  let _cachedPowInput = 1;

  let _zoomInstanceResolve = null;
  const _zoomInstanceReady = new Promise((resolve) => { _zoomInstanceResolve = resolve; });
  let _zoomInstanceValue = window.__zoomInstance;
  if (_zoomInstanceValue) _zoomInstanceResolve(_zoomInstanceValue);
  Object.defineProperty(window, '__zoomInstance', {
    get() { return _zoomInstanceValue; },
    set(v) {
      _zoomInstanceValue = v;
      if (v && _zoomInstanceResolve) { _zoomInstanceResolve(v); _zoomInstanceResolve = null; }
    },
    configurable: true,
    enumerable: true
  });

  const _hookCameraFov = (cam) => {
    const fovKey = Object.getOwnPropertyNames(cam).find(key => {
      const desc = Object.getOwnPropertyDescriptor(cam, key);
      if (!desc?.get) return false;
      try {
        const val = desc.get.call(cam);
        return typeof val === "number" && val >= 40 && val <= 150;
      } catch (e) { return false; }
    });
    if (!fovKey) return false;

    const desc = Object.getOwnPropertyDescriptor(cam, fovKey);
    const origGet = desc.get;
    const origSet = desc.set;

    const defaultFov = parseFloat(localStorage.getItem("SETTINGS___SETTING/CAMERA___SETTING/MAIN_FOV___SETTING")?.replace(/"/g, "")) || 100;
    let ads = false;

    Object.defineProperty(cam, fovKey, {
      get() { return origGet.call(this); },
      set(v) {
        if (v === defaultFov) { ads = false; origSet.call(this, v); return; }
        if (v < defaultFov) ads = true;
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
          origSet.call(this, Math.max(1, Math.min(179, defaultFov - zoomDelta * curved)));
        } else {
          origSet.call(this, v);
        }
      },
      configurable: true,
      enumerable: true
    });
    return true;
  };

  const setAdsPower = async (multiplier) => {
    window.ads_power = multiplier;
    _cachedPow = Math.pow(multiplier, 0.4);
    _cachedPowInput = multiplier;

    const instance = await _zoomInstanceReady;
    const cam = findCamera(instance);
    if (cam) _hookCameraFov(cam);
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

    if (_isMatch(url)) {
      setAdsPower(settings.ads_power);
      _stopGc();
    } else if (_previousUrl && _isMatch(_previousUrl)) {
      _startGc();
    }

    _previousUrl = url;
  });

  const handleInitialLoad = () => {
    const url = window.location.href;
    if (_isMatch(url)) {
      setAdsPower(settings.ads_power);
    } else {
      _startGc();
      schedulePrewarmHotPaths();
    }
    _previousUrl = url;
  };

  handleInitialLoad();
});
