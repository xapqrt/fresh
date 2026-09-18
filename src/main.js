const { app, BrowserWindow, session, protocol, ipcMain, globalShortcut, clipboard, dialog, shell, net, screen } = require("electron");
const { applySwitches } = require("./util/switches");
const { default_settings, allowed_urls } = require("./util/defaults.json");
const { registerShortcuts } = require("./util/shortcuts");
const DiscordRPC = require("./addons/rpc");
const path = require("path");
const os = require("os");
const Store = require("electron-store");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
let ffmpegPath = require("ffmpeg-static");

if (ffmpegPath && ffmpegPath.includes("app.asar")) {
  ffmpegPath = ffmpegPath.replace("app.asar", "app.asar.unpacked");
}
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

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
if (!settings.menu_opacity || Number(settings.menu_opacity) <= 0) {
  settings.menu_opacity = 100;
}
if (settings.advanced_css && (settings.advanced_css.includes("263f8a2cbfc9d6e90f37e32f88d3265d") || settings.advanced_css.includes("rick and morty"))) {
  settings.advanced_css = "";
}
store.set("settings", settings);

let gameWindow = null;
let splashWindow = null;
const getGameWindow = () => gameWindow;

// One instance per launch — two clients writing to the same bundle cache /
// settings would fight each other.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const gw = getGameWindow();
    if (gw && !gw.isDestroyed()) {
      if (gw.isMinimized()) gw.restore();
      gw.focus();
    }
  });
}

function matchesKeybindMain(input, bind) {
  if (!bind) return false;
  if (bind === 'Shift') return input.code === 'ShiftLeft' || input.code === 'ShiftRight';
  if (bind === 'RightShift' || bind === 'ShiftRight') return input.code === 'ShiftRight';
  if (bind === 'LeftShift' || bind === 'ShiftLeft') return input.code === 'ShiftLeft';
  return input.code === bind || input.key === bind;
}

let _failLoadAttempt = 0;

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

// FPS cap: webContents.setFrameRate pins the page frame rate.
// SAFETY: it is always clamped to the display's actual refresh rate —
// requesting a rate HIGHER than the panel can present makes Chromium
// produce frames faster than WindowServer flips, which on macOS ANGLE
// Metal saturates the GPU command ring and DROPS presented frames
// (measured: 1.6–2.7 FPS on screen at "650 FPS" rAF). On the 60Hz Air
// panel every value ≥ 60 is therefore a no-op; only a true sub-refresh
// cap (e.g. 30) actually calls setFrameRate. Live-updatable, no restart.
const applyFrameCap = () => {
  if (!gameWindow || gameWindow.isDestroyed()) return;
  const cap = Number(settings.fps_cap) || 0;
  if (cap === 0) return;
  try {
    const displayHz = Math.round(screen.getPrimaryDisplay().refreshRate) || 60;
    const eff = Math.min(cap, displayHz);
    if (eff > 0 && eff < displayHz) {
      gameWindow.webContents.setFrameRate(eff);
    }
  } catch (e) {}
};

