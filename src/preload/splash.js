const { ipcRenderer } = require("electron");

document.addEventListener("DOMContentLoaded", () => {
  const versionElement = document.querySelector(".ver");
  const statusElement = document.querySelector(".status");
  const statusContainerElement = document.querySelector(".status-container");
  const iconElement = document.querySelector(".icon");
  const titleElement = document.querySelector(".title");

  ipcRenderer.on("splash-ready", () => {
    setTimeout(() => {
      if (iconElement) iconElement.style.transform = "translateY(calc(-120% + 50px)) scale(0.4)";
      if (versionElement) { versionElement.style.opacity = "1"; versionElement.style.top = "69px"; }
      if (titleElement) { titleElement.style.opacity = "1"; titleElement.style.top = "40px"; }
      if (statusContainerElement) statusContainerElement.style.opacity = "1";
    }, 1000);
  });

  if (versionElement) versionElement.textContent = "v1.1.8";
  if (statusElement) statusElement.textContent = "Launching...";
});