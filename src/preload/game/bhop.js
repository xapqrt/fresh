var _ipc = null;
try { _ipc = require('electron').ipcRenderer; } catch (e) { }

function installBhopHook(getSettings) {
  var _shiftDown = false;
  var _qDown = false;
  var _aDown = false;
  var _dDown = false;
  var _bhopOn = false;
  var _qDownPhys = false;
  var _rAFId = null;
  var _phase = 0;
  var _strafeKey = null;
  var _strafePhysDown = false;
  var _lastToggle = 0;
  var _holdMs = 8;
  var _jitterMs = 1;
  var _jitterAccum = 0;
  var _pendingKeys = [];
  var _toggleCode = 'ShiftLeft';
  var _jumpCode = 'KeyQ';
  var _jumpChar = 'q';

  function _readKeys() {
    var s = typeof getSettings === 'function' ? getSettings() : null;
    var toggle = (s && s.bhop_toggle) || 'Shift';
    var jump = (s && s.bhop_jump) || 'KeyQ';
    _toggleCode = toggle === 'Control' ? 'ControlLeft' : (toggle === 'Alt' ? 'AltLeft' : 'ShiftLeft');
    _jumpCode = jump === 'KeyW' ? 'KeyW' : 'KeyQ';
    _jumpChar = jump === 'KeyW' ? 'w' : 'q';
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

  function _tick(now) {
    if (!_bhopOn) { _rAFId = null; return; }

    var grounded = _pollGround();

    if (grounded === true) {
      _lastToggle = now - _holdMs - _jitterMs;
      if (_phase === 1) { _qDownPhys = false; _queueKey(_jumpChar, false); _phase = 2; }
      _qDownPhys = true; _queueKey(_jumpChar, true);
      _pulseStrafe();
      _phase = 1;
      _jitterAccum = Math.random() * _jitterMs;
      _flushKeys();
      _rAFId = requestAnimationFrame(_tick);
      return;
    }

    if (grounded === false) {
      _flushKeys();
      _rAFId = requestAnimationFrame(_tick);
      return;
    }

    if (_lastToggle !== 0 && performance.now() - now > 3.6) {
      _flushKeys();
      _rAFId = requestAnimationFrame(_tick);
      return;
    }

    if (now - _lastToggle < _holdMs + _jitterAccum) {
      _flushKeys();
      _rAFId = requestAnimationFrame(_tick);
      return;
    }

    _lastToggle = now;
    _jitterAccum = Math.random() * _jitterMs;

    if (_phase === 1) {
      _qDownPhys = false; _queueKey('q', false); _phase = 2;
    } else if (_phase === 2) {
      _qDownPhys = true; _queueKey('q', true);
      _pulseStrafe();
      _phase = 1;
    }
    _flushKeys();
    _rAFId = requestAnimationFrame(_tick);
  }

  function _start() {
    if (_bhopOn) return;
    _bhopOn = true;
    _strafeKey = _aDown ? 'a' : (_dDown ? 'd' : null);
    _strafePhysDown = false;
    _phase = 1; _qDownPhys = true; _queueKey(_jumpChar, true);
    _lastToggle = performance.now();
    _flushKeys();
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

  function _reset() { _shiftDown = false; _qDown = false; _aDown = false; _dDown = false; _strafeKey = null; _stop(); }

  window.addEventListener("keydown", function (e) {
    if (!e.isTrusted || e.repeat) return;
    var k = e.key;
    if (k === "Escape") { _reset(); return; }
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
    _readKeys();
    if (e.code === _toggleCode) { _shiftDown = true; _start(); }
    else if (e.code === _jumpCode) { _qDown = true; _start(); }
    else if (k === "a" || k === "A") { _aDown = true; if (_bhopOn) _strafeKey = 'a'; }
    else if (k === "d" || k === "D") { _dDown = true; if (_bhopOn) _strafeKey = 'd'; }
  }, true);

  window.addEventListener("keyup", function (e) {
    if (!e.isTrusted) return;
    var k = e.key;
    if (k === "Escape") return;
    _readKeys();
    if (e.code === _toggleCode) { _shiftDown = false; if (!_shiftDown && !_qDown) _stop(); }
    else if (e.code === _jumpCode) { _qDown = false; if (!_shiftDown && !_qDown) _stop(); }
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
