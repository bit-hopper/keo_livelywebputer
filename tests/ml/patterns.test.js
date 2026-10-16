import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checked } from './helpers.js';

const DT = 'datatype pizza = Crust | Cheese of pizza | Anchovy of pizza;\n';
const T = 'datatype t = A | B of int | C of t * t;\n';

test('an exhaustive match is silent', () => {
  const r = checked(DT + 'fun f(Crust) = 1 | f(Cheese(x)) = 2 | f(Anchovy(y)) = 3;');
  assert.deepEqual(r, { warnings: [], error: null });
});

test('a variable or wildcard clause makes a match exhaustive', () => {
  assert.deepEqual(checked(DT + 'fun f(Crust) = 1 | f(x) = 2;').warnings, []);
  assert.deepEqual(checked(DT + 'fun f(Crust) = 1 | f(_) = 2;').warnings, []);
});

test('a missing constructor is a warning that names it', () => {
  const r = checked(DT + 'fun f1(Crust) = 1 | f1(Cheese(x)) = 2;');
  assert.equal(r.error, null);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0], 'f1 has no clause for Anchovy(_); a value like that raises Match');
});

test('every missing constructor is listed', () => {
  const r = checked(DT + 'fun f(Crust) = 1;');
  assert.match(r.warnings[0], /no clause for Cheese\(_\) and Anchovy\(_\)/);
});

test('sml style prints witnesses SML-style', () => {
  const r = checked(DT + 'fun f(Crust) = 1;', { style: 'sml' });
  assert.match(r.warnings[0], /Cheese _ and Anchovy _/);
});

test('integer constants form an infinite signature', () => {
  assert.match(checked('fun h(0) = 1;').warnings[0], /^h has no clause for _;/);
  assert.deepEqual(checked('fun h(0) = 1 | h(n) = 2;').warnings, []);
});

test('bool is a two-constructor datatype', () => {
  assert.deepEqual(checked('fun k(true) = 1 | k(false) = 0;').warnings, []);
  assert.match(checked('fun k(true) = 1;').warnings[0], /no clause for false/);
});

test('tuples: columns are checked together', () => {
  assert.deepEqual(checked('fun k(true, _) = 1 | k(_, true) = 2 | k(false, false) = 3;').warnings, []);
  assert.match(checked('fun k2(true, _) = 1 | k2(_, true) = 2;').warnings[0], /no clause for \(false,false\)/);
});

test('nested constructors', () => {
  assert.match(checked(T + 'fun g(A, 0) = 1 | g(B x, _) = 2;').warnings[0], /no clause for/);
  assert.deepEqual(checked(T + 'fun d2(C(A,_)) = 1 | d2(C(_,A)) = 2 | d2(C(_,_)) = 3 | d2(A) = 4 | d2(B _) = 5;').warnings, []);
  const r = checked(T + 'fun d(C(A,_)) = 1 | d(C(_,A)) = 2 | d(C(B _, B _)) = 3;');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /raises Match/);
  assert.match(r.warnings[0], /\bA\b/);
  assert.match(r.warnings[0], /B\(_\)/);
});

test('curried definitions check the argument tuple', () => {
  assert.deepEqual(checked(T + 'fun c(A)(B(y)) = 1 | c(_)(_) = 2;').warnings, []);
  assert.match(checked(T + 'fun c(A)(B(y)) = 1;').warnings[0], /no clause for/);
});

test('a redundant clause is an error of its own class', () => {
  const r = checked(DT + 'fun f2(Crust) = 1 | f2(x) = 2 | f2(Cheese(y)) = 3;');
  assert.equal(r.error, 'redundant: clause 3 of f2 can never be used: the clauses before it already match everything it matches');
});

test('redundancy: duplicates, constants, nested', () => {
  assert.match(checked('fun k(true) = 1 | k(false) = 0 | k(true) = 2;').error, /^redundant: clause 3 of k/);
  assert.match(checked('fun h(0) = 1 | h(0) = 2 | h(_) = 3;').error, /^redundant: clause 2 of h/);
  assert.match(checked(T + 'fun d3(C(A,_)) = 1 | d3(C(_,A)) = 2 | d3(C(_,_)) = 3 | d3(A) = 4 | d3(B _) = 5 | d3(C(A,A)) = 6;').error, /clause 6 of d3/);
});

test('an overlapping later clause is not redundant', () => {
  assert.deepEqual(checked('fun k(true, _) = 1 | k(_, true) = 2 | k(false, false) = 3;'), { warnings: [], error: null });
});

test('the page setting demotes redundant to a warning', () => {
  const r = checked('fun h(0) = 1 | h(0) = 2 | h(_) = 3;', { redundantAsWarning: true });
  assert.equal(r.error, null);
  assert.match(r.warnings[0], /clause 2 of h can never be used/);
});

test('case and fn name themselves', () => {
  assert.match(checked(T + 'fun n(x) = case x of A => 1 | B _ => 2;').warnings[0], /^this case expression has no rule for C\(_,_\)/);
  assert.match(checked(T + 'val z = (fn A => 1);').warnings[0], /^this fn has no rule for B\(_\) and C\(_,_\)/);
  assert.match(checked(T + 'val z = (fn A => 1 | A => 2 | _ => 3);').error, /^redundant: rule 2 of this fn/);
});

test('handle: redundant is an error, non-exhaustive is silent', () => {
  assert.deepEqual(checked('fun f(x) = x handle Div => 1;'), { warnings: [], error: null });
  assert.match(checked('fun f1(x) = x handle Div => 1 | Div => 2;').error, /^redundant: rule 2 of this handler/);
  assert.match(checked('fun f2(x) = x handle Div => 1 | _ => 2 | Overflow => 3;').error, /rule 3 of this handler/);
});

test('exception constructors in a fn form an infinite signature', () => {
  assert.match(checked('fun e(Div) = 1 | e(Overflow) = 2;').warnings[0], /^e has no clause for _;/);
});

test('val patterns that can fail warn; ones that cannot are silent', () => {
  assert.deepEqual(checked('val (q, r) = (1, 2);').warnings, []);
  assert.deepEqual(checked('val n = 5;').warnings, []);
  assert.match(checked(T + 'val B x = B 1;').warnings[0], /^this val pattern does not match every value, for example A and C\(_,_\); a value like that raises Bind/);
});

test('sequencing and derived andalso/orelse are always exhaustive', () => {
  assert.deepEqual(checked('val x = (1; 2); val y = true andalso false;'), { warnings: [], error: null });
});

test('the book: shish_kebab', () => {
  const src = 'datatype shish_kebab = Skewer | Onion of shish_kebab | Lamb of shish_kebab | Tomato of shish_kebab;\n' +
    'fun only_onions(Skewer) = true | only_onions(Onion(x)) = only_onions(x) | only_onions(Lamb(x)) = false | only_onions(Tomato(x)) = false;';
  assert.deepEqual(checked(src), { warnings: [], error: null });
  assert.match(checked(src.replace(' | only_onions(Tomato(x)) = false', '')).warnings[0], /no clause for Tomato\(_\)/);
});
