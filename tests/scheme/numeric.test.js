import { test } from 'node:test';
import assert from 'node:assert/strict';
import { val } from './helpers.js';

const cases = (pairs) => { for (const [src, want] of pairs) assert.equal(val(src), want, src); };

test('exact integer arithmetic and bigint promotion', () => {
  cases([
    ['(+ 1 2)', '3'], ['(- 10 3 2)', '5'], ['(* 2 3 4)', '24'], ['(+)', '0'], ['(*)', '1'], ['(- 5)', '-5'],
    ['(+ 9007199254740991 1)', '9007199254740992'],
    ['(* 99999999999 99999999999)', '9999999999800000000001'],
    ['(- (expt 2 60) (expt 2 60))', '0'],
    ['(expt 2 100)', '1267650600228229401496703205376'],
    ['(quotient (expt 10 30) (expt 10 28))', '100'],
    ['(exact->inexact (expt 2 70))', '1.1805916207174113e21'],
    ['(= (expt 2 60) (expt 2 60))', '#t'],
    ['(< (expt 2 60) (expt 2 61))', '#t'],
  ]);
});

test('big results demote back to small ints', () => {
  cases([['(eq? (- (+ (expt 2 60) 5) (expt 2 60)) 5)', '#t']]);
});

test('rationals', () => {
  cases([
    ['(/ 1 3)', '1/3'], ['(/ 6 4)', '3/2'], ['(/ 6 3)', '2'], ['(+ 1/2 1/3)', '5/6'], ['(* 2/3 3/2)', '1'],
    ['(- 1/2 1/2)', '0'], ['(/ 1 -2)', '-1/2'], ['(exact->inexact 1/4)', '0.25'], ['(< 1/3 1/2)', '#t'],
    ['(numerator 6/4)', '3'], ['(denominator 6/4)', '2'], ['(floor 7/2)', '3'], ['(ceiling 7/2)', '4'],
    ['(round 7/2)', '4'], ['(round 5/2)', '2'], ['(truncate -7/2)', '-3'], ['(floor -7/2)', '-4'],
    ['(expt 2/3 2)', '4/9'], ['(expt 2 -3)', '1/8'], ['(exact 0.5)', '1/2'], ['(exact 2.5)', '5/2'],
  ]);
});

test('inexact numbers keep their exactness visible', () => {
  cases([
    ['(* 1.0 3)', '3.0'], ['(+ 0.5 0.5)', '1.0'], ['(exact->inexact 1/3)', '0.3333333333333333'],
    ['(+ 0.1 0.2)', '0.30000000000000004'], ['(sqrt 2)', '1.4142135623730951'],
    ['(* 0 1.5)', '0'], ['(max 1 2.0)', '2.0'], ['(min 1 2.0)', '1.0'], ['(exact (floor 3.7))', '3'],
    ['(round 2.5)', '2.0'], ['(round 3.5)', '4.0'], ['(round -2.5)', '-2.0'], ['(truncate 2.7)', '2.0'],
    ['(/ 1.0 0)', ';Division by zero signalled by /.'], ['(/ 1 0)', ';Division by zero signalled by /.'],
    ['(/ 1.0 0.)', '+inf.0'], ['(exact->inexact 100)', '100.0'], ['1e21', '1e21'], ['1.5e-7', '1.5e-7'],
    ['(integer? 3.0)', '#t'], ['(integer? 3.5)', '#f'], ['(exact? 3.0)', '#f'], ['(inexact? 3.0)', '#t'],
    ['(= 3 3.0)', '#t'], ['(eqv? 3 3.0)', '#f'], ['(equal? 3 3.0)', '#f'],
  ]);
});

test('sqrt, expt, exp/log', () => {
  cases([
    ['(sqrt 16)', '4'], ['(sqrt 15)', '3.872983346207417'], ['(sqrt 1/4)', '1/2'], ['(sqrt 16.0)', '4.0'],
    ['(sqrt (expt 10 40))', '100000000000000000000'],
    ['(call-with-values (lambda () (exact-integer-sqrt 17)) list)', '(4 1)'],
    ['(expt 2 10)', '1024'], ['(expt 2.0 0.5)', '1.4142135623730951'], ['(expt 0 0)', '1'], ['(exp 0)', '1'],
    ['(log 1)', '0'], ['(sin 0)', '0'], ['(atan 1 1)', '0.7853981633974483'], ['(number->string (exp 1))', '"2.718281828459045"'],
  ]);
});

test('integer division', () => {
  cases([
    ['(quotient 7 2)', '3'], ['(quotient -7 2)', '-3'], ['(remainder 7 2)', '1'], ['(remainder -7 2)', '-1'],
    ['(modulo 7 2)', '1'], ['(modulo -7 2)', '1'], ['(modulo 7 -2)', '-1'], ['(modulo -7 -2)', '-1'],
    ['(quotient 7 0)', ';Division by zero signalled by integer-quotient.'],
    ['(modulo 10 0)', ';Division by zero signalled by integer-modulo.'],
    ['(gcd 12 18)', '6'], ['(lcm 4 6)', '12'], ['(gcd)', '0'], ['(abs -5)', '5'], ['(abs -5.5)', '5.5'],
    ['(even? 10)', '#t'], ['(odd? 10)', '#f'], ['(even? (expt 2 70))', '#t'],
    ['(exact->inexact (/ (expt 10 30) 3))', '3.333333333333333e29'],
  ]);
});

test('numeric predicates and conversion', () => {
  cases([
    ['(number? 1)', '#t'], ['(number? "1")', '#f'], ['(zero? 0)', '#t'], ['(zero? 0.0)', '#t'],
    ['(positive? 3)', '#t'], ['(negative? -1/2)', '#t'], ['(number->string 255 16)', '"ff"'],
    ['(string->number "42")', '42'], ['(string->number "abc")', '#f'], ['(string->number "1/2")', '1/2'],
    ['(string->number "ff" 16)', '255'], ['(string->number "1.5")', '1.5'],
    ['(1+ 5)', '6'], ['(-1+ 5)', '4'], ['(add1 5)', '6'], ['(sub1 5)', '4'], ['(square 5)', '25'], ['(cube 3)', '27'],
    ['(exact->inexact 12345678901234567890)', '12345678901234567000.0'],
  ]);
});

test('numeric type errors use the integer-* primitive names', () => {
  cases([
    ['(+ 1 "a")', ';The object "a", passed as the second argument to integer-add, is not the correct type.'],
    ['(+ (quote a) 1)', ';The object a, passed as the first argument to integer-add, is not the correct type.'],
    ['(< 1 (quote x))', ';The object x, passed as the second argument to integer-less?, is not the correct type.'],
    ['(* 2 "x")', ';The object "x", passed as the second argument to integer-multiply, is not the correct type.'],
  ]);
});

test('comparison chains', () => {
  cases([
    ['(< 1 2 3)', '#t'], ['(< 1 3 2)', '#f'], ['(<= 1 1 2)', '#t'], ['(= 2 2 2)', '#t'], ['(> 3 2 1)', '#t'], ['(>= 3 3 4)', '#f'],
  ]);
});
