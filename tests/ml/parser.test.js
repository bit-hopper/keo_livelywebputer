import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from '../../core/lib/ml/src/parser.js';
import { MLError } from '../../core/lib/ml/src/errors.js';
import { items, parsed, one, failure, chunks, show } from './helpers.js';

test('expressions: application is left-associative and binds tighter than infix operators', () => {
  assert.equal(one('f x y;'), '((f x) y)');
  assert.equal(one('f(x)(y);'), '((f x) y)');
  assert.equal(one('1 + 2 * 3;'), '(1 + (2 * 3))');
  assert.equal(one('1 - 2 - 3;'), '((1 - 2) - 3)');
  assert.equal(one('f x + g y;'), '((f x) + (g y))');
  assert.equal(one('n div 2 + n mod 3;'), '((n div 2) + (n mod 3))');
  assert.equal(one('a + 1 = b;'), '((a + 1) = b)');
  assert.equal(one('a < b;'), '(a < b)');
  assert.equal(one('x <> y;'), '(x <> y)');
  assert.equal(one('~5 + 1;'), '(-5 + 1)');
  assert.equal(one('~ x;'), '(~ x)');
  assert.equal(one('n-1;'), '(n - 1)');
});

test('tuples, unit, sequences, parentheses', () => {
  assert.equal(one('(1, 2, 3);'), '(1, 2, 3)');
  assert.equal(one('();'), '()');
  assert.equal(one('(1; 2);'), '(1; 2)');
  assert.equal(one('((1));'), '1');
  assert.equal(one('(f x, g y);'), '((f x), (g y))');
});

test('andalso / orelse / typed / if / case / fn / raise / handle', () => {
  assert.equal(one('a andalso b orelse c;'), '((a andalso b) orelse c)');
  assert.equal(one('a orelse b andalso c;'), '(a orelse (b andalso c))');
  assert.equal(one('(x : int);'), '(x : int)');
  assert.equal(one('if a then 1 else 2;'), '(if a then 1 else 2)');
  assert.equal(one('if a then if b then 1 else 2 else 3;'), '(if a then (if b then 1 else 2) else 3)');
  assert.equal(one('case x of A => 1 | B(y) => y;'), '(case x of A => 1 | (B y) => y)');
  assert.equal(one('fn (n, m) => n + m;'), '(fn (n, m) => (n + m))');
  assert.equal(one('fn Skewer => 0 | Onion(x) => 1;'), '(fn Skewer => 0 | (Onion x) => 1)');
  assert.equal(one('raise No_bacon(3);'), '(raise (No_bacon 3))');
  assert.equal(one('a orelse raise Fail;'), '(a orelse (raise Fail))');
  assert.equal(one('(raise No_bacon(3)) handle No_bacon(n) => n + 1;'), '((raise (No_bacon 3)) handle (No_bacon n) => (n + 1))');
  assert.equal(one('f(x) handle A => 1 | B => 2;'), '((f x) handle A => 1 | B => 2)');
});

test('let: declarations, then a sequence of expressions', () => {
  assert.equal(one('let val x = 1 in x + 1 end;'), '(let val x = 1 in (x + 1))');
  assert.equal(one('let val x = 1 fun f(y) = y in f(x) end;'), '(let val x = 1 fun f y = y in (f x))');
  assert.equal(one('let val x = 1 in x; x + 1 end;'), '(let val x = 1 in (x; (x + 1)))');
  assert.equal(one('let in 5 end;'), '(let  in 5)');
});

test('op makes an infix name an ordinary one', () => {
  assert.equal(one('op + (1, 2);'), '(+ (1, 2))');
  assert.equal(one('op =;'), '=');
});

test('patterns', () => {
  assert.equal(one('val (a, b) = (1, true);'), 'val (a, b) = (1, true)');
  assert.equal(one('val _ = 1;'), 'val _ = 1');
  assert.equal(one('val Cons(h, t) = x;'), 'val (Cons (h, t)) = x');
  assert.equal(one('val x : int = 5;'), 'val (x : int) = 5');
  assert.equal(one('val NumStruct.Zero = z;'), 'val NumStruct.Zero = z');
  assert.equal(one('fn 0 => 1 | n => n;'), '(fn 0 => 1 | n => n)');
});

