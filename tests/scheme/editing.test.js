// Pure text functions behind the Scheme cell editor (bracket matching, indentation).
// The module is a Lively module(...).requires().toRun(...) file, so load it into a
// sandbox with just enough of those globals stubbed.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '../../core/lively/identity/SchemeEditing.js');

function load() {
  const lively = { identity: {} };
  const ctx = {
    lively,
    module: () => ({ requires: () => ({ toRun: (fn) => fn() }) }),
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  return lively.identity.SchemeEditing;
}

const E = load();

// indent of the line that follows `before` (the text up to and including a newline)
function nextIndent(before) {
  return E.indentFor(before + 'x', before.length);
}

test('scan: strings, comments and char literals hide brackets', () => {
  const t = '(a "(" ; )\n #\\( b)';
  const pairs = E.scan(t).pairs;
  assert.strictEqual(pairs.length, 2);
  assert.strictEqual(pairs[0].match, t.length - 1);
});

test('scan: context at the limit', () => {
  assert.strictEqual(E.scan('(a "bc', 6).context, 'string');
  assert.strictEqual(E.scan('(a ; hi', 7).context, 'comment');
  assert.strictEqual(E.scan('(a #| hi', 8).context, 'blockcomment');
  assert.strictEqual(E.scan('(a "b" c)', 9).context, 'code');
  assert.strictEqual(E.scan('(a "b\\"c" d', 11).context, 'code');
});

test('matchAt: bracket before or after the caret, and unmatched', () => {
  const t = '(a (b) c)';
  assert.deepEqual(E.matchAt(t, 1), { a: 0, b: 8 });   // just after "("
  assert.deepEqual(E.matchAt(t, 0), { a: 0, b: 8 });   // just before "("
  assert.deepEqual(E.matchAt(t, 6), { a: 5, b: 3 });   // just after ")"
  assert.strictEqual(E.matchAt(t, 2), null);
  assert.deepEqual(E.matchAt('(a (b)', 0), { a: 0, b: -1 });
  assert.deepEqual(E.matchAt('a)', 2), { a: 1, b: -1 });
  assert.deepEqual(E.matchAt('[a (b)]', 7), { a: 6, b: 0 });
});

test('indentFor: top level and body forms', () => {
  assert.strictEqual(nextIndent('(define (f x)\n'), 2);
  assert.strictEqual(nextIndent('(lambda (x)\n'), 2);
  assert.strictEqual(nextIndent('(let loop ((i 0))\n'), 2);
  assert.strictEqual(nextIndent('(define (f x)\n  (+ x 1))\n'), 0);
  assert.strictEqual(nextIndent('  (when ok\n'), 4);
  assert.strictEqual(nextIndent('(define-record-type point\n'), 2);
});

test('indentFor: calls align with the first argument', () => {
  assert.strictEqual(nextIndent('(foo a\n'), 5);
  assert.strictEqual(nextIndent('(if (< a b)\n'), 4);
  assert.strictEqual(nextIndent('(+ 1 2\n'), 3);
  assert.strictEqual(nextIndent('(foo\n'), 2);
  assert.strictEqual(nextIndent('(cond ((= x 1) 1)\n'), 6);
  assert.strictEqual(nextIndent("(foo 'a\n"), 5);
  assert.strictEqual(nextIndent("(foo 'bar baz\n"), 5);
});

test('indentFor: data and binding lists align with the first element', () => {
  assert.strictEqual(nextIndent("'(a\n"), 2);
  assert.strictEqual(nextIndent('(let ((x 1)\n'), 6);
  assert.strictEqual(nextIndent('(let ([x 1]\n'), 6);
  assert.strictEqual(nextIndent('((f x)\n'), 1);
  assert.strictEqual(nextIndent("(foo '(1 2\n"), 7);
  assert.strictEqual(nextIndent('(foo #(1 2\n'), 7);
});

test('indentFor: nesting resets to the enclosing list', () => {
  assert.strictEqual(nextIndent('(define (f x)\n  (if x\n      1\n      2)\n'), 2);
  assert.strictEqual(nextIndent('(define (f x)\n  (cond ((a) 1)\n'), 8);
});

test('indentFor: leaves lines inside strings and block comments alone', () => {
  assert.strictEqual(E.indentFor('(display "abc\nxyz")', 14), null);
  assert.strictEqual(E.indentFor('#| note\n more |#', 8), null);
  // a line comment does not hide brackets on the next line
  assert.strictEqual(nextIndent('(foo a ; (\n'), 5);
});

test('reindent: normalizes a whole definition top-down', () => {
  const messy = '(define (fact n)\n(if (= n 0)\n1\n(* n\n(fact (- n 1)))))';
  const want = '(define (fact n)\n  (if (= n 0)\n      1\n      (* n\n         (fact (- n 1)))))';
  assert.strictEqual(E.reindent(messy, 0, 4).text, want);
});

test('reindent: is idempotent and only touches the asked lines', () => {
  const good = '(define (f x)\n  (+ x 1))';
  assert.strictEqual(E.reindent(good, 0, 1).text, good);
  const text = '(a b\n    c\n    d)';
  const r = E.reindent(text, 1, 1);
  assert.strictEqual(r.text, '(a b\n   c\n    d)');
  assert.strictEqual(r.deltas[1], -1);
});

test('reindent: a lone blank line is indented, blank lines in a block are emptied', () => {
  assert.strictEqual(E.reindent('(foo\n', 1, 1).text, '(foo\n  ');
  assert.strictEqual(E.reindent('(foo\n   \nb)', 0, 2).text, '(foo\n\n  b)');
});

test('reindent: does not touch a string that spans lines', () => {
  const t = '(display "a\n   b")';
  assert.strictEqual(E.reindent(t, 1, 1).text, t);
});

test('indentFor: letcc is a body form', () => {
  assert.strictEqual(nextIndent('(letcc hop\n'), 2);
  assert.strictEqual(nextIndent('  (letcc k\n'), 4);
});

test('indentFor: cases and define-datatype bodies, and the body lines of a cases clause', () => {
  assert.strictEqual(nextIndent('(cases expr e\n'), 2);
  assert.strictEqual(nextIndent('(define-datatype expr expr?\n'), 2);
  // inside a clause the variant name is not a function: body lines go 2 in, not under the field list
  assert.strictEqual(nextIndent('(cases expr e\n  (add-exp (l r)\n'), 4);
  assert.strictEqual(nextIndent('(define (f e)\n  (cases expr e\n    (add-exp (l r) (g l)\n'), 6);
  // an ordinary call inside a clause body still aligns with its first argument
  assert.strictEqual(nextIndent('(cases expr e\n  (add-exp (l r)\n    (+ (f l)\n'), 7);
  // a list that is not a cases clause is unchanged
  assert.strictEqual(nextIndent('(foo (bar 1\n'), 10);
});
