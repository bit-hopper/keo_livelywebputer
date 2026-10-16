// Lists, strings, chars, options, print and the overloaded comparisons (MLspec.md section 11, "Phase 5a").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lexTokens, parsed, one, failure, types, rejects, checked, evaluator } from './helpers.js';
import { Lexer } from '../../core/lib/ml/src/lexer.js';
import { Interpreter } from '../../core/lib/ml/src/interpreter.js';

const lexError = (src) => {
  try { const lx = new Lexer(src); while (lx.next().type !== 'eof'); } catch (e) { return e.errorClass + ': ' + e.message; }
  return null;
};

// Run a cell; returns the segments plus the echo lines (`val` / datatype lines) and the final state.
function run(src, settings = {}) {
  const r = new Interpreter({ style: 'sml', ...settings }).evalSync(src);
  return {
    state: r.state,
    segments: r.segments,
    values: r.segments.filter((s) => s.kind === 'value').map((s) => s.text),
    stdout: r.segments.filter((s) => s.kind === 'stdout').map((s) => s.text).join(''),
    error: r.segments.find((s) => s.kind === 'error') || null,
    warnings: r.segments.filter((s) => s.kind === 'warning').map((s) => s.text),
  };
}
const last = (src, settings) => { const v = run(src, settings).values; return v[v.length - 1]; };

// ---- lexer -------------------------------------------------------------------------------------------------------

test('string and char literals are tokens, with SML escapes decoded', () => {
  assert.deepEqual(lexTokens('"hi" #"x" ""'), ['string:hi', 'char:x', 'string:']);
  assert.deepEqual(lexTokens('"a\\nb\\tc\\\\d\\"e"'), ['string:a\nb\tc\\d"e']);
  assert.deepEqual(lexTokens('"\\065\\066"'), ['string:AB']);
  assert.deepEqual(lexTokens('"\\^A\\^Z"'), ['string:\x01\x1a']);
  assert.deepEqual(lexTokens('"\\u0041\\u00e9"'), ['string:A\u00e9']);
  assert.deepEqual(lexTokens('"\\a\\b\\v\\f\\r"'), ['string:\x07\b\v\f\r']);
  assert.deepEqual(lexTokens('#"\\n" #"\\"" #"\\\\"'), ['char:\n', 'char:"', 'char:\\']);
});

test('a backslash, blanks and a backslash continue a string over a line break', () => {
  assert.deepEqual(lexTokens('"ab\\\n     \\cd"'), ['string:abcd']);
});

test('a string stays one token even if it holds keywords, comment marks or operators', () => {
  assert.deepEqual(lexTokens('"val (* x *) ::"'), ['string:val (* x *) ::']);
});

test('bad strings and chars get pointed messages', () => {
  assert.match(lexError('"never closed'), /^syntax: this string is never closed/);
  assert.match(lexError('"two\nlines"'), /^syntax: a string cannot contain a raw line break/);
  assert.match(lexError('"\\q"'), /^syntax: unknown escape \\q/);
  assert.match(lexError('"\\12"'), /^syntax: a \\ddd escape takes exactly three digits/);
  assert.match(lexError('"\\300"'), /^syntax: the escape \\300 is not a character/);
  assert.match(lexError('"\\uZZZZ"'), /^syntax: a \\u escape takes exactly four hexadecimal digits/);
  assert.match(lexError('"\\^a"'), /^syntax: \\\^ must be followed by/);
  assert.match(lexError('#"ab"'), /^syntax: a character literal holds exactly one character, but this has 2/);
  assert.match(lexError('#""'), /exactly one character, but this has 0/);
});

// ---- parser ------------------------------------------------------------------------------------------------------

test(':: and @ are right associative, ^ is left associative, and they bind as SML says', () => {
  assert.equal(one('1 :: 2 :: nil;'), '(1 :: (2 :: nil))');
  assert.equal(one('a @ b @ c;'), '(a @ (b @ c))');
  assert.equal(one('a ^ b ^ c;'), '((a ^ b) ^ c)');
  assert.equal(one('1 + 2 :: l;'), '((1 + 2) :: l)');
  assert.equal(one('x :: y = z;'), '((x :: y) = z)');
  assert.equal(one('"a" ^ "b" = c;'), '(("a" ^ "b") = c)');
  assert.equal(one('f x :: g y;'), '((f x) :: (g y))');
});

