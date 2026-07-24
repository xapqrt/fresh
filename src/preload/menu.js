// src/preload/menu.js (minimal example)

class Menu {
  constructor() {
    this.overlay = document.createElement("div");
    this.overlay.style.cssText = "position:fixed;top:0;left:0;z-index:10000;background:rgba(0,0,0,0.5);width:100%;height:100%;display:none;";
    document.body.appendChild(this.overlay);
  }
  toggle() {
    this.overlay.style.display = this.overlay.style.display === "none" ? "" : "none";
  }
}

window.__dawnMenu = new Menu();