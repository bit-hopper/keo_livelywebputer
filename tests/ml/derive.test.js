import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from '../../core/lib/ml/src/parser.js';
import { derive } from '../../core/lib/ml/src/derive.js';
import { show, chunks } from './helpers.js';

// The derived item for each item of a source, rendered with the same printer the parser tests use.
const core = (source) => new Parser(source).parseAll().map((it) => show(derive(it)));
const one = (source) => {
  const out = core(source);
  assert.equal(out.length, 1, 'expected one item');
  return out[0];
};

test('case becomes the application of a fn', () => {
  assert.equal(one('case x of A => 1 | B(y) => y;'), '((fn A => 1 | (B y) => y) x)');
  const it = derive(new Parser('case x of A => 1;').nextItem());
  assert.equal(it.exp.derived, 'case');
  assert.deepEqual(it.exp.fn.origin, { kind: 'case' });
});

test('andalso and orelse become if, with the basis true and false', () => {
  assert.equal(one('a andalso b;'), '(if a then b else false)');
  assert.equal(one('a orelse b;'), '(if a then true else b)');
  assert.equal(one('a andalso b orelse c;'), '(if (if a then b else false) then true else c)');
  const it = derive(new Parser('a orelse b;').nextItem());
  assert.equal(it.exp.then.basis, true, 'the expansion must not see a program-defined true');
  assert.equal(it.exp.derived, 'orelse');
});

test('a sequence becomes nested applications of fn _', () => {
  assert.equal(one('(f x; g y);'), '((fn _ => (g y)) (f x))');
  assert.equal(one('(a; b; c);'), '((fn _ => ((fn _ => c) b)) a)');
  assert.equal(one('let val x = 1 in f x; x end;'), '(let val x = 1 in ((fn _ => x) (f x)))');
});

test('fun: one argument is a fn over the clauses; the name is a rec variable', () => {
  assert.equal(one('fun f(x) = x + 1;'), 'val rec f = (fn x => (x + 1))');
  assert.equal(one('fun f(Skewer) = 0 | f(Onion(s)) = 1 + f(s);'),
    'val rec f = (fn Skewer => 0 | (Onion s) => (1 + (f s)))');
  const it = derive(new Parser('fun f(x) = x;').nextItem());
  assert.equal(it.binds[0].rec, true);
  assert.equal(it.binds[0].pat.forceVar, true, 'a function name is never a constructor');
  assert.deepEqual(it.binds[0].exp.origin, { kind: 'fun', name: 'f' });
});

test('fun: several arguments are curried and matched together as a tuple', () => {
  assert.equal(one('fun f x y = x + y;'), 'val rec f = (fn $1 => (fn $2 => ((fn (x, y) => (x + y)) ($1, $2))))');
  assert.equal(one('fun g Skewer n = n | g (Onion(s)) n = g s (n + 1);'),
    'val rec g = (fn $1 => (fn $2 => ((fn (Skewer, n) => n | ((Onion s), n) => ((g s) (n + 1))) ($1, $2))))');
  // a tuple argument is one argument
  assert.equal(one('fun g(Skewer, n) = n | g(Onion(s), n) = g(s, n + 1);'),
    'val rec g = (fn (Skewer, n) => n | ((Onion s), n) => (g (s, (n + 1))))');
  // two curried arguments: the matching happens when the second is supplied
  const it = derive(new Parser('fun h(A) (B) = 1;').nextItem());
  assert.equal(show(it), 'val rec h = (fn $1 => (fn $2 => ((fn (A, B) => 1) ($1, $2))))');
  assert.deepEqual(it.binds[0].exp.origin, { kind: 'fun', name: 'h', curried: true });
});

test('fun: a result type annotation types each clause body', () => {
  assert.equal(one('fun f(x) : int = x;'), 'val rec f = (fn x => (x : int))');
  assert.equal(one('fun f(A) : int = 1 | f(B) : int = 2;'), 'val rec f = (fn A => (1 : int) | B => (2 : int))');
});