test('val declarations: rec and and', () => {
  assert.equal(one('val rec f = fn 0 => 1 | n => n;'), 'val rec f = (fn 0 => 1 | n => n)');
  assert.equal(one('val x = 1 and y = 2;'), 'val x = 1 and y = 2');
});

test('fun: clauses, curried definitions, annotations, mutual recursion', () => {
  assert.equal(one('fun only_onions(Skewer) = true | only_onions(Onion(x)) = only_onions(x);'),
    'fun only_onions Skewer = true | only_onions (Onion x) = (only_onions x)');
  assert.equal(one('fun fibs(n)(m) = Link(n+m, fibs(m));'), 'fun fibs n m = (Link ((n + m), (fibs m)))');
  assert.equal(one('fun has(a:meza,Steak,d:dessert):bool = true;'), 'fun has (a : meza), Steak, (d : dessert)) : bool = true'.replace('has (a', 'has ((a'));
  assert.equal(one('fun f(x) = x + 1 and g(y) = f(y) * 2;'), 'fun f x = (x + 1) and g y = ((f y) * 2)');
  assert.equal(one('fun f x y = x;'), 'fun f x y = x');
  assert.equal(one('fun id x = x;'), 'fun id x = x');
});

test('fun: clauses must agree on the name and on the number of arguments', () => {
  assert.match(failure('fun f(x) = 1 | g(x) = 2;'), /^syntax: every clause of a function must define the same name/);
  assert.match(failure('fun f(x) = 1 | f(x)(y) = 2;'), /^syntax: every clause of f must take the same number of arguments/);
  assert.match(failure('fun f = 1;'), /^syntax: unexpected '=' ; expected an argument pattern after f|^syntax: unexpected '='/);
});

test('datatype: nullary and unary constructors, parameters, recursion, and', () => {
  assert.equal(one('datatype fish = Anchovy | Lox | Tuna;'), 'datatype fish = Anchovy | Lox | Tuna');
  assert.equal(one('datatype shish = Skewer | Onion of shish;'), 'datatype shish = Skewer | Onion of shish');
  assert.equal(one("datatype 'a pizza = Bottom | Topping of ('a * ('a pizza));"),
    "datatype ('a) pizza = Bottom | Topping of ('a * 'a pizza)");
  assert.equal(one("datatype ('a, 'b) pair = P of 'a * 'b;"), "datatype ('a, 'b) pair = P of ('a * 'b)");
  assert.equal(one('datatype chain = Link of (int * (int -> chain));'), 'datatype chain = Link of (int * (int -> chain))');
  assert.equal(one("datatype 'a slist = Empty | Cons of 'a sexp * 'a slist and 'a sexp = An_atom of 'a | A_slist of 'a slist;"),
    "datatype ('a) slist = Empty | Cons of ('a sexp * 'a slist) and ('a) sexp = An_atom of 'a | A_slist of 'a slist");
});

test('datatype heads take type variables, not types (the book\'s ⊗ boxes)', () => {
  const msg = /^ungrammatical: a datatype head takes type variables like 'a, not types; found/;
  assert.match(failure('datatype int open_faced_sandwich = Bread of int;'), msg);
  assert.match(failure('datatype fish pizza = Bottom | Topping of (fish * (fish pizza));'), msg);
  assert.match(failure('datatype (int, bool) p = P;'), msg);
  assert.match(failure('datatype bool open_faced_sandwich = Bread of bool;'), msg);
});

test('type and exception declarations', () => {
  assert.equal(one('type pair = int * bool;'), 'type pair = (int * bool)');
  assert.equal(one("type 'a box = 'a * 'a;"), "type ('a) box = ('a * 'a)");
  assert.equal(one('exception No_bacon of int;'), 'exception No_bacon of int');
  assert.equal(one('exception Too_small;'), 'exception Too_small');
  assert.equal(one('exception A and B of int;'), 'exception A and B of int');
});

