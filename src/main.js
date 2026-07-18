const { app, ipcMain, globalShortcut } = require("electron");
const { initSplash } = require("./windows/splash");
const { getGameWindow } = require("./windows/game");
const { applySwitches } = require("./util/switches");
const fs = require("fs");
const path = require("path");
const os = require("os");

applySwitches();

app.on("ready", async () => {
  initSplash();
  try { require("os").setPriority(process.pid, -10); } catch (e) {}
  globalShortcut.register("F8", () => {
    const gw = getGameWindow();
    if (gw && !gw.isDestroyed()) gw.webContents.send("toggle-menu");
  });
  console.log("[menu] F8 registered:", globalShortcut.isRegistered("F8"));
  globalShortcut.register("Shift+F8", () => {
    const gw = getGameWindow();
    if (gw && !gw.isDestroyed()) gw.webContents.send("toggle-menu");
  });
  //TEMP-TEST
  if (process.argv.includes("--test-menu")) {
    const _testTimer = setInterval(() => {
      const gw = getGameWindow();
      if (gw && !gw.isDestroyed()) {
        clearInterval(_testTimer);
        setTimeout(() => {
          if (!gw.isDestroyed()) gw.webContents.executeJavaScript("if(window.__testToggleMenu) window.__testToggleMenu();");
        }, 3000);
      }
    }, 500);
  }
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
});

ipcMain.on("save-recording", (e, buf) => {
  try {
    const clipsDir = path.join(os.homedir(), "Movies", "clips");
    fs.mkdirSync(clipsDir, { recursive: true });
    const filepath = path.join(clipsDir, `dawn-${Date.now()}.webm`);
    fs.writeFile(filepath, Buffer.from(buf), (err) => {
      if (err) console.error("Failed to save recording:", err);
    });
  } catch (err) {
    console.error("Failed to save recording:", err);
  }
});

app.on("window-all-closed", () => app.quit());
