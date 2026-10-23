// Fetches the GPL reference corpus -- the csls programs and the unit-test suites of ucblogo-code -- into
// tests/logo/reference/, a directory that is gitignored (LOGO.md decisions 9 and 10: nothing from that repository is ever
// committed here). Pinned to one commit so a test run is reproducible.
//
//   node tests/logo/fetch-reference.js            fetch anything missing
//   node tests/logo/fetch-reference.js --force    fetch everything again
//
// The tests that use these files skip, rather than fail, when the directory is absent, and print this command.
// Needs network access to raw.githubusercontent.com; plain Node https, no GitHub CLI.

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMMIT = 'f0ca245e5215f39de7e24252fd2b1946c321c772';
const OUT = path.join(here, 'reference');

const CSLS = ['algs', 'basic', 'buttons', 'cards', 'crypto', 'diff', 'doctor', 'dotgame', 'format', 'fsm', 'master', 'match',
  'math', 'mines', 'multi', 'pascal', 'playfair', 'plot', 'poker', 'pour', 'psort', 'solitaire', 'streams', 'student', 'tower', 'ttt'];
const SUITES = ['Arithmetic', 'Bitwise', 'Constructors', 'Control', 'Files', 'Macros', 'MemMgr', 'OOP', 'Predicates', 'Random'];

const files = [];
for (const n of CSLS) files.push({ url: `csls/${n}`, dest: `csls/${n}.lg` });
files.push({ url: 'tests/UnitTests.lg', dest: 'tests/UnitTests.lg' });
for (const s of SUITES) files.push({ url: `tests/UnitTests-${s}.lg`, dest: `tests/UnitTests-${s}.lg` });

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'lively-logo-test-fetch' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

(async () => {
  const force = process.argv.includes('--force');
  let fetched = 0;
  for (const f of files) {
    const dest = path.join(OUT, f.dest);
    if (!force && fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const body = await get(`https://raw.githubusercontent.com/jrincayc/ucblogo-code/${COMMIT}/${f.url}`);
    fs.writeFileSync(dest, body);
    fetched++;
  }
  fs.writeFileSync(path.join(OUT, 'COMMIT.txt'), COMMIT + '\n');
  console.log(`reference corpus at ${COMMIT.slice(0, 7)}: ${fetched} fetched, ${files.length - fetched} already present -> ${OUT}`);
})().catch((e) => { console.error('fetch failed:', e.message); process.exit(1); });
