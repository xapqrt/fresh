const fs = require('fs');

if (process.argv.length < 4) {
  console.error('usage: node show-ctx.js <bundle.js> <needle> [before] [after]');
  process.exit(1);
}

const b = fs.readFileSync(process.argv[2], 'utf-8');
const needle = process.argv[3];
const before = parseInt(process.argv[4] || '500', 10);
const after = parseInt(process.argv[5] || '700', 10);
const maxHits = 6;

function showAround() {
  let idx = -1, hits = 0;
  while ((idx = b.indexOf(needle, idx + 1)) >= 0 && hits < maxHits) {
    hits++;
    const start = Math.max(0, idx - before);
    const end = Math.min(b.length, idx + needle.length + after);
    console.log('=== hit', hits, '@', idx, '===');
    console.log(b.slice(start, end));
    console.log();
  }
  if (!hits) console.log('no hits for', JSON.stringify(needle));
}

showAround();
