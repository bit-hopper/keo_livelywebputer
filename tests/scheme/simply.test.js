// Word/sentence library (#lang simply): the vocabulary itself, a corpus of
// small word-game programs, console input as sentences, and the pattern matcher.
// Expected values are worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newInterp, run, val, stdout } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = (name) => fs.readFileSync(path.join(here, 'corpora', name + '.scm'), 'utf8');

function lib() {
  const i = newInterp();
  assert.equal(run('#lang simply', i), '');
  return i;
}

function check(i, pairs) {
  for (const [src, want] of pairs) assert.equal(val(src, i), want, src);
}

test('simply: the library loads silently and is idempotent', () => {
  const i = lib();
  assert.equal(run('#lang simply', i), '');
  assert.equal(val("(first 'hello)", i), 'h');
});

test('simply: predicates', () => {
  check(lib(), [
    ["(word? 'a)", '#t'], ['(word? 12)', '#t'], ['(word? "x")', '#t'], ["(word? '(a))", '#f'],
    ["(sentence? '(a b 3))", '#t'], ["(sentence? '(a (b)))", '#f'], ["(sentence? 'a)", '#f'],
    ["(empty? '())", '#t'], ['(empty? "")', '#t'], ["(empty? 'a)", '#f'], ["(empty? '(a))", '#f'],
  ]);
});

test('simply: selectors on words, numbers and sentences', () => {
  check(lib(), [
    ["(first 'hello)", 'h'], ["(last 'hello)", 'o'], ["(bf 'hello)", 'ello'], ["(bl 'hello)", 'hell'],
    ["(butfirst 'a)", '""'], ["(butlast 'a)", '""'],
    ["(first '(a b c))", 'a'], ["(last '(a b c))", 'c'], ["(bf '(a b c))", '(b c)'], ["(bl '(a b c))", '(a b)'],
    ['(first 274)', '2'], ['(last 274)', '4'], ['(bf 274)', '74'], ['(bl 274)', '27'],
    ["(count 'hello)", '5'], ["(count '(a b c))", '3'], ["(count '())", '0'], ['(count 1234)', '4'],
    ["(item 2 '(a b c))", 'b'], ["(item 3 'hello)", 'l'], ['(item 1 274)', '2'],
  ]);
});

test('simply: selector errors are reported MIT-style', () => {
  const i = lib();
  assert.equal(val("(first '())", i), ';Invalid argument to first: ()');
  assert.equal(val("(last '())", i), ';Invalid argument to last: ()');
  assert.equal(val('(bf "")', i), ';Invalid argument to butfirst: ""');
  assert.equal(val("(item 4 '(a b c))", i), ';Invalid argument to item: 4');
  assert.equal(val("(count (lambda (x) x))", i).startsWith(';Invalid argument to count:'), true);
});

test('simply: word and sentence construction', () => {
  check(lib(), [
    ["(word 'a 'b 'c)", 'abc'], ["(word 'a 1)", 'a1'], ['(word 1 2)', '12'], ['(word)', '""'],
    ['(number? (word 1 2))', '#t'], ["(symbol? (word 'a 'b))", '#t'],
    ["(sentence 'a 'b)", '(a b)'], ["(sentence '(a b) 'c '(d e))", '(a b c d e)'], ['(sentence)', '()'],
    ["(se '() 'a '())", '(a)'], ["(se 1 '(2 3))", '(1 2 3)'],
  ]);
  const i = lib();
  assert.equal(val("(word 'a '(b))", i), ';Invalid argument to word: (b)');
  assert.equal(val("(se '((a)) 'b)", i), ';Argument to sentence not a word or sentence: ((a))');
});

test('simply: member?, before?, appearances', () => {
  check(lib(), [
    ["(member? 'b '(a b c))", '#t'], ["(member? 'z '(a b c))", '#f'], ["(member? 2 '(1 2 3))", '#t'],
    ["(member? 'a 'banana)", '#t'], ["(member? 'z 'banana)", '#f'], ["(member? 3 12345)", '#t'],
    ["(before? 'apple 'banana)", '#t'], ["(before? 'b 'a)", '#f'], ['(before? 2 10)', '#t'],
    ["(appearances 'a 'banana)", '3'], ["(appearances 'a '(a b a))", '2'], ["(appearances 3 31353)", '3'],
  ]);
});

