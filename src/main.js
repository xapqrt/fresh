const { app, BrowserWindow, session, protocol, ipcMain, nativeTheme, shell, globalShortcut } = require("electron");
const { applySwitches } = require("./util/switches");
const { default_settings, allowed_urls } = require("./util/defaults.json");
const path = require("path");
const os = require("os");
const Store = require("electron-store");
const fs = require("fs");

protocol.registerSchemesAsPrivileged([
  { scheme: "https", privileges: { bypassCSP: true, secure: true, supportFetchAPI: true } },
  { scheme: "dawn-patch", privileges: { bypassCSP: true, secure: true, supportFetchAPI: true, standard: true, corsEnabled: true } },
  { scheme: "dawnclient", privileges: { bypassCSP: true, secure: true, supportFetchAPI: true, standard: true, corsEnabled: true } },
]);

applySwitches();

const store = new Store();
if (!store.has("settings")) {
  store.set("settings", default_settings);
}
let settings = store.get("settings");
for (const key in default_settings) {
  if (!(key in settings) || typeof settings[key] !== typeof default_settings[key]) {
    settings[key] = default_settings[key];
  }
}
store.set("settings", settings);

let gameWindow = null;
let splashWindow = null;

// ── IPC Handlers (must be registered before any window loads) ──────────────────
ipcMain.on("get-settings", (e) => { e.returnValue = settings; });
ipcMain.handle("get-settings", async () => settings);
ipcMain.on("update-setting", (e, key, value) => {
  settings[key] = value;
  store.set("settings", settings);
});
ipcMain.handle("fs-exists", async (_, p) => { try { return fs.existsSync(p); } catch { return false; } });
ipcMain.handle("fs-read-file", async (_, p, enc) => { try { return fs.readFileSync(p, enc || "utf-8"); } catch { return null; } });
ipcMain.handle("fs-write-file", async (_, p, content) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content, "utf-8"); return true; } catch { return false; } });
ipcMain.handle("fs-readdir", async (_, p) => { try { return fs.readdirSync(p); } catch { return []; } });
ipcMain.handle("fs-mkdir", async (_, p) => { try { fs.mkdirSync(p, { recursive: true }); return true; } catch { return false; } });
ipcMain.handle("get-documents-path", async () => app.getPath("documents"));
ipcMain.handle("clipboard-write", async (_, text) => { try { require("electron").clipboard.writeText(text); } catch {} });
ipcMain.handle("clipboard-read", async () => { try { return require("electron").clipboard.readText(); } catch { return ""; } });
ipcMain.on("open-external", (_, url) => { try { shell.openExternal(url); } catch {} });
ipcMain.on("navigate", (_, url) => { if (gameWindow && !gameWindow.isDestroyed()) gameWindow.loadURL(url); });
ipcMain.on("navigate-home", () => { if (gameWindow && !gameWindow.isDestroyed()) gameWindow.loadURL(settings.base_url); });
ipcMain.on("toggle-fullscreen", () => { if (gameWindow && !gameWindow.isDestroyed()) gameWindow.setFullScreen(!gameWindow.isFullScreen()); });
ipcMain.on("toggle-devtools", () => { if (gameWindow && !gameWindow.isDestroyed()) gameWindow.webContents.toggleDevTools(); });
ipcMain.handle("screenshot", async () => {
  if (gameWindow && !gameWindow.isDestroyed()) {
    return (await gameWindow.webContents.capturePage()).toPNG();
  }
  return null;
});

ipcMain.on("bhop-key", (_, { key, down }) => {
  if (gameWindow && !gameWindow.isDestroyed()) {
    gameWindow.webContents.sendInputEvent({
      type: down ? "keyDown" : "keyUp",
      keyCode: key.toUpperCase(),
    });
  }
});

