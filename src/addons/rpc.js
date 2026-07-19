const rpc = require("discord-rpc");
const { version } = require("../../package.json");

class DiscordRPC {
  constructor() {
    if (DiscordRPC._instance) return DiscordRPC._instance;
    DiscordRPC._instance = this;
    this.clientId = "1384959605712355479";
    this.startTimestamp = Date.now();
    this.client = new rpc.Client({ transport: "ipc" });
    this._retryDelay = 5000;
    this._reconnectTimer = null;
    this.init();
  }

  destroy() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try {
      this.client.destroy();
    } catch (e) {
      /* already closed */
    }
  }

  init() {
    this._reconnectTimer = null;
    this.client.on("ready", () => { this._retryDelay = 5000; this.setActivity(); });
    this.client.on("disconnected", () => {
      if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this._retryDelay = Math.min(this._retryDelay * 2, 60000);
        this.login();
      }, this._retryDelay);
    });
    this.login();
  }

  login() {
    this.client.login({ clientId: this.clientId }).catch(console.error);
  }

  setActivity(activity = this.defaultActivity()) {
    this.client.setActivity(activity).catch(console.error);
  }

  setState(state) {
    const activity = this.defaultActivity();
    activity.state = state;
    this.setActivity(activity);
  }

  defaultActivity() {
    return {
      startTimestamp: this.startTimestamp,
      state: "In the lobby",
      largeImageKey: "dawn",
      largeImageText: `Dawn Client v${version}`,
      instance: false,
      buttons: [
        { label: "Discord", url: "https://discord.gg/VsMEQ3HWs2" },
        { label: "Download", url: "https://github.com/zVipexx/dawn-client" },
      ],
    };
  }
}

module.exports = DiscordRPC;