// Settings: in-memory update + renderer broadcast are immediate; the
// synchronous full-file disk write is debounced so rapid toggles/sliders
// don't pile up JSON writes.
let _settingsSaveTimer = null;
ipcMain.on("update-setting", (e, key, value) => {
  if (key === "fps_cap") value = Number(value) || 0;
  settings[key] = value;
  if (key === "fps_cap") applyFrameCap();
  if (gameWindow && !gameWindow.isDestroyed()) {
    gameWindow.webContents.send("settings-updated", settings);
  }
  clearTimeout(_settingsSaveTimer);
  _settingsSaveTimer = setTimeout(() => {
    _settingsSaveTimer = null;
    store.set("settings", settings);
  }, 250);
});
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
ipcMain.on("bhop-keys", (_, events) => {
  if (!gameWindow || gameWindow.isDestroyed()) return;
  _lastBhopFlush = Date.now();
  for (const { key, down } of events) {
    const code = key.length === 1 ? key.toUpperCase() : key;
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

// ── Upstream Dawn Client IPC Handlers ─────────────────────────────────────
ipcMain.handle("ping-url", async (_event, url) => {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = net.request({ method: "HEAD", url });
    request.on("response", () => done(Date.now() - start));
    request.on("error", () => done(null));
    setTimeout(() => {
      try { request.abort(); } catch {}
      done(null);
    }, 3000);
    request.end();
  });
});

ipcMain.on("open-swapper-folder", () => {
  const swapperPath = path.join(app.getPath("documents"), "DawnClient/swapper/assets");
  if (!fs.existsSync(swapperPath)) fs.mkdirSync(swapperPath, { recursive: true });
  shell.openPath(swapperPath);
});

const scriptsPath = path.join(app.getPath("documents"), "DawnClient/scripts");
if (!fs.existsSync(scriptsPath)) fs.mkdirSync(scriptsPath, { recursive: true });

ipcMain.on("open-scripts-folder", () => {
  shell.openPath(scriptsPath);
});

ipcMain.on("get-scripts-path", (e) => {
  e.returnValue = scriptsPath;
});

ipcMain.on("open-skins-folder", () => {
  const skinsPath = path.join(app.getPath("documents"), "DawnClient/swapper/assets/img");
  if (!fs.existsSync(skinsPath)) fs.mkdirSync(skinsPath, { recursive: true });
  shell.openPath(skinsPath);
});

ipcMain.on("get-sounds-path", (e) => {
  const soundsPath = path.join(app.getPath("documents"), "DawnClient/swapper/assets/media");
  if (!fs.existsSync(soundsPath)) fs.mkdirSync(soundsPath, { recursive: true });
  e.returnValue = soundsPath;
});

ipcMain.on("open-sounds-folder", () => {
  const soundsPath = path.join(app.getPath("documents"), "DawnClient/swapper/assets/media");
  if (!fs.existsSync(soundsPath)) fs.mkdirSync(soundsPath, { recursive: true });
  shell.openPath(soundsPath);
});

ipcMain.on("open-gallery-folder", () => {
  const galleryFolder = path.join(app.getPath("documents"), "DawnClient/gallery");
  if (!fs.existsSync(galleryFolder)) fs.mkdirSync(galleryFolder, { recursive: true });
  shell.openPath(galleryFolder);
});

const galleryFolder = path.join(app.getPath("documents"), "DawnClient/gallery");
if (!fs.existsSync(galleryFolder)) fs.mkdirSync(galleryFolder, { recursive: true });

ipcMain.handle("get-file-preview", (event, filePath) => {
  const ext = filePath.split(".").pop().toLowerCase();
  const mimeTypes = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  const mime = mimeTypes[ext] || "image/png";
  const data = fs.readFileSync(filePath);
  return `data:${mime};base64,${data.toString("base64")}`;
});

ipcMain.handle("get-gallery-root", () => galleryFolder);

function copyRecursiveSync(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src);
    for (const entry of entries) copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
  } else {
    fs.copyFileSync(src, dest);
  }
}

try {
  fs.watch(galleryFolder, (eventType, filename) => {
    if (filename) BrowserWindow.getAllWindows().forEach((win) => win.webContents.send("gallery-updated"));
  });
} catch (e) {}

ipcMain.on("open-category-folder", (event, folderPath) => {
  try {
    if (fs.existsSync(folderPath)) shell.openPath(folderPath);
  } catch (err) { console.error(err); }
});

ipcMain.on("open-import", async (event, categoryPath) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Select file to import",
    defaultPath: categoryPath,
    properties: ["openFile"],
    filters: [
      {
        name: "All Supported",
        extensions: ["txt", "json", "css", "png", "jpg", "jpeg", "gif", "webp"],
      },
    ],
  });
  if (!canceled && filePaths.length > 0) {
    const filePath = filePaths[0];
    fs.copyFileSync(filePath, path.join(categoryPath, path.basename(filePath)));
    event.sender.send("gallery-updated");
  }
});

ipcMain.on("import-file", (event, categoryPath, filePath) => {
  try {
    if (!fs.statSync(filePath).isFile()) return;
    const fileName = path.basename(filePath);
    const targetPath = path.join(categoryPath, fileName);
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(filePath, targetPath);
    event.reply("gallery-updated");
  } catch (err) { console.error(err); }
});

ipcMain.on("delete-file", (event, filePath) => {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  event.reply("gallery-updated");
});

ipcMain.on("rename-file", (event, oldPath, newName) => {
  const newPath = path.join(path.dirname(oldPath), newName);
  if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
  event.reply("gallery-updated");
});

ipcMain.on("copy-image-path", (event, imgPath) => {
  if (fs.existsSync(imgPath)) {
    clipboard.writeText(imgPath);
    event.sender.send("image-path-copied");
  }
});