test('types: precedence, application, qualified names', () => {
  const ty = (src) => one('(x : ' + src + ');').replace(/^\(x : /, '').replace(/\)$/, '');
  assert.equal(ty('int -> int -> int'), '(int -> (int -> int))');
  assert.equal(ty('int * bool -> int'), '((int * bool) -> int)');
  assert.equal(ty('(int -> int) -> int'), '((int -> int) -> int)');
  assert.equal(ty("'a * main * 'b"), "('a * main * 'b)");
  assert.equal(ty('int list list'), 'int list list');
  assert.equal(ty('(int, bool) pair'), '(int, bool) pair');
  assert.equal(ty('a_N.number * a_N.number'), '(a_N.number * a_N.number)');
  assert.equal(ty("(('a -> bool) -> (('a * ('a list)) -> ('a list)))"), "(('a -> bool) -> (('a * 'a list) -> 'a list))");
});

test('local', () => {
  assert.equal(one('local val x = 1 in val y = x end;'), 'local val x = 1 in val y = x end');
});

test('signatures and structures', () => {
  assert.equal(one('signature N = sig type number exception Too_small val succ : number -> number val is_zero : number -> bool end;'),
    'signature N = sig type number exception Too_small val succ : (number -> number) val is_zero : (number -> bool) end');
  assert.equal(one("signature S = sig type 'a t structure Sub : SUB sharing type t = Sub.u end;"),
    "signature S = sig type ('a) t structure Sub : SUB sharing type t = Sub.u end");
  assert.equal(one('signature P = sig type number val plus : (number * number) -> number end;'),
    'signature P = sig type number val plus : ((number * number) -> number) end');
  assert.equal(one('structure IntStruct = NumberAsInt();'), 'structure IntStruct = NumberAsInt()');
  assert.equal(one('structure S :> N = struct type number = int end;'), 'structure S :> N = struct type number = int end');
  assert.equal(one('structure S = T :> N;'), 'structure S = T :> N');
  assert.equal(one('structure A = struct val x = 1 end and B = A;'), 'structure A = struct val x = 1 end and B = A');
});

test('functors: derived parameter and argument forms, ascription, where type', () => {
  assert.equal(one('functor NumberAsInt() :> N = struct type number = int end;'),
    'functor NumberAsInt() :> N = struct type number = int end');
  assert.equal(one('functor PON(structure a_N : N) :> P where type number = a_N.number = struct type number = a_N.number end;'),
    'functor PON(structure a_N : N) :> P where type number = a_N.number = struct type number = a_N.number end');
  assert.equal(one('structure IntArith = PON(structure a_N = IntStruct);'), 'structure IntArith = PON(structure a_N = IntStruct)');
  // one expression, a later binding seeing the earlier one (the book's NP application)
  assert.equal(one('structure Z = NP(structure a_N = NumberAsNum() structure a_P = PON(structure a_N = a_N));'),
    'structure Z = NP(structure a_N = NumberAsNum() structure a_P = PON(structure a_N = a_N))');
  assert.equal(one('functor F(X : S) = X;'), 'functor F(X : S) = X');
  assert.equal(one('functor NP(structure a_N : N structure a_P : P sharing type a_N.number = a_P.number) :> T = struct end;'),
    'functor NP(structure a_N : N structure a_P : P sharing type a_N.number = a_P.number) :> T = struct  end');
  assert.equal(one('functor G() :> N where type number = int = struct type number = int end;'),
    'functor G() :> N where type number = int = struct type number = int end');
  assert.equal(one('structure X = let val y = 1 in struct end end;'), 'structure X = let val y = 1 in struct  end end');
});

test('items: ; is optional after a declaration, required after an expression', () => {
  assert.deepEqual(parsed('val a = 1 val b = 2 fun f(x) = x'), ['val a = 1', 'val b = 2', 'fun f x = x']);
  assert.deepEqual(parsed('val a = 1;; ; val b = 2;'), ['val a = 1', 'val b = 2']);
  assert.deepEqual(parsed('1 + 2'), ['(1 + 2)']);              // the last expression may omit it
  assert.match(failure('1 + 2 val x = 3;'), /^syntax: unexpected 'val'/);
});

