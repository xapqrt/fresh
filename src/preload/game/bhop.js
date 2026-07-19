var _ipc = null;
try { _ipc = require('electron').ipcRenderer; } catch (e) { }

function installBhopHook(capCheck) {
  var _shiftDown = false;
  var _qDown = false;
  var _bhopOn = false;
  var _qDownPhys = false;
  var _rAFId = null;
  var _phase = 0;

  var _aDown = false;
  var _dDown = false;
  var _strafeKey = null;
  var _strafePhysDown = false;

  // Decoupled strafe-switch timing (air-control). Independent from the jump
  // pulse so the direction flip lands mid-air for max speed gain.
  var _strafeSwitchMs = 130;
  var _lastStrafeSwitch = 0;

  var _qDownEvt = new KeyboardEvent("keydown", {
    key: "q", code: "KeyQ", keyCode: 81, which: 81,
    bubbles: true, cancelable: true,
  });
  var _qUpEvt = new KeyboardEvent("keyup", {
    key: "q", code: "KeyQ", keyCode: 81, which: 81,
    bubbles: true, cancelable: true,
  });
  var _aDownEvt = new KeyboardEvent("keydown", {
    key: "a", code: "KeyA", keyCode: 65, which: 65,
    bubbles: true, cancelable: true,
  });
  var _aUpEvt = new KeyboardEvent("keyup", {
    key: "a", code: "KeyA", keyCode: 65, which: 65,
    bubbles: true, cancelable: true,
  });
  var _dDownEvt = new KeyboardEvent("keydown", {
    key: "d", code: "KeyD", keyCode: 68, which: 68,
    bubbles: true, cancelable: true,
  });
  var _dUpEvt = new KeyboardEvent("keyup", {
    key: "d", code: "KeyD", keyCode: 68, which: 68,
    bubbles: true, cancelable: true,
  });

  var _qD = { type: 'keyDown', keyCode: 81, code: 'KeyQ', key: 'q' };
  var _qU = { type: 'keyUp', keyCode: 81, code: 'KeyQ', key: 'q' };
  var _aD = { type: 'keyDown', keyCode: 65, code: 'KeyA', key: 'a' };
  var _aU = { type: 'keyUp', keyCode: 65, code: 'KeyA', key: 'a' };
  var _dD = { type: 'keyDown', keyCode: 68, code: 'KeyD', key: 'd' };
  var _dU = { type: 'keyUp', keyCode: 68, code: 'KeyD', key: 'd' };

  // Key code table hoisted to module scope — avoids allocating a fresh
  // object on every bhop keypress (cuts per-frame GC churn at high hop rates).
  var _KEY_CODES = {
    q: { keyCode: 81, code: 'KeyQ', key: 'q' },
    a: { keyCode: 65, code: 'KeyA', key: 'a' },
    d: { keyCode: 68, code: 'KeyD', key: 'd' },
  };

  function _postKey(key, down) {
    // Relay to the main process, which dispatches via the CDP debugger's
    // Input.dispatchKeyEvent (lowest latency, bypasses the page event pipeline).
    // Falls back to direct DOM dispatch if IPC is unavailable.
    if (_ipc) {
      var m = _KEY_CODES[key];
      if (m) {
        try { _ipc.send('dawn-bhop-key', { type: down ? 'keyDown' : 'keyUp', keyCode: m.keyCode, code: m.code, key: m.key }); return; } catch (e) {}
      }
    }
    if (key === 'q') document.dispatchEvent(down ? _qDownEvt : _qUpEvt);
    else if (key === 'a') document.dispatchEvent(down ? _aDownEvt : _aUpEvt);
    else if (key === 'd') document.dispatchEvent(down ? _dDownEvt : _dUpEvt);
  }

  function _isInput(el) {
    if (!el) return false;
    var t = el.tagName;
    return t === "INPUT" || t === "TEXTAREA" || el.isContentEditable ||
      (el.getAttribute && el.getAttribute("role") === "textbox");
  }

  var _lastToggle = 0;
  var _holdMs = 14;
  var _jitterMs = 2;
  var _jitterAccum = 0;

  var _VYSNC_BUDGET = 3.6;
  var _VSYNC_PERIOD = 4.2;

  var _groundedCache = null;
  var _groundedValid = false;

  function _checkGrounded() {
    try {
      var v = window.__onGround;
      if (typeof v === 'boolean') {
        _groundedCache = v;
        _groundedValid = true;
        return v;
      }
    } catch (e) {}
    _groundedValid = false;
    return null;
  }

  function _pulseStrafe() {
    if (!_strafeKey) return;
    // If the user is physically holding the strafe key, never send a synthetic
    // keyup — that would drop their held input for a frame and cause a "stall"
    // in that direction. Only auto-pulse (toggle) when the key is NOT held.
    var physicallyHeld = (_strafeKey === 'a' && _aDown) || (_strafeKey === 'd' && _dDown);
    if (physicallyHeld) { _strafePhysDown = true; return; }
    _postKey(_strafeKey, false);
    _postKey(_strafeKey, true);
    _strafePhysDown = true;
  }

  // Decoupled strafe flip: toggles the strafe direction on its own timer
  // (independent of the jump pulse) for optimal air-control / speed.
  function _strafeSwitch() {
    if (!_strafeKey) return;
    var physicallyHeld = (_strafeKey === 'a' && _aDown) || (_strafeKey === 'd' && _dDown);
    if (physicallyHeld) return; // user is steering manually; don't fight them
    _postKey(_strafeKey, false);
    _strafeKey = (_strafeKey === 'a') ? 'd' : 'a';
    _postKey(_strafeKey, true);
    _strafePhysDown = true;
  }

  function _tick(now) {
    if (!_bhopOn) { _rAFId = null; return; }

    if (capCheck && !capCheck(now)) { _rAFId = requestAnimationFrame(_tick); return; }

    // Decoupled strafe switching (air-control), runs on its own cadence.
    if (_strafeKey && (now - _lastStrafeSwitch) >= _strafeSwitchMs) {
      _lastStrafeSwitch = now;
      _strafeSwitch();
    }

    var grounded = _checkGrounded();

    if (grounded === true) {
      _lastToggle = now - _holdMs - _jitterMs;
      if (_phase === 1) {
        _qDownPhys = false; _postKey('q', false); _phase = 2;
      }
      _qDownPhys = true; _postKey('q', true);
      _phase = 1;
      _jitterAccum = Math.random() * _jitterMs;
      _rAFId = requestAnimationFrame(_tick);
      return;
    }

    if (grounded === false) {
      _rAFId = requestAnimationFrame(_tick);
      return;
    }

    if (_lastToggle !== 0 && performance.now() - now > _VYSNC_BUDGET) {
      _rAFId = requestAnimationFrame(_tick);
      return;
    }

    if (now - _lastToggle < _holdMs + _jitterAccum) {
      _rAFId = requestAnimationFrame(_tick);
      return;
    }

    _lastToggle = now;
    _jitterAccum = Math.random() * _jitterMs;

    if (_phase === 1) {
      _qDownPhys = false; _postKey('q', false); _phase = 2;
    } else if (_phase === 2) {
      _qDownPhys = true; _postKey('q', true);
      // NOTE: strafe is driven by the decoupled _strafeSwitch timer (air-control),
      // not here — calling _pulseStrafe() too would double-flip the direction.
      _phase = 1;
    }
    _rAFId = requestAnimationFrame(_tick);
  }

  function _start() {
    if (_bhopOn) return;
    _bhopOn = true;
    _checkGrounded();
    _strafeKey = _aDown ? 'a' : (_dDown ? 'd' : null);
    _strafePhysDown = false;
    _lastStrafeSwitch = performance.now();
    _phase = 1; _qDownPhys = true; _postKey('q', true);
    _lastToggle = performance.now();
    _rAFId = requestAnimationFrame(_tick);
  }

  function _stop() {
    if (!_bhopOn) return;
    _bhopOn = false;
    if (_rAFId !== null) { cancelAnimationFrame(_rAFId); _rAFId = null; }
    if (_qDownPhys) { _qDownPhys = false; _postKey('q', false); }
    if (_strafePhysDown && _strafeKey) {
      // Don't release a strafe key the user is still physically holding.
      var physicallyHeld = (_strafeKey === 'a' && _aDown) || (_strafeKey === 'd' && _dDown);
      if (!physicallyHeld) _postKey(_strafeKey, false);
      _strafePhysDown = false;
    }
    _strafeKey = null;
    _phase = 0;
  }

  function _reset() { _shiftDown = false; _qDown = false; _aDown = false; _dDown = false; _strafeKey = null; _stop(); }

  window.addEventListener("keydown", function (e) {
    if (!e.isTrusted || e.repeat) return;
    var k = e.key;
    if (k === "Escape") { _reset(); return; }
    if (_isInput(e.target)) return;
    if (k === "Shift") { _shiftDown = true; _start(); }
    else if (k === "q" || k === "Q") { _qDown = true; _start(); }
    else if (k === "a" || k === "A") { _aDown = true; if (_bhopOn) { _strafeKey = 'a'; _lastStrafeSwitch = performance.now(); } }
    else if (k === "d" || k === "D") { _dDown = true; if (_bhopOn) { _strafeKey = 'd'; _lastStrafeSwitch = performance.now(); } }
  }, true);

  window.addEventListener("keyup", function (e) {
    if (!e.isTrusted) return;
    var k = e.key;
    if (k === "Escape") return;
    if (k === "Shift") { _shiftDown = false; if (!_shiftDown && !_qDown) _stop(); }
    else if (k === "q" || k === "Q") { _qDown = false; if (!_shiftDown && !_qDown) _stop(); }
    else if (k === "a" || k === "A") {
      _aDown = false;
      if (_bhopOn && _strafeKey === 'a') { _strafeKey = _dDown ? 'd' : null; }
    }
    else if (k === "d" || k === "D") {
      _dDown = false;
      if (_bhopOn && _strafeKey === 'd') { _strafeKey = _aDown ? 'a' : null; }
    }
  }, true);

  window.addEventListener("blur", _reset);
}

module.exports = { installBhopHook };
