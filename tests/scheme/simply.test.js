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

test('simply: selector errors read like the book\'s (capitalised procedure names)', () => {
  const i = lib();
  assert.equal(val("(first '())", i), ';Invalid argument to FIRST: ()');
  assert.equal(val("(last '())", i), ';Invalid argument to LAST: ()');
  assert.equal(val('(bf "")', i), ';Invalid argument to BUTFIRST: ""');
  assert.equal(val("(item 4 '(a b c))", i), ';No such item: 4 (a b c)');
  assert.equal(val("(item 0 '(a b c))", i), ';Invalid first argument to ITEM (must be positive): 0');
  assert.equal(val("(count (lambda (x) x))", i).startsWith(';Invalid argument to COUNT:'), true);
});

test('simply: word and sentence construction', () => {
  check(lib(), [
    ["(word 'a 'b 'c)", 'abc'], ["(word 'a 1)", 'a1'], ['(word 1 2)', '12'], ['(word)', '""'],
    ['(number? (word 1 2))', '#t'], ["(symbol? (word 'a 'b))", '#t'],
    ["(sentence 'a 'b)", '(a b)'], ["(sentence '(a b) 'c '(d e))", '(a b c d e)'], ['(sentence)', '()'],
    ["(se '() 'a '())", '(a)'], ["(se 1 '(2 3))", '(1 2 3)'],
  ]);
  const i = lib();
  assert.equal(val("(word 'a '(b))", i), ';Invalid argument to WORD: (b)');
  assert.equal(val("(se '((a)) 'b)", i), ';Argument to SENTENCE not a word or sentence: ((a))');
});

test('simply: text becomes a number, a symbol or stays a string by the book\'s rules', () => {
  check(lib(), [
    // written the way a number normally is: a number
    ['(number? (word 1 2))', '#t'], ['(number? (word 2 \'|.| 5))', '#t'], ['(number? (word "-" 7))', '#t'],
    ['(number? (word 0))', '#t'], ["(number? (word 0 '|.| 5))", '#t'], ['(bf 274)', '74'],
    // leading zero, leading point, trailing zero in a decimal, minus zero: stays text
    ['(bf 105)', '"05"'], ['(word 0 5)', '"05"'], ["(word '|.| 5)", '".5"'], ["(word 1 '|.| 5 0)", '"1.50"'],
    ['(word "-" 0)', '"-0"'], ['(number? (bf 105))', '#f'], ['(string? (bf 105))', '#t'],
    // a symbol: starts with a letter (either case) or one of ! $ % & * / : < = > ? ~ _ ^
    ["(symbol? (word 'a 'b))", '#t'], ["(symbol? (word 'A 'b))", '#t'], ['(symbol? (word "?" "x"))', '#t'],
    // anything else is a string
    ['(word "(" \'a)', '"(a"'], ['(first "(abc")', '"("'], ['(string? (word 1 \'a))', '#t'],
    // single characters
    ['(first 274)', '2'], ['(first "+5")', '+'], ['(first "-5")', '-'], ['(item 2 "a.b")', '"."'],
  ]);
});

test('simply: the conversion procedures are available', () => {
  check(lib(), [
    ['(string->word "42")', '42'], ['(string->word "cat")', 'cat'], ['(string->word "a b")', '"a b"'],
    ["(word->string 'cat)", '"cat"'], ['(word->string 42)', '"42"'], ['(word->string "x")', '"x"'],
    ['(char->word #\\7)', '7'], ['(char->word #\\a)', 'a'], ['(char->word #\\,)', '","'],
  ]);
});

