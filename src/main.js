const { app } = require("electron");
const { initSplash } = require("./windows/splash");
const { applySwitches } = require("./util/switches");

applySwitches();

app.on("ready", async () => {
  initSplash();
});

app.on("window-all-closed", () => app.quit());
