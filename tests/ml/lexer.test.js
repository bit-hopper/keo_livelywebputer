import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer } from '../../core/lib/ml/src/lexer.js';
import { MLError } from '../../core/lib/ml/src/errors.js';
import { lexTokens, tokens } from './helpers.js';

const lexError = (src) => {
  try { tokens(src); } catch (e) { assert.ok(e instanceof MLError); return e.errorClass + ': ' + e.message; }
  return null;
};

test('identifiers, keywords, integers', () => {
  assert.deepEqual(lexTokens('val One_more_than = 5;'),
    ['kw:val', 'id:One_more_than', 'op:=', 'int:5', 'op:;']);
  assert.deepEqual(lexTokens("a_N x' Y2"), ['id:a_N', "id:x'", 'id:Y2']);
  assert.deepEqual(lexTokens('div mod'), ['id:div', 'id:mod']);   // infix identifiers, not reserved
});

test('~ negates an integer literal; elsewhere it is a symbolic name', () => {
  assert.deepEqual(lexTokens('~5 ~ x'), ['int:-5', 'sym:~', 'id:x']);
  assert.deepEqual(lexTokens('7 div ~2'), ['int:7', 'id:div', 'int:-2']);
});

test('integers are 63-bit: -2^62 .. 2^62-1, exact beyond 2^53', () => {
  const [t] = tokens('4611686018427387903');
  assert.equal(t.value, 4611686018427387903n);
  assert.equal(typeof t.value, 'bigint');
  assert.equal(tokens('~4611686018427387904')[0].value, -4611686018427387904n);
  assert.equal(typeof tokens('9007199254740992')[0].value, 'number');
  assert.match(lexError('4611686018427387904'), /^ungrammatical: .*too large/);
  assert.match(lexError('~4611686018427387905'), /^ungrammatical: .*too large/);
});

test('qualified names carry their path', () => {
  const [t] = tokens('a_N.is_zero');
  assert.equal(t.type, 'id');
  assert.equal(t.value, 'is_zero');
  assert.deepEqual(t.qual, ['a_N']);
  assert.deepEqual(tokens('A.B.c')[0].qual, ['A', 'B']);
  assert.equal(tokens('x')[0].qual, null);
});

test('symbols: reserved ones are ops, the rest are symbolic names; maximal munch', () => {
  assert.deepEqual(lexTokens('-> => :> : | = _'), ['op:->', 'op:=>', 'op::>', 'op::', 'op:|', 'op:=', 'op:_']);
  assert.deepEqual(lexTokens('<= >= <> + - * <'), ['sym:<=', 'sym:>=', 'sym:<>', 'sym:+', 'sym:-', 'sym:*', 'sym:<']);
  assert.deepEqual(lexTokens('(n-1)'), ['op:(', 'id:n', 'sym:-', 'int:1', 'op:)']);
  assert.deepEqual(lexTokens('(x:int)'), ['op:(', 'id:x', 'op::', 'id:int', 'op:)']);
});

test('type variables', () => {
  const [a, b] = tokens("'a ''b");
  assert.deepEqual([a.type, a.value, a.eq], ['tyvar', "'a", false]);
  assert.deepEqual([b.type, b.value, b.eq], ['tyvar', "''b", true]);
  assert.match(lexError("' "), /type variable/);
});

test('glyph aliases', () => {
  assert.deepEqual(lexTokens('α → β'), ['tyvar:\'a', 'op:->', "tyvar:'b"]);
  assert.deepEqual(lexTokens('a ⇒ b'), ['id:a', 'op:=>', 'id:b']);
  assert.deepEqual(lexTokens('F ▷ S'), ['id:F', 'op::>', 'id:S']);
  assert.deepEqual(lexTokens('int ∗ int'), ['id:int', 'sym:*', 'id:int']);
  assert.equal(tokens('α')[0].glyph, true);
});

test('comments nest and are skipped', () => {
  assert.deepEqual(lexTokens('a (* b (* c *) d *) e'), ['id:a', 'id:e']);
  assert.deepEqual(lexTokens('(*) x *) y'), ['id:y']);   // (*) opens a comment, as in SML
  assert.deepEqual(lexTokens('(* a\nb *) c'), ['id:c']);
  assert.equal(tokens('(* a\nb *) c')[0].line, 2);        // line numbers survive a multi-line comment
  assert.match(lexError('x (* never closed'), /^syntax: .*never closed/);
});

test('pragmas', () => {
  const [p] = tokens('(*# style: book *)');
  assert.deepEqual([p.type, p.name, p.value], ['pragma', 'style', 'book']);
  assert.equal(tokens('(*# depth: 20 *)')[0].value, '20');
  assert.equal(tokens('(*# nonsense *)')[0].value, null);
});

test('⊗ and the placeholder', () => {
  assert.deepEqual(lexTokens('⊗ val x = 1'), ['op:⊗', 'kw:val', 'id:x', 'op:=', 'int:1']);
  assert.deepEqual(lexTokens('a … b ... c'), ['id:a', 'ellipsis:…', 'id:b', 'ellipsis:...', 'id:c']);
  assert.deepEqual(lexTokens('x.'), ['id:x', 'op:.']);   // a dot with no letter after it is not a path
});

test('a • line is a type box: the line is wrapped in ( ... );', () => {
  assert.deepEqual(lexTokens('• f : α → β\nval x = 1'),
    ['op:(', 'id:f', 'op::', "tyvar:'a", 'op:->', "tyvar:'b", 'op:)', 'op:;', 'kw:val', 'id:x', 'op:=', 'int:1']);
  assert.deepEqual(lexTokens('  • f : int'), ['op:(', 'id:f', 'op::', 'id:int', 'op:)', 'op:;']);   // ends at EOF too
  // not at the start of a line: just an unexpected character
  assert.match(lexError('x • y'), /unexpected character/);
});

test('reals, strings and stray characters get pointed messages', () => {
  assert.match(lexError('1.5'), /^syntax: reals are not part of the core/);
  assert.match(lexError('2e3'), /^syntax: reals are not part/);
  assert.match(lexError('"hello"'), /^syntax: strings are not part/);
  assert.match(lexError('_x'), /cannot start with _/);
  assert.match(lexError('x § y'), /unexpected character/);
});

test('positions: line, column and offsets', () => {
  const ts = tokens('val x\n  = 12');
  assert.deepEqual(ts.map((t) => [t.line, t.col, t.start, t.end]), [[1, 1, 0, 3], [1, 5, 4, 5], [2, 3, 8, 9], [2, 5, 10, 12]]);
});

test('the lexer is lazy: an error late in the source does not stop earlier tokens', () => {
  const lx = new Lexer('val x = 1; "late"');
  for (let i = 0; i < 5; i++) assert.notEqual(lx.next().type, 'eof');
  assert.throws(() => lx.next(), (e) => e instanceof MLError);
  assert.equal(lx.next().type, 'eof');   // and it moved past the bad string
});

test('CRLF source lexes like LF', () => {
  assert.deepEqual(lexTokens('val x = 1;\r\nval y = 2;\r\n'), lexTokens('val x = 1;\nval y = 2;\n'));
});
