import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluator } from './helpers.js';
import { ItemRun, makeGlobals } from '../../core/lib/ml/src/machine.js';
import { Parser } from '../../core/lib/ml/src/parser.js';
import { derive } from '../../core/lib/ml/src/derive.js';
import { Elaborator } from '../../core/lib/ml/src/infer.js';
import { makeBasis } from '../../core/lib/ml/src/basis.js';

// Run `src`, return the named values; throws if the run failed.
function vals(src, ...names) {
  const e = evaluator();
  const r = e.run(src);
  assert.equal(r.error, null, r.error);
  return names.length === 1 ? e.value(names[0]) : names.map((n) => e.value(n));
}
const fails = (src) => evaluator().run(src).error;

test('integer arithmetic and the floor semantics of div and mod', () => {
  assert.deepEqual(vals('val a = 7 div 2; val b = ~7 div 2; val c = ~7 mod 2; val d = 15 mod 4; val e = 7 mod ~2; val f = 7 div ~2;', 'a', 'b', 'c', 'd', 'e', 'f'),
    [3, -4, 1, 3, -1, -4]);
  assert.deepEqual(vals('val a = 2 + 3 * 4; val b = 10 - 4 - 3; val c = ~(5 - 8); val d = 0 * ~3;', 'a', 'b', 'c', 'd'), [14, 3, 3, 0]);
  assert.equal(Object.is(vals('val z = 0 * ~3;', 'z'), -0), false);
});

test('comparison and equality', () => {
  assert.deepEqual(vals('val a = 3 < 4; val b = 4 <= 4; val c = 5 > 6; val d = (1, 2) = (1, 2); val e = (1, 2) <> (1, 3);', 'a', 'b', 'c', 'd', 'e'),
    ['true', 'true', 'false', 'true', 'true']);
  assert.equal(vals('datatype t = A | B of int | C of t * t;\nval r = C(B 1, A) = C(B 1, A);', 'r'), 'true');
  assert.equal(vals('datatype t = A | B of int | C of t * t;\nval r = C(B 1, A) = C(B 2, A);', 'r'), 'false');
  assert.equal(vals('val r = not (1 = 2);', 'r'), 'true');
});

test('63-bit ints: exact beyond 2^53, Overflow outside the range', () => {
  assert.equal(vals('val x = 4611686018427387903;', 'x'), 4611686018427387903n);
  assert.equal(vals('val x = 2000000000 * 2000000000;', 'x'), 4000000000000000000n);
  assert.equal(vals('val x = 4611686018427387903 - 1;', 'x'), 4611686018427387902n);
  assert.equal(vals('val x = ~4611686018427387903 - 1;', 'x'), -4611686018427387904n);
  assert.equal(fails('val x = 4611686018427387903 + 1;'), 'uncaught: "exn:Overflow"');
  assert.equal(fails('val x = 3037000500 * 3037000500;'), 'uncaught: "exn:Overflow"');
  // a result that comes back into the safe range is a plain number again, so `=` still works
  assert.equal(vals('val x = (4611686018427387903 - 4611686018427387900) = 3;', 'x'), 'true');
  assert.equal(vals('fun fact(n) = if n = 0 then 1 else n * fact(n - 1);\nval x = fact(20);', 'x'), 2432902008176640000n);
  assert.equal(fails('fun fact(n) = if n = 0 then 1 else n * fact(n - 1);\nval x = fact(21);'), 'uncaught: "exn:Overflow"');
  assert.equal(vals('val x = 9007199254740993 div 3;', 'x'), 3002399751580331);
  assert.equal(vals('val x = ~9007199254740993 mod 10;', 'x'), 7);
});

test('Div, and handling it', () => {
  assert.equal(fails('val x = 1 div 0;'), 'uncaught: "exn:Div"');
  assert.equal(fails('val x = 5 mod 0;'), 'uncaught: "exn:Div"');
  assert.equal(vals('val x = (1 div 0) handle Div => 42;', 'x'), 42);
  assert.equal(vals('val x = (4611686018427387903 + 1) handle Overflow => 7;', 'x'), 7);
});

