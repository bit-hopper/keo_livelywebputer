import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interpreter } from '../../core/lib/ml/src/interpreter.js';

// Run `src` as one cell in a fresh interpreter (or the given one); returns { state, lines, last, error }.
function run(src, interp = new Interpreter({ style: 'book' })) {
  const r = interp.evalSync(src);
  const lines = r.segments.map((s) => (s.kind === 'error' ? 'error:' + s.errorClass + ' ' : '') + s.text);
  const err = r.segments.find((s) => s.kind === 'error');
  return { state: r.state, lines, last: lines[lines.length - 1], error: err ? err.errorClass + ': ' + err.text : null, interp };
}
const val = (src, interp) => run(src, interp).last;

const NUM = `
signature N = sig type number exception Too_small val succ : number -> number val pred : number -> number val is_zero : number -> bool end;
functor NumberAsInt() :> N = struct type number = int exception Too_small fun succ(n) = n + 1 fun pred(n) = if n = 0 then raise Too_small else n - 1 fun is_zero(n) = (n = 0) end;
functor NumberAsNum() :> N = struct datatype num = Zero | One_more_than of num type number = num exception Too_small fun succ(n) = One_more_than(n) fun pred(Zero) = raise Too_small | pred(One_more_than(n)) = n fun is_zero(Zero) = true | is_zero(a_num) = false end;
structure IntStruct = NumberAsInt();
structure NumStruct = NumberAsNum();
signature P = sig type number val plus : (number * number) -> number end;
functor PON(structure a_N : N) :> P where type number = a_N.number = struct type number = a_N.number fun plus(n,m) = if a_N.is_zero(n) then m else a_N.succ(plus(a_N.pred(n),m)) end;
structure IntArith = PON(structure a_N = IntStruct);
`;

test('signatures, functors and structures echo, with the signature name when there is one', () => {
  const r = run(NUM);
  assert.equal(r.state, 'done');
  assert.equal(r.lines[0], 'signature N =\n  sig\n    type number\n    exception Too_small\n    val succ : number -> number\n' +
    '    val pred : number -> number\n    val is_zero : number -> bool\n  end');
  assert.equal(r.lines[1], 'functor NumberAsInt() : N');
  assert.equal(r.lines.find((l) => l.startsWith('structure IntStruct')), 'structure IntStruct : N');
  const pon = r.lines.find((l) => l.startsWith('functor PON'));
  assert.match(pon, /^functor PON\(structure a_N : N\) :\n  sig\n    type number = a_N\.number\n    val plus : \(a_N\.number \* a_N\.number\) -> a_N\.number\n  end$/);
});

test('an opaque signature hides the type: signature nonsense, and a constructor that is not there', () => {
  const interp = run(NUM).interp;
  const r = run('IntArith.plus(1,2);', interp);
  assert.equal(r.state, 'error');
  assert.match(r.error, /^signature: plus consumes IntStruct\.number \* IntStruct\.number, but was given int \* int; IntStruct\.number is an abstract type here/);
  assert.match(run('NumStruct.Zero;', interp).error, /^signature: NumStruct has no component Zero/);
});

test('conceal and reveal: the numbers of one structure can be added, those of another cannot', () => {
  const src = NUM + `
signature N_C_R = sig type number exception Too_small val conceal : int -> number val succ : number -> number val pred : number -> number val is_zero : number -> bool val reveal : number -> int end;
functor NumberAsInt3() :> N_C_R = struct type number = int exception Too_small fun conceal(n) = n fun succ(n) = n + 1 fun pred(n) = if n = 0 then raise Too_small else n - 1 fun is_zero(n) = (n = 0) fun reveal(n) = n end;
functor NumberAsNum3() :> N_C_R = struct datatype num = Zero | One_more_than of num type number = num exception Too_small fun conceal(n) = if n = 0 then Zero else One_more_than(conceal(n - 1)) fun succ(n) = One_more_than(n) fun pred(Zero) = raise Too_small | pred(One_more_than(n)) = n fun is_zero(Zero) = true | is_zero(a_num) = false fun reveal(n) = if is_zero(n) then 0 else 1 + reveal(pred(n)) end;
structure IntStruct3 = NumberAsInt3();
structure NumStruct3 = NumberAsNum3();
functor PON3(structure a_N : N_C_R) :> P where type number = a_N.number = struct type number = a_N.number fun plus(n,m) = if a_N.is_zero(n) then m else a_N.succ(plus(a_N.pred(n),m)) end;
structure NumArith3 = PON3(structure a_N = NumStruct3);
structure IntArith3 = PON3(structure a_N = IntStruct3);
`;
  const interp = run(src).interp;
  assert.equal(val('NumStruct3.reveal(NumArith3.plus(NumStruct3.conceal(1), NumStruct3.conceal(2)));', interp), 'val it = 3 : int');
  assert.equal(val('IntStruct3.reveal(IntArith3.plus(IntStruct3.conceal(40), IntStruct3.conceal(2)));', interp), 'val it = 42 : int');
  assert.match(run('IntStruct3.reveal(NumArith3.plus(IntStruct3.conceal(1), IntStruct3.conceal(2)));', interp).error,
    /^signature: plus consumes NumStruct3\.number \* NumStruct3\.number, but was given IntStruct3\.number \* IntStruct3\.number/);
});

