import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from '../../core/lib/ml/src/parser.js';
import { derive } from '../../core/lib/ml/src/derive.js';
import { Elaborator } from '../../core/lib/ml/src/infer.js';
import { makeBasis } from '../../core/lib/ml/src/basis.js';
import {
  typeToString, TVar, tcon, tfn, ttuple, tInt, tBool, INT, TyName,
} from '../../core/lib/ml/src/types.js';
import { unify, UnifyFailure } from '../../core/lib/ml/src/unify.js';
import { types, rejects, session } from './helpers.js';

// The type of the last binding of a source, in SML style (what SML/NJ prints).
const ty = (source) => {
  const lines = types(source, 'sml');
  return lines[lines.length - 1].replace(/^\S+ : /, '');
};
const SK = 'datatype shish = Skewer | Onion of shish | Lamb of shish; ';
const PIZZA = "datatype 'a pizza = Bottom | Topping of 'a * 'a pizza; ";

// ---- types, unification, printing -------------------------------------------------------------------------

test('unify: structure, variables, occurs check, equality', () => {
  const a = new TVar(1);
  unify(tfn(a, tInt), tfn(tBool, tInt));
  assert.equal(typeToString(a, 'sml'), 'bool');
  assert.throws(() => unify(tInt, tBool), (e) => e instanceof UnifyFailure && e.reason === 'mismatch');
  assert.throws(() => unify(ttuple([tInt]), ttuple([tInt, tInt])), (e) => e.reason === 'mismatch');
  const b = new TVar(1);
  assert.throws(() => unify(b, tfn(b, tInt)), (e) => e.reason === 'occurs');
  const eqv = new TVar(1, true);
  assert.throws(() => unify(eqv, tfn(tInt, tInt)), (e) => e.reason === 'equality');
  unify(eqv, ttuple([tInt, tBool]));
  const c = new TVar(1);
  const eq2 = new TVar(1, true);
  unify(c, eq2); // the survivor keeps the equality constraint
  assert.throws(() => unify(c, tfn(tInt, tInt)), (e) => e.reason === 'equality');
});

test('unify: levels are lowered so a variable is never generalised before what it mentions', () => {
  const outer = new TVar(1);
  const inner = new TVar(3);
  unify(outer, tfn(inner, tInt));
  assert.equal(inner.level, 1);
});

test('datatype names are generative: same name, different type', () => {
  const a = new TyName('t', 0, true);
  const b = new TyName('t', 0, true);
  assert.throws(() => unify(tcon(a), tcon(b)), (e) => e.reason === 'mismatch');
  unify(tcon(a), tcon(a));
});

test('type printing: book style parenthesises every compound operand; sml style uses precedence', () => {
  const a = new TVar(1);
  a.generic = true;
  const b = new TVar(1);
  b.generic = true;
  const list = new TyName('list', 1, true);
  const t1 = tfn(ttuple([tInt, tcon(list, [tInt])]), tInt);
  assert.equal(typeToString(t1, 'book'), '(int * (int list)) -> int');
  assert.equal(typeToString(t1, 'sml'), 'int * int list -> int');
  const t2 = tfn(a, tfn(a, ttuple([b, a])));
  assert.equal(typeToString(t2, 'book'), 'α -> (α -> (β * α))');
  assert.equal(typeToString(t2, 'sml'), "'a -> 'a -> 'b * 'a");
  assert.equal(typeToString(tfn(tfn(a, b), a), 'sml'), "('a -> 'b) -> 'a");
  const e = new TVar(1, true);
  e.generic = true;
  assert.equal(typeToString(tfn(e, tBool), 'sml'), "''a -> bool");
  assert.equal(typeToString(tfn(e, tBool), 'book'), "''α -> bool");
  assert.equal(typeToString(ttuple([]), 'sml'), 'unit');
  assert.equal(typeToString(tcon(INT), 'book'), 'int');
});

// ---- principal types ----------------------------------------------------------------------------------------