test('items keep their source text and location', () => {
  const its = items('val a = 1;\n  fun f(x) = x;\n');
  assert.equal(its[0].text, 'val a = 1');
  assert.equal(its[1].text, 'fun f(x) = x');
  assert.deepEqual([its[1].loc.line, its[1].loc.col], [2, 3]);
  assert.deepEqual(its[0].loc, { line: 1, col: 1, start: 0, end: 9 });
});

test('pragmas become items', () => {
  const its = items('(*# style: sml *)\nval x = 1;');
  assert.deepEqual([its[0].kind, its[0].name, its[0].value], ['pragma', 'style', 'sml']);
  assert.equal(its[1].kind, 'val');
});

test('a • type box is an expression statement asserting a type', () => {
  assert.deepEqual(parsed('• only_onions : shish_kebab → bool\nval x = 1'),
    ['(only_onions : (shish_kebab -> bool))', 'val x = 1']);
  assert.deepEqual(parsed('• add : α → (α ∗ main)'), ["(add : ('a -> ('a * main)))"]);
});

test('⊗ items: a rejected parse becomes a bad item and the next item still parses', () => {
  const its = items('⊗ datatype int p = A;\nval x = 1;\n⊗ val y = 2;');
  assert.equal(its[0].kind, 'bad');
  assert.equal(its[0].expectRejected, true);
  assert.equal(its[0].error.errorClass, 'ungrammatical');
  assert.equal(its[0].text, 'datatype int p = A');
  assert.equal(its[1].kind, 'val');
  assert.equal(its[1].expectRejected, undefined);
  assert.equal(its[2].kind, 'val');           // a ⊗ box that parses fine is still an item; the checker decides
  assert.equal(its[2].expectRejected, true);
  // without ⊗ the same error propagates
  assert.throws(() => items('datatype int p = A;'), MLError);
});

test('⊗ recovery skips to the end of the item, not into the middle of a let', () => {
  const its = items('⊗ val x = let val a = 1; val b = ) in a end;\nval ok = 1;');
  assert.equal(its[0].kind, 'bad');
  assert.equal(its[1].kind, 'val');
  assert.equal(its[1].binds[0].pat.name, 'ok');
});

test('⊗ recovery survives a lexical error inside the rejected item', () => {
  const its = items('⊗ val x = "string";\nval ok = 1;');
  assert.equal(its[0].kind, 'bad');
  assert.equal(its[1].binds[0].pat.name, 'ok');
});

test('placeholders are ungrammatical', () => {
  assert.match(failure('fun is_prime(n) = … and has_no_divisors(n,c) = …;'), /^ungrammatical: … is a placeholder/);
  assert.match(failure('fun make_cons(a,f) = ...;'), /^ungrammatical: \.\.\. is a placeholder/);
});

test('things outside the core get a pointed message, not a generic syntax error', () => {
  assert.match(failure('val x = [1, 2];'), /^syntax: lists are not part of the core the book uses/);
  assert.match(failure('val x = 1 :: nil;'), /^syntax: the operator :: is not part of the core/);
  assert.match(failure('val x = a ^ b;'), /^syntax: the operator \^ is not part of the core/);
  assert.match(failure('val x = #1 y;'), /^syntax: records are not part of the core/);
  assert.match(failure('open A;'), /^syntax: open is not part of the core/);
  assert.match(failure('infix 5 ++;'), /^syntax: infix declarations are not part of the core/);
  assert.match(failure('val x as y = 1;'), /as patterns are not part of the core/);
  assert.match(failure('while true do 1;'), /while loops are not part of the core/);
  assert.match(failure('val s = "hi";'), /^syntax: strings are not part of the core/);
  assert.match(failure('val r = 1.5;'), /^syntax: reals are not part of the core/);
  assert.match(failure('Compiler.Control.Print.printDepth := 100;'), /^syntax: the operator := is not part of the core/);
});