test('list literals, in expressions and in patterns', () => {
  assert.equal(one('[1, 2, 3];'), '[1, 2, 3]');
  assert.equal(one('[];'), '[]');
  assert.equal(one('[[1], [], [2, 3]];'), '[[1], [], [2, 3]]');
  assert.equal(one('["a", "b"];'), '["a", "b"]');
  assert.equal(one('fn [] => 0 | [x] => x | [x, y] => x + y;'), '(fn [] => 0 | [x] => x | [x, y] => (x + y))');
  assert.equal(one('fn (x :: y :: r) => r;'), '(fn (:: (x, (:: (y, r)))) => r)');
  assert.equal(one('fn "a" => 1 | #"b" => 2;'), '(fn "a" => 1 | #"b" => 2)');
  assert.equal(one('fun f nil = 0 | f (x :: _) = x;'), 'fun f nil = 0 | f (:: (x, _)) = x');
  assert.equal(one('fun f [] = 0 | f [x] = x;'), 'fun f [] = 0 | f [x] = x');
});

test('a malformed list or string pattern is a syntax error at the right place', () => {
  assert.equal(failure('val x = [1, 2;'), "syntax: unexpected ';'; expected ',' or ']'");
  assert.equal(failure('val x = [1 2];'), null);   // (1 2) is an application: a type error, not a syntax error
  assert.equal(failure('val [x, y = 1;'), "syntax: unexpected '='; expected ',' or ']'");
  assert.match(failure('val x = a := 1;'), /^syntax: the operator := is not part of the core/);
});

// ---- types -------------------------------------------------------------------------------------------------------

test('principal types of list, string, char and option expressions', () => {
  assert.deepEqual(types('val a = [1, 2]; val b = "x" ^ "y"; val c = #"z"; val d = SOME [1]; val e = [];', 'sml'),
    ['a : int list', 'b : string', 'c : char', 'd : int list option', "e : 'a list"]);
  assert.deepEqual(types('fun len [] = 0 | len (_ :: t) = 1 + len t;', 'sml'), ["len : 'a list -> int"]);
  assert.deepEqual(types('fun app (xs, ys) = xs @ ys;', 'sml'), ["app : 'a list * 'a list -> 'a list"]);
  assert.equal(last('val m = map;'), "val m = fn : ('a -> 'b) -> 'a list -> 'b list");   // (map is ML source in the interpreter's prelude)
  assert.equal(last('val m = map;', { style: 'book' }), 'val m = fn : (α -> β) -> ((α list) -> (β list))');
  assert.deepEqual(types('val p = (hd, tl, null, length, rev, size, print);', 'sml'),
    ["p : ('a list -> 'a) * ('b list -> 'b list) * ('c list -> bool) * ('d list -> int) * ('e list -> 'e list) * (string -> int) * (string -> unit)"]);
  assert.deepEqual(types('val q = (str, ord, chr, explode, implode, concat, Int.toString);', 'sml'),
    ['q : (char -> string) * (char -> int) * (int -> char) * (string -> char list) * (char list -> string) * (string list -> string) * (int -> string)']);
  assert.equal(last('val o = (valOf, isSome, SOME, NONE);'), "val o = (fn,fn,fn,NONE) : ('a option -> 'a) * ('b option -> bool) * ('c -> 'c option) * 'd option");
  assert.deepEqual(types('val c = op ::;', 'sml'), ["c : 'a * 'a list -> 'a list"]);
});

test('list, string and char type errors name the clash', () => {
  assert.match(rejects('[1, true];'), /^nonsense: the elements of a list must all have the same type: this one has type bool, but the ones before it have type int/);
  assert.match(rejects('1 :: 2;'), /^nonsense: :: consumes int \* \(int list\), but was given int \* int/);
  assert.match(rejects('"a" ^ 5;'), /^nonsense: \^ consumes string \* string, but was given string \* int/);
  assert.match(rejects('fn [1, "a"] => 0;'), /^nonsense: the patterns of a list must all have the same type/);
  assert.match(rejects('fn "a" => 1 | 2 => 2;'), /^nonsense: this pattern has type int, but the earlier patterns have type string/);
  assert.match(rejects('size 5;'), /^nonsense: size consumes string, but was given int/);
  assert.match(rejects('rev "abc";'), /^nonsense: rev consumes α list, but was given string/);
  assert.match(rejects('print 5;'), /^nonsense: print consumes string, but was given int/);
  assert.match(rejects('#"a" ^ "b";'), /^nonsense: \^ consumes string \* string, but was given char \* string/);
});

