// src/preload/game.js
// Enhanced Electron-compatible preload script with Pointer Lock V2 support
// Ensures compatibility with Electron 33+ while maintaining V2 behavior

const { BrowserWindow, ipcMain, app, shell, session, protocol } = require("electron");
const { default_settings, allowed_urls } = require("../util/defaults.json");
const { initResourceSwapper } = require("../addons/swapper.js");
const path = require("path");
const Store = require("electron-store");
const fs = require("fs");
const https = require("https");

const { installBhopHook } = require("./game/bhop");
require("../addons/Custom Skin Link.js");

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installBhopHook);
} else {
  installBhopHook();
}

let _pointerLockRequested = false;
let _pointerLockElement = null;

const _startPointerLockV2 = () => {
  // Mono retro fast pointer lock (Electron 28+ V2 API)
  const windowRef = gameWindowRef;
  
  if (!windowRef || windowRef.isDestroyed()) return;
  
  const { webContents } = windowRef;
  
  try {
    // Hide cursor temporarily
    webContents.send('hide-cursor', { show: false });
    
    // Request pointer lock with V2 compatibility
    setTimeout(() => {
      if (!webContents.isDestroyed()) {
        webContents.send('request-pointerlock-v2', {});
        _pointerLockRequested = true;
      }
    }, 10);
    
    // Fallback for Electron 33+ native API
    if (typeof webContents.setUserMediaContextEnabled === 'function') {
      webContents.setUserMediaContextEnabled(true);
    }
    
    console.log('[PointerLockV2] Pointer lock requested for Electron');
  } catch (e) {
    console.warn('[PointerLockV2] Failed to request pointer lock:', e.message);
    setTimeout(_startPointerLockV2, 100);
  }
};

const _emulatePointerLock = () => {
  // Native-style pointer lock emulation for Electron 33+
  try {
    if (document.pointerLockElement || document.mozPointerLockElement) {
      return;
    }
    
    // Force pointer lock on canvas elements if available
    const canvas = document.getElementById('gameCanvas');
    if (canvas) {
      canvas.focus();
      
      const requestPointerLock = canvas.requestPointerLock || 
                                    canvas.mozRequestPointerLock || 
                                    canvas.webkitRequestPointerLock;
      
      if (requestPointerLock) {
        requestPointerLock.call(canvas);
      }
    }
    
    // Set force lock flag if available
    window.__dawnPointerLockV2 = true;
    
    console.log('[PointerLockV2] Emulated pointer lock for canvas');
  } catch (e) {
    console.error('[PointerLockV2] Pointer lock emulation failed:', e);
  }
};

const _enhancePointerLockV2 = () => {
  if (_pointerLockRequested) {
    _emulatePointerLock();
    return;
  }
  
  // Check multiple times for potential lock
  if (!document.pointerLockElement && !document.mozPointerLockElement) {
    _startPointerLockV2();
  }
};

const _setupPointerLockEvents = () => {
  // Monitor pointer lock state for Electron V2 compatibility
  const checkInterval = setInterval(() => {
    if (!_pointerLockRequested) {
      const hasLock = document.pointerLockElement || document.mozPointerLockElement || window.__dawnPointerLockV2;
      if (hasLock) {
        _pointerLockRequested = true;
        console.log('[PointerLockV2] Detected pointer lock');
      }
    }
  }, 50);
  
  // Cleanup after success
  const cleanupInterval = setInterval(() => {
    if (_pointerLockRequested) {
      clearInterval(checkInterval);
      clearInterval(cleanupInterval);
    }
  }, 2000);
  
  return () => {
    clearInterval(checkInterval);
    clearInterval(cleanupInterval);
  };
};

let gameWindowRef = null;
const _installGameWindow = (win) => {
  gameWindowRef = win;
};