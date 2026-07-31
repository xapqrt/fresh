const { app, BrowserWindow, session, protocol, ipcMain, nativeTheme, shell, globalShortcut } = require("electron");
const { applySwitches } = require("./util/switches");
const { default_settings, allowed_urls } = require("./util/defaults.json");
const path = require("path");
const os = require("os");
const Store = require("electron-store");
const fs = require("fs");

protocol.registerSchemesAsPrivileged([
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
const getGameWindow = () => gameWindow;

function matchesKeybindMain(input, bind) {
  if (!bind) return false;
  if (bind === 'Shift') return input.code === 'ShiftLeft' || input.code === 'ShiftRight';
  if (bind === 'RightShift' || bind === 'ShiftRight') return input.code === 'ShiftRight';
  if (bind === 'LeftShift' || bind === 'ShiftLeft') return input.code === 'ShiftLeft';
  return input.code === bind || input.key === bind;
}

// ── Synthetic key tracking ────────────────────────────────────────────────
const _syntheticKeys = new Set();
let _lastBhopFlush = 0;

function releaseSyntheticKeys() {
  if (!gameWindow || gameWindow.isDestroyed()) return;
  for (const key of _syntheticKeys) {
    try {
      gameWindow.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: key,
      });
    } catch (e) {}
  }
  _syntheticKeys.clear();
}

setInterval(() => {
  if (_syntheticKeys.size === 0) { _lastBhopFlush = 0; return; }
  if (_lastBhopFlush !== 0 && Date.now() - _lastBhopFlush > 1500) {
    releaseSyntheticKeys();
    _lastBhopFlush = 0;
  }
}, 500);

// ── IPC Handlers (must be registered before any window loads) ──────────────────
ipcMain.on("get-settings", (e) => { e.returnValue = settings; });
ipcMain.handle("get-settings", async () => settings);
ipcMain.on("update-setting", (e, key, value) => {
  settings[key] = value;
  store.set("settings", settings);
  if (gameWindow && !gameWindow.isDestroyed()) {
    gameWindow.webContents.send("settings-updated", settings);
  }
});
ipcMain.handle("fs-exists", async (_, p) => { try { return fs.existsSync(p); } catch { return false; } });
ipcMain.handle("fs-read-file", async (_, p, enc) => { try { return fs.readFileSync(p, enc || "utf-8"); } catch { return null; } });
ipcMain.handle("fs-write-file", async (_, p, content) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content, "utf-8"); return true; } catch { return false; } });
ipcMain.handle("fs-readdir", async (_, p) => { try { return fs.readdirSync(p); } catch { return []; } });
ipcMain.handle("fs-mkdir", async (_, p) => { try { fs.mkdirSync(p, { recursive: true }); return true; } catch { return false; } });
ipcMain.handle("get-documents-path", async () => app.getPath("documents"));
ipcMain.handle("dump-cookies", async () => {
  const domains = ['https://kirka.io', 'https://api2.kirka.io', 'https://login.xsolla.com', 'https://accounts.google.com'];
  const result = {};
  for (const url of domains) {
    try {
      const cookies = await session.defaultSession.cookies.get({ url });
      result[url] = cookies.map(c => ({ name: c.name, domain: c.domain, path: c.path, sameSite: c.sameSite, secure: c.secure, httpOnly: c.httpOnly, value: c.value.slice(0,30) }));
    } catch (e) { result[url] = `error: ${e.message}`; }
  }
  return result;
});
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

ipcMain.on("bhop-keys", (_, events) => {
  if (!gameWindow || gameWindow.isDestroyed()) return;
  _lastBhopFlush = Date.now();
  for (const { key, down } of events) {
    const code = key.toUpperCase();
    if (down) {
      if (_syntheticKeys.has(code)) continue;
      _syntheticKeys.add(code);
    } else {
      if (!_syntheticKeys.has(code)) continue;
      _syntheticKeys.delete(code);
    }
    gameWindow.webContents.sendInputEvent({
      type: down ? "keyDown" : "keyUp",
      keyCode: code,
    });
  }
});