test('fun ... and ... is one val rec with every binding', () => {
  assert.equal(one('fun even(n) = n = 0 orelse odd(n - 1) and odd(n) = n <> 0 andalso even(n - 1);'),
    'val rec even = (fn n => (if (n = 0) then true else (odd (n - 1)))) and rec odd = (fn n => (if (n <> 0) then (even (n - 1)) else false))');
});

test('fresh names restart per item and never clash with source names', () => {
  const a = core('fun f x y = x; fun g x y = y;');
  assert.ok(a[0].includes('$1') && a[1].includes('$1'));
  assert.ok(!/\$/.test(show(new Parser('fun f x y = x;').nextItem())), 'source identifiers cannot contain $');
});

test('nested derived forms are expanded everywhere', () => {
  assert.equal(one('fn x => case x of A => a andalso b | B => 1;'),
    '(fn x => ((fn A => (if a then b else false) | B => 1) x))');
  assert.equal(one('(case x of A => 1) handle E => (a; b);'),
    '(((fn A => 1) x) handle E => ((fn _ => b) a))');
  assert.equal(one('let fun f(x) = x in f(1) end;'), '(let val rec f = (fn x => x) in (f 1))');
  assert.equal(one('local fun f(x) = x in val y = f(1) end;'), 'local val rec f = (fn x => x) in val y = (f 1) end');
  assert.equal(one('val x = 1 andalso 2;'), 'val x = (if 1 then 2 else false)');
});

test('items that need nothing are passed through unchanged', () => {
  const src = 'datatype t = A | B of int; type p = int * bool; exception E of int; val x = 5; x + 1; (*# style: sml *)';
  const parsed = new Parser(src).parseAll();
  const derived = parsed.map(derive);
  for (const i of [0, 1, 2, 5]) assert.equal(derived[i], parsed[i], 'shared, not copied: item ' + i);
  assert.equal(show(derived[3]), 'val x = 5');
  assert.equal(show(derived[4]), '(x + 1)');
});

test('item text, location and the rejected-expected mark survive the rewrite', () => {
  const [it] = new Parser('⊗ fun f(x) = x orelse y;').parseAll();
  const out = derive(it);
  assert.equal(out.text, 'fun f(x) = x orelse y');
  assert.equal(out.expectRejected, true);
  assert.deepEqual(out.loc, it.loc);
  assert.equal(out.binds[0].exp.match[0].exp.loc.start, it.binds[0].clauses[0].exp.loc.start);
});

test('a bad (rejected-as-expected) item passes through', () => {
  const [bad] = new Parser('⊗ val = ;').parseAll();
  assert.equal(bad.kind, 'bad');
  assert.equal(derive(bad), bad);
});

test('the parsed tree is not modified', () => {
  const src = 'fun f x y = case x of A => y andalso y | B => (y; y); structure S :> SIG = struct fun g(z) = z end;'
    + 'functor F(structure a : N) :> P = struct end; structure v = F(structure a = X);';
  const parsed = new Parser(src).parseAll();
  const before = JSON.stringify(parsed);
  parsed.forEach(derive);
  assert.equal(JSON.stringify(parsed), before);
});

// ---- modules ----------------------------------------------------------------------------------------------

test('structure ascription becomes an ascribe expression', () => {
  assert.equal(one('structure S :> SIG = struct val x = 1 end;'), 'structure S = struct val x = 1 end :> SIG');
  assert.equal(one('structure S : SIG = T;'), 'structure S = T : SIG');
  assert.equal(one('structure S = struct end;'), 'structure S = struct  end');
  assert.equal(one('structure A = struct fun f(x) = x end and B : S = A;'),
    'structure A = struct val rec f = (fn x => x) end and B = A : S');
});

test('functor over specs: a named parameter, an open, and the ascription moved inside', () => {
  assert.equal(
    one('functor PON(structure a_N : N) :> P where type number = a_N.number = struct type number = a_N.number end;'),
    'functor PON($param : sig structure a_N : N end) = let open $param in struct type number = a_N.number end :> P where type number = a_N.number end');
  assert.equal(
    one('functor NP(structure a_N : N structure a_P : P sharing type a_N.number = a_P.number) :> T = struct end;'),
    'functor NP($param : sig structure a_N : N structure a_P : P sharing type a_N.number = a_P.number end) = let open $param in struct  end :> T end');
});

