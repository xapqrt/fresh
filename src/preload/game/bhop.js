var _ipc = null;
try { _ipc = require('electron').ipcRenderer; } catch (e) { }

function installBhopHook(getSettings) {
  var _shiftDown = false;
  var _aDown = false;
  var _dDown = false;
  var _bhopOn = false;
  var _qDownPhys = false;
  var _rAFId = null;
  var _phase = 0;
  var _strafeKey = null;
  var _strafePhysDown = false;
  var _lastToggle = 0;
  var _holdMs = 4;
  var _jitterMs = 0.2;
  var _jitterAccum = 0;
  var _lastPulse = 0;
  var _pendingKeys = [];
  var _toggleCode = 'ShiftLeft';
  var _jumpChar = 'q';
  var _wasAirborne = true;
  var _lastPress = 0;
  var _retryGroundedMs = 90;
  var _ctrlDown = false;

  function _readKeys() {
    var s = typeof getSettings === 'function' ? getSettings() : null;
    var toggle = (s && s.bhop_toggle) || 'Shift';
    var jump = (s && s.bhop_jump) || 'KeyQ';
    _toggleCode = toggle === 'Control' ? 'ControlLeft' : (toggle === 'Alt' ? 'AltLeft' : 'ShiftLeft');
    // Jump key is Q in Kirka (Q = jump, Shift = crouch). Space plays no part.
    if (jump === 'KeyW' || jump === 'w') _jumpChar = 'w';
    else if (jump === 'KeyQ' || jump === 'q') _jumpChar = 'q';
    else _jumpChar = 'q';
  }

  function _enabled() {
    try {
      var s = typeof getSettings === 'function' ? getSettings() : null;
      return !(s && s.bhop_enabled === false);
    } catch (e) { return true; }
  }

  function _queueKey(key, down) {
    _pendingKeys.push({ key, down });
  }

  function _flushKeys() {
    if (!_pendingKeys.length || !_ipc) { _pendingKeys = []; return; }
    _ipc.send('bhop-keys', _pendingKeys);
    _pendingKeys = [];
  }

  function _pollGround() {
    try {
      var v = window.__onGround;
      if (typeof v === 'boolean') return v;
    } catch (e) {}
    return null;
  }

  function _pollAntiSpam() {
    try {
      var v = window.__antiSpam;
      if (typeof v === 'boolean') return v;
    } catch (e) {}
    return false;
  }

  function _sendJump(down) {
    if (down === _qDownPhys) return;
    _qDownPhys = down;
    _queueKey(_jumpChar, down);
    if (down) _lastPress = performance.now();
  }

  function _pulseStrafe(now) {
    if (!_strafeKey) return;
    var physicallyHeld = (_strafeKey === 'a' && _aDown) || (_strafeKey === 'd' && _dDown);
    if (physicallyHeld) { _strafePhysDown = true; return; }
    if (now - _lastPulse < 25) return;
    _lastPulse = now;
    _queueKey(_strafeKey, false);
    _queueKey(_strafeKey, true);
    _strafePhysDown = true;
  }

  function _tick(now) {
    if (!_bhopOn) { _rAFId = null; return; }

    var grounded = _pollGround();

    if (grounded === true) {
      // Jump only while grounded: one press per landing. Pressing mid-air fills
      // the game's jump buffer, which then fires phantom hops after release.
      // If the game's anti-spam counter is still hot (very short hop), defer a
      // frame instead of letting the press get eaten.
      if ((_wasAirborne || now - _lastPress >= _retryGroundedMs) && !_pollAntiSpam()) {
        if (_phase === 1) { _sendJump(false); _phase = 2; }
        _sendJump(true);
        _lastToggle = now;
        _jitterAccum = Math.random() * _jitterMs;
        _phase = 1;
        _wasAirborne = false;
      } else if (_phase === 1 && now - _lastToggle >= _holdMs + _jitterAccum) {
        _sendJump(false);
        _phase = 2;
      }
      _pulseStrafe(now);
      queueMicrotask(_flushKeys);
      _rAFId = requestAnimationFrame(_tick);
      return;
    }

    if (grounded === false) {
      // In flight: finish the hold, wait for the next landing.
      if (_phase === 1) { _sendJump(false); _phase = 2; }
      _wasAirborne = true;
      queueMicrotask(_flushKeys);
      _rAFId = requestAnimationFrame(_tick);
      return;
    }

    // ── Blind fallback (no __onGround hook): timed cadence ──
    if (now - _lastToggle < _holdMs + _jitterAccum) {
      queueMicrotask(_flushKeys);
      _rAFId = requestAnimationFrame(_tick);
      return;
    }

    var _n = 0;
    while (now - _lastToggle >= _holdMs + _jitterAccum && _n++ < 8) {
      _lastToggle += _holdMs + _jitterAccum;
      _jitterAccum = Math.random() * _jitterMs;
      if (_phase === 1) {
        _sendJump(false); _phase = 2;
      } else {
        if (!_pollAntiSpam()) _sendJump(true);
        _pulseStrafe(now);
        _phase = 1;
      }
    }
    queueMicrotask(_flushKeys);
    _rAFId = requestAnimationFrame(_tick);
  }

  function _start() {
    if (_bhopOn || !_enabled()) return;
    _bhopOn = true;
    _strafeKey = _aDown ? 'a' : (_dDown ? 'd' : null);
    _strafePhysDown = false;
    _qDownPhys = false;
    _phase = 0;
    _wasAirborne = true;
    _lastPress = 0;
    _lastToggle = performance.now();
    _jitterAccum = Math.random() * _jitterMs;
    _rAFId = requestAnimationFrame(_tick);
  }

  function _stop() {
    if (!_bhopOn) return;
    _bhopOn = false;
    if (_rAFId !== null) { cancelAnimationFrame(_rAFId); _rAFId = null; }
    if (_qDownPhys) { _qDownPhys = false; _queueKey(_jumpChar, false); }
    if (_strafePhysDown && _strafeKey) {
      var physicallyHeld = (_strafeKey === 'a' && _aDown) || (_strafeKey === 'd' && _dDown);
      if (!physicallyHeld) _queueKey(_strafeKey, false);
      _strafePhysDown = false;
    }
    _flushKeys();
    _strafeKey = null;
    _phase = 0;
  }

  function _reset() { _shiftDown = false; _ctrlDown = false; _aDown = false; _dDown = false; _strafeKey = null; _stop(); }

  window.addEventListener("keydown", function (e) {
    if (!e.isTrusted || e.repeat) return;
    var k = e.key;
    if (k === "Escape") { _reset(); return; }
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
    _readKeys();
    if (e.code === "ControlLeft" && _toggleCode !== "ControlLeft") {
      _ctrlDown = true;
      _queueKey("ShiftLeft", true);
      queueMicrotask(_flushKeys);
    }
    else if (e.code === _toggleCode) {
      if (_ctrlDown) { _shiftDown = false; } else { _shiftDown = true; _start(); }
    }
    else if (k === "a" || k === "A") { _aDown = true; if (_bhopOn) _strafeKey = 'a'; }
    else if (k === "d" || k === "D") { _dDown = true; if (_bhopOn) _strafeKey = 'd'; }
  }, true);

  window.addEventListener("keyup", function (e) {
    if (!e.isTrusted) return;
    var k = e.key;
    if (k === "Escape") return;
    _readKeys();
    if (e.code === "ControlLeft" && _toggleCode !== "ControlLeft") {
      _ctrlDown = false;
      _queueKey("ShiftLeft", false);
      queueMicrotask(_flushKeys);
    }
    else if (e.code === _toggleCode) { _shiftDown = false; _stop(); }
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
