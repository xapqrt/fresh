var _ipc = null;
try { _ipc = require('electron').ipcRenderer; } catch (e) { }

function installBhopHook(getSettings) {
  var _getSettings = getSettings || function () { return null; };

  var _jumpKey = ' ';
  var _toggleCode = 'Shift';

  var _shiftDown = false;
  var _qDown = false;
  var _aDown = false;
  var _dDown = false;
  var _bhopOn = false;
  var _qDownPhys = false;
  var _phase = 0;
  var _strafeKey = null;
  var _strafePhysDown = false;
  var _lastToggle = 0;
  var _holdMs = 8;
  var _jitterMs = 1;
  var _jitterAccum = 0;
  var _pendingKeys = [];
  var _tickCount = 0;
  var _pressTick = -1;
  var _lastTickAt = 0;
  var _fallbackRAF = null;

  function _readKeys() {
    var s = _getSettings();
    if (!s) return;
    if (typeof s.bhop_jump === 'string' && s.bhop_jump) {
      var c = s.bhop_jump.trim();
      if (c === 'Space' || c === 'KeySpace' || c === 'space') {
        _jumpKey = ' ';
      } else if (c.length === 1) {
        _jumpKey = c.toLowerCase();
      } else if (c.indexOf('Key') === 0) {
        _jumpKey = c.slice(3).toLowerCase();
      } else {
        _jumpKey = c.toLowerCase();
      }
    } else {
      _jumpKey = ' ';
    }
    if (typeof s.bhop_toggle === 'string' && s.bhop_toggle) {
      var t = s.bhop_toggle;
      if (t === 'Shift' || t === 'LeftShift' || t === 'ShiftLeft') _toggleCode = 'Shift';
      else if (t === 'RightShift' || t === 'ShiftRight') _toggleCode = 'ShiftRight';
      else _toggleCode = t;
    } else {
      _toggleCode = 'Shift';
    }
  }

  function _toggleMatch(code) {
    if (_toggleCode === 'Shift') return code === 'ShiftLeft' || code === 'ShiftRight';
    return code === _toggleCode;
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

  function _pulseStrafe() {
    if (!_strafeKey) return;
    var physicallyHeld = (_strafeKey === 'a' && _aDown) || (_strafeKey === 'd' && _dDown);
    if (physicallyHeld) { _strafePhysDown = true; return; }
    _queueKey(_strafeKey, false);
    _queueKey(_strafeKey, true);
    _strafePhysDown = true;
  }

  // Driven synchronously by the game's own physics tick (via dawn-patch),
  // falling back to rAF polling if the patch is absent/dead.
  function _step(now, g) {
    var grounded = typeof g === 'boolean' ? g : null;

    if (grounded === true) {
      if (_qDownPhys) { _qDownPhys = false; _queueKey(_jumpKey, false); }
      _qDownPhys = true; _queueKey(_jumpKey, true);
      _phase = 1;
      _pressTick = _tickCount;
      _lastToggle = now;
      _jitterAccum = Math.random() * _jitterMs;
      _pulseStrafe();
      _flushKeys();
      return;
    }

    if (grounded === false) {
      _flushKeys();
      return;
    }

    // ground state unknown — cycle a fresh press edge
    if (now - _lastToggle < _holdMs + _jitterAccum) { _flushKeys(); return; }
    _lastToggle = now;
    _jitterAccum = Math.random() * _jitterMs;
    if (_phase === 1) {
      _qDownPhys = false; _queueKey(_jumpKey, false); _phase = 2;
    } else {
      _qDownPhys = true; _queueKey(_jumpKey, true);
      _pressTick = _tickCount;
      _phase = 1;
      _pulseStrafe();
    }
    _flushKeys();
  }

  function _onGroundTick(g) {
    _lastTickAt = performance.now();
    if (!_bhopOn) return;
    _tickCount++;
    _step(_lastTickAt, g);
  }

  function _fallbackTick(now) {
    if (!_bhopOn) { _fallbackRAF = null; return; }
    if (now - _lastTickAt < 2000) {
      _fallbackRAF = requestAnimationFrame(_fallbackTick);
      return;
    }
    _tickCount++;
    _step(now, _pollGround());
    _fallbackRAF = requestAnimationFrame(_fallbackTick);
  }

  function _start() {
    if (_bhopOn) return;
    _readKeys();
    _bhopOn = true;
    _strafeKey = _aDown ? 'a' : (_dDown ? 'd' : null);
    _strafePhysDown = false;
    _phase = 1; _qDownPhys = true; _queueKey(_jumpKey, true);
    _lastToggle = performance.now();
    _lastTickAt = _lastToggle;
    _pressTick = _tickCount;
    _flushKeys();
    _fallbackRAF = requestAnimationFrame(_fallbackTick);
  }

  function _stop() {
    if (!_bhopOn) return;
    _bhopOn = false;
    if (_fallbackRAF !== null) { cancelAnimationFrame(_fallbackRAF); _fallbackRAF = null; }
    if (_qDownPhys) { _qDownPhys = false; _queueKey(_jumpKey, false); }
    if (_strafePhysDown && _strafeKey) {
      var physicallyHeld = (_strafeKey === 'a' && _aDown) || (_strafeKey === 'd' && _dDown);
      if (!physicallyHeld) _queueKey(_strafeKey, false);
      _strafePhysDown = false;
    }
    _flushKeys();
    _strafeKey = null;
    _phase = 0;
  }

  function _reset() { _shiftDown = false; _qDown = false; _aDown = false; _dDown = false; _strafeKey = null; _stop(); }

  try { window.__onGroundTick = _onGroundTick; } catch (e) {}

  window.addEventListener("keydown", function (e) {
    if (!e.isTrusted || e.repeat) return;
    var k = e.key;
    if (k === "Escape") { _reset(); return; }
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
    if (_toggleMatch(e.code)) { _shiftDown = true; _start(); }
    else if (k === _jumpKey || k === _jumpKey.toUpperCase()) { _qDown = true; _start(); }
    else if (k === "a" || k === "A") { _aDown = true; if (_bhopOn) _strafeKey = 'a'; }
    else if (k === "d" || k === "D") { _dDown = true; if (_bhopOn) _strafeKey = 'd'; }
  }, true);

  window.addEventListener("keyup", function (e) {
    if (!e.isTrusted) return;
    var k = e.key;
    if (k === "Escape") return;
    if (_toggleMatch(e.code)) { _shiftDown = false; if (!_shiftDown && !_qDown) _stop(); }
    else if (k === _jumpKey || k === _jumpKey.toUpperCase()) { _qDown = false; if (!_shiftDown && !_qDown) _stop(); }
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
