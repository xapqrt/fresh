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

  function _send(payload, evtDown, evtUp, down) {
    if (_ipc) {
      _ipc.send('dawn-bhop-key', payload);
    } else {
      document.dispatchEvent(down ? evtDown : evtUp);
    }
  }

  function _postKey(key, down) {
    if (key === 'q') {
      _send(down ? _qD : _qU, _qDownEvt, _qUpEvt, down);
    } else if (key === 'a') {
      _send(down ? _aD : _aU, _aDownEvt, _aUpEvt, down);
    } else if (key === 'd') {
      _send(down ? _dD : _dU, _dDownEvt, _dUpEvt, down);
    }
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
    _postKey(_strafeKey, false);
    _postKey(_strafeKey, true);
    _strafePhysDown = true;
  }

  function _tick(now) {
    if (!_bhopOn) { _rAFId = null; return; }

    if (capCheck && !capCheck(now)) { _rAFId = requestAnimationFrame(_tick); return; }

    var grounded = _checkGrounded();

    if (grounded === true) {
      _lastToggle = now - _holdMs - _jitterMs;
      if (_phase === 1) {
        _qDownPhys = false; _postKey('q', false); _phase = 2;
      }
      _qDownPhys = true; _postKey('q', true);
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
      _pulseStrafe();
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
      _postKey(_strafeKey, false);
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
    else if (k === "a" || k === "A") { _aDown = true; if (_bhopOn) _strafeKey = 'a'; }
    else if (k === "d" || k === "D") { _dDown = true; if (_bhopOn) _strafeKey = 'd'; }
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
