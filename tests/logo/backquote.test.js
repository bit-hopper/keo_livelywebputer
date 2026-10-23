// Backquote: the cases the reference cannot be the oracle for (its implementation is Logo source, so its error messages
// quote that source), and the machine-level properties that matter to us -- STOP and OUTPUT still work through it, a
// THROW inside a comma reaches the CATCH, and a deep unquote does not use the JS stack. The value cases are compared with
// the reference in differential.test.js (seed/backquote.lg).
import test from 'node:test';
import assert from 'node:assert/strict';
import { out, logo } from './helpers.js';

test('substitution and splicing', () => {
  assert.equal(out('make "x 5\nshow `[a ,:x ,[:x+1] ,@[list :x :x] b]'), '[a 5 6 5 5 b]');
  assert.equal(out('show `[a ,@[word "p "q] b]'), '[a pq b]');
  assert.equal(out('show `[a ,@[1+2] b]'), '[a 3 b]');
});

test('the unquoted instructions run left to right', () => {
  assert.equal(out('make "n 0\nto next\nmake "n :n + 1\noutput :n\nend\nshow `[,[next] ,[next] ,@[list next next]]'), 'next defined\n[1 2 3 4]');
});

test('a glued prefix joins the value', () => {
  assert.equal(out('make "w "hello\nshow `[",:w :,[first [p q]]]'), '["hello :p]');
  assert.equal(out('make "l [p q]\nshow `[a ",@:l b]'), '[a "p q b]');
});

test('nested backquotes keep the commas of the inner level', () => {
  assert.equal(out('make "x 5\nshow `[a `[b ,:x ,,:x]]'), '[a ` [b , [:x] , [5]]]');
});

test('empty and plain input', () => {
  assert.equal(out('show `[]'), '[]');
  assert.equal(out('show `[a [b c] d]'), '[a [b c] d]');
  assert.equal(out('show ` "abc'), '[a b c]');
});

test('errors name the backquote, not a library', () => {
  assert.match(out('show `[a ,[foo] b]'), /^I don't know how {2}to foo/);
  assert.match(out('show `[a ,[print 1] b]'), /^1\nprint didn't output to `/);
  assert.match(out('show `[a ,[stop] b]'), /^stop didn't output to `/);
  assert.match(out('show `[a ,[] b]'), /didn't output to `/);
  assert.match(out('make "l [p q]\nshow `[a ",:l]'), /^word doesn't like \[p q\] as input/);
  assert.match(out('show `[a ,]'), /doesn't like \[\] as input/);
  assert.match(out('show `'), /^not enough inputs to `/);
});

// Decision 14: OUTPUT leaves the enclosing procedure through RUN-like constructs, and a comma's instruction list is one.
// (The reference reports an error here because its backquote is a Logo procedure sitting in between.)
test('OUTPUT and THROW work through the instructions', () => {
  assert.equal(out('to f\nmake "r `[a ,[output 7]]\noutput 99\nend\nshow f'), 'f defined\n7');
  assert.equal(out('show catch "t [`[a ,[(throw "t 9)]]]'), '9');
});

// Each level splices the whole list built below it, so the work grows with the square of the depth (3000 deep is about
// 4.5 million cells); the depth is what is being tested, not the speed, so keep it modest.
test('a deep non-tail recursion through backquote finishes', () => {
  const r = logo('to build :n\nif :n = 0 [output []]\noutput `[,:n ,@[build :n - 1]]\nend\nshow count build 3000');
  assert.equal(r.text.trim(), 'build defined\n3000');
});
