const { installBhopHook } = require("./game/bhop");
require("../addons/Custom Skin Link.js");

const weaponHook = require('../webgl/weapon-hook');
const observerRouter = require('../dom/observer-router');

const _cssStyleId = "dawn-custom-css";
const _advancedStyleId = "dawn-advanced-css";
const _cssCache = new Map();

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
  if (["css_link", "css_enabled", "advanced_css"].includes(e.detail.setting)) {
    loadCustomCSS();
  }
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
