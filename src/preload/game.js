const { installBhopHook } = require("./game/bhop");
require("../addons/Custom Skin Link.js");

const weaponHook = require('../webgl/weapon-hook');

const fs = require('fs');
const path = require('path');
const { navCacheGet, navCacheSet } = require('../util/nav-cache');

const _cssStyleId = "dawn-custom-css";
const _advancedStyleId = "dawn-advanced-css";
const _cssCache = new Map();

let _menuEl = null;
let _menuCssInjected = false;

let _settings = null;
try { _settings = require('electron').ipcRenderer.sendSync('get-settings'); } catch (e) {}
let _localSettings = _settings ? { ..._settings } : null;
try {
  require('electron').ipcRenderer.on('settings-updated', (_event, s) => {
    _localSettings = s;
  });
} catch (e) {}

const createWeaponConfig = (s) => ({
  colorEnabled: s.weapon_color ?? false,
  rgb: s.weapon_rgb ?? false,
  wireframe: s.weapon_wireframe ?? false,
  universal: s.universal_settings ?? false,
  colorHex: s.weapon_color_hex || '#FFFFFF',
  getSettings: () => ({
    size: s.weapon_size ?? 1,
    offsetX: s.weapon_offset_x ?? 0,
    offsetY: s.weapon_offset_y ?? 0,
    offsetZ: s.weapon_offset_z ?? 0,
  }),
  getArmSettings: (wid, side) => ({
    size: s.arm_size ?? 1,
    offsetX: s.arm_offset_x ?? 0,
    offsetY: s.arm_offset_y ?? 0,
    offsetZ: s.arm_offset_z ?? 0,
    wireframe: (s.universal_arm_settings ? s.weapon_wireframe : s.arm_wireframe) ?? false,
    colorEnabled: (s.universal_arm_settings ? s.weapon_color : s.arm_color) ?? false,
    colorHex: (s.universal_arm_settings ? s.weapon_color_hex : s.arm_color_hex) || '#FFFFFF',
    rgb: (s.universal_arm_settings ? s.weapon_rgb : s.arm_rgb) ?? false,
  }),
});

function updateWeaponConfig(s) {
  weaponHook.setWeaponConfig(createWeaponConfig(s), {}, {});
}

if (_settings) {
  updateWeaponConfig(_settings);
}

function injectMenu() {
  if (_menuEl) return;
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => injectMenu(), { once: true });
    return;
  }
  try {
    const menuPath = path.join(__dirname, '../assets/html/menu.html');
    let html = navCacheGet(menuPath);
    if (html === undefined) {
      html = fs.readFileSync(menuPath, 'utf-8');
      navCacheSet(menuPath, html);
    }
    _menuEl = document.createElement('div');
    _menuEl.id = 'dawn-menu-container';
    _menuEl.innerHTML = html;
    _menuEl.style.display = 'none';
    _menuEl.style.willChange = 'transform';
    document.body.appendChild(_menuEl);

    if (!_menuCssInjected) {
      const cssPath = path.join(__dirname, '../assets/css/menu.css');
      let css = navCacheGet(cssPath);
      if (css === undefined) {
        css = fs.readFileSync(cssPath, 'utf-8');
        navCacheSet(cssPath, css);
      }
      const style = document.createElement('style');
      style.id = 'dawn-menu-css';
      style.textContent = css;
      document.head.appendChild(style);
      _menuCssInjected = true;
    }

    const menuEl = _menuEl.querySelector('.menu');
    if (menuEl && !menuEl.hasAttribute('data-active')) {
      menuEl.setAttribute('data-active', 'false');
    }
    applyPerfMode();

    _menuEl.addEventListener('change', (e) => {
      const el = e.target.closest('[data-setting]');
      if (!el) return;
      const key = el.dataset.setting;
      const val = el.type === 'checkbox' ? el.checked : el.value;
      try {
        require('electron').ipcRenderer.send('update-setting', key, val);
        if (_localSettings) _localSettings[key] = val;
        document.dispatchEvent(new CustomEvent('juice-settings-changed', {
          detail: { setting: key, value: val }
        }));
      } catch (e) {}
    });
  } catch (e) {
    console.warn('[Dawn] Menu injection failed:', e.message);
  }
}

function loadSettingsIntoMenu() {
  if (!_menuEl) return;
  const s = _localSettings;
  if (!s) return;
  try {
    _menuEl.querySelectorAll('[data-setting]').forEach(el => {
      const key = el.dataset.setting;
      const val = s[key];
      if (val === undefined) return;
      if (el.type === 'checkbox') {
        el.checked = Boolean(val);
      } else if (el.type === 'color') {
        el.value = val || '#FFFFFF';
      } else {
        el.value = val;
      }
    });
  } catch (e) {}
}

// performance_mode: strip menu transitions/animations/blur for lower overhead.
function applyPerfMode() {
  if (!_menuEl) return;
  const menuEl = _menuEl.querySelector('.menu');
  if (!menuEl) return;
  const perf = _localSettings ? _localSettings.performance_mode !== false : true;
  menuEl.classList.toggle('perf-mode', perf);
}

