const { app, ipcMain, globalShortcut, protocol } = require("electron");
const { applySwitches } = require("./util/switches");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Allow the app shell (https + dawn-patch) to load without CSP/storage blocks.
// Without this, the login page renders blank and auth never completes.
protocol.registerSchemesAsPrivileged([
  { scheme: "https", privileges: { bypassCSP: true, secure: true, supportFetchAPI: true } },
  { scheme: "dawn-patch", privileges: { bypassCSP: true, secure: true, supportFetchAPI: true, standard: true, corsEnabled: true } },
  { scheme: "dawnclient", privileges: { bypassCSP: true, secure: true, supportFetchAPI: true, standard: true, corsEnabled: true } },
]);

applySwitches();


const { initGame, getGameWindow } = require("./windows/game");

app.on("ready", async () => {
  initGame();
  try { require("os").setPriority(process.pid, -10); } catch (e) {}
  // macOS: disable App Nap / sudden termination so the game process is never
  // throttled or suspended (kills the "laggy after a few matches" symptom).
  try {
    if (process.platform === "darwin") {
      const { app: electronApp } = require("electron");
      if (electronApp.disableAppNap) electronApp.disableAppNap("Dawn Client is a game");
      if (electronApp.disableSuddenTermination) electronApp.disableSuddenTermination();
    }
  } catch (e) {}
  globalShortcut.register("F8", () => {
    const gw = getGameWindow();
    if (gw && !gw.isDestroyed()) gw.webContents.send("toggle-menu");
  });
  console.log("[menu] F8 registered:", globalShortcut.isRegistered("F8"));
  globalShortcut.register("Shift+F8", () => {
    const gw = getGameWindow();
    if (gw && !gw.isDestroyed()) gw.webContents.send("toggle-menu");
  });
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
