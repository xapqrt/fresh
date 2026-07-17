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

const createWindow = () => {
  gameWindow = new BrowserWindow({
    fullscreen: process.platform !== "darwin" && settings.auto_fullscreen,
    icon: path.join(__dirname, "../assets/img/icon.ico"),
    title: "Dawn Client",
    width: 1280,
    height: 720,
    show: false,
    backgroundColor: "#141414",
    backgroundThrottling: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      sandbox: false,
      webSecurity: false,
      preload: path.join(__dirname, "../preload/game.js"),
    },
  });

  if (process.platform === "darwin" && settings.auto_fullscreen) {
    gameWindow.once("ready-to-show", () => {
      gameWindow.setFullScreen(true);
    });
  }

  gameWindow.webContents.setUserAgent(
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.296 Safari/537.36 Electron/10.4.7 DawnClient/${app.getVersion()}`
  );

  gameWindow.webContents.on("new-window", (e, url) => {
    e.preventDefault();
    require("electron").shell.openExternal(url);
  });

  gameWindow.webContents.on("did-navigate-in-page", (e, url) => {
    gameWindow.webContents.send("url-change", url);
  });

  gameWindow.loadURL(settings.base_url);
  gameWindow.removeMenu();
  gameWindow.maximize();

  gameWindow.once("ready-to-show", () => {
    gameWindow.show();
  });

  gameWindow.on("page-title-updated", (e) => e.preventDefault());

  gameWindow.on("closed", () => {
    ipcMain.removeAllListeners("get-settings");
    ipcMain.removeAllListeners("update-setting");
    gameWindow = null;
  });
};

const initGame = () => {
  protocol.registerBufferProtocol('dawn-patch', (request, callback) => {
    const urlParams = new URL(request.url);
    const targetScriptUrl = urlParams.searchParams.get('url');
    fetchText(targetScriptUrl).then((code) => {
      const target = "f5['a'][hF]";
      if (code.includes(target)) {
        code = code.replace(target, "(window.__f5=f5,window.__zoomInstance=this,f5['a'][hF])");
      }
      code += `\n//# sourceURL=${targetScriptUrl}`;
      callback({ mimeType: 'text/javascript', data: Buffer.from(code) });
    }).catch((err) => {
      console.error('dawn-patch fetch failed:', err);
      callback({ statusCode: 500 });
    });
  });

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
};
