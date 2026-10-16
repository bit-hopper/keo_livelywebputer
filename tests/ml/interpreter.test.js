import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interpreter } from '../../core/lib/ml/src/interpreter.js';

// A one-line rendering of each segment: 'kind[:tone|:class]  text'
const line = (s) => s.kind + (s.tone ? ':' + s.tone : '') + (s.errorClass ? ':' + s.errorClass : '') + ' ' + s.text;
function run(src, interp = new Interpreter()) {
  const r = interp.evalSync(src);
  return { state: r.state, lines: r.segments.map(line), segments: r.segments, interp };
}

const SHISH = 'datatype shish_kebab = Skewer | Onion of shish_kebab | Lamb of shish_kebab | Tomato of shish_kebab;\n' +
  'fun only_onions(Skewer) = true | only_onions(Onion(x)) = only_onions(x) | only_onions(Lamb(x)) = false | only_onions(Tomato(x)) = false;\n';

test('declarations echo in declaration order, in the book style', () => {
  const r = run(SHISH + 'only_onions(Onion(Onion(Skewer)));');
  assert.equal(r.state, 'done');
  assert.deepEqual(r.lines, [
    'value datatype shish_kebab = Skewer | Onion of shish_kebab | Lamb of shish_kebab | Tomato of shish_kebab',
    'value val only_onions = fn : shish_kebab -> bool',
    'value val it = true : bool',
  ]);
});

test('parameterised datatypes print α and the book parenthesises compound types', () => {
  const r = run("datatype 'a pizza = Bottom | Topping of ('a * ('a pizza));\nTopping(1, Topping(2, Bottom));");
  assert.deepEqual(r.lines, [
    'value datatype α pizza = Bottom | Topping of (α * (α pizza))',
    'value val it = Topping(1,Topping(2,Bottom)) : int pizza',
  ]);
});

test('the sml style prints like SML/NJ', () => {
  const r = run("(*# style: sml *)\ndatatype 'a pizza = Bottom | Topping of ('a * ('a pizza));\nTopping(1, Topping(2, Bottom));\nfun id(x) = x;");
  assert.deepEqual(r.lines, [
    "value datatype 'a pizza = Bottom | Topping of 'a * 'a pizza",
    'value val it = Topping (1,Topping (2,Bottom)) : int pizza',
    "value val id = fn : 'a -> 'a",
  ]);
});

test('types, exceptions, tuples, negative numbers, unit', () => {
  const r = run("type pair = int * bool;\nexception No_bacon of int;\nexception Plain;\nval p = (~3, true);\nval u = ();");
  assert.deepEqual(r.lines, [
    'value type pair = int * bool',
    'value exception No_bacon of int',
    'value exception Plain',
    'value val p = (~3,true) : int * bool',
    'value val u = () : unit',
  ]);
});

test('a pattern binding echoes every variable', () => {
  assert.deepEqual(run('val (a, b) = (1, 2);').lines, ['value val a = 1 : int', 'value val b = 2 : int']);
});

test('a static error ends the cell and keeps what came before', () => {
  const interp = new Interpreter();
  const r = run(SHISH + 'only_onions(5);\nval never = 1;', interp);
  assert.equal(r.state, 'error');
  assert.equal(r.lines.at(-1), 'error:nonsense only_onions consumes shish_kebab, but was given int');
  assert.ok(!r.lines.some((l) => l.includes('never')));
  assert.equal(run('only_onions(Skewer);', interp).lines[0], 'value val it = true : bool');
  assert.equal(run('never;', interp).state, 'error');
});

test('errors carry their position and class', () => {
  const r = run('val x = 1;\nval y = x + true;');
  const e = r.segments.at(-1);
  assert.equal(e.kind, 'error');
  assert.equal(e.errorClass, 'nonsense');
  assert.equal(e.line, 2);
  const syn = run('val = ;');
  assert.equal(syn.segments.at(-1).errorClass, 'syntax');
});

test('an uncaught exception is meaningless, and the cell keeps the earlier items', () => {
  const interp = new Interpreter();
  const r = run('exception No_bacon of int;\nval ok = 1;\nval z = raise No_bacon(0);\nval after = 2;', interp);
  assert.equal(r.state, 'error');
  assert.equal(r.lines.at(-1), 'error:exception uncaught exception No_bacon(0)');
  assert.deepEqual(run('ok;', interp).lines, ['value val it = 1 : int']);
  assert.equal(run('after;', interp).state, 'error');
  assert.equal(run('1 div 0;', interp).lines.at(-1), 'error:exception uncaught exception Div');
});

