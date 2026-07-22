const { app, ipcMain, globalShortcut, protocol } = require("electron");
const { applySwitches } = require("./util/switches");

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

app.on("child-process-gone", (_, details) => {
  console.error(`[main] child-process-gone: type=${details.type} reason=${details.reason}`);
  if (details.type !== "GPU") return;
  // GPU just crashed. Chromium will restart it immediately (thanks to
  // --disable-gpu-process-crash-limit). Wait 1.5s for the restart to
  // finish, then reload the game page so it creates a fresh WebGL context
  // on the new GPU process (instead of falling back to SwiftShader).
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
  }, 1500);
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => app.quit());
