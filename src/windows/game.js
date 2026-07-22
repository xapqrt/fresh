const { BrowserWindow, ipcMain, app, shell, session, protocol } = require("electron");
const { default_settings, allowed_urls } = require("../util/defaults.json");
const { initResourceSwapper } = require('../addons/swapper.js');
const { performance } = require("perf_hooks");
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

// Main-process bhop state machine. Receives keyboard/ground state from the
// renderer (via lightweight IPC) and injects keys via sendInputEvent — no CDP,
// no rAF in renderer, no IPC per key event.
let _bhopS = null;

function _bhopMake() {
  return { on: false, phase: 0, grounded: null, qDownPhys: false,
    qDown: false, shiftDown: false, aDown: false, dDown: false,
    strafeKey: null, strafePhysDown: false, lastToggle: 0,
    holdMs: 10, jitterMs: 2, jitterAccum: 0,
    lastStrafeSwitch: 0, strafeSwitchMs: 130, tid: null };
}

function _bhopInject(s, key, down) {
  if (!gameWindow || gameWindow.isDestroyed()) return;
  try {
    const type = down ? 'keyDown' : 'keyUp';
    gameWindow.webContents.sendInputEvent({ type, keyCode: key, modifiers: [] });
  } catch (e) { /* non-critical */ }
}

function _bhopTick() {
  try {
    const s = _bhopS;
    if (!s || !s.on) return;
    const now = performance.now();

    // Strafe switching (decoupled air-control)
    if (s.strafeKey && (now - s.lastStrafeSwitch) >= s.strafeSwitchMs) {
      s.lastStrafeSwitch = now;
      const phys = (s.strafeKey === 'a' && s.aDown) || (s.strafeKey === 'd' && s.dDown);
      if (!phys) {
        _bhopInject(s, s.strafeKey, false);
        s.strafeKey = s.strafeKey === 'a' ? 'd' : 'a';
        _bhopInject(s, s.strafeKey, true);
        s.strafePhysDown = true;
      }
    }

    if (s.grounded === true) {
      s.lastToggle = now - s.holdMs - s.jitterMs;
      if (s.phase === 1) { s.qDownPhys = false; _bhopInject(s, 'q', false); s.phase = 2; }
      s.qDownPhys = true; _bhopInject(s, 'q', true);
      s.phase = 1;
      s.jitterAccum = Math.random() * s.jitterMs;
      return;
    }

    if (s.grounded === false) return;

    if (s.lastToggle !== 0 && now - s.lastToggle > 5) return;
    if (now - s.lastToggle < s.holdMs + s.jitterAccum) return;

    s.lastToggle = now;
    s.jitterAccum = Math.random() * s.jitterMs;

    if (s.phase === 1) { s.qDownPhys = false; _bhopInject(s, 'q', false); s.phase = 2; }
    else if (s.phase === 2) { s.qDownPhys = true; _bhopInject(s, 'q', true); s.phase = 1; }
  } catch (e) {
    console.error('[bhop] Tick error:', e);
  }
}

ipcMain.on('bhop-start', () => {
  if (!_bhopS) _bhopS = _bhopMake();
  const s = _bhopS; s.on = true; s.phase = 1; s.qDownPhys = true;
  _bhopInject(s, 'q', true);
  s.lastToggle = performance.now();
  s.lastStrafeSwitch = performance.now();
  if (s.tid) clearInterval(s.tid);
  s.tid = setInterval(_bhopTick, 4);
});

ipcMain.on('bhop-stop', () => {
  const s = _bhopS; if (!s) return; s.on = false;
  if (s.qDownPhys) { s.qDownPhys = false; _bhopInject(s, 'q', false); }
  if (s.strafePhysDown && s.strafeKey) {
    const phys = (s.strafeKey === 'a' && s.aDown) || (s.strafeKey === 'd' && s.dDown);
    if (!phys) _bhopInject(s, s.strafeKey, false);
    s.strafePhysDown = false;
  }
  if (s.tid) { clearInterval(s.tid); s.tid = null; }
});

