const { installBhopHook } = require("./game/bhop");
require("../addons/Custom Skin Link.js");

const weaponHook = require('../webgl/weapon-hook');
const observerRouter = require('../dom/observer-router');

const _cssStyleId = "dawn-custom-css";
const _advancedStyleId = "dawn-advanced-css";

async function loadCustomCSS() {
  try {
    const _ipcCSS = require('electron').ipcRenderer;
    const settings = _ipcCSS.sendSync('get-settings');
    if (!settings) return;

    if (settings.css_enabled && settings.css_link) {
      let existing = document.getElementById(_cssStyleId);
      if (existing) existing.remove();

      try {
        const res = await fetch(settings.css_link);
        if (res.ok) {
          const text = await res.text();
          const style = document.createElement('style');
          style.id = _cssStyleId;
          style.textContent = text;
          document.head.appendChild(style);
        }
      } catch (e) {
        console.warn('[Dawn] Failed to load custom CSS:', e.message);
      }
    } else {
      const existing = document.getElementById(_cssStyleId);
      if (existing) existing.remove();
    }

    if (settings.advanced_css) {
      let existing = document.getElementById(_advancedStyleId);
      if (existing) existing.remove();
      const style = document.createElement('style');
      style.id = _advancedStyleId;
      style.textContent = settings.advanced_css;
      document.head.appendChild(style);
    } else {
      const existing = document.getElementById(_advancedStyleId);
      if (existing) existing.remove();
    }
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