// Bundle cache: memory + disk (keyed by URL filename, e.g. app.abc123.js)
const _bundleCache = new Map();
const _cacheDir = () => path.join(app.getPath('userData'), 'bundle-cache');
const _cacheKey = (url) => { try { return new URL(url).pathname.split('/').pop() || url; } catch { return url; } };
const _cacheGet = (key) => {
  if (_bundleCache.has(key)) return _bundleCache.get(key);
  try {
    const f = path.join(_cacheDir(), _cacheKey(key));
    if (fs.existsSync(f)) { const d = fs.readFileSync(f, 'utf-8'); _bundleCache.set(key, d); return d; }
  } catch (e) {}
  return null;
};
const _cacheSet = (key, data) => {
  _bundleCache.set(key, data);
  try { const d = _cacheDir(); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, _cacheKey(key)), data, 'utf-8'); } catch (e) {}
};
let _patchProtocolRegistered = false;

const PRELOAD_PATH = path.join(__dirname, "preload", "game.js");
const SPLASH_PRELOAD = path.join(__dirname, "preload", "splash.js");

function fetchText(url) {
  return fetch(url).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
}

const initResourceSwapper = () => {
  const customDir = path.join(app.getPath("userData"), "custom");
  const files = {};
  const filter = { urls: [] };

  if (require("fs").existsSync(customDir)) {
    const walk = (dir) => {
      for (const file of require("fs").readdirSync(dir)) {
        const full = path.join(dir, file);
        const stat = require("fs").statSync(full);
        if (stat.isDirectory()) walk(full);
        else {
          const rel = full.replace(customDir + path.sep, "").replace(/\\/g, "/");
          files[rel] = full;
          filter.urls.push("*://*/*" + rel);
        }
      }
    };
    walk(customDir);
  }

  if (filter.urls.length) {
    protocol.handle("dawnclient", (request) => {
      const url = new URL(request.url);
      const path_ = url.pathname.slice(1);
      const file = files[path_];
      if (file && require("fs").existsSync(file)) {
        return new Response(require("fs").createReadStream(file));
      }
      return new Response("Not found", { status: 404 });
    });
  }

  return { files, filter };
};

const initPatchProtocol = () => {
  if (_patchProtocolRegistered) return;
  _patchProtocolRegistered = true;

  try {
    protocol.handle('dawn-patch', async (request) => {
      const urlParams = new URL(request.url);
      const targetScriptUrl = urlParams.searchParams.get('url');

      const serve = (body, status = 200) => new Response(body, {
        status,
        headers: {
          'content-type': 'text/javascript',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=31536000, immutable',
        }
      });

      const cached = _cacheGet(targetScriptUrl);
      if (cached) return serve(cached);

      try {
        let code = await fetchText(targetScriptUrl);

        const zoomTarget = "f5['a'][hF]";
        if (code.includes(zoomTarget)) {
          code = code.replace(zoomTarget, "(window.__f5=f5,window.__zoomInstance=this,f5['a'][hF])");
        } else {
          console.warn('[dawn-patch] WARNING: zoom pattern not found — bundle format may have changed');
        }

        const onGroundRe = /this\['onGround'\]\s*=\s*([^;,]+)/;
        if (onGroundRe.test(code)) {
          code = code.replace(onGroundRe, "this['onGround']=$1,window.__onGround=$1");
        } else {
          console.warn('[dawn-patch] WARNING: onGround pattern not found — bhop may be broken');
        }

        code += `\n//# sourceURL=${targetScriptUrl}`;

        _cacheSet(targetScriptUrl, code);

        return serve(code);
      } catch (err) {
        console.error('dawn-patch fetch failed:', err);
        return serve("console.error('dawn-patch failed');", 500);
      }
    });
  } catch (e) {
    console.warn('dawn-patch registration warning:', e.message);
  }
};

