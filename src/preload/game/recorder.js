var _ipc = null;
try { _ipc = require('electron').ipcRenderer; } catch (e) { }
var _desktopCapturer = null;
try { _desktopCapturer = require('electron').desktopCapturer; } catch (e) { }

function installRecorder() {
  if (!_desktopCapturer || !_ipc) { console.error('[Recorder] missing desktopCapturer or ipcRenderer'); return; }

  var _recording = false;
  var _mediaRecorder = null;
  var _stream = null;
  var _indicator = null;
  var _chunks = [];

  function _createIndicator() {
    if (_indicator) return;
    _indicator = document.createElement('div');
    _indicator.id = 'df-recorder-indicator';
    _indicator.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:99999;' +
      'width:10px;height:10px;border-radius:50%;background:#f00;' +
      'box-shadow:0 0 6px rgba(255,0,0,0.8);display:none;pointer-events:none;';
    var append = function() {
      if (document.body) { document.body.appendChild(_indicator); return; }
      requestAnimationFrame(append);
    };
    append();
  }

  function _toggle() {
    if (_recording) { _stop(); return; }
    _start();
  }

  function _readConfig() {
    var s = window.dawnSettings || window.settings || {};
    return {
      fps: parseInt(s.rec_fps) || 60,
      scale: parseFloat(s.rec_scale) || 1,
      codec: s.rec_codec || 'vp9',
      indicator: s.rec_indicator !== undefined ? !!s.rec_indicator : true,
      keybind: s.rec_keybind || 'F9',
      keybind2: s.rec_keybind2 || null
    };
  }

  function _updateUI(recording) {
    var statusEl = document.getElementById('rec-status');
    if (statusEl) statusEl.innerText = recording ? 'Recording' : 'Idle';
    var btn = document.getElementById('rec-start-stop');
    if (btn) btn.innerText = recording ? 'Stop Recording' : 'Start Recording';
  }

  function _start() {
    if (_recording) return;
    try { require('fs').appendFileSync(require('os').homedir() + '/rec-debug.log', 'REC START w=' + (window.screen.width) + '\n'); } catch (e) {}
    try {
      var cfg = _readConfig();
      var w = Math.round((window.screen.width || 1920) * cfg.scale);
      var h = Math.round((window.screen.height || 1080) * cfg.scale);
      if (w % 2) w++; if (h % 2) h++;

      _desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      }).then(function(sources) {
        var src = sources.find(function(s) {
          return s.name.indexOf('Dawn Client') !== -1 || s.name.indexOf('kirka') !== -1 || s.name.indexOf('240Hz') !== -1;
        });
        if (!src) { src = sources.find(function(s) { return s.id; }); }
        if (!src) { src = sources[0]; }
        if (!src) return;

        var mediaFn = typeof navigator.mediaDevices.getDisplayMedia === 'function'
          ? navigator.mediaDevices.getDisplayMedia
          : null;
        if (mediaFn) {
          console.log('[Recorder] using getDisplayMedia path');
        } else {
          mediaFn = function(c) { return navigator.mediaDevices.getUserMedia(c); };
          console.log('[Recorder] getDisplayMedia unavailable, falling back to getUserMedia');
        }
        mediaFn({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: src.id,
              width: w,
              height: h,
            },
          },
        }).then(function(stream) {
          _stream = stream;
          _chunks = [];
          var mime = 'video/webm;codecs=' + cfg.codec;
          if (!MediaRecorder.isTypeSupported(mime)) {
            mime = 'video/webm;codecs=vp9';
          }
          if (!MediaRecorder.isTypeSupported(mime)) {
            mime = 'video/webm;codecs=vp8';
          }
          if (!MediaRecorder.isTypeSupported(mime)) {
            mime = 'video/webm';
          }
          _mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
          _mediaRecorder.ondataavailable = function(e) {
            if (e.data.size > 0) _chunks.push(e.data);
          };
          _mediaRecorder.onstop = function() {
            if (_chunks.length === 0) return;
            var blob = new Blob(_chunks, { type: 'video/webm' });
            _chunks = [];
            var reader = new FileReader();
            reader.onload = function() {
              _ipc.send('save-recording', reader.result);
              try { require('fs').appendFileSync(require('path').join(require('os').homedir(), 'rec-debug.log'), 'REC STOP saved\n'); } catch(e) {}
            };
            reader.readAsArrayBuffer(blob);
            if (_stream) { _stream.getTracks().forEach(function(t) { t.stop(); }); _stream = null; }
            _mediaRecorder = null;
          };
          _mediaRecorder.start(1000);
          _recording = true;
          try { require('fs').appendFileSync(require('path').join(require('os').homedir(), 'rec-debug.log'), 'REC START w='+w+' h='+h+' mime='+mime+'\n'); } catch(e) {}
          _createIndicator();
          _indicator.style.display = cfg.indicator ? '' : 'none';
          _updateUI(true);
        }).catch(function(e) { console.error('[Recorder] getUserMedia failed:', e); });
      }).catch(function(e) { console.error('[Recorder] getSources failed:', e); });
    } catch (e) { console.error('[Recorder] _start error:', e); }
  }

  function _stop() {
    if (!_recording) return;
    _recording = false;
    if (_indicator) _indicator.style.display = 'none';
    if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
      _mediaRecorder.stop();
    } else {
      if (_stream) { _stream.getTracks().forEach(function(t) { t.stop(); }); _stream = null; }
      _mediaRecorder = null;
    }
    _updateUI(false);
  }

  (function() {
    var cfg = _readConfig();
    var kb = String(cfg.keybind || 'F9').toUpperCase();
    var kb2 = cfg.keybind2 ? String(cfg.keybind2).toUpperCase() : null;
    console.log('[Recorder] keybind set to', kb + (kb2 ? ', ' + kb2 : ''));
    document.addEventListener('keydown', function(e) {
      var key = e.key ? e.key.toUpperCase() : '';
      if (key === 'F9' || key === kb || (kb2 && key === kb2)) {
        e.preventDefault();
        e.stopPropagation();
        _toggle();
      }
    }, true);
  })();

  window.addEventListener('beforeunload', function() {
    if (_recording) _stop();
  });

  _createIndicator();

  window.__dawnRecorder = {
    toggle: _toggle,
    start: _start,
    stop: _stop,
    isRecording: function() { return _recording; }
  };
}

module.exports = { installRecorder };