ipcMain.on('bhop-ground', (_, g) => { if (_bhopS) _bhopS.grounded = g; });

ipcMain.on('bhop-keystate', (_, st) => {
  if (!_bhopS) return;
  if (st.aDown !== undefined) _bhopS.aDown = st.aDown;
  if (st.dDown !== undefined) _bhopS.dDown = st.dDown;
  if (st.qDown !== undefined) _bhopS.qDown = st.qDown;
  if (st.shiftDown !== undefined) _bhopS.shiftDown = st.shiftDown;
});

let gameWindow = null;
let _bhopDebugger = null;

app.on('before-quit', () => {
  if (_bhopS && _bhopS.tid) { clearInterval(_bhopS.tid); _bhopS.tid = null; }
  if (_bhopDebugger) {
    try { _bhopDebugger.detach(); } catch (e) {}
    _bhopDebugger = null;
  }
});

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
    show: false,
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

  // Apply fps cap from settings (default 240)
  try { gameWindow.setFrameRate(parseInt(settings.fps_cap, 10) || 240); } catch (e) {}

  gameWindow.webContents.setUserAgent(
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.128 Safari/537.36 Electron/12.2.3 DawnClient/${app.getVersion()}`
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

  const showFallback = setTimeout(() => {
    if (gameWindow && !gameWindow.isVisible()) {
      if (process.platform === "darwin" && settings.auto_fullscreen) {
        gameWindow.setFullScreen(true);
      }
      gameWindow.show();
    }
  }, 10000);

  gameWindow.once("ready-to-show", () => {
    clearTimeout(showFallback);
    try { require("os").setPriority(gameWindow.webContents.getProcessId(), -10); } catch (e) {}
    if (process.platform === "darwin" && settings.auto_fullscreen) {
      gameWindow.setFullScreen(true);
    }
    gameWindow.show();
  });

  gameWindow.on("page-title-updated", (e) => e.preventDefault());

  gameWindow.on("close", () => {
    if (_bhopS && _bhopS.tid) { clearInterval(_bhopS.tid); _bhopS.tid = null; }
    _bhopS = null;
  });

  gameWindow.on("closed", () => {
    if (_bhopS && _bhopS.tid) { clearInterval(_bhopS.tid); _bhopS.tid = null; }
    _bhopS = null;
    ipcMain.removeAllListeners("get-settings");
    ipcMain.removeAllListeners("update-setting");
    ipcMain.removeAllListeners("save-recording");
    ipcMain.removeAllListeners("navigate-home");
    ipcMain.removeAllListeners("screenshot");
    ipcMain.removeAllListeners("toggle-fullscreen");
    ipcMain.removeAllListeners("toggle-devtools");
    ipcMain.removeAllListeners("bhop-start");
    ipcMain.removeAllListeners("bhop-stop");
    ipcMain.removeAllListeners("bhop-ground");
    ipcMain.removeAllListeners("bhop-keystate");
    gameWindow = null;
  });
};

let _patchProtocolRegistered = false;

const initGame = () => {
  if (!_patchProtocolRegistered) {
    _patchProtocolRegistered = true;
    try {
      protocol.handle('dawn-patch', async (request) => {
        const urlParams = new URL(request.url);
        const targetScriptUrl = urlParams.searchParams.get('url');
        try {
          let code = await fetchText(targetScriptUrl);
          const target = "f5['a'][hF]";
          if (code.includes(target)) {
            code = code.replace(target, "(window.__f5=f5,window.__zoomInstance=this,f5['a'][hF])");
          }
          code += `\n//# sourceURL=${targetScriptUrl}`;
          return new Response(code, {
            status: 200,
            headers: {
              'content-type': 'text/javascript',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': '*'
            }
          });
        } catch (err) {
          console.error('dawn-patch fetch failed:', err);
          return new Response("console.error('dawn-patch failed');", { status: 500 });
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