ipcMain.on("copy-file-content", (event, filePath) => {
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      clipboard.writeText(content);
      event.sender.send("file-content-copied");
    } catch (err) { console.error(err); }
  }
});

ipcMain.on("get-gallery", (event) => {
  const categories = [];
  const subfolders = fs
    .readdirSync(galleryFolder, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
  const rootFiles = fs.readdirSync(galleryFolder).filter((f) => fs.statSync(path.join(galleryFolder, f)).isFile());

  if (rootFiles.length) {
    categories.push({
      name: "Root",
      path: galleryFolder,
      files: rootFiles.map((f) => ({
        name: f,
        path: path.join(galleryFolder, f),
      })),
    });
  }

  for (const folder of subfolders) {
    const folderPath = path.join(galleryFolder, folder);
    const files = fs
      .readdirSync(folderPath)
      .filter((f) => fs.statSync(path.join(folderPath, f)).isFile())
      .map((f) => ({ name: f, path: path.join(folderPath, f) }));
    categories.push({ name: folder, path: folderPath, files });
  }

  event.sender.send("gallery-list", categories);
});

ipcMain.on("open-file", (event, filePath) => {
  if (fs.existsSync(filePath)) shell.openPath(filePath);
});

ipcMain.on("import-folder-recursive", (event, folderPath) => {
  try {
    const dest = path.join(galleryFolder, path.basename(folderPath));
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    copyRecursiveSync(folderPath, dest);
    event.reply("gallery-updated");
  } catch (err) {
    event.reply("import-folder-error", err.toString());
  }
});

const quickCssPath = path.join(app.getPath("documents"), "DawnClient", "quickcss.css");
if (!fs.existsSync(quickCssPath)) {
  try {
    fs.mkdirSync(path.dirname(quickCssPath), { recursive: true });
    fs.writeFileSync(quickCssPath, "", "utf8");
  } catch (e) {}
}

ipcMain.on("get-quickcss-path", (e) => {
  e.returnValue = quickCssPath;
});

ipcMain.on("reset-juice-settings", () => {
  store.set("settings", default_settings);
  try { fs.writeFileSync(quickCssPath, "", "utf8"); } catch (e) {}
  app.relaunch();
  app.quit();
});

ipcMain.on("save-skin-local", (event, skinname, filePath) => {
  const skinsFolder = path.join(app.getPath("documents"), "DawnClient/swapper/assets/img");
  if (!fs.existsSync(skinsFolder)) fs.mkdirSync(skinsFolder, { recursive: true });
  const fileBuffer = fs.readFileSync(filePath);
  fs.writeFileSync(path.join(skinsFolder, skinname), fileBuffer);
});

ipcMain.on("save-skin-from-buffer", (event, skinname, buffer) => {
  const skinsFolder = path.join(app.getPath("documents"), "DawnClient/swapper/assets/img");
  if (!fs.existsSync(skinsFolder)) fs.mkdirSync(skinsFolder, { recursive: true });
  fs.writeFileSync(path.join(skinsFolder, skinname), buffer);
});

ipcMain.on("save-sound", (event, soundname, filePath, volume) => {
  try {
    const soundsFolder = path.join(app.getPath("documents"), "DawnClient/swapper/assets/media");
    if (!fs.existsSync(soundsFolder)) fs.mkdirSync(soundsFolder, { recursive: true });
    const inputPath = path.resolve(filePath);
    const savePath = path.join(soundsFolder, soundname);

    ffmpeg(inputPath)
      .setFfmpegPath(ffmpegPath)
      .audioFilters(`volume=${volume}`)
      .output(savePath)
      .on("end", () => event.reply("save-sound-success"))
      .on("error", (err) => {
        console.error("FFmpeg error:", err);
        event.reply("save-sound-error", err.message);
      })
      .run();
  } catch (err) {
    event.reply("save-sound-error", err.message);
  }
});

ipcMain.on("navigate", (_, url) => {
  if (gameWindow && !gameWindow.isDestroyed()) {
    gameWindow.loadURL(url);
  }
});

// Bundle cache: memory + disk (keyed by URL filename, e.g. app.abc123.js)
// P0-1: filename is version-suffixed so any patch change invalidates old
// entries; stale entries are pruned at startup (see pruneBundleCache).
// The version is derived from the needle set (below), so editing PATCHES
// invalidates the cache automatically — no manual bump to remember.
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
    if (fs.existsSync(f)) {
      const d = fs.readFileSync(f, 'utf-8');
      if (d.trim().startsWith('<')) {
        try { fs.unlinkSync(f); } catch (e) {}
        return null;
      }
      _bundleCache.set(key, d);
      return d;
    }
  } catch (e) {}
  return null;
};
const _cacheSet = (key, data) => {
  _bundleCache.set(key, data);
  try {
    const d = _cacheDir();
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, _cacheKey(key));
    // Atomic: write tmp then renameSync so cached bundle is immediately accessible
    fs.writeFileSync(f + '.tmp', data, 'utf-8');
    fs.renameSync(f + '.tmp', f);
  } catch (e) {}
};
let _patchProtocolRegistered = false;

