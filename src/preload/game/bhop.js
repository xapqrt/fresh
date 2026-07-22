var _ipc = null;
try { _ipc = require('electron').ipcRenderer; } catch (e) { }

function installBhopHook() {
  var _shiftDown = false;
  var _qDown = false;
  var _aDown = false;
  var _dDown = false;
  var _bhopOn = false;
  var _lastGround = null;

  function _send(key, down) {
    if (_ipc) {
      _ipc.send('bhop-keystate', { aDown: _aDown, dDown: _dDown, qDown: _qDown, shiftDown: _shiftDown });
      if (!_bhopOn) { _bhopOn = true; _ipc.send('bhop-start'); }
    }
  }

  function _stop() {
    if (!_bhopOn) return;
    _bhopOn = false;
    if (_ipc) { _ipc.send('bhop-stop'); }
  }

  // Poll __onGround every rAF and send changes to main
  var _groundRaf = null;
  function _groundPoll() {
    var v = null;
    try { var x = window.__onGround; if (typeof x === 'boolean') v = x; } catch (e) {}
    if (v !== _lastGround) {
      _lastGround = v;
      if (_ipc && v !== null) _ipc.send('bhop-ground', v);
    }
    _groundRaf = requestAnimationFrame(_groundPoll);
  }
  _groundPoll();

  window.addEventListener("keydown", function (e) {
    if (!e.isTrusted || e.repeat) return;
    var k = e.key;
    if (k === "Escape") { _shiftDown = false; _qDown = false; _aDown = false; _dDown = false; _stop(); return; }
    if (_isInput(e.target)) return;
    if (k === "Shift") { _shiftDown = true; _send('q', true); }
    else if (k === "q" || k === "Q") { _qDown = true; _send('q', true); }
    else if (k === "a" || k === "A") { _aDown = true; _send('a', true); }
    else if (k === "d" || k === "D") { _dDown = true; _send('d', true); }
  }, true);

  window.addEventListener("keyup", function (e) {
    if (!e.isTrusted) return;
    var k = e.key;
    if (k === "Escape") return;
    if (k === "Shift") { _shiftDown = false; if (!_shiftDown && !_qDown) _stop(); _sendState(); }
    else if (k === "q" || k === "Q") { _qDown = false; if (!_shiftDown && !_qDown) _stop(); _sendState(); }
    else if (k === "a" || k === "A") { _aDown = false; _sendState(); }
    else if (k === "d" || k === "D") { _dDown = false; _sendState(); }
  }, true);

  function _sendState() {
    if (_ipc && _bhopOn) _ipc.send('bhop-keystate', { aDown: _aDown, dDown: _dDown, qDown: _qDown, shiftDown: _shiftDown });
  }

  function _isInput(el) {
    if (!el) return false;
    var t = el.tagName;
    return t === "INPUT" || t === "TEXTAREA" || el.isContentEditable ||
      (el.getAttribute && el.getAttribute("role") === "textbox");
  }

  window.addEventListener("blur", function () {
    _shiftDown = false; _qDown = false; _aDown = false; _dDown = false; _stop();
    _lastGround = null;
  });
}

module.exports = { installBhopHook };
