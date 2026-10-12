import { test } from 'node:test';
import assert from 'node:assert/strict';
import { val, run, newInterp } from './helpers.js';

test('boots and evaluates arithmetic', () => {
  assert.equal(val('(+ 1 2)'), '3');
  assert.equal(val('(* 6 7)'), '42');
});

test('define and call', () => {
  const i = newInterp();
  assert.equal(val('(define (sq x) (* x x)) (sq 12)', i), '144');
});

test('lists and quote', () => {
  assert.equal(val("(cons 'a '(b c))"), '(a b c)');
  assert.equal(val("(map (lambda (x) (* x x)) '(1 2 3))"), '(1 4 9)');
});

test('errors are reported in classic REPL style', () => {
  assert.equal(val('(car 5)'), ';The object 5, passed as the first argument to car, is not the correct type.');
  assert.equal(val('(foo)'), ';Unbound variable: foo');
});
