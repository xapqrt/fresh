const { isArmSig, getArmType, TOMAHAWK_SIG } = require('./arm-sigs');
const { applyZSpin, applyXSpin, applyYSpin, hsvToRgb } = require('./mat-utils');
const wasm = require('../wasm/dawn_wasm');

const _matBuf = wasm.getScratchBuf();
const _matBufI32 = new Int32Array(_matBuf.buffer, _matBuf.byteOffset, _matBuf.length);
const _rgbPixel = new Uint8Array(4);

let _lastDrawCall = -1;
let _drawCallCount = 0;

const _BLOOM_SIZE = 32;
const _BLOOM_MASK = _BLOOM_SIZE - 1;

let _bloomGen = 0;
const _bloomWords = new Uint32Array(_BLOOM_SIZE);
const _bloomGens = new Uint32Array(_BLOOM_SIZE);

const _bloomCheck = (hash) => {
  const h = (hash >>> 0) & _BLOOM_MASK;
  const bit = 1 << ((hash >>> 24) & 7);
  const wordIdx = h >>> 2;
  const shift = (h & 3) << 3;
  const mask = bit << shift;
  if (_bloomGens[wordIdx] === _bloomGen && (_bloomWords[wordIdx] & mask)) return true;
  if (_bloomGens[wordIdx] !== _bloomGen) _bloomWords[wordIdx] = 0;
  _bloomGens[wordIdx] = _bloomGen;
  _bloomWords[wordIdx] |= mask;
  return false;
};

const _fastHash = () => {
  const i32 = _matBufI32;
  return (i32[0] ^ i32[5] ^ i32[10] ^ i32[15]) >>> 0;
};

const INSPECT_DURATIONS = {
  vita: 600, rev: 550, mac10: 800, ar9: 550, m60: 550,
  scar: 550, shark: 550, lar: 550, weatie: 550, bayonet: 800, tomahawk: 750,
};

const _DEFAULT_CFG = { size: 1, offsetX: 0, offsetY: 0, offsetZ: 0 };
const _DEFAULT_ARM = { size: 1, offsetX: 0, offsetY: 0, offsetZ: 0, wireframe: false, colorEnabled: false, colorHex: '#FFFFFF', rgb: false };

let _hooked = false;
let _lastClearMask = 0;
let _lastBoundTexture = null;
const _lastRgbUpload = new Uint8Array(4);
let _rgbFrameCount = 0;

let _inspectStart = null;
let _inspectingWeaponId = null;
let _inspectKeybind = 'KeyZ';
let _domWeaponId = 'vita';
let _tomahawkCount = 0;
let _weaponConfig = null;
let _enableMods = false;

let _inspectFns = null;
let _armFns = null;

let _gameContext = null;

const setInspectKeybind = (key) => { _inspectKeybind = key; };
const getInspectKeybind = () => _inspectKeybind;
const updateDomWeaponId = (id) => { _domWeaponId = id || 'vita'; };
const getDomWeaponId = () => _domWeaponId;
const startInspect = (time, weaponId) => { _inspectStart = time; _inspectingWeaponId = weaponId; };

const setWeaponConfig = (config, inspectFns, armFns) => {
  _weaponConfig = config;
  _inspectFns = inspectFns;
  _armFns = armFns;
  _enableMods = !!(config && (config.wireframe || config.colorEnabled || config.rgb || config.universal));

  if (_enableMods && _gameContext) {
    _installWrappers(_gameContext);
  }
};

const _getCfg = (wid) => _weaponConfig?.getSettings?.(wid) || _DEFAULT_CFG;
const _getArmCfg = (wid, type) => _weaponConfig?.getArmSettings?.(wid, type) || _DEFAULT_ARM;

const _lastHexCache = { hex: '', r: 255, g: 255, b: 255 };
const _parseHexCached = (hex, px) => {
  if (hex === _lastHexCache.hex) {
    px[0] = _lastHexCache.r;
    px[1] = _lastHexCache.g;
    px[2] = _lastHexCache.b;
    px[3] = 255;
    return;
  }
  const r = parseInt(hex[1] + hex[2], 16);
  const g = parseInt(hex[3] + hex[4], 16);
  const b = parseInt(hex[5] + hex[6], 16);
  _lastHexCache.hex = hex;
  _lastHexCache.r = isNaN(r) ? 255 : r;
  _lastHexCache.g = isNaN(g) ? 255 : g;
  _lastHexCache.b = isNaN(b) ? 255 : b;
  px[0] = _lastHexCache.r;
  px[1] = _lastHexCache.g;
  px[2] = _lastHexCache.b;
  px[3] = 255;
};

const _parseSig = () => wasm.parseSig(0);

const _checkNonAffine = (v3, v7, v11, v15) => {
  return (v3 > 0.001 || v3 < -0.001) || (v7 > 0.001 || v7 < -0.001) || (v11 > 0.001 || v11 < -0.001) || (v15 - 1.0 > 0.001 || v15 - 1.0 < -0.001);
};

