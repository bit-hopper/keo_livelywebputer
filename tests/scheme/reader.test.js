import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from '../../core/lib/scheme/src/index.js';
import { toWrite } from '../../core/lib/scheme/src/printer.js';
import { val } from './helpers.js';

const read = (s) => toWrite(new Parser(s).next());
const readAll = (s) => new Parser(s).readAll().map(toWrite);

test('atoms', () => {
  assert.equal(read('42'), '42');
  assert.equal(read('-7'), '-7');
  assert.equal(read('1/2'), '1/2');
  assert.equal(read('4/2'), '2');
  assert.equal(read('3.14'), '3.14');
  assert.equal(read('.5'), '0.5');
  assert.equal(read('1e3'), '1000.0');
  assert.equal(read('#t'), '#t');
  assert.equal(read('#false'), '#f');
  assert.equal(read('#T'), '#t');            // the capital forms are accepted too
  assert.equal(read('#F'), '#f');
  assert.equal(read('#TRUE'), '#t');
  assert.equal(read('foo-bar?'), 'foo-bar?');
  assert.equal(read('+'), '+');
  assert.equal(read('...'), '...');
  assert.equal(read('1+'), '1+');
  assert.equal(read('-1+'), '-1+');
  assert.equal(read('#xFF'), '255');
  assert.equal(read('#b101'), '5');
  assert.equal(read('123456789012345678901234567890'), '123456789012345678901234567890');
});

test('symbols are case sensitive', () => {
  assert.equal(val("(eq? 'Foo 'foo)"), '#f');
  assert.equal(read('Hello'), 'Hello');
});

test('strings and escapes', () => {
  assert.equal(read('"hi"'), '"hi"');
  assert.equal(read('"a\\nb"'), '"a\\nb"');
  assert.equal(read('"q\\"q"'), '"q\\"q"');
  assert.equal(read('"tab\\there"'), '"tab\\there"');
  assert.equal(read('"\\x41;"'), '"A"');
});

test('chars', () => {
  assert.equal(read('#\\a'), '#\\a');
  assert.equal(read('#\\space'), '#\\space');
  assert.equal(read('#\\newline'), '#\\newline');
  assert.equal(read('#\\('), '#\\(');
  assert.equal(read('#\\x41'), '#\\A');
  assert.equal(val('(char->integer #\\A)'), '65');
});

test('lists, dotted pairs, vectors, brackets', () => {
  assert.equal(read('(1 2 3)'), '(1 2 3)');
  assert.equal(read('(1 . 2)'), '(1 . 2)');
  assert.equal(read('(1 2 . 3)'), '(1 2 . 3)');
  assert.equal(read('()'), '()');
  assert.equal(read('[a b]'), '(a b)');
  assert.equal(read('#(1 2 (3))'), '#(1 2 (3))');
  assert.equal(read('(a (b (c)))'), '(a (b (c)))');
});

test('quote forms', () => {
  assert.equal(read("'a"), '(quote a)');
  assert.equal(read('`(a ,b ,@c)'), '(quasiquote (a (unquote b) (unquote-splicing c)))');
  assert.equal(read("''a"), '(quote (quote a))');
});

test('comments', () => {
  assert.deepEqual(readAll('1 ; comment\n2'), ['1', '2']);
  assert.deepEqual(readAll('1 #| block #| nested |# |# 2'), ['1', '2']);
  assert.deepEqual(readAll('1 #;(ignored thing) 2'), ['1', '2']);
  assert.deepEqual(readAll('#;a'), []);
});

test('#lang line is captured and skipped', () => {
  const p = new Parser('#lang sicp\n(+ 1 2)');
  assert.equal(p.lang, 'sicp');
  assert.equal(toWrite(p.next()), '(+ 1 2)');
  assert.equal(Parser.extractLang('  #lang eopl\nfoo'), 'eopl');
  assert.equal(Parser.extractLang('(+ 1 2)'), null);
});

test('syntax errors', () => {
  assert.throws(() => new Parser('(1 2').next(), (e) => e.payload.kind === 'parse-error');
  assert.throws(() => new Parser(')').next(), (e) => e.payload.kind === 'parse-error');
  assert.throws(() => new Parser('"abc').next(), (e) => e.payload.kind === 'parse-error');
});

test('forms are read lazily, one at a time', () => {
  const p = new Parser('(a) (b');
  assert.equal(toWrite(p.next()), '(a)');
  assert.throws(() => p.next());
});
