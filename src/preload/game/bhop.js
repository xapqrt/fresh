var _ipc = null;
try { _ipc = require('electron').ipcRenderer; } catch (e) { }

function installBhopHook() {
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

  function _sendKey(key, down) {
    if (!_ipc) return;
    try {
      _ipc.send('bhop-key', { key: key, down: down });
    } catch (e) {}
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
    _sendKey(_strafeKey, false);
    _sendKey(_strafeKey, true);
    _strafePhysDown = true;
  }

  function _tick(now) {
    if (!_bhopOn) { _rAFId = null; return; }

    var grounded = _pollGround();

    if (grounded === true) {
      _lastToggle = now - _holdMs - _jitterMs;
      if (_phase === 1) { _qDownPhys = false; _sendKey('q', false); _phase = 2; }
      _qDownPhys = true; _sendKey('q', true);
      _pulseStrafe();
      _phase = 1;
      _jitterAccum = Math.random() * _jitterMs;
      _rAFId = requestAnimationFrame(_tick);
      return;
    }

    if (grounded === false) {
      _rAFId = requestAnimationFrame(_tick);
      return;
    }

    if (_lastToggle !== 0 && performance.now() - now > 3.6) {
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
      _qDownPhys = false; _sendKey('q', false); _phase = 2;
    } else if (_phase === 2) {
      _qDownPhys = true; _sendKey('q', true);
      _pulseStrafe();
      _phase = 1;
    }
    _rAFId = requestAnimationFrame(_tick);
  }

  function _start() {
    if (_bhopOn) return;
    _bhopOn = true;
    _strafeKey = _aDown ? 'a' : (_dDown ? 'd' : null);
    _strafePhysDown = false;
    _phase = 1; _qDownPhys = true; _sendKey('q', true);
    _lastToggle = performance.now();
    _rAFId = requestAnimationFrame(_tick);
  }

  function _stop() {
    if (!_bhopOn) return;
    _bhopOn = false;
    if (_rAFId !== null) { cancelAnimationFrame(_rAFId); _rAFId = null; }
    if (_qDownPhys) { _qDownPhys = false; _sendKey('q', false); }
    if (_strafePhysDown && _strafeKey) {
      var physicallyHeld = (_strafeKey === 'a' && _aDown) || (_strafeKey === 'd' && _dDown);
      if (!physicallyHeld) _sendKey(_strafeKey, false);
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
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
    if (e.code === "ShiftLeft") { _shiftDown = true; _start(); }
    else if (k === "q" || k === "Q") { _qDown = true; _start(); }
    else if (k === "a" || k === "A") { _aDown = true; if (_bhopOn) _strafeKey = 'a'; }
    else if (k === "d" || k === "D") { _dDown = true; if (_bhopOn) _strafeKey = 'd'; }
  }, true);

  window.addEventListener("keyup", function (e) {
    if (!e.isTrusted) return;
    var k = e.key;
    if (k === "Escape") return;
    if (e.code === "ShiftLeft") { _shiftDown = false; if (!_shiftDown && !_qDown) _stop(); }
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
