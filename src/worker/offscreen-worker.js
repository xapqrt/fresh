// OffscreenCanvas + WebGL Worker POC
// Electron 12 (Chromium 89) compatibility:
//   - OffscreenCanvas: Chrome 69+ ✓
//   - transferControlToOffscreen(): Chrome 69+ ✓
//   - OffscreenCanvas WebGL context in worker: Chrome 79+ ✓
//   - SharedArrayBuffer: Chrome 89+ (requires cross-origin isolation)

// Blockers on Electron 12:
//   - SharedArrayBuffer requires Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy
//     headers. With webSecurity: false this may work, but the game page (kirka.io)
//     doesn't serve these headers. A session.webRequest.onHeadersReceived hook could
//     inject them.
//   - OffscreenCanvas WebGL has no stencil/alpha from worker context.
//   - Worker thread cannot access DOM (expected).

self.onmessage = function (e) {
  const { cmd, canvas, sab } = e.data;

  if (cmd === 'init-webgl' && canvas) {
    try {
      const gl = canvas.getContext('webgl', {
        desynchronized: true,
        alpha: false,
        antialias: false,
        stencil: false,
        depth: true,
        premultipliedAlpha: false,
      });
      if (!gl) {
        self.postMessage({ ok: false, error: 'WebGL not available in worker' });
        return;
      }
      gl.clearColor(0.0, 0.0, 0.0, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      self.postMessage({ ok: true, info: 'WebGL context acquired in worker' });
    } catch (err) {
      self.postMessage({ ok: false, error: err.message });
    }
    return;
  }

  if (cmd === 'ping-sab' && sab) {
    try {
      const view = new Uint32Array(sab);
      Atomics.store(view, 0, 42);
      Atomics.notify(view, 0, 1);
      self.postMessage({ ok: true, info: 'SharedArrayBuffer write + notify OK' });
    } catch (err) {
      self.postMessage({ ok: false, error: err.message });
    }
    return;
  }

  if (cmd === 'ping') {
    self.postMessage({ ok: true, info: 'Worker alive' });
  }
};