test('equality works on lists, strings and chars, and not through a function', () => {
  assert.deepEqual(types('val a = [1] = [1]; val b = "s" = "s"; val c = #"a" <> #"b"; val d = [SOME "x"] = [NONE];', 'sml'),
    ['a : bool', 'b : bool', 'c : bool', 'd : bool']);
  assert.match(rejects('[(fn x => x)] = [(fn x => x)];'), /^nonsense: equality is needed here/);
  assert.deepEqual(types('fun same (a, b) = a = b;', 'sml'), ["same : ''a * ''a -> bool"]);
});

test('the basis names can be redefined, and a datatype named list hides the built-in type but not [] and ::', () => {
  assert.deepEqual(types('fun map f = f; fun hd x = x; val size = 3;', 'sml'), ["map : 'a -> 'a", "hd : 'a -> 'a", 'size : int']);
  const sess = run("datatype 'a list = Empty | Cons of 'a * 'a list;\nCons (1, Empty);\n[1, 2];\nfun clen Empty = 0 | clen (Cons (_, t)) = 1 + clen t;\nclen (Cons (1, Cons (2, Empty)));");
  assert.deepEqual(sess.values, ["datatype 'a list = Empty | Cons of 'a * 'a list", 'val it = Cons (1,Empty) : int list', 'val it = [1,2] : int list',
    "val clen = fn : 'a list -> int", 'val it = 2 : int']);
  const mixed = run("datatype 'a list = Empty | Cons of 'a * 'a list;\nfun clen Empty = 0 | clen (Cons (_, t)) = 1 + clen t;\nclen [1, 2, 3];");
  assert.equal(mixed.error.errorClass, 'nonsense');
  assert.match(mixed.error.text, /two different types that are both named list/);
});

// ---- the overloaded comparisons ----------------------------------------------------------------------------------

test('< > <= >= work on ints, strings and chars, and default to int', () => {
  assert.deepEqual(run('3 < 4; "apple" < "banana"; "b" >= "a"; #"a" < #"b"; #"z" <= #"a"; "b" > "ab"; 5 >= 5; "" < "a";').values,
    ['val it = true : bool', 'val it = true : bool', 'val it = true : bool', 'val it = true : bool', 'val it = false : bool',
      'val it = true : bool', 'val it = true : bool', 'val it = true : bool']);
  assert.deepEqual(types('fun lt (a, b) = a < b;', 'sml'), ['lt : int * int -> bool']);
  assert.deepEqual(types('val f = fn (a, b) => a >= b;', 'sml'), ['f : int * int -> bool']);
  assert.deepEqual(types('fun lts (a : string, b) = a < b;', 'sml'), ['lts : string * string -> bool']);
  assert.deepEqual(types('fun m (a, b) = if a > b then a else b;', 'sml'), ['m : int * int -> int']);
});

test('an overloaded comparison is decided by its first use, or defaults to int', () => {
  // `m` has no annotation, so it is int * int -> int, and then ("x","y") is a mistake
  assert.match(rejects('fun m (a, b) = if a > b then a else b; m ("x", "y");'), /^nonsense: m consumes int \* int, but was given string \* string/);
  assert.deepEqual(types('val s = (fn (a, b) => a < b) ("x", "y");', 'sml'), ['s : bool']);
});

test('a let-bound comparison stays monomorphic, as in SML/NJ (checked against it 2026-10-16)', () => {
  assert.equal(run('fun g x = let fun lt (a, b) = a < b in (lt (1, 2), lt ("a", "b")) end;').error.errorClass, 'nonsense');
  assert.equal(run('val h = let val lt = fn (a, b) => a < b in (lt (1, 2), lt (#"a", #"b")) end;').error.errorClass, 'nonsense');
  assert.deepEqual(run('fun g2 x = let fun lt (a, b) = a < b in lt (1, 2) end;').values, ["val g2 = fn : 'a -> bool"]);
  assert.deepEqual(run('fun g3 x = let fun lt (a, b) = a < b in lt ("a", "b") end;').values, ["val g3 = fn : 'a -> bool"]);
});