test('simply: member?, before?, appearances', () => {
  const i = lib();
  check(i, [
    ["(member? 'b '(a b c))", '#t'], ["(member? 'z '(a b c))", '#f'], ["(member? 2 '(1 2 3))", '#t'],
    ["(member? 'a 'banana)", '#t'], ["(member? 'z 'banana)", '#f'], ["(member? 3 12345)", '#t'],
    ["(member? 'a '())", '#f'], ['(member? \'a "")', '#f'],
    // the library compares words loosely: 3 and "3", abc and "abc"
    ['(member? 3 \'("3"))', '#t'], ['(member? \'abc \'("abc"))', '#t'],
    ["(appearances 'a 'banana)", '3'], ["(appearances 'a '(a b a))", '2'], ["(appearances 3 31353)", '3'],
    // alphabetical on the text of the words, so 10 comes before 9
    ["(before? 'apple 'banana)", '#t'], ["(before? 'b 'a)", '#f'], ['(before? 2 10)', '#f'], ['(before? 10 9)', '#t'],
    ["(before? 'a 'a)", '#f'],
  ]);
  assert.equal(val("(member? 'ab 'abc)", i), ';Invalid arguments to MEMBER?: ab abc');
  assert.equal(val("(before? '(a) 'b)", i), ';Invalid first argument to BEFORE? (not a word): (a)');
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
  assert.equal(val("(accumulate max '())", lib()), ";Can't accumulate empty input with that combiner");
});

test('simply: reduce takes (combiner list) and still takes the core\'s three arguments', () => {
  const i = lib();
  check(i, [
    ["(reduce + '(1 2 3))", '6'], ["(reduce - '(10 3 2))", '9'], ["(reduce append '((a) (b) (c)))", '(a b c)'],
    ["(reduce + '(5))", '5'], ["(reduce + '())", '0'], ["(reduce * '())", '1'], ["(reduce append '())", '()'],
    ["(reduce + 0 '(1 2 3))", '6'], ["(reduce + 10 '())", '10'],
  ]);
  assert.equal(val("(reduce max '())", i), ";Can't reduce empty input with that combiner");
});

test('simply: show displays its argument, show-line drops the parentheses, align follows the book', () => {
  const i = lib();
  assert.equal(stdout("(show '(a (b c) \"s\"))", i), '(a (b c) s)\n');
  assert.equal(stdout('(show "hi there")', i), 'hi there\n');
  assert.equal(val('(let ((p (open-output-string))) (show 7 p) (get-output-string p))', i), '"7\\n"');
  assert.equal(stdout("(show-line '(a b 3))", i), 'a b 3\n');
  assert.equal(stdout("(show-line '())", i), '\n');
  assert.equal(val('(show-line 5)', i), ';Invalid argument to SHOW-LINE (not a list): 5');
  check(i, [
    // words are padded on the right; numbers are padded on the left
    ["(align 'ab 5)", '"ab   "'], ['(align 42 6)', '"    42"'], ['(align "hi" 2)', '"hi"'],
    // the third argument is the number of digits after the point
    ['(align 3.14159 8 2)', '"    3.14"'], ['(align 7 5 2)', '" 7.00"'], ['(align -2.5 8 1)', '"    -2.5"'],
    ['(align 0.05 6 2)', '"  0.05"'], ['(align 2.6 6 0)', '"     3"'], ['(align (sqrt 7) 10 5)', '"   2.64575"'],
    // too long: keep what fits and end with a plus sign
    ['(align 12345679 4 0)', '"123+"'], ["(align 'abcdefg 4)", '"abc+"'], ['(align 123456 3)', '"12+"'],
    ['(align 3.14159 4 3)', '"3.1+"'],
    // a fraction that rounds to nothing shows a single 0, not 00
    ['(align 0.4 3)', '"  0"'], ['(align 0 3)', '"  0"'],
  ]);
  assert.equal(val("(align '(a) 3)", i), ';Invalid argument to ALIGN: (a)');
});

