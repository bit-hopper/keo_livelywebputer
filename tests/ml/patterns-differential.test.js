// 400 generated clause sets (tests/ml/tools/gen-patterns.js), each run through SML/NJ once (tests/ml/tools/runindep.sh;
// the output is committed as tests/ml/seed/patterns.smlnj-output.out). We replay them: for each function our checker must
// agree with SML/NJ on whether it is exhaustive, and on exactly which clauses are redundant. Wording is never compared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunks, checked } from './helpers.js';

const seed = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed');
const srcFile = path.join(seed, 'patterns.sml');
const outFile = path.join(seed, 'patterns.smlnj-output.out');
const have = fs.existsSync(srcFile) && fs.existsSync(outFile);

// -> [{ verdict: 'ok'|'nonexhaustive'|'redundant', redundant: [1-based clause numbers] }], one per chunk after the prelude
function reference(text) {
  const blocks = text.replace(/\r/g, '').split(/^######## c_\d+$/m).slice(1);
  return blocks.map((b) => {
    const lines = b.split('\n');
    const redundant = [];
    let verdict = 'ok';
    let inRules = false;
    let n = 0;
    for (const line of lines) {
      if (/Error: match redundant/.test(line)) { verdict = 'redundant'; inRules = true; n = 0; continue; }
      if (/Warning: match nonexhaustive/.test(line)) { if (verdict === 'ok') verdict = 'nonexhaustive'; inRules = true; n = 0; continue; }
      if (inRules) {
        if (/^(?: {10}| {4}-->   )\S/.test(line)) { n++; if (line.startsWith('    -->')) redundant.push(n); } else inRules = false;
      }
    }
    return { verdict, redundant };
  });
}

test('generated clause sets: exhaustiveness and redundancy agree with SML/NJ', { skip: !have && 'tests/ml/seed/patterns.* is not present' }, () => {
  const cs = chunks(fs.readFileSync(srcFile, 'utf8'));
  const ref = reference(fs.readFileSync(outFile, 'utf8'));
  assert.equal(ref.length, cs.length - 1, 'one reference block per generated function');
  const prelude = cs[0];
  const mismatches = [];
  const seen = { ok: 0, nonexhaustive: 0, redundant: 0 };
  cs.slice(1).forEach((chunk, i) => {
    const r = checked(prelude + '\n' + chunk, { redundantAsWarning: true });
    assert.equal(r.error, null, 'chunk ' + (i + 1) + ': ' + r.error);
    const redundant = r.warnings.map((w) => /^clause (\d+) of /.exec(w)).filter(Boolean).map((m) => Number(m[1]));
    const nonexhaustive = r.warnings.some((w) => / has no clause for /.test(w));
    const ours = redundant.length ? 'redundant' : nonexhaustive ? 'nonexhaustive' : 'ok';
    seen[ref[i].verdict]++;
    // SML/NJ reports a redundant match as an error, and then says nothing more about exhaustiveness
    if (ours !== ref[i].verdict) mismatches.push('#' + (i + 1) + ' ' + ours + ' vs SML/NJ ' + ref[i].verdict + '\n' + chunk);
    else if (JSON.stringify(redundant) !== JSON.stringify(ref[i].redundant)) {
      mismatches.push('#' + (i + 1) + ' redundant clauses ' + redundant + ' vs SML/NJ ' + ref[i].redundant + '\n' + chunk);
    }
  });
  // the corpus is only worth something if it exercises all three outcomes
  assert.ok(seen.ok > 20 && seen.nonexhaustive > 50 && seen.redundant > 50, JSON.stringify(seen));
  assert.deepEqual(mismatches, []);
});
