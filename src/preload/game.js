const { installBhopHook } = require("./game/bhop");
require("../addons/Custom Skin Link.js");

const weaponHook = require('../webgl/weapon-hook');
const observerRouter = require('../dom/observer-router');

const fs = require('fs');
const path = require('path');

const _cssStyleId = "dawn-custom-css";
const _advancedStyleId = "dawn-advanced-css";
const _cssCache = new Map();

let _menuEl = null;
let _menuCssInjected = false;

let _settings = null;
try { _settings = require('electron').ipcRenderer.sendSync('get-settings'); } catch (e) {}

const _menuKeybind = _settings?.menu_keybind || 'ShiftRight';

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
  try {
    const html = fs.readFileSync(path.join(__dirname, '../assets/html/menu.html'), 'utf-8');
    _menuEl = document.createElement('div');
    _menuEl.id = 'dawn-menu-container';
    _menuEl.innerHTML = html;
    _menuEl.style.display = 'none';
    document.body.appendChild(_menuEl);

    if (!_menuCssInjected) {
      const css = fs.readFileSync(path.join(__dirname, '../assets/css/menu.css'), 'utf-8');
      const style = document.createElement('style');
      style.id = 'dawn-menu-css';
      style.textContent = css;
      document.head.appendChild(style);
      _menuCssInjected = true;
    }
  } catch (e) {
    console.warn('[Dawn] Menu injection failed:', e.message);
  }
}

function toggleMenu() {
  injectMenu();
  if (!_menuEl) return;
  const shown = _menuEl.style.display !== 'none';
  _menuEl.style.display = shown ? 'none' : '';
}

window.addEventListener("keydown", (e) => {
  if (e.code === _menuKeybind) {
    e.stopImmediatePropagation();
    toggleMenu();
  }
}, true);

try { require('electron').ipcRenderer.on('toggle-menu', toggleMenu); } catch (e) {}

async function loadCustomCSS() {
  try {
    const _ipcCSS = require('electron').ipcRenderer;
    const settings = _ipcCSS.sendSync('get-settings');
    if (!settings) return;

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
  try {
    const s = require('electron').ipcRenderer.sendSync('get-settings');
    updateWeaponConfig(s);
  } catch (e) {}
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    installBhopHook();
    loadCustomCSS();
    weaponHook.hookWebGL();
    observerRouter.start();
  });
} else {
  installBhopHook();
  loadCustomCSS();
  weaponHook.hookWebGL();
  observerRouter.start();
}
