// tests/ml/seed/t9.sml (lists, strings, options, print) was run through SML/NJ 110.79 by seed/runchunks.sh; the output is
// seed/t9.smlnj-output.out. Same method as eval-differential.test.js: every chunk runs through the whole engine (SML style) on top of
// the chunks that ran cleanly before it, and we compare accepted or rejected, an uncaught exception's name, whether a
// non-exhaustive match is reported, and every `val x = V : T` line SML/NJ printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunks } from './helpers.js';
import { Interpreter } from '../../core/lib/ml/src/interpreter.js';

const seed = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed');
const have = fs.existsSync(path.join(seed, 't9.sml')) && fs.existsSync(path.join(seed, 't9.smlnj-output.out'));

function outputBlocks(text) {
  const blocks = text.replace(/\r/g, '').split(/^######## c_\d+\.sml$/m).slice(1);
  return blocks.map((b) => b.split('\n').filter((l) => !l.startsWith('    | ')).join('\n'));
}

// `val x = V : T` lines; a value or type may wrap onto following indented lines
function smlnjVals(block) {
  const out = new Map();
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /(?:^|\))val (\S+) = (.*)$/.exec(lines[i]); // (`abval it = 3 : int`: print wrote no newline before the echo)
    if (!m) continue;
    let rest = m[2];
    while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) rest += ' ' + lines[++i].trim();
    out.set(m[1], rest.trim());
  }
  return out;
}

// After the program defines its own `list`, SML/NJ writes the built-in one as `?.list`; we write both as `list` (the value is
// what matters here, and the tests below check that the two are different types).
const normal = (s) => s.replace(/\?\.list/g, 'list').replace(/\s+/g, ' ').trim();

// Chunks we decide differently on purpose.
const KNOWN = [
  // (none yet)
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

test('t9 (lists, strings, options, print): accept/reject, exceptions, warnings and values agree with SML/NJ', { skip: !have && 'tests/ml/seed/t9.* is not present' }, () => {
  const cs = chunks(fs.readFileSync(path.join(seed, 't9.sml'), 'utf8'));
  const blocks = outputBlocks(fs.readFileSync(path.join(seed, 't9.smlnj-output.out'), 'utf8'));
  assert.equal(cs.length, blocks.length);
  const interp = new Interpreter({ style: 'sml', redundant: 'error' });
  const mismatches = [];
  let compared = 0;
  cs.forEach((chunk, i) => {
    const block = blocks[i];
    const tag = 't9#' + i + ' ' + chunk.slice(0, 50).replace(/\s+/g, ' ');
    const before = snapshot(interp);
    const r = interp.evalSync(chunk);
    const theirErr = /Error:/.test(block);
    const theirExn = /uncaught exception (\w+)/.exec(block);
    const ourErr = r.segments.find((s) => s.kind === 'error');
    const failed = !!ourErr;
    if (ourErr || theirErr || theirExn) restore(interp, before);
    if (KNOWN.some(([re]) => re.test(chunk))) return;
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
    if (theirErr) { compared++; return; }
    // a non-exhaustive match: reported by both (a `val` pattern that can fail is the recorded exception: SML/NJ is silent)
    if (!/^val \(/.test(chunk)) {
      const theirWarn = /match nonexhaustive/.test(block);
      const ourWarn = r.segments.some((s) => s.kind === 'warning');
      if (theirWarn !== ourWarn) mismatches.push(tag + ' => nonexhaustive warning: SML/NJ ' + theirWarn + ', ours ' + ourWarn);
      compared++;
    }
    const ours = new Map();
    for (const s of r.segments) {
      if (s.kind !== 'value') continue;
      for (const line of s.text.split('\n')) {
        const m = /^val (\S+) = (.*)$/.exec(line);
        if (m) ours.set(m[1], m[2].trim());
      }
    }
    for (const [name, text] of smlnjVals(block)) {
      if (text.includes('#') && !text.includes('#"')) continue; // print depth cut
      if (text.includes('...') || text.includes('?.X')) continue; // length cut, value restriction artefact
      compared++;
      if (!ours.has(name)) mismatches.push(tag + ' => missing val ' + name);
      else if (normal(ours.get(name)) !== normal(text)) mismatches.push(tag + ' => ' + name + ': SML/NJ [' + text + '] / ours [' + ours.get(name) + ']');
    }
  });
  assert.ok(compared > 80, 'expected many comparisons, got ' + compared);
  assert.deepEqual(mismatches, []);
});