const _installWrappers = (gl) => {
  _rgbPixel[0] = 255; _rgbPixel[1] = 255; _rgbPixel[2] = 255; _rgbPixel[3] = 255;

  const rgbTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, rgbTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, _rgbPixel);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);

  const origClear = gl.clear.bind(gl);
  gl.clear = (mask) => { _lastClearMask = mask; return origClear(mask); };

  const origBindTexture = gl.bindTexture.bind(gl);
  gl.bindTexture = (target, texture) => {
    if (target === gl.TEXTURE_2D) _lastBoundTexture = texture;
    return origBindTexture(target, texture);
  };

  const origUniform4 = gl.uniformMatrix4fv.bind(gl);

  gl.uniformMatrix4fv = (location, transpose, data, srcOffset, srcLength) => {
    if (window.__weaponModsActive === false) return origUniform4(location, transpose, data, srcOffset, srcLength);
    if (!_enableMods || !data || data.length < 16) {
      return origUniform4(location, transpose, data, srcOffset, srcLength);
    }

    const offset = srcOffset | 0;

    const d3 = data[offset + 3], d7 = data[offset + 7], d11 = data[offset + 11], d15 = data[offset + 15];

    if (_checkNonAffine(d3, d7, d11, d15)) {
      return origUniform4(location, transpose, data, srcOffset, srcLength);
    }

    const dc = _drawCallCount;
    if (dc !== _lastDrawCall) {
      _bloomGen++;
      _lastDrawCall = dc;
      _tomahawkCount = 0;
    }

    if (_lastClearMask !== 256) {
      return origUniform4(location, transpose, data, srcOffset, srcLength);
    }

    const d0 = data[offset], d1 = data[offset + 1], d2 = data[offset + 2];
    const d4 = data[offset + 4], d5 = data[offset + 5], d6 = data[offset + 6];
    const d8 = data[offset + 8], d9 = data[offset + 9], d10 = data[offset + 10];
    const d12 = data[offset + 12], d13 = data[offset + 13], d14 = data[offset + 14];

    _matBuf[0] = d0; _matBuf[1] = d1; _matBuf[2] = d2; _matBuf[3] = d3;
    _matBuf[4] = d4; _matBuf[5] = d5; _matBuf[6] = d6; _matBuf[7] = d7;
    _matBuf[8] = d8; _matBuf[9] = d9; _matBuf[10] = d10; _matBuf[11] = d11;
    _matBuf[12] = d12; _matBuf[13] = d13; _matBuf[14] = d14; _matBuf[15] = d15;

    if (_bloomCheck(_fastHash())) {
      return origUniform4(location, transpose, data, srcOffset, srcLength);
    }

    const sig = _parseSig();
    const treatAsArm = sig === TOMAHAWK_SIG ? (++_tomahawkCount > 1) : isArmSig(sig);

    if (!treatAsArm) {
      const currentId = _domWeaponId || 'vita';

      if (_inspectStart !== null && _inspectingWeaponId !== null && _inspectingWeaponId !== currentId) {
        _inspectStart = null;
        _inspectingWeaponId = null;
      }

      const cfg = _getCfg(currentId);
      const wc = _weaponConfig;

      if (wc.colorEnabled) {
        origBindTexture(gl.TEXTURE_2D, rgbTexture);
        if (wc.rgb) {
          if (_rgbFrameCount++ % 3 === 0) {
            const buf = hsvToRgb((performance.now() / 3000) * 360);
            _rgbPixel[0] = buf[0]; _rgbPixel[1] = buf[1]; _rgbPixel[2] = buf[2]; _rgbPixel[3] = 255;
            _lastRgbUpload[0] = _rgbPixel[0];
            _lastRgbUpload[1] = _rgbPixel[1];
            _lastRgbUpload[2] = _rgbPixel[2];
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, _rgbPixel);
          }
        } else {
          _parseHexCached(wc.colorHex, _rgbPixel);
          if (_rgbPixel[0] !== _lastRgbUpload[0] ||
              _rgbPixel[1] !== _lastRgbUpload[1] ||
              _rgbPixel[2] !== _lastRgbUpload[2]) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, _rgbPixel);
            _lastRgbUpload[0] = _rgbPixel[0];
            _lastRgbUpload[1] = _rgbPixel[1];
            _lastRgbUpload[2] = _rgbPixel[2];
          }
        }
      } else {
        origBindTexture(gl.TEXTURE_2D, _lastBoundTexture || null);
      }

      let scale = cfg.size || 1;
      let ox = cfg.offsetX || 0;
      let oy = cfg.offsetY || 0;
      let oz = cfg.offsetZ || 0;
      let spinZ = 0, spinX = 0, spinY = 0;

      if (_inspectStart !== null && _inspectingWeaponId === null) {
        _inspectingWeaponId = currentId;
      }

      if (_inspectStart !== null && _inspectingWeaponId === currentId && _inspectFns) {
        const fn = _inspectFns[currentId];
        if (fn) {
          const elapsed = performance.now() - _inspectStart;
          const t = elapsed < 0 ? 0 : (elapsed > 1000 ? 1 : elapsed / (INSPECT_DURATIONS[currentId] || 1000));
          const kf = fn(t < 1 ? t : 1);
          scale *= kf.scale || 1;
          ox += (kf.offsetX || 0) * scale;
          oy += (kf.offsetY || 0) * scale;
          oz += (kf.offsetZ || 0) * scale;
          spinZ = kf.spinZ || 0;
          spinX = kf.spinX || 0;
          spinY = kf.spinY || 0;
          if (t >= 1) { _inspectStart = null; _inspectingWeaponId = null; }
        } else { _inspectStart = null; _inspectingWeaponId = null; }
      }

      _matBuf[0] *= scale; _matBuf[1] *= scale; _matBuf[2] *= scale;
      _matBuf[4] *= scale; _matBuf[5] *= scale; _matBuf[6] *= scale;
      _matBuf[8] *= scale; _matBuf[9] *= scale; _matBuf[10] *= scale;
      _matBuf[12] += ox; _matBuf[13] += oy; _matBuf[14] += oz;

      if (spinZ) applyZSpin(_matBuf, spinZ);
      if (spinX) applyXSpin(_matBuf, spinX);
      if (spinY) applyYSpin(_matBuf, spinY);

      return origUniform4(location, transpose, _matBuf, 0, 16);
    }

    const currentId = _domWeaponId || 'vita';
    const armSide = getArmType(sig, currentId, _matBuf[12]) !== 0;
    const armCfg = _getArmCfg(currentId, armSide ? 'right' : 'left');

    let armScale = armCfg.size || 1;
    let ox = armCfg.offsetX || 0;
    let oy = armCfg.offsetY || 0;
    let oz = armCfg.offsetZ || 0;
    let armSpinX = 0, armSpinY = 0, armSpinZ = 0;

    if (_inspectStart !== null && _inspectingWeaponId === currentId && _armFns) {
      const fn = _armFns[currentId + '_' + (armSide ? 'right' : 'left')];
      if (fn) {
        const elapsed = performance.now() - _inspectStart;
        const t = elapsed < 0 ? 0 : (elapsed > 1000 ? 1 : elapsed / (INSPECT_DURATIONS[currentId] || 1000));
        const kf = fn(t < 1 ? t : 1);
        ox += (kf.offsetX || 0) * armScale;
        oy += (kf.offsetY || 0) * armScale;
        oz += (kf.offsetZ || 0) * armScale;
        armSpinX = kf.spinX || 0;
        armSpinY = kf.spinY || 0;
        armSpinZ = kf.spinZ || 0;
      }
    }

    _matBuf[0] *= armScale; _matBuf[1] *= armScale; _matBuf[2] *= armScale;
    _matBuf[4] *= armScale; _matBuf[5] *= armScale; _matBuf[6] *= armScale;
    _matBuf[8] *= armScale; _matBuf[9] *= armScale; _matBuf[10] *= armScale;
    _matBuf[12] += ox; _matBuf[13] += oy; _matBuf[14] += oz;

    if (armSpinX) applyXSpin(_matBuf, armSpinX);
    if (armSpinY) applyYSpin(_matBuf, armSpinY);
    if (armSpinZ) applyZSpin(_matBuf, armSpinZ);

    return origUniform4(location, transpose, _matBuf, 0, 16);
  };

  const origDrawArrays = gl.drawArrays.bind(gl);
  gl.drawArrays = (mode, first, count) => {
    _drawCallCount++;
    return origDrawArrays(mode, first, count);
  };

  const origDrawElements = gl.drawElements.bind(gl);
  gl.drawElements = (mode, count, type, offset) => {
    _drawCallCount++;
    return origDrawElements(mode, count, type, offset);
  };
};

const hookWebGL = () => {
  if (_hooked) return;
  _hooked = true;

  const _needsModProcessing = () => _enableMods && window.__weaponModsActive !== false;

  const origGetCtx = HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetCtx.call(this, type, Object.assign({ desynchronized: true }, attrs));
    if (!ctx || (type !== 'webgl' && type !== 'webgl2')) return ctx;
    if (this.id !== 'game' || _gameContext) return ctx;

    _gameContext = ctx;

    if (_needsModProcessing()) {
      _installWrappers(ctx);
    }

    return ctx;
  };
};

module.exports = {
  hookWebGL, setWeaponConfig, setInspectKeybind, getInspectKeybind,
  updateDomWeaponId, getDomWeaponId, startInspect,
};