const PRELOAD_PATH = path.join(__dirname, "preload", "game.js");
const SPLASH_PRELOAD = path.join(__dirname, "preload", "splash.js");

function fetchText(url) {
  return fetch(url, { signal: AbortSignal.timeout(15000) }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
}

const initResourceSwapper = () => {
  const customDir = path.join(app.getPath("userData"), "custom");
  // normKey -> absolute file path. NormKey is the file's base/hash name with
  // underscores stripped, because the game requests sounds like
  // "___hit___.200043fa.mp3" while the source files are "__hit__.200043fa.mp3".
  const normMap = {};

  const registerFile = (full) => {
    const base = path.basename(full);
    if (!/\.(mp3|png|jpg|jpeg|webp|webm|ogg|wav|css|js|txt|json|svg)$/i.test(base)) return;
    // normalize: strip underscores from the name segment so any underscore
    // count matches; also drop any stray doubled extensions (use.X.mp3.mp3)
    const clean = base.replace(/\.mp3\.mp3$/i, ".mp3").replace(/_/g, "").toLowerCase();
    normMap[clean] = full;
  };

  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    try {
      for (const file of fs.readdirSync(dir)) {
        const full = path.join(dir, file);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full);
        else registerFile(full);
      }
    } catch (e) {}
  };
  walk(customDir);
  walk(path.join(app.getPath("documents"), "DawnClient", "swapper", "assets"));

  // dawnclient://<absolute-file-path> → serve that file straight from disk.
  protocol.handle("dawnclient", (request) => {
    try {
      const filePath = decodeURIComponent(request.url.replace(/^dawnclient:\/\//, ""));
      const fs = require("fs");
      if (filePath && fs.existsSync(filePath)) {
        return new Response(fs.readFileSync(filePath));
      }
    } catch (e) {}
    return new Response("Not found", { status: 404 });
  });

  return normMap;
};

// ── dawn-patch: registry of bundle patches ─────────────────────────────────
// Each entry is a literal string needle → replacement. Needles are verified
// unique in the current bundle (see bundle-research-report.md); a needle that
// stops matching is reported in __patchMeta.missing instead of crashing.
const PATCHES = [
  // onGround hook for current bundle app.c2fce18f.js
  {
    name: 'onGround',
    needle: "iP[d7c(0x3ab6)]=iP[d7c(0x52a9)],iP[d7c(0x52a9)]=this[d7c(0x52a9)]",
    replacement: "iP[d7c(0x3ab6)]=iP[d7c(0x52a9)],iP[d7c(0x52a9)]=window.__onGround=!!this[d7c(0x52a9)]",
  },
  // onGround hook fallback for older bundle app.662a34fb.js
  {
    name: 'onGroundLegacy',
    needle: "iP[da8(0x3d56)]=iP[da8(0x55bf)],iP[da8(0x55bf)]=this[da8(0x55bf)]",
    replacement: "iP[da8(0x3d56)]=iP[da8(0x55bf)],iP[da8(0x55bf)]=window.__onGround=!!this[da8(0x55bf)]",
  },
  // bhop multiplier hook for current bundle app.c2fce18f.js
  {
    name: 'bhopMult',
    needle: "var iV=d73(0x365f)===typeof iT['wWMnwNWm']?iT[d73(0x528b)]:1.5;",
    replacement: "var iV='number'===typeof window.__dawnBhopMult?window.__dawnBhopMult:(d73(0x365f)===typeof iT['wWMnwNWm']?iT[d73(0x528b)]:1.5);",
  },
  // bhop slider expansion for current bundle app.c2fce18f.js
  {
    name: 'bhopSlider',
    needle: "'range','min':'1','max':'3','step':'0.1'",
    replacement: "'range','min':'1','max':'5','step':'0.1'",
  },
  // Fix 0.5x time scaling and eliminate delta jitter at uncapped FPS: use instantaneous frame-accurate delta.
  // window.__dawnTickMul (set from the menu "Logic Tick Rate") divides the
  // re-schedule interval, overclocking the game's self-scheduling main
  // loop: 2 = ~120Hz logic, 4 = ~240Hz logic. Default 1 = stock 60Hz.
  // EXPERIMENTAL: if the world starts moving at 2x speed the tick uses a
  // fixed dt instead of the measured one — set the rate back to 60.
  {
    name: 'gameLoopDeltaFix',
    needle: "window['wmwMNWn']=iM,iL[dhc(0x6857)][dhc(0x2eb5)]=Date[dhc(0x2eb5)](),iL[dhc(0x3918)](0x1/ iM*window[dhc(0x243e)])",
    replacement: "window['wmwMNWn']=iM,iL[dhc(0x6857)][dhc(0x2eb5)]=Date[dhc(0x2eb5)](),(function(){var _now=performance.now();var _dt=window.__lastMainDelta?Math.min(Math.max((_now-window.__lastMainDelta)/1000,0.0005),0.05):0.016;window.__lastMainDelta=_now;iL[dhc(0x3918)](_dt/(window.__dawnTickMul||1)*window[dhc(0x243e)]);})()",
  },
];

// FNV-1a over the needle set → any patch edit auto-invalidates cached bundles.
const _patchHash = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};
const PATCH_VERSION = _patchHash(JSON.stringify(PATCHES));

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

