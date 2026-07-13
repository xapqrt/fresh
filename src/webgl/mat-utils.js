const _cos = new Float64Array(1);
const _sin = new Float64Array(1);

const applyZSpin = (mat, angle) => {
  _cos[0] = Math.cos(angle); _sin[0] = Math.sin(angle);
  const cos = _cos[0], sin = _sin[0];
  const sx = Math.sqrt(mat[0] * mat[0] + mat[1] * mat[1] + mat[2] * mat[2]);
  const sy = Math.sqrt(mat[4] * mat[4] + mat[5] * mat[5] + mat[6] * mat[6]);
  const x0 = mat[0] / sx, x1 = mat[1] / sx, x2 = mat[2] / sx;
  const y0 = mat[4] / sy, y1 = mat[5] / sy, y2 = mat[6] / sy;
  const nx0 = x0 * cos - y0 * sin, nx1 = x1 * cos - y1 * sin, nx2 = x2 * cos - y2 * sin;
  const ny0 = x0 * sin + y0 * cos, ny1 = x1 * sin + y1 * cos, ny2 = x2 * sin + y2 * cos;
  mat[0] = nx0 * sx; mat[1] = nx1 * sx; mat[2] = nx2 * sx;
  mat[4] = ny0 * sy; mat[5] = ny1 * sy; mat[6] = ny2 * sy;
};

const applyXSpin = (mat, angle) => {
  _cos[0] = Math.cos(angle); _sin[0] = Math.sin(angle);
  const cos = _cos[0], sin = _sin[0];
  const sy = Math.sqrt(mat[4] * mat[4] + mat[5] * mat[5] + mat[6] * mat[6]);
  const sz = Math.sqrt(mat[8] * mat[8] + mat[9] * mat[9] + mat[10] * mat[10]);
  const y0 = mat[4] / sy, y1 = mat[5] / sy, y2 = mat[6] / sy;
  const z0 = mat[8] / sz, z1 = mat[9] / sz, z2 = mat[10] / sz;
  const ny0 = y0 * cos - z0 * sin, ny1 = y1 * cos - z1 * sin, ny2 = y2 * cos - z2 * sin;
  const nz0 = y0 * sin + z0 * cos, nz1 = y1 * sin + z1 * cos, nz2 = y2 * sin + z2 * cos;
  mat[4] = ny0 * sy; mat[5] = ny1 * sy; mat[6] = ny2 * sy;
  mat[8] = nz0 * sz; mat[9] = nz1 * sz; mat[10] = nz2 * sz;
};

const applyYSpin = (mat, angle) => {
  _cos[0] = Math.cos(angle); _sin[0] = Math.sin(angle);
  const cos = _cos[0], sin = _sin[0];
  const sx = Math.sqrt(mat[0] * mat[0] + mat[1] * mat[1] + mat[2] * mat[2]);
  const sz = Math.sqrt(mat[8] * mat[8] + mat[9] * mat[9] + mat[10] * mat[10]);
  const x0 = mat[0] / sx, x1 = mat[1] / sx, x2 = mat[2] / sx;
  const z0 = mat[8] / sz, z1 = mat[9] / sz, z2 = mat[10] / sz;
  const nx0 = x0 * cos + z0 * sin, nx1 = x1 * cos + z1 * sin, nx2 = x2 * cos + z2 * sin;
  const nz0 = -x0 * sin + z0 * cos, nz1 = -x1 * sin + z1 * cos, nz2 = -x2 * sin + z2 * cos;
  mat[0] = nx0 * sx; mat[1] = nx1 * sx; mat[2] = nx2 * sx;
  mat[8] = nz0 * sz; mat[9] = nz1 * sz; mat[10] = nz2 * sz;
};

const _hsvBuf = new Uint8Array(3);
const hsvToRgb = (hue) => {
  hue = ((hue % 360) + 360) % 360;
  const sector = (hue / 60) | 0;
  const f = (hue / 60) - sector;
  const q = Math.round((1 - f) * 255);
  const t = Math.round(f * 255);
  switch (sector) {
    case 0: _hsvBuf[0] = 255; _hsvBuf[1] = t; _hsvBuf[2] = 0; break;
    case 1: _hsvBuf[0] = q; _hsvBuf[1] = 255; _hsvBuf[2] = 0; break;
    case 2: _hsvBuf[0] = 0; _hsvBuf[1] = 255; _hsvBuf[2] = t; break;
    case 3: _hsvBuf[0] = 0; _hsvBuf[1] = q; _hsvBuf[2] = 255; break;
    case 4: _hsvBuf[0] = t; _hsvBuf[1] = 0; _hsvBuf[2] = 255; break;
    default: _hsvBuf[0] = 255; _hsvBuf[1] = 0; _hsvBuf[2] = q; break;
  }
  return _hsvBuf;
};

module.exports = { applyZSpin, applyXSpin, applyYSpin, hsvToRgb };