test('constants, operators, tuples, if', () => {
  assert.equal(ty('val x = 5;'), 'int');
  assert.equal(ty('val x = ~5;'), 'int');
  assert.equal(ty('val x = (1, true, ());'), 'int * bool * unit');
  assert.equal(ty('val x = 1 + 2 * 3 - 4 div 5 mod 6;'), 'int');
  assert.equal(ty('val x = 1 < 2;'), 'bool');
  assert.equal(ty('val x = if 1 < 2 then (1, 2) else (3, 4);'), 'int * int');
  assert.equal(ty('val x = 1 < 2 andalso 3 >= 4 orelse not true;'), 'bool');
  assert.equal(ty('val f = op +;'), 'int * int -> int');
  assert.equal(ty('val x = (1; true);'), 'bool');
});

test('functions: identity, application, curry, composition, higher order', () => {
  assert.equal(ty('fun id x = x;'), "'a -> 'a");
  assert.equal(ty('val k = fn x => fn y => x;'), "'a -> 'b -> 'a");
  assert.equal(ty('fun add x y = x + y;'), 'int -> int -> int');
  assert.equal(ty('fun add(x, y) = x + y;'), 'int * int -> int');
  assert.equal(ty('fun comp f g x = f(g(x));'), "('a -> 'b) -> ('c -> 'a) -> 'c -> 'b");
  assert.equal(ty('fun app f x = f x;'), "('a -> 'b) -> 'a -> 'b");
  assert.equal(ty('fun twice f x = f(f(x));'), "('a -> 'a) -> 'a -> 'a");
  assert.equal(ty('fun swap(a, b) = (b, a);'), "'a * 'b -> 'b * 'a");
  assert.equal(ty('val z = (fn x => x)(5);'), 'int');
});

test('datatypes: constructors are functions, patterns, recursion', () => {
  assert.equal(ty(SK + 'val x = Onion;'), 'shish -> shish');
  assert.equal(ty(SK + 'val x = Onion(Skewer);'), 'shish');
  assert.equal(ty(SK + 'fun only_onions(Skewer) = true | only_onions(Onion(x)) = only_onions(x) | only_onions(Lamb(x)) = false;'), 'shish -> bool');
  assert.equal(ty(PIZZA + 'fun rem_fish(x, Bottom) = Bottom | rem_fish(x, Topping(t, p)) = Topping(t, rem_fish(x, p));'),
    "'a * 'b pizza -> 'b pizza");
  assert.equal(ty(PIZZA + 'fun len(Bottom) = 0 | len(Topping(_, p)) = 1 + len(p);'), "'a pizza -> int");
  assert.equal(ty(PIZZA + 'val p = Topping(1, Bottom);'), 'int pizza');
  assert.equal(ty(PIZZA + 'val p = Topping;'), "'a * 'a pizza -> 'a pizza");
});

test('parametric datatypes with two parameters, and mutually recursive datatypes', () => {
  assert.equal(ty("datatype ('a, 'b) pair = P of 'a * 'b; fun fst(P(a, b)) = a;"), "('a, 'b) pair -> 'a");
  const lines = types("datatype 'a slist = Empty | Scons of 'a sexp * 'a slist and 'a sexp = An_atom of 'a | A_slist of 'a slist; "
    + "fun size(Empty) = 0 | size(Scons(e, r)) = size_e(e) + size(r) and size_e(An_atom(_)) = 1 | size_e(A_slist(l)) = size(l);", 'sml');
  assert.deepEqual(lines.slice(-2), ["size : 'a slist -> int", "size_e : 'a sexp -> int"]);
});

test('let polymorphism and generalisation levels', () => {
  assert.equal(ty('val p = let val id = fn x => x in (id(1), id(true)) end;'), 'int * bool');
  assert.equal(ty('fun f x = let val y = x in y end;'), "'a -> 'a");
  assert.equal(ty('fun f x = let fun g y = (x, y) in g end;'), "'a -> 'b -> 'a * 'b");
  assert.equal(ty('val id = fn x => x; val a = id(1); val b = id(true);'), 'bool');
  // no value restriction: the result of a call is still polymorphic (a recorded deviation from SML/NJ)
  assert.equal(ty('fun id x = x; val z = id(id);'), "'a -> 'a");
  assert.equal(ty('val (a, b) = (fn x => x, 5);'), 'int');
});