test('a comparison on any other type is nonsense', () => {
  assert.match(rejects('[1] < [2];'), /^nonsense: < > <= and >= compare an int, a string or a char, but here the operands would have type int list/);
  assert.match(rejects('(1, 2) < (3, 4);'), /would have type int \* int/);
  assert.match(rejects('fun f (x : \'a) = x < x;'), /^nonsense: < > <= and >= compare an int, a string or a char/);
  assert.match(rejects('true < false;'), /would have type bool/);
  assert.match(rejects('"a" < 1;'), /^nonsense: < consumes string \* string, but was given string \* int/);
});

// ---- running -----------------------------------------------------------------------------------------------------

test('list operations', () => {
  assert.equal(last('val l = [1, 2, 3]; 0 :: l;'), 'val it = [0,1,2,3] : int list');
  assert.equal(last('[1, 2] @ [3] @ [];'), 'val it = [1,2,3] : int list');
  assert.equal(last('[[1], [2, 3], []];'), 'val it = [[1],[2,3],[]] : int list list');
  assert.equal(last('rev [1, 2, 3];'), 'val it = [3,2,1] : int list');
  assert.equal(last('length [7, 8, 9];'), 'val it = 3 : int');
  assert.equal(last('(hd [4, 5], tl [4, 5], null [], null [4]);'), 'val it = (4,[5],true,false) : int * int list * bool * bool');
  assert.equal(last('map (fn x => x * x) [1, 2, 3];'), 'val it = [1,4,9] : int list');
  assert.equal(last('map (fn s => s ^ "!") ["a", "b"];'), 'val it = ["a!","b!"] : string list');
  assert.equal(last('map (op ::) [(1, []), (2, [3])];'), 'val it = [[1],[2,3]] : int list list');
  assert.equal(last('val e = []; e @ e;'), "val it = [] : 'a list");
  assert.equal(last('fun flat [] = [] | flat (x :: xs) = x @ flat xs; flat [[1], [2, 3], [4]];'), 'val it = [1,2,3,4] : int list');
});

test('list patterns: nil, [], [x], x :: rest, nested, constants', () => {
  assert.equal(last('fun f [] = 0 | f [x] = x | f (x :: y :: _) = x + y; (f [], f [5], f [5, 6, 7]);'), 'val it = (0,5,11) : int * int * int');
  assert.equal(last('fun g nil = "empty" | g (_ :: nil) = "one" | g _ = "many"; (g [], g [1], g [1, 2]);'), 'val it = ("empty","one","many") : string * string * string');
  assert.equal(last('fun n [[x]] = x | n _ = 0; (n [[9]], n [[1, 2]], n []);'), 'val it = (9,0,0) : int * int * int');
  assert.equal(last('fun k [1, 2] = "a" | k (1 :: _) = "b" | k _ = "c"; (k [1, 2], k [1, 3], k [2]);'), 'val it = ("a","b","c") : string * string * string');
  assert.equal(last('val (a :: b) = [1, 2, 3]; (a, b);'), 'val it = (1,[2,3]) : int * int list');
  assert.equal(last('fun f (x :: xs : int list) = x | f [] = 0; f [3];'), 'val it = 3 : int');
});

test('non-exhaustive and redundant list matches', () => {
  assert.deepEqual(run('fun g (x :: xs) = x;').warnings, ['g has no clause for []; a value like that raises Match']);
  assert.deepEqual(run('fun h [] = 0 | h [_] = 1;').warnings, ['h has no clause for _ :: _ :: _; a value like that raises Match']);
  assert.deepEqual(run('fun o (SOME x) = x;').warnings, ['o has no clause for NONE; a value like that raises Match']);
  assert.deepEqual(run('fun s "a" = 1;').warnings, ['s has no clause for _; a value like that raises Match']);
  assert.deepEqual(run('fun ok [] = 0 | ok (_ :: _) = 1;').warnings, []);
  assert.deepEqual(run('fun ok2 [] = 0 | ok2 [_] = 1 | ok2 (_ :: _ :: _) = 2;').warnings, []);
  assert.match(run('fun r [] = 0 | r _ = 1 | r (x :: xs) = 2;').error.text, /^clause 3 of r can never be used/);
  assert.match(run('fun r2 [] = 0 | r2 [] = 1;').error.text, /^clause 2 of r2 can never be used/);
  assert.match(run('fun r3 "a" = 1 | r3 "a" = 2 | r3 _ = 3;').error.text, /^clause 2 of r3 can never be used/);
  assert.match(run('fun r4 #"a" = 1 | r4 #"a" = 2 | r4 _ = 3;').error.text, /^clause 2 of r4 can never be used/);
  assert.equal(run('fun f (x :: _) = x; f [];').error.text, 'uncaught exception Match');
});

