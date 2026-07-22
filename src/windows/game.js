const { BrowserWindow, ipcMain, app, shell, session, protocol } = require("electron");
const { default_settings, allowed_urls } = require("../util/defaults.json");
const { initResourceSwapper } = require('../addons/swapper.js');
const path = require("path");
const Store = require("electron-store");
const fs = require("fs");
const https = require("https");

const fetchText = (url) => new Promise((resolve, reject) => {
  https.get(url, (res) => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      reject(new Error(`fetchText: ${url} returned ${res.statusCode}`));
      return;
    }
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    res.on('error', reject);
  }).on('error', reject);
});

const store = new Store();
if (!store.has("settings")) {
  store.set("settings", default_settings);
}

const settings = store.get("settings");

for (const key in default_settings) {
  if (
    !settings.hasOwnProperty(key) ||
    typeof settings[key] !== typeof default_settings[key]
  ) {
    settings[key] = default_settings[key];
    store.set("settings", settings);
  }
}

if (!allowed_urls.includes(settings.base_url)) {
  settings.base_url = default_settings.base_url;
  store.set("settings", settings);
}

ipcMain.on("get-settings", (e) => {
  e.returnValue = settings;
});

ipcMain.handle("get-settings-async", async () => settings);

ipcMain.handle("fs-exists", async (_, p) => {
  try { return fs.existsSync(p); } catch (e) { return false; }
});

ipcMain.handle("fs-read-file", async (_, p, enc) => {
  try { return fs.readFileSync(p, enc || "utf-8"); } catch (e) { return null; }
});

ipcMain.handle("fs-write-file", async (_, p, content) => {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf-8");
    return true;
  } catch (e) { return false; }
});

ipcMain.handle("fs-readdir", async (_, p) => {
  try { return fs.readdirSync(p); } catch (e) { return []; }
});

ipcMain.handle("fs-mkdir", async (_, p) => {
  try { fs.mkdirSync(p, { recursive: true }); return true; } catch (e) { return false; }
});

ipcMain.handle("get-documents-path", async () => {
  return app.getPath("documents");
});

ipcMain.handle("clipboard-write", async (_, text) => {
  try { require("electron").clipboard.writeText(text); } catch (e) {}
});

ipcMain.handle("clipboard-read", async () => {
  try { return require("electron").clipboard.readText(); } catch (e) { return ""; }
});

ipcMain.handle("get-desktop-sources", async (_, opts) => {
  try {
    const { desktopCapturer } = require("electron");
    return await desktopCapturer.getSources(opts || { types: ["screen", "window"] });
  } catch (e) {
    console.error("get-desktop-sources failed:", e);
    return [];
  }
});

ipcMain.on("open-external", (_, url) => {
  try { shell.openExternal(url); } catch (e) {}
});

const _writeSettings = () => {
  const configPath = path.join(app.getPath("userData"), "config.json");
  fs.writeFile(configPath, JSON.stringify({ settings }), () => {});
};

let _storeTimer = null;
ipcMain.on("update-setting", (e, key, value) => {
  settings[key] = value;
  if (_storeTimer) clearTimeout(_storeTimer);
  _storeTimer = setTimeout(() => {
    _storeTimer = null;
    _writeSettings();
  }, 1000);
});

ipcMain.on("navigate", (_, url) => {
  gameWindow.loadURL(url);
});

ipcMain.on("save-recording", (_, buf) => {
  const clipsDir = path.join(app.getPath("documents"), "DawnClient", "clips");
  if (!fs.existsSync(clipsDir)) { fs.mkdirSync(clipsDir, { recursive: true }); }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(clipsDir, `clip-${ts}.webm`);
  fs.writeFile(filePath, Buffer.from(buf), () => {});
});

ipcMain.on("reset-juice-settings", () => {
  store.set("settings", default_settings);
  app.relaunch();
  app.quit();
});

ipcMain.on("open-swapper-folder", () => {
  const swapperPath = path.join(
    app.getPath("documents"),
    "DawnClient/swapper/assets"
  );

  if (!fs.existsSync(swapperPath)) {
    fs.mkdirSync(swapperPath, { recursive: true });
    shell.openPath(swapperPath);
  } else {
    shell.openPath(swapperPath);
  }
});

let gameWindow = null;
let _lastHeartbeat = 0;

ipcMain.on('heartbeat', () => { _lastHeartbeat = performance.now(); });

setInterval(() => {
  if (!gameWindow || gameWindow.isDestroyed()) return;
  if (_lastHeartbeat === 0) return;
  if (performance.now() - _lastHeartbeat > 12000) {
    _lastHeartbeat = 0;
    const url = gameWindow.webContents.getURL() || settings.base_url;
    gameWindow.loadURL(url);
  }
}, 5000);