// In-flight dedupe: the warm-up and the game's own request can race for the
// same 6.5MB bundle on a cold cache — share one fetch/patch instead of doing
// two concurrent downloads and two identical disk writes.
const _inflightFetches = new Map();
const patchAndCache = async (targetScriptUrl) => {
  const existing = _inflightFetches.get(targetScriptUrl);
  if (existing) return existing;
  const p = (async () => {
    const t0 = Date.now();
    let code = await fetchText(targetScriptUrl);
    if (!code || code.trim().startsWith('<')) {
      throw new Error(`Invalid JS response (HTML) for ${targetScriptUrl}`);
    }
    const { code: patched, meta } = applyPatches(code);
    const finalCode = patched + `\n//# sourceURL=${targetScriptUrl}` + `\nwindow.__patchMeta = ${JSON.stringify(meta)};`;
    _cacheSet(targetScriptUrl, finalCode);
    console.log(`[dawn-patch] ${meta.applied.length ? 'patched' : 'passthrough'} ${new URL(targetScriptUrl).pathname.split('/').pop()} in ${Date.now() - t0}ms — applied:[${meta.applied.join(',') || '-'}] missing:[${meta.missing.join(',') || '-'}]`);
    return finalCode;
  })();
  _inflightFetches.set(targetScriptUrl, p);
  try {
    return await p;
  } finally {
    _inflightFetches.delete(targetScriptUrl);
  }
};

// Warm the bundle cache during splash so the game window's first script
// request usually hits the cache. This runs in PARALLEL with window creation
// (never gates it) — a slow fetch must not delay startup.
//
// Warm-start shortcut: remember the last seen app.<hash>.js URL. If the
// bundle for it is already on disk we skip the index-HTML fetch entirely
// (one less network round-trip per warm launch); if the game shipped a new
// bundle the URL miss falls through to the live index fetch.
const _lastBundleUrlFile = () => path.join(_cacheDir(), 'last-bundle-url.txt');
const _rememberBundleUrl = (url) => {
  try {
    fs.mkdirSync(_cacheDir(), { recursive: true });
    fs.writeFileSync(_lastBundleUrlFile(), url, 'utf-8');
  } catch (e) {}
};
const warmBundleCache = async () => {
  try {
    const base = settings.base_url || 'https://kirka.io/';
    try {
      const lastUrl = fs.readFileSync(_lastBundleUrlFile(), 'utf-8').trim();
      if (lastUrl && _cacheGet(lastUrl)) {
        console.log('[dawn-patch] warm: cached bundle URL from last run, skipping index fetch');
        return true;
      }
    } catch (e) {}
    const html = await fetchText(base);
    const m = html.match(/assets\/js\/(app\.\w+\.js)/);
    if (!m) { console.warn('[dawn-patch] warm: app bundle URL not found in index page'); return false; }
    // Use m[0] ('assets/js/app.xxx.js') to avoid fetching the HTML fallback at root
    const url = new URL(m[0], base).href;
    if (_cacheGet(url)) { _rememberBundleUrl(url); console.log('[dawn-patch] warm: already cached', m[1]); return true; }
    await patchAndCache(url);
    _rememberBundleUrl(url);
    return true;
  } catch (err) {
    console.warn('[dawn-patch] warm failed:', err.message);
    return false;
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
    icon: path.join(__dirname, "assets/img/icon.png"),
    width: 500,
    height: 500,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, "preload/splash.js"),
    },
  });

  splashWindow.loadFile(path.join(__dirname, "assets/html/splash.html"));
  splashWindow.once("ready-to-show", () => {
    splashWindow.show();
    splashWindow.webContents.send("splash-ready");
  });

  splashWindow.on("closed", () => {
    ipcMain.removeAllListeners("quit-and-install");
    splashWindow = null;
  });
};

