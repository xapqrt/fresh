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

  function _start() {
    if (_recording) return;
    try {
      _desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      }).then(function(sources) {
        var src = sources.find(function(s) {
          return s.name.indexOf('Dawn Client') !== -1 || s.name.indexOf('kirka') !== -1;
        });
        if (!src) { src = sources[0]; }
        if (!src) return;

        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: src.id,
            },
          },
        }).then(function(stream) {
          _stream = stream;
          _chunks = [];
          var mime = 'video/webm;codecs=vp9';
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
            };
            reader.readAsArrayBuffer(blob);
            if (_stream) { _stream.getTracks().forEach(function(t) { t.stop(); }); _stream = null; }
            _mediaRecorder = null;
          };
          _mediaRecorder.start(1000);
          _recording = true;
          _createIndicator();
          _indicator.style.display = '';
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
  }

  document.addEventListener('keydown', function(e) {
    if (e.key === 'F9') {
      e.preventDefault();
      e.stopPropagation();
      _toggle();
    }
  }, true);

  window.addEventListener('beforeunload', function() {
    if (_recording) _stop();
  });

  _createIndicator();
}

module.exports = { installRecorder };