test('strings and chars', () => {
  assert.equal(last('"he" ^ "llo" ^ " " ^ "world";'), 'val it = "hello world" : string');
  assert.equal(last('size "hello";'), 'val it = 5 : int');
  assert.equal(last('(size "", size "\\n");'), 'val it = (0,1) : int * int');
  assert.equal(last('explode "abc";'), 'val it = [#"a",#"b",#"c"] : char list');
  assert.equal(last('implode (rev (explode "stressed"));'), 'val it = "desserts" : string');
  assert.equal(last('(ord #"a", chr 98, str #"z");'), 'val it = (97,#"b","z") : int * char * string');
  assert.equal(last('concat ["ab", "cd", "ef"];'), 'val it = "abcdef" : string');
  assert.equal(last('concat [];'), 'val it = "" : string');
  assert.equal(last('("a" = "a", "a" = "b", "a" <> "b", #"x" = #"x");'), 'val it = (true,false,true,true) : bool * bool * bool * bool');
  assert.equal(last('fun greet "bob" = 1 | greet "ann" = 2 | greet _ = 0; (greet "ann", greet "bob", greet "x");'), 'val it = (2,1,0) : int * int * int');
  assert.equal(last('fun vowel #"a" = true | vowel #"e" = true | vowel _ = false; (vowel #"e", vowel #"z");'), 'val it = (true,false) : bool * bool');
  assert.equal(last('Int.toString 42 ^ Int.toString ~7;'), 'val it = "42~7" : string');
});

test('how strings and chars are printed', () => {
  assert.equal(last('"tab\\there";'), 'val it = "tab\\there" : string');
  assert.equal(last('"quote\\"back\\\\slash";'), 'val it = "quote\\"back\\\\slash" : string');
  assert.equal(last('"line\\nbreak";'), 'val it = "line\\nbreak" : string');
  assert.equal(last('"ctl\\001end";'), 'val it = "ctl\\^Aend" : string');
  assert.equal(last('"hi\\200there";'), 'val it = "hi\\200there" : string');
  assert.equal(last('"\\u2603";'), 'val it = "\\u2603" : string');
  assert.equal(last('#"\\n";'), 'val it = #"\\n" : char');
  assert.equal(last('#"\\"";'), 'val it = #"\\"" : char');
  assert.equal(last('[#"a", #"\\\\"];'), 'val it = [#"a",#"\\\\"] : char list');
  assert.equal(last('"é";'), 'val it = "\\233" : string');
});

test('options', () => {
  assert.equal(last('(SOME 3, NONE : int option);'), 'val it = (SOME 3,NONE) : int option * int option');
  assert.equal(last('[SOME 1, NONE, SOME 3];'), 'val it = [SOME 1,NONE,SOME 3] : int option list');
  assert.equal(last('valOf (SOME "x");'), 'val it = "x" : string');
  assert.equal(last('(isSome (SOME 1), isSome (NONE : int option));'), 'val it = (true,false) : bool * bool');
  assert.equal(last('fun opt (SOME x) = x | opt NONE = 0; (opt (SOME 5), opt NONE);'), 'val it = (5,0) : int * int');
  assert.equal(run('valOf NONE;').error.text, 'uncaught exception Option');
  assert.equal(last('(valOf NONE handle Option => 7);'), 'val it = 7 : int');
});

test('hd, tl, chr and the other primitives raise the basis exceptions', () => {
  assert.equal(run('hd [];').error.text, 'uncaught exception Empty');
  assert.equal(run('tl [];').error.text, 'uncaught exception Empty');
  assert.equal(run('chr ~1;').error.text, 'uncaught exception Chr');
  assert.equal(run('chr 70000;').error.text, 'uncaught exception Chr');
  assert.equal(last('(hd [] handle Empty => 0);'), 'val it = 0 : int');
  assert.equal(last('(tl [1] handle Empty => [9]);'), 'val it = [] : int list');
  // an exception the program declares with the same name is a different exception: the basis's Empty still escapes it
  assert.equal(run('exception Empty; (hd [] handle Empty => 5);').error.text, 'uncaught exception Empty');
});