const createSplashWindow = () => {
  splashWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    backgroundColor: "#07070a",
    resizable: false,
    alwaysOnTop: true,
    center: true,
    show: false,
    webPreferences: {
      preload: SPLASH_PRELOAD,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  splashWindow.loadFile(path.join(__dirname, "..", "assets", "splash.html"));
  splashWindow.once("ready-to-show", () => {
    splashWindow.show();
    splashWindow.webContents.send("splash-show");
  });

  splashWindow.on("closed", () => { splashWindow = null; });
};

const createWindow = () => {
  // Note: Don't add --enable-gpu-rasterization, --enable-zero-copy, --disable-gpu-vsync etc.
  // These crash the GPU process on Apple Silicon Metal and cause Chromium to fall
  // back to SwiftShader software rendering (~2-5 FPS). switches.js handles safe flags.
  
  gameWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    show: false, // FIX: Don't show until ready-to-show
    frame: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: PRELOAD_PATH,
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      pointerLockV2: true,
      scrollBounce: false,
      pinchZoom: false,
      experimentalFeatures: false,
      backgroundThrottling: false,
      spellcheck: false,
      enableWebSQL: false,
    },
    backgroundColor: "#141414",
    paintWhenInitiallyHidden: true,
  });

  // FIX: Show window as early as possible to eliminate black screen
  gameWindow.once("ready-to-show", () => {
    if (gameWindow && !gameWindow.isDestroyed()) {
      gameWindow.show();
      
      // Boost renderer process priority
      try { 
        os.setPriority(gameWindow.webContents.getProcessId(), -10); 
      } catch (e) {}
      
      if (process.platform === "darwin" && settings.auto_fullscreen) {
        gameWindow.setFullScreen(true);
      }
    }
  });

  // Also show on did-finish-load as fallback
  gameWindow.webContents.once("did-finish-load", () => {
    if (gameWindow && !gameWindow.isVisible() && !gameWindow.isDestroyed()) {
      gameWindow.show();
    }
  });

  // FIX: Handle render process gone gracefully
  gameWindow.webContents.on("render-process-gone", (event, details) => {
    console.log("[game] Renderer process gone:", details.reason);
    if (gameWindow && !gameWindow.isDestroyed()) {
      setTimeout(() => {
        try {
          const targetUrl = settings.base_url || "https://kirka.io/";
          console.error(`[game] Reloading renderer to ${targetUrl}`);
          gameWindow.loadURL(targetUrl);
        } catch (e) {}
      }, 2000);
    }
  });

  gameWindow.webContents.on("unresponsive", () => {
    setTimeout(() => {
      try { gameWindow.reload(); } catch (e) {}
    }, 5000);
  });

  gameWindow.webContents.on("did-fail-load", (_, code, desc) => {
    if (code === -3 || code === -6) { // Connection timeout/reset
      setTimeout(() => { try { gameWindow.reload(); } catch (e) {} }, 2000);
    }
  });

  // Track in-page navigation to detect match start/end
  gameWindow.webContents.on("did-navigate-in-page", (e, url) => {
    gameWindow.webContents.send("url-change", url);
    const wasInMatch = _navIsMatch(_navPreviousUrl);
    const nowInMatch = _navIsMatch(url);
    if (wasInMatch && !nowInMatch) {
      matchEnded();
    }
    _navPreviousUrl = url;
  });

  gameWindow.on("page-title-updated", (e) => e.preventDefault());

  gameWindow.on("closed", () => {
    ipcMain.removeAllListeners("get-settings");
    ipcMain.removeAllListeners("update-setting");
    ipcMain.removeAllListeners("navigate-home");
    ipcMain.removeAllListeners("screenshot");
    ipcMain.removeAllListeners("toggle-fullscreen");
    ipcMain.removeAllListeners("toggle-devtools");
    gameWindow = null;
  });

  // Set up protocol handlers before loading
  initPatchProtocol();
  const swap = initResourceSwapper();

  // FIX: Single webRequest handler for both bundle patching and custom resources
  const bundleFilter = { urls: ['*://kirka.io/assets/js/app.*.js'] };
  const allUrls = swap.filter.urls.length
    ? [...bundleFilter.urls, ...swap.filter.urls]
    : bundleFilter.urls;

  session.defaultSession.webRequest.onBeforeRequest(
    { urls: allUrls },
    (details, callback) => {
      if (/kirka\.io\/assets\/js\/app\.\w+\.js/.test(details.url)) {
        return callback({ redirectURL: 'dawn-patch://bundle/app.js?url=' + encodeURIComponent(details.url) });
      }

      if (swap.filter.urls.length) {
        const cleaned = details.url.replace(/https?:\/\//, '').replace(/\?.*/, '').replace(/#.*/, '').replace(/_/g, '');
        const redirect = 'dawnclient://' + (swap.files[cleaned] || details.url);
        return callback({ cancel: false, redirectURL: redirect });
      }

      callback({ cancel: false });
    }
  );

  // Load the game with fallback URL
  const targetUrl = settings.base_url || "https://kirka.io/";
  gameWindow.loadURL(targetUrl);
  gameWindow.maximize();

  // Startup timeout: if the window hasn't shown within 15s, force-show to prevent black hang
  setTimeout(() => {
    if (gameWindow && !gameWindow.isDestroyed() && !gameWindow.isVisible()) {
      console.warn("[game] Startup timeout — forcing window show");
      gameWindow.show();
    }
  }, 15000);
};

