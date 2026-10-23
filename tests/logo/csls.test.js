// The csls book programs (Phase 1 acceptance, LOGO.md 13): each program from the fetched corpus is loaded into our engine
// together with a driver script of our own (tests/logo/csls/<name>.driver.lg) that calls its procedures, and what is
// printed must equal what the reference printed for the same program and driver (<name>.ucblogo-output.txt, recorded by
// tests/logo/csls/record.sh). The programs themselves are GPL and are never committed: the corpus is fetched into the
// gitignored tests/logo/reference/ by `node tests/logo/fetch-reference.js`, and every test here skips when it is absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newInterpreter } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CSLS = path.join(here, 'reference', 'csls');
const DIR = path.join(here, 'csls');
const MARKER = '=====DRIVER=====';

// What our engine prints after the driver's marker line, for `name`'s program followed by its driver.
function ours(name) {
  const program = fs.readFileSync(path.join(CSLS, name + '.lg'), 'utf8');
  const driver = fs.readFileSync(path.join(DIR, name + '.driver.lg'), 'utf8');
  const it = newInterpreter();
  const text = it.run(program + '\n' + driver, { onError: 'continue' }).text;
  const at = text.indexOf(MARKER + '\n');
  assert.notEqual(at, -1, `[${name}] the driver's marker line was never printed`);
  return text.slice(at + MARKER.length + 1);
}

const trim = (t) => t.replace(/\s+$/, '');

// Per program: pairs [reference text, our text] where we differ ON PURPOSE. Each must occur in the recording, so a stale
// entry fails the test (the same convention as differential.test.js).
const DIFFERS = {};

for (const name of ['pour', 'match', 'poker', 'playfair', 'math', 'algs', 'streams']) {
  const have = fs.existsSync(path.join(CSLS, name + '.lg'));
  test(`csls ${name} prints what the reference prints`, { skip: have ? false : 'corpus not fetched (node tests/logo/fetch-reference.js)' }, () => {
    let ref = fs.readFileSync(path.join(DIR, name + '.ucblogo-output.txt'), 'utf8').replace(/\r/g, '');
    ref = ref.replace(/Thank you for using Logo\.\nHave a nice day\.\n?$/, '');
    for (const [was, now] of DIFFERS[name] || []) {
      assert.ok(ref.includes(was), `[${name}] a "reference differs" entry no longer occurs in the recording:\n${was}`);
      ref = ref.replace(was, now);
    }
    assert.equal(trim(ours(name)), trim(ref));
  });
}
