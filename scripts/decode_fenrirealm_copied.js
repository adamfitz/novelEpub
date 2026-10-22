#!/usr/bin/env node
const fs = require('fs');

function decode(input) {
  const lines = input.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^[A-Za-z0-9+/=]{740,750}$/.test(line.trim())) {
      continue;
    }
    line = line.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
    line = line.trim();
    if (line === '') {
      continue;
    }
    if (line.match(/Read on FenriRealm/i) || line.match(/fenrirealm\.com/i)) {
      continue;
    }
    out.push(line);
  }
  return out.join('\n\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: decode_fenrirealm_copied.js <input.txt> [output.txt]');
    process.exit(1);
  }
  const input = fs.readFileSync(args[0], 'utf8');
  const result = decode(input);
  if (args[1]) {
    fs.writeFileSync(args[1], result);
    console.log('Wrote', args[1]);
  } else {
    console.log(result);
  }
}

module.exports = { decode };
