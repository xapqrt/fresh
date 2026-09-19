const fs = require('fs');

if (process.argv.length < 4) {
  console.error('usage: node decode-idx.js <strings.json> <hexIdx> [hexIdx...]');
  process.exit(1);
}

const out = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
const idx = (h) => out[parseInt(h, 16) - 0xfd];
for (const n of process.argv.slice(3)) {
  console.log(n, '=>', JSON.stringify(idx(n)));
}