// Bundle cache: memory + disk (keyed by URL filename, e.g. app.abc123.js)
// P0-1: filename is version-suffixed so any patch change invalidates old
// entries; stale entries are pruned at startup (see pruneBundleCache).
const PATCH_VERSION = 2;
const _bundleCache = new Map();
const _cacheDir = () => path.join(app.getPath('userData'), 'bundle-cache');
const _cacheKey = (url) => { try { return (new URL(url).pathname.split('/').pop() || url) + '.p' + PATCH_VERSION; } catch { return url + '.p' + PATCH_VERSION; } };
const pruneBundleCache = () => {
  try {
    const d = _cacheDir();
    if (!fs.existsSync(d)) return;
    const keep = '.p' + PATCH_VERSION;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith(keep)) {
        try { fs.unlinkSync(path.join(d, f)); console.log('[dawn-patch] pruned stale bundle cache:', f); } catch (e) {}
      }
    }
  } catch (e) {}
};
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

  if (require("fs").existsSync(customDir)) {
    const walk = (dir) => {
      for (const file of require("fs").readdirSync(dir)) {
        const full = path.join(dir, file);
        const stat = require("fs").statSync(full);
        if (stat.isDirectory()) walk(full);
        else {
          const rel = full.replace(customDir + path.sep, "").replace(/\\/g, "/");
          files[rel] = full;
        }
      }
    };
    walk(customDir);
  }

  if (Object.keys(files).length) {
    protocol.handle("dawnclient", (request) => {
      const urlPath = new URL(request.url).pathname.replace(/^\//, '');
      const file = files[urlPath];
      if (file && require("fs").existsSync(file)) {
        return new Response(require("fs").createReadStream(file));
      }
      return new Response("Not found", { status: 404 });
    });
  }

  return files;
};

// ── dawn-patch: registry of bundle patches ─────────────────────────────────
// Each entry is a literal string needle → replacement. Needles are verified
// unique in the current bundle (see bundle-research-report.md); a needle that
// stops matching is reported in __patchMeta.missing instead of crashing.
const PATCHES = [
  {
    name: 'onGround',
    needle: "iP[da8(0x3d56)]=iP[da8(0x55bf)],iP[da8(0x55bf)]=this[da8(0x55bf)]",
    replacement: "iP[da8(0x3d56)]=iP[da8(0x55bf)],iP[da8(0x55bf)]=window.__onGround=!!this[da8(0x55bf)]",
  },
  {
    name: 'antiSpam',
    needle: "this[bWR(0x6627)]=0x1",
    replacement: "window.__antiSpam=(this[bWR(0x6627)]=0x1)",
  },
  {
    name: 'antiSpamClear',
    needle: "this['wNWmWwM']=!0x1",
    replacement: "window.__antiSpam=(this['wNWmWwM']=!0x1)",
  },
];

const applyPatches = (code) => {
  const meta = { version: PATCH_VERSION, applied: [], missing: [] };
  for (const p of PATCHES) {
    if (code.includes(p.needle)) {
      code = code.replace(p.needle, p.replacement);
      meta.applied.push(p.name);
    } else {
      meta.missing.push(p.name);
    }
  }
  return { code, meta };
};

const patchAndCache = async (targetScriptUrl) => {
  const t0 = Date.now();
  let code = await fetchText(targetScriptUrl);
  const { code: patched, meta } = applyPatches(code);
  const finalCode = patched + `\n//# sourceURL=${targetScriptUrl}` + `\nwindow.__patchMeta = ${JSON.stringify(meta)};`;
  _cacheSet(targetScriptUrl, finalCode);
  console.log(`[dawn-patch] ${meta.applied.length ? 'patched' : 'passthrough'} ${new URL(targetScriptUrl).pathname.split('/').pop()} in ${Date.now() - t0}ms — applied:[${meta.applied.join(',') || '-'}] missing:[${meta.missing.join(',') || '-'}]`);
  return finalCode;
};

const warmBundleCache = async () => {
  try {
    const base = settings.base_url || 'https://kirka.io/';
    const html = await fetchText(base);
    const m = html.match(/assets\/js\/(app\.\w+\.js)/);
    if (!m) { console.warn('[dawn-patch] warm: app bundle URL not found in index page'); return; }
    const url = new URL(m[1], 'https://kirka.io/').href;
    if (_cacheGet(url)) { console.log('[dawn-patch] warm: already cached', m[1]); return; }
    await patchAndCache(url);
  } catch (err) {
    console.warn('[dawn-patch] warm failed:', err.message);
  }
};

