const { BrowserWindow, ipcMain } = require("electron");
const { initGame } = require("./game");
const path = require("path");

let splashWindow;

const createWindow = () => {
  splashWindow = new BrowserWindow({
    icon: path.join(__dirname, "../assets/img/icon.png"),
    width: 500,
    height: 500,
    frame: false,
    // NOTE: removed transparent:true — on Apple Silicon / Electron 12 the
    // transparent window forces ANGLE to composite via GL_TEXTURE_RECTANGLE_ARB
    // IOSurfaces, which makes Chromium's GL decoder log GL_INVALID_ENUM every
    // frame on the game's WebGL context (.WebGL-*) and adds per-frame validation
    // overhead -> stutter. An opaque splash with a solid bg is visually identical
    // for the ~100ms it shows and keeps the GPU process in a clean 2D-texture mode.
    backgroundColor: "#07070a",
    alwaysOnTop: true,
    resizable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "../preload/splash.js"),
    },
  });

  splashWindow.loadFile(path.join(__dirname, "../assets/html/splash.html"));
  splashWindow.once("ready-to-show", () => {
    splashWindow.show();
    splashWindow.webContents.send("splash-ready");
    handleClose();
  });

  splashWindow.on("closed", () => {
    splashWindow = null;
  });
};

const handleClose = () =>
  setTimeout(() => {
    if (splashWindow) {
      initGame();
      splashWindow.close();
    }
  }, 100);

const initSplash = createWindow;

module.exports = { initSplash };