test('a failed item defines nothing', () => {
  const interp = new Interpreter();
  run('val x = 1 div 0;', interp);
  assert.equal(run('x;', interp).state, 'error');
  run('fun f(0) = 1 | f(0) = 2;', interp);
  assert.equal(run('f;', interp).state, 'error');
});

test('non-exhaustive is a warning and the function is defined; redundant is an error', () => {
  const interp = new Interpreter();
  const r = run('datatype t = A | B;\nfun f(A) = 1;\nf(A);', interp);
  assert.equal(r.state, 'done');
  assert.ok(r.lines.some((l) => l.startsWith('warning f has no clause for B')));
  assert.equal(r.lines.at(-1), 'value val it = 1 : int');
  const bad = run('fun g(A) = 1 | g(_) = 2 | g(B) = 3;', interp);
  assert.equal(bad.state, 'error');
  assert.match(bad.lines[0], /^error:redundant clause 3 of g/);
  const demoted = run('(*# redundant: warning *)\nfun g(A) = 1 | g(_) = 2 | g(B) = 3;', interp);
  assert.equal(demoted.state, 'done');
  assert.match(demoted.lines[0], /^warning clause 3 of g/);
});

test('type-box verdicts', () => {
  const interp = new Interpreter();
  run(SHISH + 'fun add_a_steak(x) = (x, 5);\nfun idi(x:int) = x;', interp);
  assert.deepEqual(run('(only_onions : shish_kebab -> bool);', interp).lines,
    ['status:ok ✓ exactly: only_onions : shish_kebab -> bool']);
  // α and 'a are the same variable; the arrow glyph is accepted
  assert.deepEqual(run('(add_a_steak : α → (α * int));', interp).lines, ['status:ok ✓ exactly: add_a_steak : α -> (α * int)']);
  const narrower = run('(add_a_steak : int -> (int * int));', interp);
  assert.match(narrower.lines[0], /^status:note ≈ the actual type is more general: add_a_steak : α -> \(α \* int\)/);
  const wrong = run("(idi : 'a -> 'a);", interp);
  assert.match(wrong.lines[0], /^status:bad ✗ nonsense: .*the actual type of idi is int -> int$/);
  assert.equal(wrong.state, 'done'); // an assertion about a name does not stop the cell
  const bullet = run('• only_onions : shish_kebab → bool', interp);
  assert.equal(bullet.lines[0], 'status:ok ✓ exactly: only_onions : shish_kebab -> bool');
});

test('a verdict does not bind it; turning verdicts off gives the plain form', () => {
  const interp = new Interpreter();
  run(SHISH, interp);
  run('(only_onions : shish_kebab -> bool);', interp);
  assert.equal(run('it;', interp).state, 'error');
  const off = run('(*# verdicts: off *)\n(only_onions : shish_kebab -> bool);', interp);
  assert.deepEqual(off.lines, ['value val it = fn : shish_kebab -> bool']);
});

