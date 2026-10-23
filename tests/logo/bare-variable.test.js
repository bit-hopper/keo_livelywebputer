// A bare word that is not a procedure but names a variable evaluates to the variable (the reference does this; the values
// are compared in differential.test.js, seed/bare-variable.lg). What the reference ALSO does, and we deliberately do not:
// it defines a hidden procedure `to yy / output :yy / end` on the first such use, which then shows up in PO, CONTENTS and
// PROCEDUREP and in error context lines ("in yy"). Here the lookup is only a fallback and the workspace stays untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { out } from './helpers.js';

test('the fallback leaves the workspace without a procedure', () => {
  assert.equal(out('make "yy 6\nshow yy\nshow procedurep "yy\nshow definedp "yy\nshow contents'), '6\nfalse\nfalse\n[[] [yy] []]');
});

test('a name that is neither a procedure nor a variable is still unknown', () => {
  assert.equal(out('show nothere'), "I don't know how  to nothere");
});

test('a procedure of the same name wins over the variable', () => {
  assert.equal(out('to samename\noutput 1\nend\nmake "samename 2\nshow samename'), 'samename defined\n1');
});

test('used as a command it is not silently accepted', () => {
  assert.equal(out('make "yy 6\nyy'), "You don't say what to do with 6");
});

test('a variable that has gone out of scope is unknown again', () => {
  assert.equal(out('to f\nlocal "q\nmake "q 1\nend\nf\nshow q'), "f defined\nI don't know how  to q");
});
