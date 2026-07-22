const { ipcRenderer, contextBridge } = require("electron");

contextBridge.exposeInMainWorld("splashAPI", {
  onShow: (callback) => {
    ipcRenderer.on("splash-show", callback);
  }
});