const initPatchProtocol = () => {
  if (_patchProtocolRegistered) return;
  _patchProtocolRegistered = true;

  try {
    protocol.handle('dawn-patch', async (request) => {
      const urlParams = new URL(request.url);
      const targetScriptUrl = urlParams.searchParams.get('url');
      if (!targetScriptUrl) {
        return new Response("Missing url param", { status: 400 });
      }

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
        const code = await patchAndCache(targetScriptUrl);
        return serve(code);
      } catch (err) {
        console.error('[dawn-patch] fetch failed for', targetScriptUrl, err);
        return serve("console.error('dawn-patch: fetch failed');", 500);
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
  gameWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    show: false,
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
      enableBlinkFeatures: 'PointerLockV2,PointerRawUpdate',
    },
    backgroundColor: "#141414",
    paintWhenInitiallyHidden: true,
  });

  gameWindow.once("ready-to-show", () => {
    if (gameWindow && !gameWindow.isDestroyed()) {
      gameWindow.show();
      try {
        os.setPriority(gameWindow.webContents.getProcessId(), -10);
      } catch (e) {}
      if (process.platform === "darwin" && settings.auto_fullscreen) {
        gameWindow.setFullScreen(true);
      }
    }
  });

  gameWindow.webContents.once("did-finish-load", () => {
    if (gameWindow && !gameWindow.isVisible() && !gameWindow.isDestroyed()) {
      gameWindow.show();
    }
  });

  gameWindow.webContents.on("render-process-gone", (event, details) => {
    console.log("[game] Renderer process gone:", details.reason);
    releaseSyntheticKeys();
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
    if (code === -3 || code === -6) {
      setTimeout(() => { try { gameWindow.reload(); } catch (e) {} }, 2000);
    }
  });

  gameWindow.webContents.on("did-start-navigation", () => {
    releaseSyntheticKeys();
  });

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
    releaseSyntheticKeys();
    ipcMain.removeAllListeners("get-settings");
    ipcMain.removeAllListeners("update-setting");
    ipcMain.removeAllListeners("navigate-home");
    ipcMain.removeAllListeners("screenshot");
    ipcMain.removeAllListeners("toggle-fullscreen");
    ipcMain.removeAllListeners("toggle-devtools");
    ipcMain.removeAllListeners("bhop-keys");
    gameWindow = null;
  });

  gameWindow.on("blur", () => {
    releaseSyntheticKeys();
  });

  gameWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && !input.repeat) {
      const bind = settings.menu_keybind || 'ShiftRight';
      if (matchesKeybindMain(input, bind)) {
        event.preventDefault();
        gameWindow.webContents.send('toggle-menu');
      }
    }
    if (input.type === 'keyUp') {
      const bind = settings.menu_keybind || 'ShiftRight';
      if (matchesKeybindMain(input, bind)) {
        event.preventDefault();
      }
    }
  });

  initPatchProtocol();
  const customFiles = initResourceSwapper();

  const bundleFilter = { urls: ['*://kirka.io/assets/js/app.*.js', '*://kirka.io/assets/js/chunk-*.js'] };
  const customFilterUrls = Object.keys(customFiles).length
    ? Object.keys(customFiles).map(k => '*://*/*' + k)
    : [];
  const allUrls = [...bundleFilter.urls, ...customFilterUrls];

  session.defaultSession.webRequest.onBeforeRequest(
    { urls: allUrls },
    (details, callback) => {
      if (/kirka\.io\/assets\/js\/(app\.\w+\.js|chunk-[\w-]+\.js)/.test(details.url)) {
        const fileName = new URL(details.url).pathname.split('/').pop();
        return callback({ redirectURL: 'dawn-patch://bundle/' + fileName + '?url=' + encodeURIComponent(details.url) });
      }

      if (Object.keys(customFiles).length) {
        try {
          const urlPath = new URL(details.url).pathname.replace(/^\//, '');
          if (customFiles[urlPath]) {
            return callback({ redirectURL: 'dawnclient://' + urlPath });
          }
        } catch (e) {}
      }

      callback({ cancel: false });
    }
  );

  const targetUrl = settings.base_url || "https://kirka.io/";
  setTimeout(() => {
    const urls = ['https://kirka.io', 'https://api2.kirka.io', 'https://login.xsolla.com'];
    urls.forEach(u => {
      session.defaultSession.cookies.get({ url: u }).then(cookies => {
        console.log(`[cookies] ${u}:`, cookies.map(c => `${c.name}=${c.value} domain=${c.domain} samesite=${c.sameSite}`).join(', ') || '(none)');
      }).catch(() => {});
    });
  }, 10000);
  gameWindow.loadURL(targetUrl);
  gameWindow.maximize();

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
  try {
    gameWindow.webContents.executeJavaScript(
      'if (typeof gc === "function") { gc(true); gc(true); }'
    );
  } catch (e) {}

  setTimeout(() => {
    try {
      if (gameWindow && !gameWindow.isDestroyed()) {
        gameWindow.webContents.executeJavaScript(`
          if (window.location.pathname.startsWith('/games') || window.location.pathname.startsWith('/hub/ranked')) {
            window.location.href = '${settings.base_url}';
          }
        `).catch(() => {
          gameWindow.reload();
        });
      }
    } catch (e) {}
  }, 300);
};

const initGame = () => {
  pruneBundleCache();
  createSplashWindow();
  setTimeout(() => {
    createWindow();
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
  setTimeout(() => { warmBundleCache(); }, 400);
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
  releaseSyntheticKeys();
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
  releaseSyntheticKeys();
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => app.quit());

module.exports = { initGame, getGameWindow };