test('datatypes, constructors as functions, pattern matching', () => {
  const src = 'datatype shish = Skewer | Onion of shish | Lamb of shish;\n' +
    'fun only_onions(Skewer) = true | only_onions(Onion(x)) = only_onions(x) | only_onions(Lamb(x)) = false;\n' +
    'val a = only_onions(Onion(Onion(Skewer)));\nval b = only_onions(Onion(Lamb(Skewer)));\nval c = Onion;\nval d = c(Skewer);';
  assert.deepEqual(vals(src, 'a', 'b', 'c', 'd'), ['true', 'false', 'fn', ['Onion', 'Skewer']]);
});

test('tuples, nested patterns, first match wins, integer patterns', () => {
  const src = 'fun f(0, _) = 100 | f(_, 0) = 200 | f(a, b) = a + b;\nval a = f(0, 5); val b = f(5, 0); val c = f(3, 4);\n' +
    'val (x, (y, z)) = (1, (2, 3));';
  assert.deepEqual(vals(src, 'a', 'b', 'c', 'x', 'y', 'z'), [100, 200, 7, 1, 2, 3]);
});

test('curried and higher-order functions', () => {
  const src = 'fun add(a)(b) = a + b;\nval inc = add(1);\nval r = inc(41);\n' +
    'fun twice(f)(x) = f(f(x));\nval s = twice(inc)(0);\nval t = twice(fn x => x * 2)(5);';
  assert.deepEqual(vals(src, 'r', 's', 't'), [42, 2, 20]);
});

test('static scope: a closure keeps the binding it was written against', () => {
  assert.equal(vals('fun f(x) = 1;\nfun g(x) = f(x);\nfun f(x) = 2;\nval r = g(0);\nval r2 = f(0);', 'r'), 1);
  assert.equal(vals('val x = 1;\nfun g(u) = x;\nval x = 2;\nval r = g(0) + x;', 'r'), 3);
});

test('mutual recursion and val rec', () => {
  const src = 'fun even(0) = true | even(n) = odd(n - 1)\nand odd(0) = false | odd(n) = even(n - 1);\nval a = even(10); val b = odd(7);\n' +
    'val rec f = fn n => if n = 0 then 1 else n * f(n - 1);\nval c = f(5);';
  assert.deepEqual(vals(src, 'a', 'b', 'c'), ['true', 'true', 120]);
});

test('let, local, and simultaneous val', () => {
  assert.equal(vals('val r = let val a = 3 val b = a + 1 in a * b end;', 'r'), 12);
  assert.equal(vals('val r = let val a = 1 in let val a = a + 1 val c = a * 10 in c + a end end;', 'r'), 22);
  assert.equal(vals('local fun h(x) = x + 1 in fun g(x) = h(h(x)) end;\nval r = g(1);', 'r'), 3);
  assert.match(fails('local fun h(x) = x + 1 in fun g(x) = h(x) end;\nval r = h(1);'), /^nonsense/);
  assert.deepEqual(vals('val a = 1;\nval a = 2 and b = a;', 'a', 'b'), [2, 1]);
  assert.equal(vals('val r = let val x = 1 val rec f = fn n => if n = 0 then x else f(n - 1) in f(3) end;', 'r'), 1);
  // a rec closure must not see a non-rec binding of the same declaration
  assert.equal(vals('val x = 10;\nval r = let val x = 1 and rec f = fn n => x in f(0) end;', 'r'), 10);
});

test('local declarations inside let keep only the body bindings', () => {
  assert.equal(vals('val r = let local val p = 5 in val q = p + 1 end in q * 2 end;', 'r'), 12);
});

test('exceptions: raise, handle, payloads, unwinding', () => {
  const src = 'exception Bad of int;\nexception Worse;\n' +
    'fun f(n) = if n > 3 then raise Bad(n) else n;\n' +
    'val a = f(2);\nval b = f(9) handle Bad(k) => k * 10;\n' +
    'val c = (1 + (raise Worse)) handle Worse => 5;\n' +
    'val d = (f(9) handle Worse => 0) handle Bad(k) => k + 1;\n' +
    'val e = (raise Bad(1)) handle Bad(2) => 0 | Bad(1) => 11;';
  assert.deepEqual(vals(src, 'a', 'b', 'c', 'd', 'e'), [2, 90, 5, 10, 11]);
  assert.equal(fails('exception Bad of int;\nval x = raise Bad(3);'), 'uncaught: ["exn:Bad",3]');
  assert.equal(fails('exception Worse;\nval x = (raise Worse) handle Bad => 1;'.replace('Bad', 'Match')), 'uncaught: "exn:Worse"');
});

