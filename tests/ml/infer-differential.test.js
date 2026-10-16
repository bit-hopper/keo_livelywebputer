// The seed corpora run through SML/NJ (tests/ml/seed/*.smlnj-output.txt, produced by runchunks.sh) are the ground truth for
// accept/reject and for principal types. We elaborate the same chunks, each on top of the chunks that succeeded before it,
// and compare after normalising: SML/NJ's `val x = V : T` lines against our echo in SML style.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunks, chunkSession } from './helpers.js';
import { typeToString } from '../../core/lib/ml/src/types.js';

const seed = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed');
const files = ['t4', 't5b', 't6'];
const have = files.every((f) => fs.existsSync(path.join(seed, f + '.sml')) && fs.existsSync(path.join(seed, f + '.smlnj-output.txt')));

// The output blocks of runchunks.sh: one per chunk, after its "######## c_NNN.sml" header and the quoted source lines.
function outputBlocks(text) {
  const blocks = text.replace(/\r/g, '').split(/^######## c_\d+\.sml$/m).slice(1);
  return blocks.map((b) => b.split('\n').filter((l) => !l.startsWith('    | ')).join('\n'));
}

// {name -> type text} for the `val` lines SML/NJ printed (a type may wrap onto following indented lines)
function smlnjVals(block) {
  const out = new Map();
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^val (\S+) = (.*)$/.exec(lines[i]);
    if (!m) continue;
    let rest = m[2];
    while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) rest += ' ' + lines[++i].trim();
    const k = rest.lastIndexOf(' : ');
    if (k < 0) continue;
    out.set(m[1], rest.slice(k + 3).trim());
  }
  return out;
}

// Did SML/NJ reject the chunk statically? (An uncaught exception is the machine's business, a redundant match the pattern
// checker's; neither is a typing verdict.)
const staticError = (block) => /Error:/.test(block) && !/match redundant/.test(block);

// Chunks we decide differently for now, and why. A change here is a decision.
const KNOWN = [
  [/^val big = \[|^fun subst_c|^val w = \[\]|^Compiler\.Control|^\(subst_c/, 'lists and := are out of the core (until the list phase)'],
  [/^IntArith2\.plus\(1,2\);/, "SML/NJ prints the name of an abbreviation (IntArith2.number) where we print the type it stands for (int)"],
  [/^4611686018427387903 \+ 1;/, 'our int is 63-bit (a recorded deviation): this literal is legal for us'],
];

test('seed corpora: accept/reject and principal types agree with SML/NJ', { skip: !have && 'tests/ml/seed is not present' }, () => {
  const mismatches = [];
  let compared = 0;
  for (const f of files) {
    const cs = chunks(fs.readFileSync(path.join(seed, f + '.sml'), 'utf8'));
    const blocks = outputBlocks(fs.readFileSync(path.join(seed, f + '.smlnj-output.txt'), 'utf8'));
    assert.equal(cs.length, blocks.length, f + ': chunk/output count');
    const s = chunkSession('sml');
    cs.forEach((chunk, i) => {
      const block = blocks[i];
      const r = s.run(chunk);
      const ref = staticError(block);
      const tag = f + '#' + i + ' ' + chunk.slice(0, 60).replace(/\s+/g, ' ');
      if (KNOWN.some(([re]) => re.test(chunk))) return;
      if (ref && !r.error) mismatches.push(tag + ' => SML/NJ rejects, we accept');
      else if (!ref && r.error) mismatches.push(tag + ' => SML/NJ accepts, we reject: ' + r.error.errorClass + ': ' + r.error.message);
      else if (!ref) {
        const theirs = smlnjVals(block);
        const ours = new Map(r.echo.filter((e) => e.kind === 'val').map((e) => [e.name, typeToString(e.type, 'sml')]));
        for (const [name, ty] of theirs) {
          if (ty.includes('?.')) continue; // value-restriction artefact (a recorded deviation)
          compared++;
          if (!ours.has(name)) mismatches.push(tag + ' => missing val ' + name);
          else if (ours.get(name) !== ty) mismatches.push(tag + ' => ' + name + ': SML/NJ ' + ty + ' / ours ' + ours.get(name));
        }
      }
    });
  }
  assert.ok(compared > 40, 'expected many compared types, got ' + compared);
  assert.deepEqual(mismatches, []);
});