test('mutual recursion with fun ... and ...', () => {
  const lines = types('fun even(n) = if n = 0 then true else odd(n - 1) and odd(n) = if n = 0 then false else even(n - 1);', 'sml');
  assert.deepEqual(lines, ['even : int -> bool', 'odd : int -> bool']);
});

test('annotations: patterns, results, expressions; rigid type variables', () => {
  assert.equal(ty('fun f(x:int) = x;'), 'int -> int');
  assert.equal(ty('fun f(x) : int = x;'), 'int -> int');
  assert.equal(ty('val f = (fn x => x) : int -> int;'), 'int -> int');
  assert.equal(ty("fun g x = (x : 'a);"), "'a -> 'a");
  assert.equal(ty("fun k(x:'a) = let val y : 'a = x in y end;"), "'a -> 'a");
  assert.equal(ty("val z = (fn x => x) : 'a -> 'a;"), "'a -> 'a");
  assert.equal(ty("fun f(x:'a, y:'b) = (y, x);"), "'a * 'b -> 'b * 'a");
  assert.equal(ty("fun h(x:''a) = x = x;"), "''a -> bool");
});

test('rigid annotation variables unify with nothing but themselves (as in SML/NJ)', () => {
  assert.match(rejects("fun h(x:'a) = x + 1;"), /^nonsense:/);
  assert.match(rejects("fun h2(x:'a, y:'b) = if true then x else y;"), /^nonsense:/);
  assert.match(rejects("fun f(x:int) = x; (f : 'a -> 'a);"), /^nonsense: .*annotated/);
  assert.equal(rejects('fun f(x:int) = x; (f : int -> int);'), null);
  assert.match(rejects("fun m2(x:'a) = x = x;"), /^nonsense: equality is needed/);
});

test('equality types', () => {
  assert.equal(ty('fun eq(a, b) = a = b;'), "''a * ''a -> bool");
  assert.equal(ty('fun ne(a, b) = a <> b;'), "''a * ''a -> bool");
  assert.equal(ty('val b = (1, true) = (2, false);'), 'bool');
  assert.equal(ty(SK + 'val b = Onion(Skewer) = Skewer;'), 'bool');
  assert.equal(ty("datatype 'a box = Box of 'a; val b = Box(1) = Box(2);"), 'bool');
  assert.match(rejects('val b = (fn x => x) = (fn x => x);'), /^nonsense: equality is needed here/);
  assert.match(rejects('fun eq_funcs(f:int->int, g:int->int) = (f = g);'), /^nonsense: equality is needed/);
});

test('a datatype with a function field has no equality; one without does', () => {
  const s = session();
  assert.equal(s.run('datatype chain = Link of int * (int -> chain); fun c(x) = Link(x, fn n => c(n)); val a = c(1);').error, null);
  assert.match(s.run('val b = a = a;').error, /^nonsense: equality is needed/);
  assert.equal(s.run('datatype two = A | B of int; val ok = B(1) = A;').error, null);
});

test('exceptions: raise, handle, payloads', () => {
  assert.equal(ty('exception No_bacon of int; fun f(n) = raise No_bacon(n);'), "int -> 'a");
  assert.equal(ty('exception E; val x = (raise E) handle E => 5;'), 'int');
  assert.equal(ty('exception No_bacon of int; fun g(n) = (if n = 0 then raise No_bacon(n) else n) handle No_bacon(m) => m + 1;'), 'int -> int');
  assert.equal(ty('val x = (1 div 0) handle Div => 0;'), 'int');
  assert.equal(ty('exception E of int; val e = E;'), 'int -> exn');
  assert.match(rejects('val x = raise 5;'), /^nonsense: raise needs an exn/);
  assert.match(rejects('exception E; val x = (1) handle E => true;'), /^nonsense:/);
  assert.match(rejects('val x = 1 handle 5 => 2;'), /^nonsense: .*exn/);
});

test('type abbreviations, including parameterised ones and unit', () => {
  assert.equal(ty('type pair = int * bool; val p = (1, true) : pair;'), 'int * bool');
  assert.equal(ty("type 'a twin = 'a * 'a; fun dup(x) = (x, x) : 'a twin;"), "'a -> 'a * 'a");
  assert.equal(ty('val u = () : unit;'), 'unit');
  assert.equal(ty("type ('a, 'b) f = 'a -> 'b; val g = (fn x => x + 1) : (int, int) f;"), 'int -> int');
});