test('print writes to stdout, in order, before the echo, and merges into one segment', () => {
  const r = run('print "hello\\n"; print (Int.toString 5 ^ "\\n"); (print "a"; print "b"; 3);');
  assert.equal(r.stdout, 'hello\n5\nab');
  assert.deepEqual(r.segments.map((s) => s.kind), ['stdout', 'value', 'stdout', 'value', 'stdout', 'value']);
  assert.deepEqual(r.values, ['val it = () : unit', 'val it = () : unit', 'val it = 3 : int']);
  // consecutive writes of one item are a single segment
  const loop = run('fun p 0 = () | p n = (print "x"; p (n - 1)); p 1000;');
  assert.equal(loop.segments.filter((s) => s.kind === 'stdout').length, 1);
  assert.equal(loop.stdout, 'x'.repeat(1000));
  // print as a value, and what an earlier failure leaves behind
  assert.equal(run('map print ["a", "b"];').stdout, 'ab');
  assert.equal(run('print "before"; hd [];').stdout, 'before');
});

test('a print loop can be stopped, and output is capped at 1 MB', () => {
  const job = new Interpreter({ style: 'sml' }).startRun('fun loop n = (print "xxxxxxxxxx"; loop (n + 1)); loop 0;');
  let got = 0;
  let state = 'running';
  for (let i = 0; i < 3 && state === 'running'; i++) {
    const s = job.step(20);
    got += s.segments.filter((x) => x.kind === 'stdout').reduce((n, x) => n + x.text.length, 0);
    state = s.state;
  }
  assert.equal(state, 'running');
  assert.ok(got > 0);
  job.interrupt();
  const end = job.step(50);
  assert.equal(end.state, 'stopped');
  assert.ok(end.segments.some((s) => s.kind === 'status' && s.text === 'Stopped'));
  // the cap
  const big = new Interpreter({ style: 'sml' }).startRun('fun loop n = if n > 200000 then () else (print "xxxxxxxxxx"; loop (n + 1)); loop 0;');
  const out = big.runToCompletion();
  const total = out.segments.filter((s) => s.kind === 'stdout').reduce((n, s) => n + s.text.length, 0);
  assert.ok(total <= 1000000, 'stdout is capped, got ' + total);
  assert.ok(out.segments.some((s) => s.kind === 'status' && s.text === '(output truncated)'));
  // past the cap, the error that ends the cell must still be reported (only printing, echo lines and warnings are dropped)
  const flood = run('fun loop n = if n > 150000 then () else (print "xxxxxxxxxx"; loop (n + 1)); loop 0; hd [];');
  assert.ok(flood.segments.some((s) => s.kind === 'status' && s.text === '(output truncated)'));
  assert.equal(flood.error && flood.error.text, 'uncaught exception Empty');
});

test('printing lists: both styles, the length and depth limits', () => {
  assert.equal(last('[SOME [1, 2]];', { style: 'sml' }), 'val it = [SOME [1,2]] : int list option list');
  assert.equal(last('[SOME [1, 2]];', { style: 'book' }), 'val it = [SOME([1,2])] : ((int list) option) list');
  assert.equal(last('(SOME (1, 2), [(1, "a")]);', { style: 'book' }), 'val it = (SOME(1,2),[(1,"a")]) : ((int * int) option) * ((int * string) list)');
  assert.equal(last('(*# length: 3 *)\n[1, 2, 3, 4, 5];'), 'val it = [1,2,3,...] : int list');
  assert.equal(last('(*# length: 3 *)\n[1, 2, 3, 4, 5];', { style: 'book' }), 'val it = [1,2,3,…] : int list');
  assert.equal(last('(*# length: 3 *)\n[1, 2, 3];'), 'val it = [1,2,3] : int list');
  assert.equal(last('(*# depth: 2 *)\n[[[1]]];'), 'val it = [[…]] : int list list list');
  const long = run('fun upto (a, b) = if a > b then [] else a :: upto (a + 1, b); upto (1, 1500);');
  assert.equal(long.values[1].split(',').length, 1001);        // 1000 elements and the ellipsis
  assert.match(long.values[1], /,1000,\.\.\.\] : int list$/);
  assert.equal(run('(*# length: nope *)').segments[0].kind, 'warning');
});