test('exception values are first-class', () => {
  assert.equal(vals('exception E of int;\nval e = E(4);\nval r = (raise e) handle E(n) => n;', 'r'), 4);
  assert.deepEqual(vals('exception E of int;\nval e = E(4);', 'e'), ['exn:E', 4]);
});

test('an exception declaration is generative: each evaluation is a different exception', () => {
  const src = 'fun mk(u) = let exception E in ((fn z => raise E), (fn th => (th 0; 0) handle E => 1)) end;\n' +
    'val (r1, h1) = mk(0);\nval (r2, h2) = mk(0);\nval a = h1 r1;\nval b = h2 r2;';
  assert.deepEqual(vals(src, 'a', 'b'), [1, 1]);
  const bad = src + '\nval c = h2 r1;';
  assert.equal(fails(bad), 'uncaught: "exn:E"'); // r1 raises the first E, h2 only handles the second
});

test('Match and Bind', () => {
  assert.equal(fails('fun f(0) = 1;\nval x = f(5);'), 'uncaught: "exn:Match"');
  assert.equal(fails('datatype t = A | B;\nval A = B;'), 'uncaught: "exn:Bind"');
  assert.equal(vals('fun f(0) = 1;\nval x = f(5) handle Match => 9;', 'x'), 9);
  assert.equal(vals('datatype t = A | B;\nval x = (let val A = B in 1 end) handle Bind => 2;', 'x'), 2);
});

test('a user exception shadows a builtin name but the machine still raises the builtin', () => {
  assert.equal(vals('exception Div;\nval x = (1 div 0) handle Div => 1 | _ => 2;', 'x'), 2);
});

test('the chapter-7 chain: a datatype with a function field', () => {
  const src = 'datatype chain = Link of int * (int -> chain);\n' +
    'fun ints(n) = Link(n + 1, ints);\n' +
    'fun chain_item(n, Link(i, f)) = if n = 1 then i else chain_item(n - 1, f(i));\n' +
    'val r = chain_item(37, ints(0));\n' +
    'fun fibs(n)(m) = Link(n + m, fibs(m));\nval s = chain_item(10, fibs(1)(1));';
  assert.deepEqual(vals(src, 'r', 's'), [37, 144]);
});

test('Stop: an infinite loop is interrupted and the environment survives', () => {
  const g = makeGlobals();
  const scope = makeBasis().child();
  const el = new Elaborator({ style: 'book' });
  const item = (src) => {
    const it = new Parser(src).nextItem();
    const r = el.elaborateItem(derive(it), scope);
    return { r, run: new ItemRun(r.ir, g) };
  };
  const a = item('val x = 5;');
  while (a.run.step(1000) === 'running');
  a.run.commit(); a.r.scope.mergeInto(scope);
  const loop = item('fun loop(n) = loop(n + 1);');
  while (loop.run.step(1000) === 'running');
  loop.run.commit(); loop.r.scope.mergeInto(scope);
  const spin = item('val y = loop(0);');
  assert.equal(spin.run.step(20), 'running'); // still going after a slice
  spin.run.interrupt();
  assert.equal(spin.run.step(1000), 'stopped');
  const b = item('val z = x + 1;');
  while (b.run.step(1000) === 'running');
  assert.equal(b.run.state, 'done');
  b.run.commit();
  assert.equal(g.get('z').value, 6);
  assert.equal(g.has('y'), false);
});

test('runaway non-tail recursion stops at the depth cap and the next cell works', () => {
  const e = evaluator();
  assert.equal(e.run('fun run(n) = 1 + run(n + 1);').error, null);
  const r = e.run('val x = run(0);');
  assert.equal(r.error, 'limit');
  assert.equal(e.run('val y = 1 + 1;').error, null);
  assert.equal(e.value('y'), 2);
});