test('simply: every, keep, accumulate, repeated', () => {
  check(lib(), [
    ["(every first '(a quick fox))", '(a q f)'],
    ["(every (lambda (w) (se w w)) '(a b))", '(a a b b)'],
    ["(every (lambda (x) (word x x)) 'hi)", '(hh ii)'],
    ["(every first '())", '()'],
    ["(keep even? '(1 2 3 4))", '(2 4)'], ['(keep even? 12345)', '24'], ["(keep even? '(1 3))", '()'],
    ["(keep (lambda (l) (member? l 'aeiou)) 'rhythm)", '""'],
    ["(accumulate + '(1 2 3 4))", '10'], ["(accumulate word '(a b c))", 'abc'], ["(accumulate se '(a b))", '(a b)'],
    ["(accumulate max '(3 9 2))", '9'], ['(accumulate + 1234)', '10'], ["(accumulate - '(10 3 2))", '9'],
    ["(accumulate + '())", '0'], ["(accumulate * '())", '1'], ["(accumulate word '())", '""'], ["(accumulate se '())", '()'],
    ["((repeated (lambda (x) (* x 2)) 3) 1)", '8'], ["((repeated cdr 0) '(a b))", '(a b)'],
  ]);
  assert.match(val("(accumulate max '())", lib()), /^;Can't accumulate empty input with that function:/);
});

test('simply: show, show-line, align', () => {
  const i = lib();
  assert.equal(stdout("(show '(a (b c) \"s\"))", i), '(a (b c) "s")\n');
  assert.equal(stdout("(show-line '(a b 3))", i), 'a b 3\n');
  assert.equal(stdout("(show-line '())", i), '\n');
  check(i, [
    ["(align 'ab 5)", '"ab   "'], ["(align 'abcdefg 4)", '"abcd"'], ['(align 42 6)', '"    42"'],
    ['(align 3.14159 6)', '"3.1416"'], ['(align 123456 3)', '"***"'],
  ]);
});

test('simply: read-line returns a sentence; with a port it is unchanged', () => {
  const i = lib();
  const job = i.startRun('(define a (read-line)) (define b (read-line)) a');
  assert.equal(job.step(1000).state, 'input');
  job.provideInput('  the 3 little   pigs ');
  assert.equal(job.step(1000).state, 'input');
  job.provideInput('');
  assert.equal(job.step(1000).state, 'done');
  assert.equal(job.segments.at(-1).text, '(the 3 little pigs)');
  check(i, [['b', '()'], ['(number? (cadr a))', '#t'],
    ['(read-line (open-input-string "x y\\nz"))', '"x y"']]);
  const eof = i.startRun('(eof-object? (read-line))');
  eof.step(1000);
  eof.provideInput(null);
  eof.step(1000);
  assert.equal(eof.segments.at(-1).text, '#t');
});

test('simply: the core is unaffected by the redefined names', () => {
  const i = lib();
  check(i, [
    ['(string-count "banana" #\\a)', '3'],
    ['(list-index even? (list 1 3 4))', '2'],
    ['(filter odd? (iota 6))', '(1 3 5)'],
    ["(sort '(3 1 2) <)", '(1 2 3)'],
    ["(map (lambda (x) (* x x)) '(1 2 3))", '(1 4 9)'],
  ]);
});

test('simply: word games corpus', () => {
  const i = newInterp();
  assert.equal(run(corpus('simply-1'), i), '', 'should load silently');
  check(i, [
    ["(pigl 'scheme)", 'emeschay'], ["(pigl 'apple)", 'appleay'], ["(pig-sentence '(the quick fox))", '(ethay uickqay oxfay)'],
    ["(plural 'city)", 'cities'], ["(plural 'day)", 'days'], ["(plural 'cat)", 'cats'],
    ["(count-vowels 'education)", '5'], ["(count-vowels 'rhythm)", '0'],
    ["(acronym '(portable network graphics for me))", 'png'], ["(acronym '(a to the))", '""'],
    ["(reverse-words '(a b c))", '(c b a)'], ["(reverse-words '())", '()'],
    ["(longest-word '(a quick brown fox))", 'quick'], ["(initials '(john fitzgerald kennedy))", '(j f k)'],
    ["(reverse-word 'hello)", 'olleh'], ["(palindrome? 'racecar)", '#t'], ["(palindrome? 'hello)", '#f'], ['(palindrome? 12321)', '#t'],
    ["(letter-pairs 'hello)", '(he el ll lo)'], ["(letter-pairs 'a)", '()'],
    ["(ordered? '(a b c))", '#t'], ["(ordered? '(a c b))", '#f'], ["(sort-sentence '(pear apple fig))", '(apple fig pear)'],
    ['(sum-digits 1234)', '10'], ['(digits-ascending? 1349)', '#t'], ['(digits-ascending? 1329)', '#f'],
    ["(count-of 'banana 'a)", '3'], ["((twice (lambda (w) (word w 'x))) 'a)", 'axx'], ["(add-ay-all '(a b))", '(aay bay)'],
    ["(greeting? '(hello there world))", '#t'], ["(greeting? '(goodbye))", '#f'],
    ["(who-is '(my name is ada lovelace))", '(name ada lovelace !)'],
  ]);
});

test('simply: pattern matcher placeholders', () => {
  check(lib(), [
    ["(match '(* me *) '(love me do))", '#t'],
    ["(match '(* me *) '(love you do))", '#f'],
    ["(match '(a * b) '(a b))", '#t'],
    ["(match '(a & b) '(a b))", '#f'],
    ["(match '(a & b) '(a x y b))", '#t'],
    ["(match '(a ? b) '(a b))", '#t'],
    ["(match '(a ? b) '(a x b))", '#t'],
    ["(match '(a ? b) '(a x y b))", '#f'],
    ["(match '(a ! b) '(a b))", '#f'],
    ["(match '(a ! b) '(a x b))", '#t'],
    ["(match '() '())", '#t'],
    ["(match '(&) '())", '#f'],
    ["(match '(*x me *y) '(love me do))", '(x love ! y do !)'],
    ["(match '(*x *y) '(a b))", '(x ! y a b !)'],
    ["(match '(!x ?y !x) '(a b a))", '(x a ! y b !)'],
    ["(match '(!x !x) '(a b))", '#f'],
    ["(match '(!x !x) '(a a))", '(x a !)'],
    ["(match '(a b) '(a b c))", '#f'],
  ]);
});
