// Guard: every injected browser script in main.js must be syntactically
// valid JavaScript AFTER ${...} interpolation. (node --check on main.js
// cannot see inside template strings — one extra paren there broke ALL live
// pairings with "Script failed to execute".)
// Covers inline executeJavaScript(`...`) templates AND the auto-login script
// built as `const script = `...`` then passed as executeJavaScript(script).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const mainPath = path.join(__dirname, 'main.js');
const src = fs.readFileSync(mainPath, 'utf8');

function extractTemplate(openBacktickIdx) {
  let i = openBacktickIdx + 1;
  let body = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { body += ch + (src[i + 1] || ''); i += 2; continue; }
    if (ch === '`') return { body, end: i + 1 };
    body += ch; i++;
  }
  return null;
}

const markers = ['executeJavaScript(`', 'const script = `'];
const seen = new Set();
let found = 0;
let failed = 0;

for (const marker of markers) {
  let idx = 0;
  while (true) {
    const start = src.indexOf(marker, idx);
    if (start < 0) break;
    const tplStart = start + marker.length - 1; // index of the backtick
    if (seen.has(tplStart)) { idx = tplStart + 1; continue; }
    seen.add(tplStart);
    const ext = extractTemplate(tplStart);
    if (!ext) { console.error('unterminated template'); process.exit(1); }
    idx = ext.end;
    found++;

    // Substitute dummy values for every ${...} placeholder.
    const filled = ext.body.replace(/\$\{[^}]+\}/g, (m) => {
      if (/safeTracking|TRACKING|USERNAME|escapedUsername/i.test(m)) return '"VL0085628805611"';
      if (/safeFlyer|FLYER|PASSWORD|escapedPassword/i.test(m)) return '"TP400EU08340134"';
      if (/actionDelay|Delay/i.test(m)) return '1000';
      if (/maxAttempts/i.test(m)) return '30';
      return '"x"';
    });
    if (/\$\{/.test(filled)) {
      console.error(`template #${found}: uninterpolated placeholder remains`);
      failed++;
      continue;
    }
    const tmp = path.join(os.tmpdir(), `inject-check-${found}.cjs`);
    fs.writeFileSync(tmp, filled);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      console.log(`template #${found}: syntax OK (${filled.length} bytes)`);
    } catch (e) {
      failed++;
      const out = ((e.stdout || '') + '\n' + (e.stderr || '')).toString();
      console.error(`template #${found}: SYNTAX ERROR\n${out.split('\n').slice(0, 8).join('\n')}`);
    }
  }
}
console.log(`checked ${found} injected script(s), ${failed} failed`);
process.exit(failed ? 1 : 0);
