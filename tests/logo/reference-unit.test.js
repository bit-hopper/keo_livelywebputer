// The reference interpreter's own unit-test suites (LOGO.md 9.3) run through OUR engine. The framework and suites are GPL
// and are fetched, not committed (node tests/logo/fetch-reference.js); this test skips when they are absent.
//
// We assemble: the framework (UnitTests.lg) minus its LOAD lines and command-line handling, then each suite we support,
// then RunAll. On the reference (6.2.5) the baseline is 57 Ok, 0 Failed, plus 31 OOP errors because the objects feature
// is not compiled in (LOGO.md 9.3); OOP and the file/memory suites are out of scope for Phase 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newInterpreter } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REF = path.join(here, 'reference', 'tests');
const have = fs.existsSync(path.join(REF, 'UnitTests.lg'));
const skip = have ? false : 'reference corpus absent: run  node tests/logo/fetch-reference.js';

function framework() {
  let t = fs.readFileSync(path.join(REF, 'UnitTests.lg'), 'utf8').replace(/\r/g, '');
  t = t.replace(/^LOAD "UnitTests-[^\n]*\n/gm, '');
  const i = t.indexOf(';; Process any command line options');
  return i === -1 ? t : t.slice(0, i);
}

// Runs the named suites and returns {ok, failed, errors, lines}: one entry per "name....  Ok|Failed|Error" line.
export function runSuites(names) {
  let src = framework();
  for (const n of names) src += '\n' + fs.readFileSync(path.join(REF, `UnitTests-${n}.lg`), 'utf8').replace(/\r/g, '');
  src += '\nRunAll\n';
  const it = newInterpreter();
  const r = it.run(src, { onError: 'continue' });
  const results = [];
  for (const line of r.text.split('\n')) {
    const m = /^(\S+?)\.\.\.\s+(Ok|Failed|Error)\s*$/.exec(line);
    if (m) results.push({ name: m[1], result: m[2] });
  }
  return { results, text: r.text };
}

for (const suite of ['Arithmetic', 'Bitwise', 'Constructors', 'Control', 'Macros', 'Predicates', 'Random']) {
  test(`reference suite ${suite}: every test is Ok`, { skip }, () => {
    const { results, text } = runSuites([suite]);
    const bad = results.filter((r) => r.result !== 'Ok');
    assert.ok(results.length > 0, 'no test lines found:\n' + text.slice(0, 2000));
    assert.deepEqual(bad, [], `${bad.length} of ${results.length} not Ok`);
  });
}
