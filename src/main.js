const { app, ipcMain } = require("electron");
const { initSplash } = require("./windows/splash");
const { applySwitches } = require("./util/switches");
const fs = require("fs");
const path = require("path");
const os = require("os");

applySwitches();

app.on("ready", async () => {
  initSplash();
  try { require("os").setPriority(process.pid, -10); } catch (e) {}
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