const createWindow = () => {
  gameWindow = new BrowserWindow({
    fullscreen: settings.auto_fullscreen,
    titleBarStyle: 'hidden',
    fullscreenable: true,
    simpleFullscreen: true,
    icon: path.join(__dirname, "../assets/img/icon.ico"),
    title: "Dawn Client",
    width: 1280,
    height: 720,
    show: true,
    backgroundColor: "#141414",
    backgroundThrottling: false,
    autoHideMenuBar: true,
    webPreferences: {
      scrollBounce: false,
      pinchZoom: false,
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: false,
      sandbox: false,
      webSecurity: false,
      nativeWindowOpen: true,
      pointerLockV2: true,
      // Never throttle input/raf when Chromium thinks the window is
      // "occluded" or not frontmost — keeps mouse input snappy.
      backgroundThrottling: false,
      preload: path.join(__dirname, "../preload/game.js"),
    },
  });

  // IMPORTANT: Do NOT call setFrameRate() here.
  // setFrameRate() is ONLY for off-screen rendering (OSR) mode.
  // On a normal BrowserWindow it interferes with the macOS CADisplayLink
  // VSync signal and causes the compositor to drop to ~2-5 FPS.

  // Use the actual Chrome 120 UA (matching Electron 28's Chromium build).
  // Chrome 89 UA causes kirka.io to serve an older JS bundle.
  gameWindow.webContents.setUserAgent(
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 DawnClient/${app.getVersion()}`
  );

  // Google / OAuth popups (window.open) must open IN-APP as real child windows
  // so the window.opener relationship + postMessage round-trip works and the
  // login callback returns to the game. Routing them to the system browser
  // (shell.openExternal) breaks OAuth because the redirect can't come back.
  // nativeWindowOpen:true makes Electron create native child popups when we
  // return action:'allow'.
  gameWindow.webContents.on("new-window", (e, url) => {
    // Match upstream (zVipexx/dawn-client): send auth/popup links to the
    // system browser. kirka.io's OAuth is a redirect flow that completes there
    // and the game window picks up the session on reload — this is the
    // proven-working behavior.
    e.preventDefault();
    require("electron").shell.openExternal(url);
  });

  gameWindow.webContents.on("did-navigate-in-page", (e, url) => {
    gameWindow.webContents.send("url-change", url);
  });

  gameWindow.removeMenu();
  gameWindow.loadURL(settings.base_url);
  gameWindow.maximize();
  gameWindow.show();

  gameWindow.once("ready-to-show", () => {
    try { require("os").setPriority(gameWindow.webContents.getProcessId(), -10); } catch (e) {}
    if (process.platform === "darwin" && settings.auto_fullscreen) {
      gameWindow.setFullScreen(true);
    }
  });

  gameWindow.webContents.on("render-process-gone", (_, details) => {
    if (details.reason === 'crashed' || details.reason === 'gpu-process-crashed' || details.reason === 'abnormal-termination') {
      const url = gameWindow.webContents.getURL() || settings.base_url;
      gameWindow.loadURL(url);
    }
  });

  gameWindow.on("unresponsive", () => {
    setTimeout(() => {
      try { gameWindow.reload(); } catch (e) { gameWindow.loadURL(settings.base_url); }
    }, 8000);
  });

  gameWindow.webContents.on("did-fail-load", (_, code) => {
    if (code === -3 || code === -6) {
      setTimeout(() => { try { gameWindow.reload(); } catch (e) {} }, 2000);
    }
  });

  gameWindow.on("page-title-updated", (e) => e.preventDefault());

  gameWindow.on("close", () => {});

  gameWindow.on("closed", () => {
    ipcMain.removeAllListeners("get-settings");
    ipcMain.removeAllListeners("update-setting");
    ipcMain.removeAllListeners("save-recording");
    ipcMain.removeAllListeners("navigate-home");
    ipcMain.removeAllListeners("screenshot");
    ipcMain.removeAllListeners("toggle-fullscreen");
    ipcMain.removeAllListeners("toggle-devtools");
    ipcMain.removeAllListeners("heartbeat");
    gameWindow = null;
  });
};

// In-memory bundle cache: key = original script URL, value = patched code string.
// This prevents re-downloading the multi-MB kirka.io bundle on every navigation.
const _bundleCache = new Map();

let _patchProtocolRegistered = false;

const initGame = () => {
  if (!_patchProtocolRegistered) {
    _patchProtocolRegistered = true;
    try {
      protocol.handle('dawn-patch', async (request) => {
        const urlParams = new URL(request.url);
        const targetScriptUrl = urlParams.searchParams.get('url');
        try {
          // Serve from memory cache if available (avoids 20s re-download per navigation)
          if (_bundleCache.has(targetScriptUrl)) {
            const cached = _bundleCache.get(targetScriptUrl);
            return new Response(cached, {
              status: 200,
              headers: {
                'content-type': 'text/javascript',
                'Access-Control-Allow-Origin': '*',
              }
            });
          }

          let code = await fetchText(targetScriptUrl);
          const target = "f5['a'][hF]";
          if (code.includes(target)) {
            code = code.replace(target, "(window.__f5=f5,window.__zoomInstance=this,f5['a'][hF])");
          }
          // Inject onGround hook into physics update loop if present
          code = code.replace(/this\['onGround'\]\s*=\s*([^;,]+)/g, "this['onGround']=$1,window.__onGround=$1");
          code += `\n//# sourceURL=${targetScriptUrl}`;

          // Store in memory cache for this session
          _bundleCache.set(targetScriptUrl, code);

          return new Response(code, {
            status: 200,
            headers: {
              'content-type': 'text/javascript',
              'Access-Control-Allow-Origin': '*',
            }
          });
        } catch (err) {
          console.error('dawn-patch fetch failed:', err);
          _bundleCache.set(targetScriptUrl, '');
          return new Response("", {
            status: 200,
            headers: {
              'content-type': 'text/javascript',
              'Access-Control-Allow-Origin': '*',
            }
          });
        }
      });
    } catch (e) {
      console.warn('dawn-patch registration warning:', e.message);
    }
  }

  const swap = initResourceSwapper();

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

  createWindow();
};

module.exports = {
  initGame,
  getGameWindow: () => gameWindow,
};