test('local, and let scoping', () => {
  const s = session();
  assert.equal(s.run('local fun helper x = x + 1 in fun inc x = helper(x) end;').error, null);
  assert.equal(s.run('val a = inc(1);').error, null);
  assert.match(s.run('val b = helper(1);').error, /^nonsense: helper is not defined/);
  assert.match(rejects('val x = let val y = 1 in y end; val z = y;'), /^nonsense: y is not defined/);
});

test('the expression statement binds it', () => {
  const s = session('sml');
  assert.deepEqual(s.run('1 + 2; it + 1; fn x => x;').lines, ['it : int', 'it : int', "it : 'a -> 'a"]);
});

test('echo order is declaration order', () => {
  const [r] = (() => {
    const global = makeBasis().child();
    const el = new Elaborator();
    const out = el.elaborateItem(derive(new Parser('val (b, a) = (1, 2);').nextItem()), global);
    return [out];
  })();
  assert.deepEqual(r.echo.map((e) => e.name), ['b', 'a']);
});

// ---- the book's two kinds of no -----------------------------------------------------------------------------

test('nonsense: wording names the function and both types', () => {
  assert.equal(rejects(SK + 'fun only_onions(Skewer) = true; only_onions(5);'),
    'nonsense: only_onions consumes shish, but was given int');
  assert.equal(rejects('if 1 then 2 else 3;'), 'nonsense: the test of an if must be a bool, but this is int');
  assert.equal(rejects('if true then 2 else false;'), 'nonsense: the two branches of this if have different types: int and bool');
  assert.equal(rejects('fun f x = x x;'), 'nonsense: this would need a type that contains itself (a circular type), as in fn x => x x');
  assert.equal(rejects('5(3);'), 'nonsense: this expression is not a function: it has type int, but it is applied to an argument');
  assert.equal(rejects('fun f(x:int) = x; val g = f(true);'), 'nonsense: f consumes int, but was given bool');
  assert.equal(rejects('val x = (1 : bool);'), 'nonsense: this expression has type int, but is annotated bool');
  assert.equal(rejects('val x = nothere;'), 'nonsense: nothere is not defined');
  assert.equal(rejects('fun f(a, b) = a + b; f(1);'), 'nonsense: f consumes int * int, but was given int');
  assert.equal(rejects('1 + true;'), 'nonsense: + consumes int * int, but was given int * bool');
});

test('nonsense: patterns', () => {
  assert.match(rejects(SK + 'fun f(Skewer) = 1 | f(5) = 2;'), /^nonsense: this pattern has type int, but the earlier patterns have type shish/);
  assert.match(rejects(SK + 'fun f(Skewer(x)) = 1;'), /^nonsense: Skewer does not take an argument/);
  assert.match(rejects(SK + 'fun f(Onion) = 1;'), /^nonsense: Onion takes an argument/);
  assert.match(rejects(SK + 'fun f(Onion(5)) = 1;'), /^nonsense: Onion takes shish, but this pattern has type int/);
  assert.equal(rejects('fun f(x) = 1 | f(x, y) = 2;'), null); // x is simply a pair here
  assert.match(rejects('val (a, b) = 5;'), /^nonsense:/);
});

test('ungrammatical: duplicate variables and a variable applied as a constructor', () => {
  assert.equal(rejects("datatype 'a pizza = Bottom | Topping of 'a * 'a pizza; fun rem(x, Bottom) = Bottom | rem(x, Topping(x, p)) = rem(x, p);"),
    'ungrammatical: the name x appears twice in one pattern');
  assert.match(rejects('fun f(C(x)) = x;'), /^ungrammatical: C is not a constructor/);
  assert.match(rejects('val (a, a) = (1, 2);'), /^ungrammatical: the name a appears twice/);
  assert.match(rejects('val a = 1 and a = 2;'), /^ungrammatical: the name a is bound twice/);
  assert.match(rejects('datatype t = A | A;'), /^ungrammatical: the constructor A appears twice/);
  assert.match(rejects('val rec x = 5;'), /^ungrammatical: val rec/);
});