ipcMain.on("check-for-updates", () => {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send("update-not-available");
  }
});

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
      nodeIntegration: true,
      webviewTag: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      disablePointerLockWait: true,
      scrollBounce: false,
      pinchZoom: false,
      experimentalFeatures: false,
      backgroundThrottling: false,
      spellcheck: false,
      enableWebSQL: false,
      enableBlinkFeatures: 'PointerLockV2',
    },
    backgroundColor: "#141414",
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
    _failLoadAttempt = 0;
    _perf('game did-finish-load');
    applyFrameCap();
    try {
      gameWindow.webContents.executeJavaScript(
        'if (performance.memory) console.log("[mem] heap after load:", Math.round(performance.memory.usedJSHeapSize / 1048576) + "MB");'
      );
    } catch (e) {}
    if (gameWindow && !gameWindow.isVisible() && !gameWindow.isDestroyed()) {
      gameWindow.show();
    }
    const _telemetryInterval = setInterval(async () => {
      if (!gameWindow || gameWindow.isDestroyed()) { clearInterval(_telemetryInterval); return; }
      // Frame telemetry only matters in a match — skip the 2s
      // executeJavaScript round-trip while sitting in the lobby.
      if (!_navIsMatch(gameWindow.webContents.getURL())) return;
      try {
        const stats = await gameWindow.webContents.executeJavaScript('window.__dawnTelemetry?.getStats()');
        if (stats && stats.ready) {
          console.log(`[live-telemetry] FPS: ${stats.fps} | FT avg: ${stats.avgFt}ms (min: ${stats.minFt}ms, max: ${stats.maxFt}ms, p99: ${stats.p99Ft}ms) | Jitter: ${stats.jitter}ms | Stutters: ${stats.stutters} | Hitches: ${stats.hitches} | Frames: ${stats.totalFrames}`);
        }
      } catch (e) {}
    }, 2000);
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

  let _unresponsiveTimer = null;
  gameWindow.webContents.on("unresponsive", () => {
    clearTimeout(_unresponsiveTimer);
    _unresponsiveTimer = setTimeout(() => {
      _unresponsiveTimer = null;
      try {
        // Never hard-reload mid-match — that's an instant loss. Only recover
        // outside a match; in-game we let the renderer settle or crash-handle.
        if (_navIsMatch(gameWindow.webContents.getURL())) {
          console.warn("[game] Unresponsive mid-match — skipping reload");
          return;
        }
        gameWindow.reload();
      } catch (e) {}
    }, 5000);
  });
  // A GC spike or hitch that resolves within 5s must not still trigger
  // the reload — cancel the pending recovery as soon as it wakes up.
  gameWindow.webContents.on("responsive", () => {
    if (_unresponsiveTimer) {
      clearTimeout(_unresponsiveTimer);
      _unresponsiveTimer = null;
    }
  });

  gameWindow.webContents.on("did-fail-load", (_, code, desc) => {
    if (code === -3 || code === -6) {
      // Back off: 2s → 4s → 8s → … (max 15s) so a dead server or offline
      // network doesn't hammer a reload loop every 2 seconds forever.
      _failLoadAttempt++;
      const delay = Math.min(2000 * Math.pow(2, _failLoadAttempt - 1), 15000);
      setTimeout(() => { try { gameWindow.reload(); } catch (e) {} }, delay);
    }
  });

  gameWindow.webContents.on("did-start-navigation", () => {
    releaseSyntheticKeys();
  });

  gameWindow.webContents.on("did-navigate-in-page", (e, url) => {
    const wasInMatch = _navIsMatch(_navPreviousUrl);
    const nowInMatch = _navIsMatch(url);
    if (wasInMatch && !nowInMatch) {
      matchEnded();
    }
    _navPreviousUrl = url;

    gameWindow.webContents.send("url-change", url);

    if (settings.discord_rpc && gameWindow.DiscordRPC) {
      const base_url = settings.base_url;
      const stateMap = {
        [`${base_url}`]: "In the lobby",
        [`${base_url}hub/leaderboard`]: "Viewing the leaderboard",
        [`${base_url}hub/clans/champions-league`]: "Viewing the clan leaderboard",
        [`${base_url}hub/clans/my-clan`]: "Viewing their clan",
        [`${base_url}hub/market`]: "Viewing the market",
        [`${base_url}hub/live`]: "Viewing videos",
        [`${base_url}hub/news`]: "Viewing news",
        [`${base_url}hub/terms`]: "Viewing the terms of service",
        [`${base_url}store`]: "Viewing the store",
        [`${base_url}servers/main`]: "Viewing main servers",
        [`${base_url}servers/parkour`]: "Viewing parkour servers",
        [`${base_url}servers/custom`]: "Viewing custom servers",
        [`${base_url}quests/hourly`]: "Viewing hourly quests",
        [`${base_url}friends`]: "Viewing friends",
        [`${base_url}inventory`]: "Viewing their inventory",
      };

      let state;
      if (stateMap[url]) {
        state = stateMap[url];
      } else if (url.startsWith(`${base_url}games/`) || url.startsWith(`${base_url}hub/ranked`)) {
        state = "In a match";
      } else if (url.startsWith(`${base_url}profile/`)) {
        state = "Viewing a profile";
      } else {
        state = "In the lobby";
      }

      try {
        gameWindow.DiscordRPC.setState(state);
      } catch (err) {}
    }
  });

  gameWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  gameWindow.on("page-title-updated", (e) => e.preventDefault());

  gameWindow.on("closed", () => {
    releaseSyntheticKeys();
    ipcMain.removeAllListeners("get-settings");
    ipcMain.removeAllListeners("update-setting");
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
  startMemoryWatchdog();

  const bundleFilter = { urls: ['*://kirka.io/assets/js/app.*.js', '*://kirka.io/assets/js/chunk-*.js'] };
  // Broad filter over the game's proxy domains AND their subdomains (assets
  // are served from e.g. cdn.kirka.io / static.kirka.io), so sound/media URL
  // matching is done in the handler (where we normalize underscores), not via
  // brittle per-file URL filters.
  const proxyDomains = ["kirka.io", "snipers.io", "ask101math.com", "fpsiogame.com", "cloudconverts.com"];
  const proxyFilter = { urls: proxyDomains.flatMap(d => [`*://${d}/*`, `*://*.${d}/*`]) };
  const allUrls = [...bundleFilter.urls, ...proxyFilter.urls];

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    const origin = details.requestHeaders?.Origin || details.requestHeaders?.origin;
    headers['Access-Control-Allow-Origin'] = origin ? [origin] : ['*'];
    headers['Access-Control-Allow-Credentials'] = ['true'];
    headers['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS, HEAD'];
    headers['Access-Control-Allow-Headers'] = ['*'];
    headers['Cross-Origin-Resource-Policy'] = ['cross-origin'];
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    callback({ responseHeaders: headers });
  });

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
          const base = urlPath.split('/').pop() || "";
          // Normalize exactly like the swapper: strip underscores + lower-case
          // so "___hit___.200043fa.mp3" matches "__hit__.200043fa.mp3".
          const clean = base.replace(/\.mp3\.mp3$/i, ".mp3").replace(/_/g, "").toLowerCase();
          const file = customFiles[clean];
          if (file) {
            return callback({ redirectURL: 'dawnclient://' + encodeURIComponent(file) });
          }
        } catch (e) {}
      }

      callback({ cancel: false });
    }
  );

  const targetUrl = settings.base_url || "https://kirka.io/";
  if (process.env.DAWN_DEBUG) {
    setTimeout(() => {
      const urls = ['https://kirka.io', 'https://api2.kirka.io', 'https://login.xsolla.com'];
      urls.forEach(u => {
        session.defaultSession.cookies.get({ url: u }).then(cookies => {
          console.log(`[cookies] ${u}:`, cookies.map(c => `${c.name}=${c.value} domain=${c.domain} samesite=${c.sameSite}`).join(', ') || '(none)');
        }).catch(() => {});
      });
    }, 10000);
  }
  gameWindow.loadURL(targetUrl);
  applyFrameCap();
  gameWindow.maximize();
  registerShortcuts(gameWindow);
  if (settings.discord_rpc) {
    try {
      gameWindow.DiscordRPC = new DiscordRPC();
    } catch (e) {
      console.warn("DiscordRPC failed to initialize:", e);
    }
  }

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