test('functor with an empty parameter has nothing to open', () => {
  assert.equal(one('functor NumberAsInt() :> N = struct type number = int end;'),
    'functor NumberAsInt($param : sig  end) = struct type number = int end :> N');
  assert.equal(one('functor G() = struct end;'), 'functor G($param : sig  end) = struct  end');
});

test('functor with a named parameter keeps it; the result ascription moves onto the body', () => {
  assert.equal(one('functor F(X : S) = X;'), 'functor F(X : S) = X');
  assert.equal(one('functor F(X : S) :> R where type t = X.t = struct end;'),
    'functor F(X : S) = struct  end :> R where type t = X.t');
  assert.equal(one('functor F(X : S) = struct fun f(y) = y end;'), 'functor F(X : S) = struct val rec f = (fn y => y) end');
});

test('functor application: structure-binding arguments are a struct; F() is F(struct end)', () => {
  assert.equal(one('structure IntStruct = NumberAsInt();'), 'structure IntStruct = NumberAsInt(struct  end)');
  assert.equal(one('structure IntArith = PON(structure a_N = IntStruct);'),
    'structure IntArith = PON(struct structure a_N = IntStruct end)');
  assert.equal(
    one('structure NPStruct = NP(structure a_N = NumberAsNum3() structure a_P = PON3(structure a_N = a_N));'),
    'structure NPStruct = NP(struct structure a_N = NumberAsNum3(struct  end) structure a_P = PON3(struct structure a_N = a_N end) end)');
  assert.equal(one('structure S = F(T);'), 'structure S = F(T)');
  assert.equal(one('structure S = F(struct val x = 1 end : SIG);'), 'structure S = F(struct val x = 1 end : SIG)');
});

test('structure expressions nest their declarations', () => {
  assert.equal(one('structure S = let fun f(x) = x in struct val y = f(1) end end;'),
    'structure S = let val rec f = (fn x => x) in struct val y = (f 1) end end');
});

// ---- the seed corpora -------------------------------------------------------------------------------------

const seed = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed');
const seedFiles = ['t4.sml', 't5b.sml', 't6.sml'];
const haveSeed = seedFiles.every((f) => fs.existsSync(path.join(seed, f)));

const SURFACE = new Set(['case', 'andalso', 'orelse', 'seq', 'fun', 'decs']);
const CORE_ITEMS = new Set(['val', 'datatype', 'type', 'exception', 'local', 'signature', 'structure', 'functor', 'expstmt', 'pragma', 'bad']);

// Every node reachable from a derived item, to check no surface-only form is left.
function* walk(n) {
  if (Array.isArray(n)) { for (const x of n) yield* walk(x); return; }
  if (n === null || typeof n !== 'object') return;
  if (n.kind) yield n;
  for (const k of Object.keys(n)) {
    if (k === 'loc' || k === 'error' || k === 'origin') continue;
    yield* walk(n[k]);
  }
}

test('seed corpora: every parsable chunk derives to the core, with no surface form left', { skip: !haveSeed && 'tests/ml/seed is not present' }, () => {
  let derived = 0;
  const leftover = [];
  for (const f of seedFiles) {
    for (const chunk of chunks(fs.readFileSync(path.join(seed, f), 'utf8'))) {
      let items;
      try { items = new Parser(chunk).parseAll(); } catch (e) { continue; } // the known out-of-core chunks (parser.test.js)
      for (const it of items) {
        const out = derive(it);
        derived++;
        assert.ok(CORE_ITEMS.has(out.kind), 'item kind ' + out.kind);
        for (const n of walk(out)) {
          // `decs` and `fun` are surface kinds; `case`/`seq` etc. never appear in a node's own kind either
          if (SURFACE.has(n.kind)) leftover.push(f + ': ' + n.kind + ' in ' + chunk.slice(0, 50));
          if (n.kind === 'functor') assert.equal(n.ascription, undefined);
          if (n.kind === 'functor') assert.equal(n.param.kind, 'named');
        }
      }
    }
  }
  assert.ok(derived > 100, 'expected the full corpora, got ' + derived + ' items');
  assert.deepEqual(leftover, []);
});