test('a failed item defines nothing, and the error leaves the earlier definitions', () => {
  const s = session('sml');
  assert.equal(s.run('val a = 1;').error, null);
  assert.match(s.run('val b = a + true;').error, /^nonsense/);
  assert.match(s.run('val c = b;').error, /^nonsense: b is not defined/);
  assert.deepEqual(s.run('val d = a + 1;').lines, ['d : int']);
});

test('type names must exist, with the right arity', () => {
  assert.match(rejects('val x = (1 : nothing);'), /^nonsense: the type nothing is not defined/);
  assert.match(rejects('val x = (1 : int int);'), /^nonsense: the type int takes 0 type arguments/);
  assert.match(rejects("datatype 'a t = T of 'a; val x = (T(1) : (int, int) t);"), /^nonsense: the type t takes 1 type argument/);
  assert.match(rejects("datatype t = T of 'a;"), /^nonsense: the type variable 'a is not bound/);
});

test('an undefined structure is reported', () => {
  assert.match(rejects('val x = S.y;'), /^signature: the structure S is not defined/);
  assert.match(rejects('structure A = B;'), /^signature: the structure B is not defined/);
  assert.match(rejects('structure A = F(structure x = struct end);'), /^signature: the functor F is not defined/);
});

// ---- shadowing and the basis -------------------------------------------------------------------------------------

test('user definitions shadow the basis, and true/false in andalso survive shadowing', () => {
  assert.equal(ty('val not = 5;'), 'int');
  assert.equal(ty('datatype b = true | false; val x = 1 < 2 andalso 3 < 4;'), 'bool');
  assert.equal(ty("datatype 'a list = Empty | Cons of 'a * 'a list; fun len(Empty) = 0 | len(Cons(_, r)) = 1 + len(r);"), "'a list -> int");
});

test('a variable pattern named like a prim or earlier value is just a new variable', () => {
  assert.equal(ty('val x = 1; fun f(x) = x;'), "'a -> 'a");
  assert.equal(ty('fun g(not) = not + 1;'), 'int -> int');
});

// ---- the IR and the match sites -----------------------------------------------------------------------------------

test('the IR resolves constructors, and match sites are recorded for the pattern checker', () => {
  const global = makeBasis().child();
  const el = new Elaborator();
  const run = (src) => {
    const r = el.elaborateItem(derive(new Parser(src).nextItem()), global);
    r.scope.mergeInto(global);
    return r;
  };
  run('datatype t = A | B of t;');
  const r = run('fun f(A) = B(A) | f(B(x)) = x;');
  const fn = r.ir.decs[0].recs[0].exp;
  assert.equal(fn.op, 'fn');
  assert.equal(fn.rules[0].pat.p, 'con');
  assert.equal(fn.rules[0].pat.con.name, 'A');
  assert.equal(fn.rules[0].body.op, 'conapp');
  assert.equal(fn.rules[1].pat.arg.p, 'var');
  const sites = r.matchSites.filter((s) => s.kind === 'fn');
  assert.equal(sites.length, 1);
  assert.equal(sites[0].rules.length, 2);
  assert.deepEqual(sites[0].origin, { kind: 'fun', name: 'f' });
  // a plain val records its pattern as a site too
  const v = run('val (a, b) = (1, 2);');
  assert.equal(v.matchSites.find((s) => s.kind === 'val').rules[0].p, 'tuple');
});

test('the datatype record keeps constructors in declaration order, with their argument types', () => {
  const global = makeBasis().child();
  const el = new Elaborator();
  const r = el.elaborateItem(derive(new Parser("datatype 'a pizza = Bottom | Topping of 'a * 'a pizza;").nextItem()), global);
  const [tn] = r.echo[0].names;
  assert.equal(tn.name, 'pizza');
  assert.deepEqual(tn.cons.map((c) => c.name), ['Bottom', 'Topping']);
  assert.equal(tn.cons[0].ty, null);
  assert.equal(typeToString(tn.cons[1].ty, 'sml'), "'a * 'a pizza");
  assert.equal(tn.admitsEq, true);
});