test('syntax errors name the token and what was expected, with a position', () => {
  assert.equal(failure('val x = ;'), "syntax: unexpected ';'; expected an expression");
  assert.equal(failure('val = 1;'), "syntax: unexpected '='; expected a pattern");
  assert.equal(failure('if a then b;'), "syntax: unexpected ';'; expected 'else'");
  assert.equal(failure('let val x = 1 in x end end;'), "syntax: unexpected 'end'; expected ';' after the expression");
  assert.equal(failure('let val x = 1 in x;'), 'syntax: the program ends too soon; expected an expression');
  assert.equal(failure('val x = 1 +'), 'syntax: the program ends too soon; expected an expression');
  try { new Parser('val a = 1;\nval b = ;').parseAll(); assert.fail(); } catch (e) { assert.deepEqual([e.line, e.col], [2, 9]); }
});

test('signature specs reject definitions and unsupported forms', () => {
  assert.match(failure('signature S = sig type t = int end;'), /^syntax: a signature leaves a type open/);
  assert.match(failure('signature S = sig datatype t = A end;'), /^syntax: unexpected 'datatype'/);
  assert.match(failure('signature S = sig eqtype t end;'), /eqtype is not part of the core/);
});

// ---- the seed corpora (transcriptions of the book's code boxes, plus probes) -------------------------

const seed = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed');
const seedFiles = ['t4.sml', 't5b.sml', 't6.sml'];
const haveSeed = seedFiles.every((f) => fs.existsSync(path.join(seed, f)));

// Chunks that do not parse, and why. Everything else in the seed files must parse; a change here is a decision.
const EXPECTED_FAILURES = [
  [/^datatype int open_faced_sandwich/, /^ungrammatical: a datatype head/],
  [/^datatype fish pizza/, /^ungrammatical: a datatype head/],
  [/^val big = \[/, /^syntax: lists are not part/],
  [/^fun subst_c/, /^syntax: lists are not part/],
  [/^Compiler\.Control/, /^syntax: the operator :=/],
  [/^val w = \[\]/, /^syntax: lists are not part/],
];

test('seed corpora: every chunk parses except the known out-of-core and ungrammatical ones', { skip: !haveSeed && 'tests/ml/seed is not present' }, () => {
  const failures = [];
  let total = 0;
  for (const f of seedFiles) {
    for (const chunk of chunks(fs.readFileSync(path.join(seed, f), 'utf8'))) {
      total++;
      const err = failure(chunk);
      if (err) failures.push({ file: f, chunk, err });
    }
  }
  assert.ok(total > 100, 'expected the full corpora, got ' + total + ' chunks');
  const unexplained = failures.filter(({ chunk, err }) => !EXPECTED_FAILURES.some(([head, msg]) => head.test(chunk) && (!msg || msg.test(err))));
  assert.deepEqual(unexplained.map((u) => u.file + ': ' + u.chunk.slice(0, 70) + ' => ' + u.err), []);
  // ... and the list above is not stale: each expectation was actually met
  for (const [head] of EXPECTED_FAILURES) {
    assert.ok(failures.some(({ chunk }) => head.test(chunk)), 'expected a failure matching ' + head);
  }
});

test('seed corpora: the parsed shape of a few whole chunks', { skip: !haveSeed && 'tests/ml/seed is not present' }, () => {
  const t4 = chunks(fs.readFileSync(path.join(seed, 't4.sml'), 'utf8'));
  const find = (head) => t4.find((c) => c.startsWith(head));
  assert.deepEqual(parsed(find('fun rem_fish')), [
    "fun rem_fish (x, Bottom) = Bottom | rem_fish (x, (Topping (x, p))) = (rem_fish (x, p)) | rem_fish (x, (Topping (t, p))) = (Topping (t, (rem_fish (x, p))))",
  ]);
  assert.deepEqual(parsed(find('(only_onions')), ['(only_onions : (shish_kebab -> bool))']);
  assert.equal(show(items(find('val deep'))[0]),
    'val deep = (let fun count 0 = 0 | count n = (1 + (count (n - 1))) in (count 1000000))');
});
