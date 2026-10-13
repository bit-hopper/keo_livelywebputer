// #lang jbob: the J-Bob proof assistant, loaded as user code because it redefines if, car, cdr, +, <
// and equal. The transcript corpus is the authors' own list of proofs; running all of them is the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newInterp, run, val } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const transcript = fs.readFileSync(path.join(here, 'corpora', 'jbob-transcript.scm'), 'utf8');

function withJbob() {
  const i = newInterp();
  assert.equal(run('#lang jbob', i), '', 'the library should load silently');
  return i;
}

function withTranscript() {
  const i = newInterp();
  assert.equal(run('#lang jbob\n' + transcript, i), '', 'the transcript should load silently');
  return i;
}

test('jbob: the language changes core names for the page, and only user code sees it', () => {
  const plain = newInterp();
  assert.match(val('(car 5)', plain), /^;/);          // an error without the library
  assert.equal(val("(car '(a b))", plain), 'a');
  const i = withJbob();
  assert.equal(val('(car 5)', i), '()');               // J-Bob's car of a non-pair
  assert.equal(val("(equal 'a 'a)", i), 't');
  assert.equal(val("(list (atom 3) (atom '(a)))", i), '(t nil)');
  assert.equal(val("(if 'nil 1 2)", i), '2');          // only the symbol nil is false
  assert.equal(val('(+ 1 (quote x))', i), '1');        // non-numbers count as zero
  assert.equal(val('(size (quote (a b (c))))', i), '4');   // counts pairs: three in the list, one in (c)
  // a fresh interpreter is not affected by the one above
  assert.equal(val("(car '(a b))", newInterp()), 'a');
});

test('jbob: library procedures keep their own meaning of car, cdr, + and if', () => {
  const i = withJbob();
  assert.equal(val('(iota 5)', i), '(0 1 2 3 4)');
  assert.equal(val('(length (list 1 2 3))', i), '3');
  assert.equal(val("(map (lambda (x) (* x 2)) '(1 2 3))", i), '(2 4 6)');
  assert.equal(val("(sort '(3 1 2) (lambda (a b) (s.< a b)))", i), '(1 2 3)');
  assert.equal(val("(append '(a) '(b c))", i), '(a b c)');
  assert.equal(val("(list-index even? '(1 3 4))", i), '2');
});

test('jbob: a single proof step is checked and a wrong one is refused', () => {
  const i = withTranscript();
  assert.equal(val('(chapter1.example1)', i), '(quote ham)');
  assert.equal(
    val("(J-Bob/step (prelude) '(car (cons 'ham '(eggs))) '((() (cdr (cons 'a 'b)))))", i),
    "(car (cons (quote ham) (quote (eggs))))");
});

test('jbob: every proof in the transcript is accepted, up to align/align', () => {
  const i = withTranscript();
  // The result is the list of definitions and theorems that were proved; it has the final
  // theorem and the induction schemes it needed only if every proof before it was accepted.
  assert.equal(
    val("(define r (dethm.align/align)) (list (length r) (and (member 'align/align (map cadr r)) #t) (and (member 'list-induction (map cadr r)) #t))", i),
    '(60 #t #t)');
});

test('jbob: a false theorem is not added', () => {
  const i = withTranscript();
  const out = val(
    "(length (J-Bob/define (prelude) '(((dethm bogus (x) (equal (car x) x)) nil (() (car x))))))", i);
  // a rejected proof leaves the starting set unchanged
  assert.equal(out, val('(length (prelude))', i));
});

test('jbob: another library cannot be loaded after it (it would be compiled with the proof language\'s if)', () => {
  const i = withJbob();
  for (const lib of ['sicp', 'tls', 'simply', 'eopl']) {
    assert.match(run('#lang ' + lib + '\n(list 1 2)', i), /cannot load "\w+" after "jbob".*Reset/, lib);
  }
});

test('jbob: it can be loaded after the other libraries, which keep working', () => {
  const i = newInterp();
  assert.equal(run('#lang sicp\n(define xs (list 1 2 3))', i), '');
  assert.equal(run('#lang jbob', i), '');
  assert.equal(val('(length xs)', i), '3');
  assert.equal(val('(stream-car (cons-stream 1 2))', i), '1');
  assert.equal(val("(equal 'a 'a)", i), 't');
});