test('long lists: building, append, reverse, length and equality do not overflow the stack', () => {
  const r = run('fun upto (a, b) = if a > b then [] else a :: upto (a + 1, b);\nval big = upto (1, 300000);\n(length big, hd (rev big), length (big @ big), big = big, big = rev (rev big));');
  assert.equal(r.error, null);
  assert.equal(r.values[r.values.length - 1], 'val it = (300000,300000,600000,true,true) : int * int * int * bool * bool');
});

test('a long list literal evaluates without deep recursion', () => {
  const src = '[' + Array.from({ length: 5000 }, (_, i) => i).join(', ') + ']';
  const r = run('length ' + src + ';');
  assert.equal(r.error, null);
  assert.equal(r.values[0], 'val it = 5000 : int');
  const nonAtomic = run('fun id x = x; length [' + Array.from({ length: 3000 }, (_, i) => 'id ' + i).join(', ') + '];');
  assert.equal(nonAtomic.error, null);
  assert.equal(nonAtomic.values[1], 'val it = 3000 : int');
});

test('list literals evaluate their elements left to right', () => {
  const r = run('[(print "a"; 1), (print "b"; 2), (print "c"; 3)];');
  assert.equal(r.stdout, 'abc');
  assert.equal(r.values[0], 'val it = [1,2,3] : int list');
});

test('a string that grows without bound ends the item, not the page', () => {
  const interp = new Interpreter({ style: 'sml' });
  const r = interp.evalSync('fun grow s = grow (s ^ s); grow "abc";');
  const err = r.segments.find((x) => x.kind === 'error');
  assert.equal(err.errorClass, 'limit');
  assert.match(err.text, /grew past what this page can hold/);
  // ... and the interpreter is still usable, with what was defined before the failure
  assert.equal(interp.evalSync('1 + 1;').segments[0].text, 'val it = 2 : int');
  assert.equal(interp.evalSync('size "ok";').segments[0].text, 'val it = 2 : int');
});

// ---- with and without the lists basis ----------------------------------------------------------------------------

test('the core basis has no lists, strings, print or option', () => {
  const core = (src) => run(src, { basis: 'core' });
  assert.match(core('[1];').error.text, /^lists are not part of the core basis/);
  assert.match(core('"a";').error.text, /^strings are not part of the core basis/);
  assert.match(core('#"a";').error.text, /^characters are not part of the core basis/);
  assert.match(core('fn [] => 1;').error.text, /^lists are not part of the core basis/);
  assert.match(core('map;').error.text, /^map is not defined/);
  assert.match(core('print;').error.text, /^print is not defined/);
  assert.match(core('1 :: nil;').error.text, /^:: is not defined/);
  assert.match(core('val x : int list = 1;').error.text, /^the type list is not defined/);
  assert.equal(core('3 < 4;').values[0], 'val it = true : bool');
  assert.equal(core('datatype \'a list = Empty | Cons of \'a * \'a list; Cons (1, Empty);').values[1], 'val it = Cons (1,Empty) : int list');
});

test('the basis adds no names the book programs would trip over: the same program runs the same either way', () => {
  const book = "datatype 'a list = Empty | Cons of 'a * 'a list;\nfun length Empty = 0 | length (Cons (_, t)) = 1 + length t;\nfun map f Empty = Empty | map f (Cons (x, t)) = Cons (f x, map f t);\nval rev = 3;\nlength (map (fn x => x + 1) (Cons (1, Cons (2, Empty))));";
  assert.deepEqual(run(book).values, run(book, { basis: 'core' }).values);
});

// ---- the machine and evaluator helpers see lists too -------------------------------------------------------------

test('the evaluator helper reads lists, strings and chars', () => {
  const ev = evaluator();
  ev.run('val l = [1, 2, 3]; val s = "ab"; val c = #"x"; val o = SOME [4];');
  assert.deepEqual(ev.value('l'), [1, 2, 3]);
  assert.equal(ev.value('s'), 'ab');
  assert.equal(ev.value('c'), '#x');
  assert.deepEqual(ev.value('o'), ['SOME', [4]]);
});

test('pattern checker through the helper: list witnesses', () => {
  assert.deepEqual(checked('fun f (x :: y :: _) = x;').warnings, ['f has no clause for []; a value like that raises Match']);
});

test('the same-name note appears only when two different types really share a name', () => {
  assert.match(rejects('val x : int = "a";'), /^nonsense: this pattern has type int, but the expression has type string$/);
  assert.equal(rejects('val x : int list = [1, 2];'), null);
});