test('⊗ boxes: rejected is the book\'s claim; the cell goes on', () => {
  const interp = new Interpreter();
  const r = run("⊗ datatype int open_faced_sandwich = Bread of int;\n" +
    "datatype fish = Anchovy | Lox | Tuna;\n" +
    "⊗ datatype fish pizza = Bottom | Topping of (fish * (fish pizza));\n" +
    "⊗ fun remove_anchovy(Bottom) = Bottom | remove_anchovy(C(x)) = C(remove_anchovy(x));\n" +
    "val after = 1;", interp);
  assert.equal(r.state, 'done');
  assert.match(r.lines[0], /^status:ok ✓ rejected as the book says \(ungrammatical\)/);
  assert.match(r.lines[2], /^status:ok ✓ rejected as the book says \(ungrammatical\)/);
  assert.match(r.lines[3], /^status:ok ✓ rejected as the book says \(/);
  assert.equal(r.lines.at(-1), 'value val after = 1 : int');
});

test('⊗ box that is accepted is reported, not hidden', () => {
  const r = run('⊗ val fine = 1;');
  assert.equal(r.lines[0], 'status:bad ✗ accepted — the book marks this box ⊗');
});

test('⊗ type box that is nonsense', () => {
  const r = run("datatype chain = Link of int * (int -> chain);\nfun fibs(n)(m) = Link(n + m, fibs(m));\n⊗ (fibs : (int * int) → chain);");
  assert.match(r.lines.at(-1), /^status:ok ✓ rejected as the book says \(nonsense\)/);
});

test('⊗ with a literal ellipsis (not a program)', () => {
  const r = run('⊗ fun is_prime(n) = … and has_no_divisors(n,c) = …;\nval ok = 2;');
  assert.match(r.lines[0], /^status:ok ✓ rejected as the book says \(ungrammatical\)/);
  assert.equal(r.lines.at(-1), 'value val ok = 2 : int');
});

test('deep values are cut at the depth setting', () => {
  const r = run("datatype n = Z | S of n;\nfun mk(0) = Z | mk(k) = S(mk(k - 1));\n(*# depth: 4 *)\nmk(10);");
  assert.equal(r.lines.at(-1), 'value val it = S(S(S(S(…)))) : n');
});

test('unknown or malformed pragmas warn', () => {
  assert.match(run('(*# nope: 1 *)').lines[0], /^warning unknown pragma nope/);
  assert.match(run('(*# style: fancy *)').lines[0], /^warning style is book or sml/);
});

test('Stop: the run ends as stopped and the environment survives', () => {
  const interp = new Interpreter();
  run('val kept = 5;\nfun loop(n) = loop(n + 1);', interp);
  const job = interp.startRun('val y = loop(0);');
  assert.equal(job.step(30).state, 'running');
  job.interrupt();
  const end = job.step(1000);
  assert.equal(end.state, 'stopped');
  assert.equal(end.segments.at(-1).text, 'Stopped');
  assert.deepEqual(run('kept + 1;', interp).lines, ['value val it = 6 : int']);
  assert.equal(run('y;', interp).state, 'error');
});

test('stepping in small slices gives the same transcript as running to the end', () => {
  const src = SHISH + 'fun count(n, acc) = if n = 0 then acc else count(n - 1, acc + 1);\ncount(300000, 0);\nonly_onions(Skewer);';
  const whole = run(src).lines;
  const job = new Interpreter().startRun(src);
  const pieces = [];
  for (let i = 0; i < 100000; i++) {
    const { state, segments } = job.step(1);
    pieces.push(...segments.map(line));
    if (state !== 'running') break;
  }
  assert.deepEqual(pieces, whole);
});

test('runaway recursion is meaningless and the next cell works', () => {
  const interp = new Interpreter();
  run('fun run(n) = 1 + run(n + 1);', interp);
  const r = run('run(0);', interp);
  assert.equal(r.state, 'error');
  assert.match(r.lines[0], /^error:limit the recursion went too deep/);
  assert.deepEqual(run('1 + 1;', interp).lines, ['value val it = 2 : int']);
});

test('the book\'s non-terminating find stops cleanly', () => {
  const interp = new Interpreter();
  run("datatype 'a list = Empty | Cons of 'a * 'a list;\ndatatype box = Bacon | Ix of int;\nexception Out_of_range;\n" +
    'fun list_item(n, Empty) = raise Out_of_range | list_item(n, Cons(b, rest)) = if n = 1 then b else list_item(n - 1, rest);\n' +
    'fun find(n, boxes) = (check(n, boxes, list_item(n, boxes)) handle Out_of_range => find(n div 2, boxes))\n' +
    'and check(n, boxes, Bacon) = n | check(n, boxes, Ix(i)) = find(i, boxes);\n' +
    'val t = Cons(Ix(5), Cons(Ix(4), Cons(Bacon, Cons(Ix(2), Cons(Ix(7), Empty)))));', interp);
  assert.deepEqual(run('find(1, t);', interp).lines, ['value val it = 3 : int']);
  const job = interp.startRun('find(1, Cons(Ix(1), Empty));');
  assert.equal(job.step(40).state, 'running'); // find(1) -> Ix(1) -> find(1): never ends
  job.interrupt();
  assert.equal(job.step(1000).state, 'stopped');
});

test('stress: a 10M-step tail loop and 2M-deep non-tail recursion both finish', { timeout: 120000 }, () => {
  const interp = new Interpreter();
  const r = run('fun count(n, acc) = if n = 0 then acc else count(n - 1, acc + 1);\nfun nt(n) = if n = 0 then 0 else 1 + nt(n - 1);\n' +
    'count(10000000, 0);\nnt(2000000);', interp);
  assert.equal(r.state, 'done');
  assert.deepEqual(r.lines.slice(-2), ['value val it = 10000000 : int', 'value val it = 2000000 : int']);
});
