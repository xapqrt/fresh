function installBhopHook() {
  var _shiftDown = false;
  var _qDown = false;
  var _bhopOn = false;
  var _qDownPhys = false;
  var _rAFId = null;
  var _phase = 0;

  var _qDownEvt = new KeyboardEvent("keydown", {
    key: "q", code: "KeyQ", keyCode: 81, which: 81,
    bubbles: true, cancelable: true,
  });
  var _qUpEvt = new KeyboardEvent("keyup", {
    key: "q", code: "KeyQ", keyCode: 81, which: 81,
    bubbles: true, cancelable: true,
  });

  function _postQ(down) {
    var evt = down ? _qDownEvt : _qUpEvt;
    document.dispatchEvent(evt);
  }

  function _isInput(el) {
    if (!el) return false;
    var t = el.tagName;
    return t === "INPUT" || t === "TEXTAREA" || el.isContentEditable ||
      (el.getAttribute && el.getAttribute("role") === "textbox");
  }

  var _lastToggle = 0;
  var _holdMs = 40;
  var _jitterMs = 6;
  var _jitterAccum = 0;

  function _tick(now) {
    if (!_bhopOn) { _rAFId = null; return; }

    if (now - _lastToggle < _holdMs + _jitterAccum) {
      _rAFId = requestAnimationFrame(_tick);
      return;
    }

    _lastToggle = now;
    _jitterAccum = Math.random() * _jitterMs;

    if (_phase === 1) {
      _qDownPhys = false; _postQ(false); _phase = 2;
    } else if (_phase === 2) {
      _qDownPhys = true; _postQ(true); _phase = 1;
    }
    _rAFId = requestAnimationFrame(_tick);
  }

  function _start() {
    if (_bhopOn) return;
    _bhopOn = true;
    _phase = 1; _qDownPhys = true; _postQ(true);
    _lastToggle = performance.now();
    _rAFId = requestAnimationFrame(_tick);
  }

  function _stop() {
    if (!_bhopOn) return;
    _bhopOn = false;
    if (_rAFId !== null) { cancelAnimationFrame(_rAFId); _rAFId = null; }
    if (_qDownPhys) { _qDownPhys = false; _postQ(false); }
    _phase = 0;
  }

  function _reset() { _shiftDown = false; _qDown = false; _stop(); }

  window.addEventListener("keydown", function (e) {
    if (!e.isTrusted || e.repeat) return;
    var k = e.key;
    if (k === "Escape") { _reset(); return; }
    if (_isInput(e.target)) return;
    if (k === "Shift") { _shiftDown = true; _start(); }
    else if (k === "q" || k === "Q") { _qDown = true; _start(); }
  }, true);

  window.addEventListener("keyup", function (e) {
    if (!e.isTrusted) return;
    var k = e.key;
    if (k === "Escape") return;
    if (k === "Shift") { _shiftDown = false; if (!_shiftDown && !_qDown) _stop(); }
    else if (k === "q" || k === "Q") { _qDown = false; if (!_shiftDown && !_qDown) _stop(); }
  }, true);

  window.addEventListener("blur", _reset);
}

module.exports = { installBhopHook };
