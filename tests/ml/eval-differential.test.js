// The seed corpora run through SML/NJ (tests/ml/seed/*.smlnj-output.txt) are also the ground truth for what the programs
// evaluate to. We run the same chunks through the whole engine (SML style), each on top of the chunks that ran cleanly before it
// (as runchunks.sh does), and compare: accepted or rejected, an uncaught exception's name, and every `val x = V : T` line
// SML/NJ printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunks } from './helpers.js';
import { Interpreter } from '../../core/lib/ml/src/interpreter.js';

const seed = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed');
const files = ['t4', 't5b', 't6'];
const have = files.every((f) => fs.existsSync(path.join(seed, f + '.sml')) && fs.existsSync(path.join(seed, f + '.smlnj-output.txt')));

function outputBlocks(text) {
  const blocks = text.replace(/\r/g, '').split(/^######## c_\d+\.sml$/m).slice(1);
  return blocks.map((b) => b.split('\n').filter((l) => !l.startsWith('    | ')).join('\n'));
}

// `val x = V : T` lines, a value or type may wrap onto following indented lines
function smlnjVals(block) {
  const out = new Map();
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^val (\S+) = (.*)$/.exec(lines[i]);
    if (!m) continue;
    let rest = m[2];
    while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) rest += ' ' + lines[++i].trim();
    out.set(m[1], rest.trim());
  }
  return out;
}

const normal = (s) => s.replace(/\s+/g, ' ').trim();

// Chunks we decide differently on purpose (same list as infer-differential.test.js, plus what only evaluation shows).
const LISTS = /^val big = \[|^fun subst_c|^val w = \[\]|^\(subst_c/; // legal with the lists basis only; the rest runs in both modes
const KNOWN = [
  [/^Compiler\.Control/, ':= and the SML/NJ compiler structures are not part of the engine'],
  [/^4611686018427387903 \+ 1;|^fact\(25\)|^val fact25/, 'our int is 63-bit, SML/NJ here is 31-bit (recorded deviation)'],
];

// Values we print differently on purpose: SML/NJ hides an exception value's payload (`No_bacon(-)`), we show it.
const VALUE_KNOWN = [
  /^val e = No_bacon\(0\);/,
  /^IntArith2\.plus\(1,2\);/, // SML/NJ keeps the name of an abbreviation (`IntArith2.number`) where we print the type it stands for (`int`)
];

function snapshot(interp) {
  const sc = interp.scope;
  return { vals: new Map(sc.vals), types: new Map(sc.types), strs: new Map(sc.strs), sigs: new Map(sc.sigs), funs: new Map(sc.funs), globals: new Map(interp.globals) };
}
function restore(interp, s) {
  interp.scope.vals = new Map(s.vals);
  interp.scope.types = new Map(s.types);
  interp.scope.strs = new Map(s.strs);
  interp.scope.sigs = new Map(s.sigs);
  interp.scope.funs = new Map(s.funs);
  interp.globals = new Map(s.globals);
}

for (const basis of ['full', 'core']) test('seed corpora (' + basis + ' basis): values, exceptions and accept/reject agree with SML/NJ', { skip: !have && 'tests/ml/seed is not present' }, () => {
  const mismatches = [];
  let compared = 0;
  for (const f of files) {
    const cs = chunks(fs.readFileSync(path.join(seed, f + '.sml'), 'utf8'));
    const blocks = outputBlocks(fs.readFileSync(path.join(seed, f + '.smlnj-output.txt'), 'utf8'));
    assert.equal(cs.length, blocks.length);
    const interp = new Interpreter({ style: 'sml', redundant: 'error', basis });
    cs.forEach((chunk, i) => {
      const block = blocks[i];
      const tag = f + '#' + i + ' ' + chunk.slice(0, 50).replace(/\s+/g, ' ');
      const before = snapshot(interp);
      const r = interp.evalSync(chunk);
      const theirErr = /Error:/.test(block);
      const theirExn = /uncaught exception (\w+)/.exec(block);
      const ourErr = r.segments.find((s) => s.kind === 'error');
      const failed = !!ourErr || r.segments.some((s) => s.kind === 'status' && s.tone === 'bad');
      if (ourErr || theirErr || theirExn) restore(interp, before);
      if (KNOWN.some(([re]) => re.test(chunk)) || (basis === 'core' && LISTS.test(chunk))) { restore(interp, before); return; }
      if (theirErr && !failed) { mismatches.push(tag + ' => SML/NJ rejects, we accept'); return; }
      if (!theirErr && ourErr && !(theirExn && ourErr.errorClass === 'exception')) {
        mismatches.push(tag + ' => SML/NJ accepts, we fail: ' + ourErr.errorClass + ': ' + ourErr.text);
        return;
      }
      if (theirExn) {
        if (!ourErr || ourErr.errorClass !== 'exception' || !ourErr.text.startsWith('uncaught exception ' + theirExn[1])) {
          mismatches.push(tag + ' => SML/NJ raised ' + theirExn[1] + ', we ' + (ourErr ? ourErr.errorClass + ': ' + ourErr.text : 'did not fail'));
        }
        compared++;
        return;
      }
      if (theirErr) return;
      const ours = new Map();
      for (const s of r.segments) {
        if (s.kind !== 'value') continue;
        for (const line of s.text.split('\n')) {
          const m = /^val (\S+) = (.*)$/.exec(line);
          if (m) ours.set(m[1], m[2].trim());
        }
      }
      if (VALUE_KNOWN.some((re) => re.test(chunk))) return;
      for (const [name, text] of smlnjVals(block)) {
        if (text.includes('#') || text.includes('...') || text.includes('?.')) continue; // print depth cut, value restriction artefact
        compared++;
        if (!ours.has(name)) mismatches.push(tag + ' => missing val ' + name);
        else if (normal(ours.get(name)) !== normal(text)) mismatches.push(tag + ' => ' + name + ': SML/NJ [' + text + '] / ours [' + ours.get(name) + ']');
      }
    });
  }
  assert.ok(compared > 60, 'expected many comparisons, got ' + compared);
  assert.deepEqual(mismatches, []);
});
