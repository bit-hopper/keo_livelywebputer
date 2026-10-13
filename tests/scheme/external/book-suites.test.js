// The interpreters published for the textbook, each run against the test suite
// that ships with it. Skipped unless EOPL_BOOK_CODE points at a checkout of that
// code (the repository is licensed for non-commercial use, so it is not copied here):
//
//   git clone --depth 1 <the repository of the published interpreters> /some/dir
//   EOPL_BOOK_CODE=/some/dir npm run test:scheme
//
// (the plain `node --test` form works too). That code predates this engine, so this
// also exercises the language library it was written for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runBookLanguage } from './book-code.js';

const root = process.env.EOPL_BOOK_CODE;
const skip = !root || !fs.existsSync(path.join(root, 'chapter3'));

const LANGUAGES = [
  'chapter3/let-lang', 'chapter3/letrec-lang', 'chapter3/proc-lang/ds-rep', 'chapter3/proc-lang/proc-rep', 'chapter3/lexaddr-lang',
  'chapter4/explicit-refs', 'chapter4/implicit-refs', 'chapter4/mutable-pairs', 'chapter4/call-by-need', 'chapter4/call-by-reference',
  'chapter5/exceptions', 'chapter6/cps-lang', 'chapter6/cps-side-effects-lang',
  'chapter7/checked', 'chapter7/inferred',
  'chapter8/abstract-types-lang', 'chapter8/full-system', 'chapter8/simplemodules',
  'chapter9/classes', 'chapter9/typed-oo',
];

for (const lang of LANGUAGES) {
  test('book code: ' + lang, { skip }, () => {
    const r = runBookLanguage(path.join(root, lang));
    assert.deepEqual(r.errors, []);
    assert.match(r.output, /no bugs found/, r.output.slice(-600));
  });
}

test('book code: chapter5/letrec-lang (both interpreters)', { skip }, () => {
  for (const top of ['top-interp.scm', 'top-interp-registers.scm']) {
    const r = runBookLanguage(path.join(root, 'chapter5/letrec-lang'), { top });
    assert.deepEqual(r.errors, [], top);
    assert.match(r.output, /no bugs found/, top);
  }
});

test('book code: chapter5/thread-lang', { skip }, () => {
  const r = runBookLanguage(path.join(root, 'chapter5/thread-lang'), { expr: '(run-all 50)' });
  assert.deepEqual(r.errors, []);
  assert.match(r.output, /no bugs found/);
});

test('book code: the unit tests in chapters 1 and 2 load without a failure report', { skip }, () => {
  const c1 = runBookLanguage(path.join(root, 'chapter1'), { top: 'test-chap1.scm', expr: '"done"' });
  assert.deepEqual(c1.errors, []);
  assert.doesNotMatch(c1.output, /returned/); // a failing check prints "... returned X, should have returned Y"
  for (const f of ['sec2.1', 'sec2.2-ds-rep', 'sec2.2-proc-rep', 'sec2.3', 'sec2.4', 'sec2.5']) {
    const r = runBookLanguage(path.join(root, 'chapter2'), { top: f + '.scm', expr: '"done"' });
    assert.deepEqual(r.errors, [], f);
  }
});