function setMenuOpen(open) {
  injectMenu();
  if (!_menuEl) return;
  const menuEl = _menuEl.querySelector('.menu');
  if (!menuEl) return;
  menuEl.setAttribute('data-active', open ? 'true' : 'false');
  _menuEl.style.display = open ? '' : 'none';
  if (open) {
    loadSettingsIntoMenu();
    // Kirka holds the Pointer Lock while in-game, which locks the cursor and
    // swallows mouse events — making the injected menu stuck & unresponsive.
    // Release it so the menu can be clicked/dragged; it re-locks on click.
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
  }
  applyPerfMode();
}

function toggleMenu() {
  injectMenu();
  const menuEl = _menuEl?.querySelector('.menu');
  const open = menuEl?.getAttribute('data-active') === 'true';
  setMenuOpen(!open);
}

try { require('electron').ipcRenderer.on('toggle-menu', toggleMenu); } catch (e) {}

async function loadCustomCSS() {
  const settings = _localSettings;
  if (!settings) return;

  try {
    const injectStyle = (id, text) => {
      let el = document.getElementById(id);
      if (el) el.remove();
      if (text) {
        el = document.createElement('style');
        el.id = id;
        el.textContent = text;
        document.head.appendChild(el);
      }
    };

    if (settings.css_enabled && settings.css_link) {
      const cached = _cssCache.get(settings.css_link);
      if (cached) {
        injectStyle(_cssStyleId, cached);
      } else {
        try {
          const res = await fetch(settings.css_link);
          if (res.ok) {
            const text = await res.text();
            _cssCache.set(settings.css_link, text);
            injectStyle(_cssStyleId, text);
          }
        } catch (e) {
          console.warn('[Dawn] Failed to load custom CSS:', e.message);
        }
      }
    } else {
      injectStyle(_cssStyleId, null);
    }

    injectStyle(_advancedStyleId, settings.advanced_css || null);
  } catch (e) {
    console.warn('[Dawn] CSS load error:', e.message);
  }
}

document.addEventListener("juice-settings-changed", (e) => {
  const setting = e.detail.setting;
  if (["css_link", "css_enabled", "advanced_css"].includes(setting)) {
    loadCustomCSS();
  }
  if (setting === "performance_mode") applyPerfMode();
  if (_localSettings) updateWeaponConfig(_localSettings);
});

let _frameTimeOverlay = null;
let _frameTimeActive = false;
let _ftHistory = [];
let _ftRAF = null;

function toggleFrameTimeLogger() {
  _frameTimeActive = !_frameTimeActive;
  if (!_frameTimeActive) {
    if (_ftRAF) { cancelAnimationFrame(_ftRAF); _ftRAF = null; }
    if (_frameTimeOverlay) { _frameTimeOverlay.remove(); _frameTimeOverlay = null; }
    return;
  }

  if (!_frameTimeOverlay) {
    _frameTimeOverlay = document.createElement('div');
    _frameTimeOverlay.id = 'dawn-ft-logger';
    Object.assign(_frameTimeOverlay.style, {
      position: 'fixed', top: '8px', right: '8px',
      background: 'rgba(0,0,0,0.75)', color: '#0f0',
      fontFamily: 'monospace', fontSize: '12px',
      padding: '8px 12px', borderRadius: '4px',
      zIndex: '2147483646', pointerEvents: 'none',
      whiteSpace: 'pre',
    });
    document.body.appendChild(_frameTimeOverlay);
  }

  _ftHistory = [];
  let lastT = performance.now();

  function _sample(t) {
    const dt = t - lastT;
    lastT = t;
    _ftHistory.push(dt);
    if (_ftHistory.length > 120) _ftHistory.shift();

    const len = _ftHistory.length;
    if (len > 1) {
      let min = Infinity, max = -Infinity, sum = 0;
      for (let i = 0; i < len; i++) {
        const v = _ftHistory[i];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      const avg = sum / len;
      const fps = 1000 / avg;
      _frameTimeOverlay.textContent =
        `FT min ${min.toFixed(2)}ms  max ${max.toFixed(2)}ms  avg ${avg.toFixed(2)}ms\nFPS ${fps.toFixed(0)}  samples ${len}`;
    }
    if (_frameTimeActive) _ftRAF = requestAnimationFrame(_sample);
  }
  _ftRAF = requestAnimationFrame(_sample);
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'F9') { e.preventDefault(); toggleFrameTimeLogger(); }
});

window.dumpCookies = async () => {
  try {
    const data = await require('electron').ipcRenderer.invoke('dump-cookies');
    console.table(data);
    return data;
  } catch (e) { console.warn('dumpCookies failed:', e); }
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    installBhopHook(() => _localSettings);
    loadCustomCSS();
    weaponHook.hookWebGL();
  });
} else {
  installBhopHook(() => _localSettings);
  loadCustomCSS();
  weaponHook.hookWebGL();
}

// The game injects its own stylesheet during bootstrap (after DOMContentLoaded),
// so CSS applied at DOMContentLoaded loses the cascade. Re-apply after full
// load and a few delayed passes — injectStyle re-inserts the <style> at the end
// of <head>, which wins on equal specificity. Idempotent and cheap (the remote
// link is cached in _cssCache after the first fetch).
window.addEventListener("load", loadCustomCSS);
setTimeout(loadCustomCSS, 2000);
setTimeout(loadCustomCSS, 5000);