test('simply: read-line returns a sentence, read-string the line as a string', () => {
  const i = lib();
  const job = i.startRun('(define a (read-line)) (define b (read-line)) a');
  assert.equal(job.step(1000).state, 'input');
  job.provideInput('  the 3 little   pigs ');
  assert.equal(job.step(1000).state, 'input');
  job.provideInput('');
  assert.equal(job.step(1000).state, 'done');
  assert.equal(job.segments.at(-1).text, '(the 3 little pigs)');
  check(i, [['b', '()'], ['(number? (cadr a))', '#t'],
    ['(read-line (open-input-string "x y\\nz"))', '(x y)'],
    ['(read-line (open-input-string "go 05 1.5 hi,"))', '(go "05" 1.5 "hi,")'],
    ['(read-string (open-input-string "x y\\nz"))', '"x y"'],
    ['(eof-object? (read-line (open-input-string "")))', '#t']]);
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

test('simply: equality and the number predicates stay strict', () => {
  const i = lib();
  check(i, [
    ['(+ 1 2)', '3'], ['(equal? 3 "3")', '#f'], ['(equal? \'abc "abc")', '#f'], ['(equal? \'(a b) \'(a b))', '#t'],
    ['(number? "5")', '#f'], ['(integer? "5")', '#f'], ['(round 7/2)', '4'], ['(member 3 (list 1 2 3))', '(3)'],
  ]);
});

test('simply: text that reads as a number works in arithmetic once the library is loaded', () => {
  const i = lib();
  check(i, [
    // the book's own example of why: a leading-zero result stays text, and still adds up
    ['(+ (bf 105) 1)', '6'], ['(* 2 (word 0 5))', '10'], ['(string? (bf 105))', '#t'],
    ['(+ "5" 1)', '6'], ['(- "10" 3)', '7'], ['(/ "9" 3)', '3'], ['(* "2" "3" "4")', '24'], ['(+ "1.5" 1)', '2.5'],
    ['(< "2" 10)', '#t'], ['(< "1" "2" "3")', '#t'], ['(< "3" "2" "3")', '#f'], ['(= "05" 5)', '#t'], ['(>= 5 "05")', '#t'],
    ['(abs "-4")', '4'], ['(sqrt "16")', '4'], ['(square "6")', '36'], ['(expt "2" 10)', '1024'], ['(max "3" 9 "7")', '9'],
    ['(quotient "17" 5)', '3'], ['(remainder 17 "5")', '2'], ['(modulo "-7" 3)', '2'], ['(even? "04")', '#t'], ['(odd? "7")', '#t'],
    ['(zero? "0")', '#t'], ['(round "7/2")', '4'], ['(exact->inexact "1/2")', '0.5'], ['(number->string "42")', '"42"'],
    ['(list-ref (list 10 20 30) "1")', '20'], ['(vector-ref (vector 10 20 30) "2")', '30'], ['(vector-length (make-vector "3" 0))', '3'],
    ['(let ((v (vector 1 2 3))) (vector-set! v "1" 9) v)', '#(1 9 3)'], ['(item "2" \'(a b c))', 'b'],
  ]);
  // text that is not a number is still the same error as before
  assert.match(val('(+ "abc" 1)', i), /^;The object "abc", passed as the first argument to integer-add/);
  assert.match(val('(+ "" 1)', i), /^;The object "", passed as the first argument to integer-add/);
  assert.match(val('(quotient "1.5" 2)', i), /^;The object "1.5"/);
  assert.match(val('(vector-ref (vector 1) "x")', i), /^;The object "x"/);
});

test('simply: strings-are-numbers switches the rule off and on again', () => {
  const i = lib();
  assert.equal(val('(+ 3 (bf 1075))', i), '78');
  assert.equal(val('(strings-are-numbers #f)', i), 'okay');
  assert.match(val('(+ 3 (bf 1075))', i), /^;The object "075"/);
  assert.equal(val('(strings-are-numbers #t)', i), 'okay');
  assert.equal(val('(+ 3 (bf 1075))', i), '78');
  // asking for the state it is already in says so
  assert.equal(stdout('(strings-are-numbers #t)', i), 'Strings are already numbers\n');
  run('(strings-are-numbers #f)', i);
  assert.equal(stdout('(strings-are-numbers #f)', i), 'Strings are already not numbers\n');
  assert.equal(val('(strings-are-numbers 5)', i), ';Strings-are-numbers: give a #t or a #f');
});

test('simply: text numbers are off on a page that has not loaded the library, and after Reset', () => {
  const fresh = newInterp();
  assert.match(val('(+ "5" 1)', fresh), /^;The object "5", passed as the first argument to integer-add/);
  assert.match(val('(< "2" 10)', fresh), /^;The object "2"/);
  assert.match(val('(list-ref (list 1 2) "1")', fresh), /^;The object "1"/);
  // other libraries do not turn it on
  const sicp = newInterp();
  run('#lang sicp', sicp);
  assert.match(val('(+ "5" 1)', sicp), /^;The object "5"/);
  // loading the word library turns it on for the whole page, other cells included
  run('#lang simply', sicp);
  assert.equal(val('(+ "5" 1)', sicp), '6');
  // a reset is a new interpreter
  assert.match(val('(+ "5" 1)', newInterp()), /^;The object "5"/);
});

test('simply: switching text numbers on does not slow down ordinary arithmetic', () => {
  const fib = '(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))';
  const time = (i) => {
    run(fib, i);
    run('(fib 20)', i);                        // warm up
    const t = performance.now();
    for (let k = 0; k < 3; k++) run('(fib 24)', i);
    return performance.now() - t;
  };
  const plain = Math.min(time(newInterp()), time(newInterp()));
  const withLib = Math.min(time(lib()), time(lib()));
  // wrapping the operators in Scheme the way the book does is about twenty times slower;
  // the native switch should be within noise of the plain engine
  assert.ok(withLib < plain * 2 + 50, `plain ${plain.toFixed(0)} ms, with the library ${withLib.toFixed(0)} ms`);
});

test('simply: loading it does not break the parser-generator read-eval-print loop', () => {
  const i = newInterp();
  run('#lang simply', i);
  assert.equal(run(corpus('eopl-3-let'), i), '', 'the language corpus loads');
  run(`(define rep (sllgen:make-rep-loop "calc> " (lambda (pgm) (value-of-program pgm))
                    (sllgen:make-stream-parser the-lexical-spec the-grammar)))`, i);
  const job = i.startRun('(rep)');
  assert.equal(job.step(1000).state, 'input');
  job.provideInput('let x = 5 in -(x,2)');
  assert.equal(job.step(1000).state, 'input');
  assert.equal(job.segments.map((s) => s.text).join(''), 'calc> #(struct:num-val 3)\ncalc> ');
  job.provideInput(null);
  assert.equal(job.step(1000).state, 'done');
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

test('simply: pattern matcher placeholders (no names: () when it matches, failed when not)', () => {
  check(lib(), [
    ["(match '(* me *) '(go me now))", '()'],
    ["(match '(* me *) '(go you now))", 'failed'],
    ["(match '(mean mr mustard) '(mean mr mustard))", '()'],
    ["(match '(a * b) '(a b))", '()'],
    ["(match '(a & b) '(a b))", 'failed'],
    ["(match '(a & b) '(a x y b))", '()'],
    ["(match '(a ? b) '(a b))", '()'],
    ["(match '(a ? b) '(a x b))", '()'],
    ["(match '(a ? b) '(a x y b))", 'failed'],
    ["(match '(a ! b) '(a b))", 'failed'],
    ["(match '(a ! b) '(a x b))", '()'],
    ["(match '() '())", '()'],
    ["(match '(&) '())", 'failed'],
    ["(match '(a b) '(a b c))", 'failed'],
    ["(match '(a b c) '(a b))", 'failed'],
  ]);
});

test('simply: pattern matcher names, longest match first, repeated names', () => {
  check(lib(), [
    // the result lists each name with its words, every group ended by !
    ["(match '(*start me *end) '(go me now))", '(start go ! end now !)'],
    ["(match '(*start me *end) '(please please me))", '(start please please ! end !)'],
    ["(match '(*start me *end) '(in my life))", 'failed'],
    ["(match '(*x me *y) '(go me now))", '(x go ! y now !)'],
    // an unnamed placeholder leaves no group
    ["(match '(* me *end) '(go me now))", '(end now !)'],
    // when several splits work, the first placeholder takes as many words as possible
    ["(match '(*front *back) '(your mother should know))", '(front your mother should know ! back !)'],
    ["(match '(*x *y) '(a b))", '(x a b ! y !)'],
    ["(match '(*x ?y) '(a b))", '(x a b ! y !)'],
    ["(match '(?x ?y) '(a b))", '(x a ! y b !)'],
    ["(match '(?x *y) '(a b))", '(x a ! y b !)'],
    ["(match '(*x b *y) '(a b c b d))", '(x a b c ! y d !)'],
    // a name used twice must match the same words each time
    ["(match '(!twice !other !twice) '(cry baby cry))", '(twice cry ! other baby !)'],
    ["(match '(!twice !other !twice) '(please please me))", 'failed'],
    ["(match '(!x ?y !x) '(a b a))", '(x a ! y b !)'],
    ["(match '(!x !x) '(a b))", 'failed'],
    ["(match '(!x !x) '(a a))", '(x a !)'],
    ["(match '(*stuff and *stuff) '(a b and a b))", '(stuff a b !)'],
    // ...and only if the second placeholder is allowed to match that many words
    ["(match '(*stuff and !stuff) '(a b and a b))", 'failed'],
    ["(match '(*stuff and *stuff) '(and))", '(stuff !)'],
  ]);
});

test('simply: trace prints calls and values the way the book shows them', () => {
  const i = lib();
  run("(define (double wd) (word wd wd))", i);
  run('(trace double)', i);
  assert.equal(stdout("(double 'frozen)", i), '(double frozen)\nfrozenfrozen\n');
  assert.equal(val("(double 'frozen)", i), 'frozenfrozen');
  // each nesting level adds a bar; a value is printed at the level of its call
  run("(define (downup wd) (if (= (count wd) 1) (se wd) (se wd (downup (bl wd)) wd)))", i);
  run('(trace downup)', i);
  assert.equal(stdout("(downup 'trace)", i), [
    '(downup trace)',
    '|  (downup trac)',
    '|  |  (downup tra)',
    '|  |  |  (downup tr)',
    '|  |  |  |  (downup t)',
    '|  |  |  |  (t)',
    '|  |  |  (tr t tr)',
    '|  |  (tra tr t tr tra)',
    '|  (trac tra tr t tr tra trac)',
    '(trace trac tra tr t tr tra trac trace)',
    '',
  ].join('\n'));
  // several arguments, and a call that starts in the middle of a line of output
  run('(define (add a b) (+ a b))', i);
  run('(trace add)', i);
  assert.equal(stdout('(begin (display "x") (add 1 2))', i), 'x\n(add 1 2)\n3\n');
  // untrace puts the original back; tracing twice does not stack
  run('(trace add)', i);
  assert.equal(stdout('(add 1 2)', i), '(add 1 2)\n3\n');
  run('(untrace add double)', i);
  assert.equal(stdout("(list (add 1 2) (double 'ab))", i), '');
  assert.equal(val("(trace 5)", i).startsWith(';'), true);
});

test('simply: trace of a doubly recursive procedure (operands run left to right here)', () => {
  const i = lib();
  run('(define (fib n) (if (<= n 2) 1 (+ (fib (- n 1)) (fib (- n 2)))))', i);
  run('(trace fib)', i);
  assert.equal(stdout('(fib 4)', i), [
    '(fib 4)',
    '|  (fib 3)',
    '|  |  (fib 2)',
    '|  |  1',
    '|  |  (fib 1)',
    '|  |  1',
    '|  2',
    '|  (fib 2)',
    '|  1',
    '3',
    '',
  ].join('\n'));
});

test('simply: an error inside a traced call does not leave later traces indented', () => {
  const i = lib();
  run("(define (g n) (if (= n 0) (car '()) (g (- n 1))))", i);
  run('(trace g)', i);
  assert.match(run('(g 2)', i), /^out:\(g 2\)\n\|  \(g 1\)\n\|  \|  \(g 0\)\n\|;/);
  run('(define (h) 1)', i);
  run('(trace h)', i);
  assert.equal(stdout('(h)', i), '(h)\n1\n');
});

test('simply: loading it replaces the core trace for the rest of the page, and a fresh page has the core one', () => {
  const core = newInterp();
  run('(define (f x) x) (trace f)', core);
  assert.match(stdout('(f 1)', core), /^\[Entering #\[compound-procedure \d+ f\]/);
  const withLib = lib();
  run('(define (f x) x) (trace f)', withLib);
  assert.equal(stdout('(f 1)', withLib), '(f 1)\n1\n');
});
