"use strict";

// Electron's before-input-event reports DOM-style codes, while
// webContents.sendInputEvent expects accelerator key names. Keep the mapping
// here so focus recovery can be tested without loading Electron.
const MODIFIER_KEY_CODES = Object.freeze(["Control", "Shift", "Alt", "Meta"]);

const keyCodeFromInput = (input = {}) => {
  const code = String(input.code || "");
  const key = String(input.key || "");

  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (code.startsWith("Control")) return "Control";
  if (code.startsWith("Shift")) return "Shift";
  if (code.startsWith("Alt")) return "Alt";
  if (code.startsWith("Meta")) return "Meta";

  const byCode = {
    Space: "Space",
    Escape: "Escape",
    Enter: "Enter",
    NumpadEnter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ArrowUp: "Up",
    ArrowDown: "Down",
  };
  if (byCode[code]) return byCode[code];
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return key || code || null;
};

class InputStateGuard {
  constructor(now = Date.now) {
    this.now = now;
    this.held = new Map();
    this.pendingReleases = new Set();
    this.blurredAt = 0;
    this.sequence = 0;
  }

  record(input = {}) {
    const identity = String(input.code || input.key || "");
    if (!identity) return;
    if (input.type === "keyDown") {
      const keyCode = keyCodeFromInput(input);
      if (keyCode) this.held.set(identity, keyCode);
    } else if (input.type === "keyUp") {
      this.held.delete(identity);
    }
  }

  blur() {
    this.blurredAt = this.now();
    this.sequence++;
    for (const keyCode of this.held.values()) this.pendingReleases.add(keyCode);
    // Modifier key-up is the event most commonly lost while macOS changes
    // Spaces. Always sanitize all four even if the key-down was also missed.
    for (const keyCode of MODIFIER_KEY_CODES) this.pendingReleases.add(keyCode);
    this.held.clear();
    return {
      sequence: this.sequence,
      releaseKeys: [...this.pendingReleases],
    };
  }

  focus() {
    const focusedAt = this.now();
    const hadBlur = this.blurredAt > 0;
    const awayMs = hadBlur ? Math.max(0, focusedAt - this.blurredAt) : 0;
    const releaseKeys = new Set(this.pendingReleases);
    for (const keyCode of MODIFIER_KEY_CODES) releaseKeys.add(keyCode);
    this.pendingReleases.clear();
    this.blurredAt = 0;
    return {
      sequence: this.sequence,
      hadBlur,
      awayMs,
      releaseKeys: [...releaseKeys],
    };
  }

  reset() {
    this.held.clear();
    this.pendingReleases.clear();
    this.blurredAt = 0;
  }
}

module.exports = {
  InputStateGuard,
  MODIFIER_KEY_CODES,
  keyCodeFromInput,
};