const _forceGC = () => {
  if (!gameWindow || gameWindow.isDestroyed()) return;
  try {
    gameWindow.webContents.executeJavaScript(
      'if (typeof gc === "function") { gc(true); gc(true); }'
    );
  } catch (e) {}
};

let _lastMatchEndedAt = 0;
const matchEnded = () => {
  const now = Date.now();
  if (now - _lastMatchEndedAt < 3000) return;
  _lastMatchEndedAt = now;
  console.log("[game] Match ended — flushing GPU state");
  try {
    gameWindow.webContents.executeJavaScript(`
      if (typeof gc === "function") { gc(true); gc(true); }
      if (performance.memory) console.log("[mem] heap after match:", Math.round(performance.memory.usedJSHeapSize / 1048576) + "MB");
    `);
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

// ── Memory watchdog (renderer + GPU process) ───────────────────────────────
// The game bundle leaks per match (textures/models accumulate); guard against
// the "fine at first, progressively slower" creep. Nudge GC over the soft
// limit, hard-reload (only outside a match) over the hard limit. The GPU
// process holds the texture memory on macOS — watch it separately so a
// leak there gets caught too.
const _MEM_WATCH_MS = 30000;
const _MEM_SOFT_LIMIT = 2 * 1024 * 1024 * 1024;
const _MEM_HARD_LIMIT = 3.5 * 1024 * 1024 * 1024;
const _GPU_HARD_LIMIT = 2.5 * 1024 * 1024 * 1024;
let _memWatchTimer = null;

const startMemoryWatchdog = () => {
  if (_memWatchTimer) return;
  _memWatchTimer = setInterval(async () => {
    try {
      if (!gameWindow || gameWindow.isDestroyed()) return;
      if (gameWindow.webContents.isLoading()) return;
      const inMatch = _navIsMatch(gameWindow.webContents.getURL());

      const info = await gameWindow.webContents.getProcessMemoryInfo();
      const rss = info.privateMemory || info.workingSetSize || 0;
      if (rss > _MEM_HARD_LIMIT && !inMatch) {
        console.warn(`[mem] renderer RSS ${(rss / 1073741824).toFixed(2)}GB — hard reload`);
        gameWindow.reload();
        return;
      } else if (rss > _MEM_SOFT_LIMIT && !inMatch) {
        console.warn(`[mem] renderer RSS ${(rss / 1073741824).toFixed(2)}GB — forcing GC`);
        _forceGC();
      }

      let gpu = null;
      for (const m of app.getAppMetrics()) if (m.type === "GPU") gpu = m;
      const gpuRss = gpu?.memory?.workingSetSize || 0;
      if (gpuRss > _GPU_HARD_LIMIT && !inMatch) {
        console.warn(`[mem] GPU process RSS ${(gpuRss / 1073741824).toFixed(2)}GB — hard reload`);
        gameWindow.reload();
      }
    } catch (e) {}
  }, _MEM_WATCH_MS);
};

const _t0 = Date.now();
const _perf = (label) => console.log(`[perf] ${label} +${Date.now() - _t0}ms`);

const initGame = () => {
  _perf('initGame');
  pruneBundleCache();
  createSplashWindow();
  // Warm in parallel — never block window creation on the network.
  warmBundleCache().catch(() => {});
  // The splash window is alwaysOnTop and paints within ~50ms, so the game
  // window starts loading immediately — no artificial delay needed.
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
};

app.on("ready", () => {
  _perf('app ready');
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
  // Flush any debounced settings write so the last change isn't lost.
  if (_settingsSaveTimer) {
    clearTimeout(_settingsSaveTimer);
    _settingsSaveTimer = null;
    store.set("settings", settings);
  }
});

app.on("window-all-closed", () => app.quit());

module.exports = { initGame, getGameWindow };