let _navPreviousUrl = settings.base_url;
const _navIsMatch = (url) => {
  try {
    const p = new URL(url).pathname;
    return p.startsWith('/games') || p.startsWith('/hub/ranked');
  } catch { return false; }
};

const matchEnded = () => {
  console.log("[game] Match ended — flushing GPU state");
  
  // Force V8 GC to free JS wrappers around WebGL resources
  try {
    gameWindow.webContents.executeJavaScript(
      'if (typeof gc === "function") { gc(true); gc(true); }'
    );
  } catch (e) {}

  // FIX: Navigate to lobby instead of full reload to avoid black screen
  setTimeout(() => {
    try {
      if (gameWindow && !gameWindow.isDestroyed()) {
        gameWindow.webContents.executeJavaScript(`
          if (window.location.pathname.startsWith('/games') || window.location.pathname.startsWith('/hub/ranked')) {
            window.location.href = '${settings.base_url}';
          }
        `).catch(() => {
          // Fallback to reload if navigation fails
          gameWindow.reload();
        });
      }
    } catch (e) {}
  }, 300);
};

const initGame = () => {
  // Create splash first for immediate visual feedback
  createSplashWindow();
  
  // Create game window shortly after
  setTimeout(() => {
    createWindow();
    
    // Close splash after game window loads
    if (gameWindow) {
      gameWindow.webContents.once("did-finish-load", () => {
        setTimeout(() => {
          if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
          }
        }, 200);
      });
    }
  }, 100);
};

app.on("ready", async () => {
  initGame();
  try { os.setPriority(process.pid, -10); } catch (e) {}
  try {
    if (process.platform === "darwin") {
      if (app.disableAppNap) app.disableAppNap("Dawn Client is a game");
      if (app.disableSuddenTermination) app.disableSuddenTermination();
    }
  } catch (e) {}
  globalShortcut.register("F8", () => {
    const gw = getGameWindow();
    if (gw && !gw.isDestroyed()) gw.webContents.send("toggle-menu");
  });
  globalShortcut.register("Shift+F8", () => {
    const gw = getGameWindow();
    if (gw && !gw.isDestroyed()) gw.webContents.send("toggle-menu");
  });
});

let _gpuRecovering = false;

app.on("child-process-gone", (_, details) => {
  console.error(`[main] child-process-gone: type=${details.type} reason=${details.reason}`);
  if (details.type !== "GPU") return;
  if (_gpuRecovering) return;
  _gpuRecovering = true;
  setTimeout(() => {
    try {
      const gw = getGameWindow();
      if (gw && !gw.isDestroyed()) {
        console.error("[main] GPU restarted — reloading to https://kirka.io/");
        gw.loadURL("https://kirka.io/");
      }
    } catch (e) {
      console.error("[main] GPU crash recovery failed:", e);
    }
    _gpuRecovering = false;
  }, 1500);
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => app.quit());

module.exports = { initGame, getGameWindow: () => gameWindow };