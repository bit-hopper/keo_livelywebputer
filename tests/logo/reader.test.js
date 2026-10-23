// Reader, runparse, minus and arity. Expected values were checked against the reference interpreter (ucblogo 6.2.5) on
// 2026-10-23 unless a comment says the engine differs on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { out } from './helpers.js';

test('vertical bars protect spaces and parentheses; a backslash protects one character', () => {
  assert.equal(out('print "|a b|\nprint count "|a b|'), 'a b\n3');
  assert.equal(out('show [a |b c| d]'), '[a b c d]');
  assert.equal(out(String.raw`print "a\ b
print count "a\ b`), 'a b\n3');
  assert.equal(out('show parse "|a (b) c|'), '[a (b) c]');
  assert.equal(out('show [a (b) c]'), '[a (b) c]');
});

test('a tilde continues the line, and so does an open bracket', () => {
  assert.equal(out('print [a ~\nb]'), 'a b');
  assert.equal(out('print [a\nb\nc]'), 'a b c');
  assert.equal(out('make "x 3\nprint :x ~\n+ 1'), '4');
});

test('a semicolon starts a comment', () => {
  assert.equal(out('print "abc;comment'), 'abc');
  assert.equal(out('print 3 ; trailing'), '3');
});

test('infix operators inside a list stay as typed until runparse or run', () => {
  assert.equal(out('show [2+3]'), '[2+3]');
  assert.equal(out('show runparse [2+3]'), '[2 + 3]');
  assert.equal(out('show runparse "|print 3+4|'), '[print 3+4]');
  assert.equal(out('show runparse [print 3+4]'), '[print 3 + 4]');
  assert.equal(out('run [print 2+3]'), '5');
});

// Minus: `a-b` and `a - b` are subtraction, `3 -1` is a negative literal (so two things), and a unary minus after an
// operator or at the start of an expression is a negation.
test('minus', () => {
  assert.equal(out('print 3-1\nprint 3 - 1'), '2\n2');
  assert.equal(out('print 3 -1'), '3\nYou don\'t say what to do with -1');
  assert.equal(out('show runparse [3-1]'), '[3 - 1]');
  assert.equal(out('show runparse [3 -1]'), '[3 -1]');
  assert.equal(out('show runparse [a - b]'), '[a - b]');
  assert.equal(out('make "a 10\nprint :a-1\nprint :a - 1'), '9\n9');
  assert.equal(out('make "a 10\nprint :a -1'), '10\nYou don\'t say what to do with -1');
  assert.equal(out('print -3 + 4\nprint 2 * -3\nprint minus 3'), '1\n-6\n-3');
  assert.equal(out('print - 3 + 4'), 'not enough inputs to print');   // a spaced minus is binary, so print has no input
});

// The reference reports "+ doesn't like [] as input" for an operator with nothing on its right; we say it needs an
// input. Same situation, our wording.
test('an infix operator with no right operand is an error', () => {
  assert.equal(out('print 3 +'), 'not enough inputs to +');
});

test('unbalanced brackets and parentheses are reported', () => {
  assert.equal(out(')'), "unexpected ')'");
  assert.equal(out(']'), "unexpected ']'");
});

test('arity: default, minimum and maximum, and the parenthesised forms', () => {
  assert.equal(out('print sum 1 2\nprint (sum 1 2 3 4)'), '3\n10');
  assert.equal(out('(print sum 1 2 3 4)'), '3 3 4');   // the parentheses belong to print, so sum takes its default two
  assert.equal(out('(print)\n(print 1 2 3)'), '\n1 2 3');
  assert.equal(out('print (sum)'), '0');
  assert.equal(out('print (sum 5)'), '5');
  assert.equal(out('print (word "a "b "c)'), 'abc');
  assert.equal(out('show (list 1 2 3)\nshow (se 1 2 3)'), '[1 2 3]\n[1 2 3]');
  assert.equal(out('show arity "sum\nshow arity "print'), '[0 2 -1]\n[0 1 -1]');
});

test('procedure inputs: required, optional with a default, and rest', () => {
  const def = 'to f :a [:b 5] [:rest]\noutput list :a :b\nend\n';
  assert.equal(out(def + 'show arity "f'), 'f defined\n[1 1 -1]');
  assert.equal(out(def + 'show f 1'), 'f defined\n[1 5]');
  assert.equal(out(def + 'show (f 1 2)'), 'f defined\n[1 2]');
  assert.equal(out(def + 'show (f 1 2 3 4)'), 'f defined\n[1 2]');
  assert.equal(out(def + 'show f'), 'f defined\nnot enough inputs to f');
  assert.equal(out('to rest :a [:r]\noutput :r\nend\nshow (rest 1 2 3 4)'), 'rest defined\n[2 3 4]');
});

test('too many and too few inputs', () => {
  assert.equal(out('to g :x\noutput :x\nend\nshow (g 1 2)'), "g defined\ntoo many inputs to g");
  assert.equal(out('to g :x\noutput :x\nend\nshow g 1 2'), "g defined\n1\nYou don't say what to do with 2");
  assert.equal(out('print first'), 'not enough inputs to first');
  assert.equal(out('print (first 1 2)'), 'too many inputs to first');
});