test('where type keeps a type visible; a different type with the same name does not match', () => {
  const interp = run(NUM).interp;
  run('functor NumberAsInt2() :> N where type number = int = struct type number = int exception Too_small fun succ(n) = n + 1 fun pred(n) = if n = 0 then raise Too_small else n - 1 fun is_zero(n) = (n = 0) end; structure IntStruct2 = NumberAsInt2(); structure IntArith2 = PON(structure a_N = IntStruct2);', interp);
  assert.equal(val('IntArith2.plus(1,2);', interp), 'val it = 3 : int');
  run('datatype num = Zero | One_more_than of num;', interp);
  const r = run('functor NumberAsNum2() :> N where type number = num = struct datatype num = Zero | One_more_than of num type number = num exception Too_small fun succ(n) = One_more_than(n) fun pred(Zero) = raise Too_small | pred(One_more_than(n)) = n fun is_zero(Zero) = true | is_zero(a_num) = false end;', interp);
  assert.match(r.error, /^signature: type number does not match definitional specification: the signature says it is num, but the structure has num \(two different types/);
});

test('sharing: without it the functor body is ill-typed, with it only consistent arguments are accepted', () => {
  const base = NUM + `
signature J = sig val new_plus : (int * int) -> int end;
signature N_C_R = sig type number exception Too_small val conceal : int -> number val succ : number -> number val pred : number -> number val is_zero : number -> bool val reveal : number -> int end;
functor NumberAsInt3() :> N_C_R = struct type number = int exception Too_small fun conceal(n) = n fun succ(n) = n + 1 fun pred(n) = if n = 0 then raise Too_small else n - 1 fun is_zero(n) = (n = 0) fun reveal(n) = n end;
functor NumberAsNum3() :> N_C_R = struct datatype num = Zero | One_more_than of num type number = num exception Too_small fun conceal(n) = if n = 0 then Zero else One_more_than(conceal(n - 1)) fun succ(n) = One_more_than(n) fun pred(Zero) = raise Too_small | pred(One_more_than(n)) = n fun is_zero(Zero) = true | is_zero(a_num) = false fun reveal(n) = if is_zero(n) then 0 else 1 + reveal(pred(n)) end;
structure IntStruct3 = NumberAsInt3();
structure NumStruct3 = NumberAsNum3();
functor PON3(structure a_N : N_C_R) :> P where type number = a_N.number = struct type number = a_N.number fun plus(n,m) = if a_N.is_zero(n) then m else a_N.succ(plus(a_N.pred(n),m)) end;
structure NumArith3 = PON3(structure a_N = NumStruct3);
structure IntArith3 = PON3(structure a_N = IntStruct3);
`;
  const interp = run(base).interp;
  const no = run('functor NP0(structure a_N : N_C_R structure a_P : P) :> J = struct fun new_plus(x,y) = a_N.reveal(a_P.plus(a_N.conceal(x),a_N.conceal(y))) end;', interp);
  assert.match(no.error, /^signature: plus consumes a_P\.number \* a_P\.number, but was given a_N\.number \* a_N\.number/);
  const NP = 'functor NP(structure a_N : N_C_R structure a_P : P sharing type a_N.number = a_P.number) :> J = struct fun new_plus(x,y) = a_N.reveal(a_P.plus(a_N.conceal(x),a_N.conceal(y))) end;';
  assert.equal(run(NP, interp).state, 'done');
  assert.equal(run('structure NPStruct = NP(structure a_N = NumStruct3 structure a_P = NumArith3);', interp).state, 'done');
  assert.equal(val('NPStruct.new_plus(2,3);', interp), 'val it = 5 : int');
  assert.match(run('structure NP1 = NP(structure a_N = NumStruct3 structure a_P = IntArith3);', interp).error,
    /^signature: type sharing violation: NumStruct3\.number # IntStruct3\.number/);
  // a structure built in the argument itself; a later binding sees the earlier one
  assert.equal(run('structure NPStruct2 = NP(structure a_N = NumberAsNum3() structure a_P = PON3(structure a_N = a_N));', interp).state, 'done');
  assert.equal(val('NPStruct2.new_plus(20, 22);', interp), 'val it = 42 : int');
});

test('a functor application is generative: its exceptions and its abstract types are new each time', () => {
  const interp = run(`
signature E = sig type t exception X val make : int -> t val raise_it : unit -> int val catch_it : (unit -> int) -> int val get : t -> int end;
functor MkE() :> E = struct datatype t = C of int exception X fun make(n) = C(n) fun raise_it(u) = raise X fun catch_it(f) = (f () handle X => 7) fun get(C(n)) = n end;
structure A = MkE();
structure B = MkE();
`).interp;
  assert.equal(val('A.catch_it(A.raise_it);', interp), 'val it = 7 : int');
  const wrong = run('B.catch_it(A.raise_it);', interp);
  assert.equal(wrong.error, 'exception: uncaught exception X');
  assert.equal(val('A.get(A.make(5));', interp), 'val it = 5 : int');
  assert.match(run('A.get(B.make(5));', interp).error, /^signature: get consumes A\.t, but was given B\.t/);
});

test('a transparent functor exposes its datatype, a new copy each application, and its constructors work', () => {
  const interp = run(`
functor D() = struct datatype d = P | Q of int fun twice(x) = case x of P => Q(0) | Q(n) => Q(n * 2) end;
structure D1 = D();
structure D2 = D();
`).interp;
  assert.equal(val('D1.twice(D1.Q(4));', interp), 'val it = Q(8) : D1.d');
  assert.equal(val('case D2.twice(D2.P) of D2.Q(n) => n | D2.P => 99;', interp), 'val it = 0 : int');
  const mix = run('D1.twice(D2.P);', interp);
  assert.match(mix.error, /^nonsense: twice consumes D1\.d, but was given D2\.d/);
});

test('transparent ascription shows the type, opaque hides it', () => {
  const sig = 'signature S = sig type t val x : t val f : t -> int end;\n';
  const body = 'struct type t = int val x = 3 fun f(n) = n + 1 end';
  const t = run(sig + 'structure T : S = ' + body + ';\nT.f(T.x + 1);');
  assert.equal(t.last, 'val it = 5 : int');
  const o = run(sig + 'structure O :> S = ' + body + ';\nO.f(O.x + 1);');
  assert.match(o.error, /^signature: /);
  assert.equal(val(sig + 'structure O :> S = ' + body + ';\nO.f(O.x);'), 'val it = 4 : int');
});

test('a structure that does not fit its signature is rejected with a reason', () => {
  const sig = 'signature S = sig type t val x : t val f : t -> int exception E of int end;\n';
  assert.match(run(sig + 'structure A : S = struct type t = int val x = 1 fun f(n) = n end;').error, /^signature: the structure has no exception E/);
  assert.match(run(sig + 'structure A : S = struct val x = 1 fun f(n) = n exception E of int end;').error, /^signature: the structure has no type t/);
  assert.match(run(sig + 'structure A : S = struct type t = int val x = 1 fun f(s:string) = 1 exception E of int end;').error.replace('string', 'string'), /^(signature|syntax|nonsense):/);
  assert.match(run(sig + 'structure A : S = struct type t = int val x = 1 fun f(n) = n exception E of bool end;').error, /^signature: the exception E has a different argument type/);
  // a polymorphic value satisfies a monomorphic spec, not the other way round
  assert.equal(run('signature M = sig val f : int -> int end;\nstructure A : M = struct fun f(x) = x end;').state, 'done');
  assert.match(run("signature M = sig val f : 'a -> 'a end;\nstructure A : M = struct fun f(x:int) = x end;").error, /^signature: f has type int -> int in the structure, which is not as general/);
});

test('nested structures, qualified names, and signatures with substructures', () => {
  const interp = run(`
signature INNER = sig val v : int end;
signature OUTER = sig structure i : INNER val w : int end;
structure O = struct structure i = struct val v = 1 end val w = 2 end;
structure O2 : OUTER = O;
structure Alias = O2;
`).interp;
  assert.equal(val('O2.i.v + Alias.w;', interp), 'val it = 3 : int');
  assert.match(run('O2.i.nothing;', interp).error, /^signature: O2\.i has no component nothing/);
  assert.match(run('O2.k.v;', interp).error, /^signature: O2 has no substructure k/);
});

test('a functor keeps the bindings it was defined against', () => {
  const interp = run('val k = 5;\nfunctor F() = struct val v = k end;\nval k = 6;\nstructure S = F();').interp;
  assert.equal(val('S.v;', interp), 'val it = 5 : int');
});

test('exceptions of a structure can be raised, and caught by qualified name', () => {
  const interp = run('structure E = struct exception Bad of int exception Plain end;').interp;
  assert.equal(val('(raise E.Bad(4)) handle E.Bad(n) => n * 2;', interp), 'val it = 8 : int');
  assert.equal(val('(raise E.Plain) handle E.Bad(n) => 1 | E.Plain => 2;', interp), 'val it = 2 : int');
  assert.equal(run('raise E.Bad(1);', interp).error, 'exception: uncaught exception Bad(1)');
});

test('qualified types and constructors from a transparent structure', () => {
  const interp = run('structure T = struct datatype color = Red | Green of int type pair = int * int end;').interp;
  assert.equal(val('T.Green(3);', interp), 'val it = Green(3) : T.color');
  assert.equal(val('fun f(T.Red) = 0 | f(T.Green(n)) = n; f(T.Green(7));', interp), 'val it = 7 : int');
  assert.equal(val('val p : T.pair = (1, 2);', interp), 'val p = (1,2) : int * int');
  assert.equal(val('fun g(c : T.color) = c; g;', interp), 'val it = fn : T.color -> T.color');
});

test('the pattern checker sees constructors of a structure', () => {
  const interp = run('structure T = struct datatype color = Red | Green of int end;').interp;
  const r = run('fun f(T.Red) = 0;', interp);
  assert.ok(r.lines.some((l) => l.startsWith('f has no clause for Green(_)')));
});

test('functors compose: a functor applied to the result of another', () => {
  const interp = run(`
signature ONE = sig val one : int end;
functor Mk(structure a : ONE) = struct val two = a.one + a.one end;
functor Twice(structure b : sig val two : int end) = struct val four = b.two + b.two end;
structure One = struct val one = 1 end;
structure Two = Mk(structure a = One);
structure Four = Twice(structure b = Two);
`).interp;
  assert.equal(val('Four.four;', interp), 'val it = 4 : int');
});

test('a failed module item defines nothing', () => {
  const interp = new Interpreter();
  run('signature S = sig val x : int end;', interp);
  run('structure A : S = struct val y = 1 end;', interp);
  assert.match(run('A.x;', interp).error, /^signature: the structure A is not defined/);
});

test('a structure inside a functor can use the parameter at run time and is thinned by the result signature', () => {
  const interp = run(`
signature SHOW = sig val name : string_stub end;
`.replace('string_stub', 'int')).interp;
  run(`
functor Wrap(structure s : SHOW) :> sig val twice : int end = struct val hidden = s.name val twice = hidden + hidden end;
structure W = Wrap(structure s = struct val name = 21 end);
`, interp);
  assert.equal(val('W.twice;', interp), 'val it = 42 : int');
  assert.match(run('W.hidden;', interp).error, /^signature: W has no component hidden/);
});

test('a type box can name a component of a structure', () => {
  const interp = run('structure S = struct fun id(x) = x val n = 3 end;').interp;
  assert.equal(run('(S.id : α → α);', interp).last, '✓ exactly: S.id : α -> α');
  assert.match(run('(S.id : int -> int);', interp).last, /^≈ the actual type is more general: S\.id : α -> α/);
  assert.match(run('(S.n : bool);', interp).last, /^✗ nonsense: .*the actual type of S\.n is int$/);
  assert.match(run('(S.missing : int);', interp).error, /^signature: S has no component missing/);
});
