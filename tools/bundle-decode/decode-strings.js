const fs = require('fs');

if (process.argv.length < 5) {
  console.error('usage: node decode-strings.js <bundle.js> <strings-out.json> <matches-out.txt>');
  process.exit(1);
}

const bundle = fs.readFileSync(process.argv[2], 'utf-8');

function extractBalanced(src, startIdx, openCh, closeCh) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === "'") inStr = false;
    } else {
      if (ch === "'") inStr = true;
      else if (ch === openCh) depth++;
      else if (ch === closeCh) {
        depth--;
        if (depth === 0) return src.slice(startIdx, i + 1);
      }
    }
  }
  throw new Error('unbalanced');
}

const arrStart = bundle.indexOf('var dqP=[');
const arrDef = extractBalanced(bundle, arrStart, '[', ']');
console.error('array len:', arrDef.length);

const sandbox = {};
eval('sandbox.dqP = ' + arrDef.slice(arrDef.indexOf('[')) + ';');
const c = sandbox.dqP;
console.error('entries:', c.length);

const iifeEnd = bundle.indexOf('}(j,0x1e40c),');
const iifeSrc = bundle.slice(0, iifeEnd + '}(j,0x1e40c),'.length);
const formulaMatch = iifeSrc.match(/try\{var d=(.*);if\(d===b\)/);
if (!formulaMatch) throw new Error('formula not found');
const bMatch = iifeSrc.match(/\(j,(0x[0-9a-f]+)\)/);
if (!bMatch) throw new Error('b not found');
const target = parseInt(bMatch[1], 16);
const formulaSrc = formulaMatch[1].replace(/Di\(/g, 'lk(');
const formulaFn = new Function('lk', 'return ' + formulaSrc + ';');
function lk(d, e) { d = d - 0xfd; return c[d]; }

let rotations = 0;
for (; rotations < 1000000; rotations++) {
  let v;
  try { v = formulaFn(lk); } catch (f) { c.push(c.shift()); continue; }
  if (v === target) break;
  c.push(c.shift());
}
if (rotations >= 1000000) throw new Error('rotation did not settle');
console.error('rotated:', rotations, 'times (target', target + ')');

const fsOut = process.argv[3];
const matchesOut = process.argv[4];
const out = [];
let max = 0;
for (let i = 0xfd; i < c.length + 0xfd; i++) {
  let s;
  try { s = lk(i); } catch (e) { break; }
  if (s === undefined) break;
  max = i;
  out.push(s);
}
fs.writeFileSync(fsOut, JSON.stringify(out));
console.error('decoded', out.length, 'strings, last idx 0x' + max.toString(16));

function hexToStr(h) {
  if (h.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(h)) return null;
  let s = '';
  for (let i = 0; i < h.length; i += 2) {
    s += String.fromCharCode(parseInt(h.substr(i, 2), 16));
  }
  return s;
}

const interesting = /ground|jump|fall|vel|grav|phys|tick|land|colli|floor|feet|air|key|input|mov|speed|straf|bhop|hop|toggle|bunny/;
const seen = new Set();
const matches = [];
out.forEach((s, i) => {
  const idx = '0x' + (i + 0xfd).toString(16);
  const forms = [s];
  const dec = hexToStr(s);
  if (dec) forms.push(dec);
  else if (s.startsWith('chunk-')) {
    const d = hexToStr(s.slice(6));
    if (d) forms.push('chunk-' + d);
  }
  for (const f of forms) {
    if (interesting.test(f) && !seen.has(f)) {
      seen.add(f);
      const shown = s.length > 160 ? s.slice(0, 160) + '…' : s;
      matches.push(idx + '\t' + JSON.stringify(shown) + '\t->\t' + JSON.stringify(f.length > 160 ? f.slice(0, 160) + '…' : f));
      break;
    }
  }
});
fs.writeFileSync(matchesOut, matches.join('\n'));
console.error('matched', matches.length, 'unique strings ->', matchesOut);
