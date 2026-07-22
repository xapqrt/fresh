const { ipcRenderer } = require("electron");
const os = require("os");

// Polyfill Array/String.prototype.at — Chromium 89 (Electron 12) lacks it,
// but kirka.io's bundle uses it heavily (e.g. t.entries.at(...)). Without this
// the login/session code throws "x.at is not a function" and the page is dead.
if (typeof Array.prototype.at !== "function") {
  Object.defineProperty(Array.prototype, "at", {
    value: function (i) {
      const len = this.length >>> 0;
      const idx = i >= 0 ? i : len + i;
      return idx >= 0 && idx < len ? this[idx] : undefined;
    },
    writable: true,
    configurable: true,
  });
}
if (typeof String.prototype.at !== "function") {
  Object.defineProperty(String.prototype, "at", {
    value: function (i) {
      const len = this.length >>> 0;
      const idx = i >= 0 ? i : len + i;
      return idx >= 0 && idx < len ? this[idx] : undefined;
    },
    writable: true,
    configurable: true,
  });
}

try { os.setPriority(process.pid, -10); } catch (e) {}

// Force raw, unadjusted mouse movement (bypassing OS mouse acceleration) when pointer lock is requested
if (typeof Element.prototype.requestPointerLock === "function") {
  const _origReqPL = Element.prototype.requestPointerLock;
  Element.prototype.requestPointerLock = function (options) {
    try {
      const res = _origReqPL.call(this, Object.assign({}, options, { unadjustedMovement: true }));
      if (res && typeof res.catch === "function") {
        return res.catch(() => _origReqPL.call(this, options));
      }
      return res;
    } catch (e) {
      return _origReqPL.call(this, options);
    }
  };
}

let settings = ipcRenderer.sendSync("get-settings");
const base_url = settings.base_url;

// Only fully initialize on kirka pages — but do NOT return/delete require here
// because the preload fires before navigation completes; window.location may still
// be about:blank. Instead, we guard hook installation inside DOMContentLoaded.
const _isKirkaPage = () => window.location.href.startsWith(base_url);

const { installBhopHook } = require("./game/bhop");
const { installRecorder } = require("./game/recorder");
const Menu = require("./menu");

installBhopHook();
installRecorder();
require("../addons/Custom Skin Link");

const installFpsOverlay = () => {
  let enabled = false;
  let rafId = null;
  let lastTime = performance.now();
  const RING = 60;
  const ring = new Float64Array(RING);
  let idx = 0;
  let filled = 0;
  let sum = 0;

  const el = document.createElement("div");
  el.id = "df-fps-overlay";
  el.style.cssText = "position:fixed;top:8px;right:8px;z-index:99999;font:bold 12px/1.3 monospace;color:#0f0;background:rgba(0,0,0,0.75);padding:4px 7px;border-radius:4px;pointer-events:none;display:none;white-space:pre;user-select:none;";
  const textEl = document.createElement("div");
  el.appendChild(textEl);
  const cvs = document.createElement("canvas");
  cvs.width = 120; cvs.height = 28;
  cvs.style.cssText = "display:block;margin-top:3px;width:120px;height:28px;";
  el.appendChild(cvs);
  const cx = cvs.getContext("2d");

  const toggle = () => {
    enabled = !enabled;
    el.style.display = enabled ? "" : "none";
    if (enabled) {
      lastTime = performance.now(); idx = 0; filled = 0; sum = 0;
      rafId = requestAnimationFrame(tick);
    } else if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  };

  const tick = (now) => {
    const delta = now - lastTime;
    lastTime = now;
    if (filled === RING) sum -= ring[idx];
    ring[idx] = delta;
    sum += delta;
    idx = (idx + 1) % RING;
    if (filled < RING) filled++;
    const avg = sum / filled;
    textEl.textContent = `${(1000/avg).toFixed(1)} FPS  ${avg.toFixed(2)} ms`;

    cx.clearRect(0, 0, 120, 28);
    const bw = 120 / filled;
    let min = ring[0], max = ring[0];
    for (let i = 0; i < filled; i++) {
      const v = ring[i]; if (v < min) min = v; if (v > max) max = v;
    }
    const range = Math.max(max - min, 1);
    for (let i = 0; i < filled; i++) {
      const h = ((ring[i] - min) / range) * 24;
      cx.fillStyle = ring[i] > avg * 1.5 ? "#f55" : "#0f0";
      cx.fillRect(bw * i, 28 - h - 2, Math.max(bw - 0.5, 1), h);
    }
    rafId = requestAnimationFrame(tick);
  };

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f" && e.isTrusted) {
      e.preventDefault(); e.stopPropagation(); toggle();
    }
  }, true);

  const ready = () => {
    if (document.body) { document.body.appendChild(el); return; }
    requestAnimationFrame(ready);
  };
  ready();
};
installFpsOverlay();

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

const _isMatch = (url) => {
  try { const p = new URL(url).pathname; return p.startsWith('/games') || p.startsWith('/hub/ranked'); }
  catch (e) { return false; };
};

window.__inMatch = _isMatch(window.location.href);
setInterval(() => { if (window.__inMatch === false && typeof global.gc === 'function') global.gc(true); }, 30000);
setInterval(() => { ipcRenderer.send('heartbeat'); }, 2000);

window.addEventListener("DOMContentLoaded", () => {
  // Instantiate Menu here — document.body now exists so all querySelector calls work
  if (_isKirkaPage()) {
    try { window.__dawnMenu = new Menu(); } catch (e) { console.error("[Dawn] Menu init error:", e); }
  }
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
    window.__inMatch = _isMatch(url);

    if (window.__inMatch) {
      setAdsPower(settings.ads_power);
    }

    _previousUrl = url;
  });

  const handleInitialLoad = () => {
    const url = window.location.href;
    window.__inMatch = _isMatch(url);
    if (window.__inMatch) {
      setAdsPower(settings.ads_power);
    } else {
      schedulePrewarmHotPaths();
    }
    _previousUrl = url;
  };

  handleInitialLoad();
});


