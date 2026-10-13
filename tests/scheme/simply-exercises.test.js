// Practice exercises of a word-and-sentence course, solved with the #lang simply library.
// The solutions are in corpora/simply-ex-*.scm (our own code). Expected values are the sample
// outputs the course textbook prints for each task, or, for the "what is printed" kind that
// has no printed answer, values worked out by hand from the definitions.
// Notes on differences that are not bugs: this engine keeps exact fractions where the
// textbook's Scheme printed decimals (the textbook says either form is fine), prints floats
// with their full digits, and is case-sensitive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newInterp, run, val, stdout } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function loaded(...names) {
  const i = newInterp();
  for (const n of names) {
    const out = run(fs.readFileSync(path.join(here, 'corpora', n + '.scm'), 'utf8'), i);
    assert.equal(out, '', n + ' should load silently');
  }
  return i;
}

function library() {
  const i = newInterp();
  assert.equal(run('#lang simply', i), '');
  return i;
}

// [expression, expected]; an expected value written "~1.5" must match as a number within 1e-9
function check(i, pairs) {
  for (const [src, want] of pairs) {
    const got = val(src, i);
    if (want.startsWith('~')) {
      assert.ok(Math.abs(parseFloat(got) - parseFloat(want.slice(1))) < 1e-9, `${src} => ${got}, wanted about ${want.slice(1)}`);
    } else {
      assert.equal(got, want, src);
    }
  }
}

test('exercises, chapter 4: arithmetic procedures with the textbook\'s sample results', () => {
  check(loaded('simply-ex-04-07'), [
    ['(fahrenheit->celsius 212)', '100'], ['(celsius->fahrenheit 100)', '212'],
    ['(fahrenheit->celsius 32)', '0'], ['(celsius->fahrenheit -40)', '-40'],
    ['(fourth-by-multiplying 3)', '81'], ['(fourth-by-squaring 3)', '81'], ['(absolute -7)', '7'], ['(absolute 7)', '7'],
    ['(scientific 7 3)', '7000'],
    ['(scientific 42 -5)', '21/50000'],            // the textbook allows the fraction form
    ['(sci-coefficient 7000)', '7'], ['(sci-exponent 7000)', '3'], ['(sci-exponent 1000)', '3'],
    ['(sci-coefficient 0.00042)', '~4.2'], ['(sci-exponent 0.00042)', '-4'],
    ['(discount 10 5)', '19/2'], ['(discount 29.90 50)', '~14.95'],
    ['(tip 19.98)', '~3.02'], ['(tip 29.23)', '~4.77'], ['(tip 7.54)', '~1.46'],
  ]);
});

test('exercises, chapter 5: words and sentences', () => {
  const i = loaded('simply-ex-04-07');
  check(i, [
    // 5.1: what is printed (worked out by hand from the selectors' definitions)
    ["(sentence 'I '(me mine))", '(I me mine)'], ["(sentence '() '(is empty))", '(is empty)'],
    ["(word '23 '45)", '2345'], ["(se '23 '45)", '(23 45)'], ["(bf 'a)", '""'], ["(bf '(aye))", '()'],
    ["(count (first '(maggie mae)))", '6'], ['(se "" \'() "" \'())', '("" "")'], ['(count (se "" \'() "" \'()))', '2'],
    // 5.2: four procedures built from the sample results
    ["(f1 '(a b c) '(d e f))", '(b c d e)'], ["(f2 '(a b c) '(d e f))", '(b c d e af)'],
    ["(f3 '(a b c) '(d e f))", '(a b c a b c)'], ["(f4 '(a b c) '(d e f))", 'be'],
    // 5.9 (the long expressions)
    [`(se (word (bl (bl (first '(make a)))) (bf (bf (last '(baseball mitt)))))
          (word (first 'with) (bl (bl (bl (bl 'rigidly)))) (first 'held) (first (bf 'stitches))))`, '(matt wright)'],
    [`(se (word (bl (bl 'bring)) 'a (last 'clean))
          (word (bl (last '(baseball hat))) (last 'for) (bl (bl 'very)) (last (first '(sunny days)))))`, '(brian harvey)'],
    // 5.10 - 5.12 (which arguments give a word or a sentence, and when the result is empty)
    ["(bf 'abc)", 'bc'], ["(bf '(a b c))", '(b c)'], ["(last 'abc)", 'c'], ["(last '(a b c))", 'c'],
    ["(bf 'x)", '""'], ["(bl 'x)", '""'], ["(bf '(x))", '()'], ["(bl '(x))", '()'],
    // 5.14 - 5.21
    ["(third '(a b c d))", 'c'], ["(third 'hello)", 'l'], ["(first-two 'ambulatory)", 'am'],
    ["(two-first 'ada 'lovelace)", 'al'], ["(two-first-sent '(ada lovelace))", 'al'],
    ["(knight '(david wessel))", '(sir david wessel)'],
    ["(insert-and '(john bill wayne fred joey))", '(john bill wayne fred and joey)'],
    ["(middle-names '(james paul mccartney))", '(paul)'], ["(middle-names '(john ronald raoul tolkien))", '(ronald raoul)'],
    ["(middle-names '(bugs bunny))", '()'], ["(middle-names '(peter blair denis bernard noone))", '(blair denis bernard)'],
    ["(query '(you are experienced))", '(are you experienced?)'],
    ["(query '(i should have known better))", '(should i have known better?)'],
  ]);
  // 5.18: a parameter called word hides the procedure word
  run("(define (ends word) (word (first word) (last word)))", i);
  assert.match(val("(ends 'john)", i), /^;The object john is not applicable/);
  // quoted text with punctuation stays one word (a string)
  assert.equal(val('(count \'("can\'t" buy me love))', i), '4');
});

test('exercises, chapter 6: predicates, cond, and and or', () => {
  const i = loaded('simply-ex-04-07');
  check(i, [
    // 6.1 and 6.2: what is printed
    ["(cond ((= 3 4) '(this boy)) ((< 2 5) '(nowhere man)) (else '(two of us)))", '(nowhere man)'],
    ['(cond (empty? 3) (square 7) (else 9))', '3'],
    [`(let () (define (third-person-singular verb)
                (cond ((equal? verb 'be) 'is) ((equal? (last verb) 'o) (word verb 'es)) (else (word verb 's))))
              (third-person-singular 'go))`, 'goes'],
    ['(or #f #f #f #t)', '#t'], ['(and #f #f #f #t)', '#f'], ['(or (= 2 3) (= 4 3))', '#f'], ['(not #f)', '#t'],
    ['(or (not (= 2 3)) (= 4 3))', '#t'], ['(or (and (= 2 3) (= 3 3)) (and (< 2 3) (< 3 4)))', '#t'],
    // 6.3, 6.4
    ['(sign -5)', 'negative'], ['(sign 0)', 'zero'], ['(sign 3)', 'positive'],
    ["(utensil 'chinese)", 'chopsticks'], ["(utensil 'italian)", 'fork'],
    // 6.5 - 6.11 with the textbook's samples
    ["(european-time '(8 am))", '8'], ["(european-time '(4 pm))", '16'], ["(american-time 21)", '(9 pm)'],
    ["(american-time 12)", '(12 pm)'], ["(european-time '(12 am))", '24'], ["(european-time '(12 pm))", '12'],
    ["(american-time 24)", '(12 am)'], ["(american-time 5)", '(5 am)'],
    ['(teen? 13)', '#t'], ['(teen? 19)', '#t'], ['(teen? 12)', '#f'], ['(teen? 20)', '#f'],
    ["(type-of '(getting better))", 'sentence'], ["(type-of 'revolution)", 'word'], ['(type-of (= 3 3))', 'boolean'],
    ['(type-of 17)', 'number'], ["(type-of '())", 'sentence'],
    ["(indef-article 'beatle)", '(a beatle)'], ["(indef-article 'album)", '(an album)'],
    ["(thismany 1 'partridge)", '(1 partridge)'], ["(thismany 3 'french-hen)", '(3 french-hens)'],
    ["(sort2 '(5 7))", '(5 7)'], ["(sort2 '(7 5))", '(5 7)'],
    ['(valid-date? 10 4 1949)', '#t'], ['(valid-date? 20 4 1776)', '#f'], ['(valid-date? 5 0 1992)', '#f'],
    ['(valid-date? 2 29 1900)', '#f'], ['(valid-date? 2 29 2000)', '#t'], ['(valid-date? 9 31 2001)', '#f'],
    // 6.12 - 6.14
    ["(plural 'boy)", 'boys'], ["(plural 'city)", 'cities'], ["(plural 'box)", 'boxes'], ["(plural 'church)", 'churches'],
    ["(plural 'cat)", 'cats'],
    ["(greet '(john lennon))", '(hello john)'], ["(greet '(dr marie curie))", '(hello dr curie)'],
    ["(greet '(dr martin luther king jr))", '(hello dr king)'], ["(greet '(queen elizabeth))", '(hello your majesty)'],
    ["(greet '(david livingstone))", '(dr livingstone i presume?)'],
    ['(describe-time 45)', '(45 seconds)'], ['(describe-time 930)', '(15.5 minutes)'],
    ['(describe-time 30000000000)', '(9.506426344208686 centuries)'],
  ]);
});

test('exercises, chapter 7: let', () => {
  const i = loaded('simply-ex-04-07');
  check(i, [
    ["(gertrude 'rose)", '(a rose is a rose is a rose)'],
    ["(gertrude 'iguana)", '(an iguana is an iguana is an iguana)'],
    ['pi-sentence', '(pi is 3.14159 but pie is lemon meringue)'],
    ["(superlative 'dumb 'exercise)", '(dumbest exercise)'],
    ['(sum-square 3 4)', '25'],         // inside the let, + multiplies and * adds, so this is a squared plus b squared
  ]);
});

test('exercises, chapter 8: every, keep, accumulate, repeated', () => {
  const i = loaded('simply-ex-08-09');
  check(i, [
    // 8.1: what is printed (worked out by hand)
    ["(every last '(algebra purple spaghetti tomato gnu))", '(a e i o u)'], ["(keep number? '(one two three four))", '()'],
    ["(accumulate * '(6 7 13 0 9 42 17))", '0'], ["(member? 'h (keep vowel? '(t h r o a t)))", '#f'],
    ["(every square (keep even? '(87 4 7 12 0 5)))", '(16 144 0)'],
    ["(accumulate word (keep vowel? (every first '(and i love her))))", 'ai'],
    ['((repeated square 0) 25)', '25'], ["(every (repeated bl 2) '(good day sunshine))", '(go d sunshi)'],
    // 8.2: the blanks (keep, every, first, every last, accumulate word, every +, accumulate +)
    ["(keep vowel? 'birthday)", 'ia'], ["(every first '(golden slumbers))", '(g s)'], ["(first '(golden slumbers))", 'golden'],
    ["(every last '(little child))", '(e d)'], ["(accumulate word (every last '(little child)))", 'ed'],
    ["(every + '(2 3 4 5))", '(2 3 4 5)'], ["(accumulate + '(2 3 4 5))", '14'],
    // 8.3: the functions described, applied
    ["((repeated sqrt 3) 256)", '2'], ["((repeated first 2) '((a b) c))", 'a'], ["((repeated (repeated bf 3) 2) 'abcdefgh)", 'gh'],
    // 8.4, 8.5
    ['(choose-members ends-vowel?)', '(george ringo)'], ['(choose-members even-count?)', '(john paul george)'],
    ['(transform-members amazify)', '(the-amazing-john the-amazing-paul the-amazing-george the-amazing-ringo)'],
    ['(transform-members butfirst)', '(ohn aul eorge ingo)'],
    // 8.6 - 8.8
    ["(spell-out 'cab)", '(charlie alpha bravo)'], ["(letter-count '(fixing a hole))", '11'], ["(letter-count '())", '0'],
    ["(exaggerate '(i ate 3 potstickers))", '(i ate 6 potstickers)'],
    ["(exaggerate '(the chow fun is good here))", '(the chow fun is great here)'],
    // 8.9: procedures that hand a sentence back (accumulate with a single word gives that word, not a sentence)
    ["(every keep-everything-every '(a b c))", '(a b c)'], ["(keep keep-everything-keep '(a b c))", '(a b c)'],
    ["(accumulate keep-everything-accumulate '(a b c))", '(a b c)'], ["(accumulate keep-everything-accumulate '(a))", 'a'],
    // 8.10 - 8.14
    ["(true-for-all? even? '(2 4 6 8))", '#t'], ["(true-for-all? even? '(2 6 3 4))", '#f'], ["(true-for-all? even? '())", '#t'],
    ["(gpa '(A A+ B+ B))", '~3.665'], ["(gpa '(A A))", '4'],
    ["(count-ums '(today um we are going to um talk about functional um programming))", '3'],
    ["(phone-unspell 'popcorn)", '7672676'], ["(subword 'polythene 5 8)", 'then'], ["(subword 'polythene 1 4)", 'poly'],
  ]);
});

test('exercises, chapter 9: lambda', () => {
  const i = loaded('simply-ex-08-09');
  check(i, [
    // 9.1
    ['((lambda (x) (+ (* x 3) 4)) 10)', '34'],
    ["(every (lambda (wd) (word (last wd) (bl wd))) '(any time at all))", '(yan etim ta lal)'],
    // 9.2, 9.3, 9.4
    ["(second-explicit '(a b c))", 'b'], ['((make-adder 5) 3)', '8'], ["(let-it-be '(a b c))", 'c'],
    ["(who '(sells out))", '(pete sells out roger sells out john sells out keith sells out)'],
    // 9.5 - 9.16 with the textbook's samples
    ["(prepend-every 's '(he aid he aid))", '(she said she said)'],
    ["(prepend-every 'anti '(dote pasto gone body))", '(antidote antipasto antigone antibody)'],
    ["((sentence-version first) '(if i fell))", '(i i f)'], ["((sentence-version square) '(8 2 4 6))", '(64 4 16 36)'],
    ["(letterwords 'o '(got to get you into my life))", '(got to you into)'],
    ["(hang 'potsticker 'etaoi)", '_ot_ti__e_'], ["(hang 'abc 'xyz)", '___'],
    ["(common-words '(a b c d) '(c d e))", '(c d)'], ["(common-words '(a b) '(c d))", '()'],
    ["(count-appearances 'a '(a b a c a))", '3'],
    ["(unabbrev '(john 1 wayne fred 4) '(bill hank kermit joey))", '(john bill wayne fred joey)'],
    ["(unabbrev '(i 3 4 tell 2) '(do you want to know a secret?))", '(i want to tell you)'],
    ["(first-last '(california ohio nebraska alabama alaska massachusetts))", '(ohio alabama alaska)'],
    ['((compose sqrt abs) -25)', '5'], ["((compose first bf) '(higher order function))", 'order'],
    ["(substitute 'maybe 'yeah '(she loves him yeah yeah yeah))", '(she loves him maybe maybe maybe)'],
    ['((type-check sqrt number?) 16)', '4'], ["((type-check sqrt number?) 'sarsaparilla)", '#f'],
    ['((aplize sqrt) 36)', '6'], ["((aplize sqrt) '(1 100 25 16))", '(1 10 5 4)'],
    // 9.17
    ["(keep-via-every even? '(1 2 3 4))", '(2 4)'], ["(keep-via-every even? '(1 3))", '()'],
  ]);
  // 9.1: a procedure called with the wrong number of arguments
  assert.match(val('((lambda (x) (+ x 3)) 10 15)', i), /^;The procedure .* has been called with 2 arguments; it requires exactly 1 argument/);
});

test('exercises, chapter 11: recursion on sentences and words', () => {
  const i = loaded('simply-ex-11-13');
  check(i, [
    ["(downup4 'toad)", '(toad toa to t to toa toad)'],
    ["(count-ums '(today um we are going to um talk about the combining um method))", '3'], ["(count-ums '())", '0'],
    ["(phone-unspell 'popcorn)", '7672676'], ["(phone-unspell 'quiz)", '7849'],
    ["(initials '(if i needed someone))", '(i i n s)'],
    ['(countdown 10)', '(10 9 8 7 6 5 4 3 2 1 blastoff!)'], ['(countdown 3)', '(3 2 1 blastoff!)'], ['(countdown 0)', '(blastoff!)'],
    ["(copies 8 'spam)", '(spam spam spam spam spam spam spam spam)'], ["(copies 0 'x)", '()'],
  ]);
});

test('exercises, chapter 12: more recursion', () => {
  const i = loaded('simply-ex-11-13');
  check(i, [
    ["(addup '(1 2 3 4))", '10'], ["(addup '())", '0'], ["(addup '(5))", '5'],
    ["(acronym '(portable network graphics))", 'png'], ["(acronym '(a))", 'a'],
    ['(factorial-minus-one 5)', '0'],                      // 12.3: moving the base case to -1 makes every answer 0
    ["(exaggerate '(i ate 3 potstickers))", '(i ate 6 potstickers)'],
    ["(exaggerate '(the chow fun is good here))", '(the chow fun is great here)'],
    ["(gpa '(A A+ B+ B))", '~3.665'],
    ['(spell-number 1971)', '(one nine seven one)'], ['(spell-number 0)', '(zero)'],
    ["(numbers '(76 trombones and 110 cornets))", '(76 110)'], ["(numbers '(a b))", '()'],
    ["(real-words '(the band are a group from paris))", '(band are group from paris)'],
    ["(remove 'the '(the song love of the loved by the band))", '(song love of loved by band)'],
    ["(my-count 'hello)", '5'], ["(my-count '(a b c))", '3'], ["(my-count '())", '0'],
    ["(arabic 'MCMLXXI)", '1971'], ["(arabic 'MLXVI)", '1066'], ["(arabic 'mcmxcix)", '1999'], ["(arabic 'IV)", '4'],
    // 12.13: a year is 365.25 days in the textbook's sample
    ['(describe-time-plural 22222)', '(6 hours 10 minutes 22 seconds)'],
    ['(describe-time-plural 4967189641)', '(1 centuries 57 years 20 weeks 6 days 8 hours 54 minutes 1 seconds)'],
    ['(describe-time 4967189641)', '(1 century 57 years 20 weeks 6 days 8 hours 54 minutes 1 second)'],
    ['(describe-time 3661)', '(1 hour 1 minute 1 second)'], ['(describe-time 0)', '()'],
  ]);
});

test('exercises, chapter 13: tracing, and a procedure that never finishes', () => {
  const i = loaded('simply-ex-11-13');
  check(i, [
    ["(explode 'dynamite)", '(d y n a m i t e)'],
    ["(pigl 'throughout)", 'oughoutthray'], ["(pigl 'prawn)", 'awnpray'],
    ['(factorial 6)', '720'],
  ]);
  // 13.1: the trace of (explode 'ape): four calls, the last one on the empty word
  run('(trace explode)', i);
  assert.equal(stdout("(explode 'ape)", i), [
    '(explode ape)',
    '|  (explode pe)',
    '|  |  (explode e)',
    '|  |  |  (explode )',
    '|  |  |  ()',
    '|  |  (e)',
    '|  (p e)',
    '(a p e)',
    ''].join('\n'));
  // 13.2: four specialists for (pigl 'throughout)
  run('(trace pigl)', i);
  const tr = stdout("(pigl 'throughout)", i);
  assert.equal((tr.match(/\(pigl /g) || []).length, 4);
  // 13.3: the first downup has no base case
  assert.equal(val("(downup-no-base 'toe)", i), ';Invalid argument to BUTLAST: ""');
  // 13.4: a recursion that never finishes is stopped by the depth limit, and the next expression still runs
  assert.equal(val('(forever 5)', i), ';Aborting!: maximum recursion depth exceeded');
  assert.equal(val('(factorial 5)', i), '120');
});

test('exercises, chapter 14: common patterns of recursion', () => {
  const i = loaded('simply-ex-14-15');
  check(i, [
    ["(remove-once 'morning '(good morning good morning))", '(good good morning)'],
    ["(up 'town)", '(t to tow town)'],
    ["(remdup '(ob la di ob la da))", '(di ob la da)'],       // the textbook accepts either copy being kept
    ["(odds '(i lost my little girl))", '(i my girl)'], ["(odds '(a))", '(a)'], ["(odds '())", '()'],
    ["(letter-count '(fixing a hole))", '11'],
    ["(my-member? 'b '(a b c))", '#t'], ["(my-member? 'z '(a b c))", '#f'], ["(my-member? 'b 'abc)", '#t'],
    ["(differences '(4 23 9 87 6 12))", '(19 -14 78 -81 6)'], ["(differences '(5))", '()'],
    ["(expand '(4 calling birds 3 french hens))", '(calling calling calling calling birds french french french hens)'],
    ["(expand '(the 7 samurai))", '(the samurai samurai samurai samurai samurai samurai samurai)'],
    ["(location 'me '(you never give me your money))", '4'], ["(location 'zzz '(a b))", '#f'],
    ["(count-adjacent-duplicates '(y a b b a d a b b a d o o))", '3'], ["(count-adjacent-duplicates '(yeah yeah yeah))", '2'],
    ["(remove-adjacent-duplicates '(y a b b a d a b b a d o o))", '(y a b a d a b a d o)'],
    ["(remove-adjacent-duplicates '(yeah yeah yeah))", '(yeah)'],
    ["(progressive-squares? '(3 9 81 6561))", '#t'], ["(progressive-squares? '(25 36 49 64))", '#f'],
    ["(pigl 'frzzmlpt)", 'frzzmlptay'], ["(pigl 'throughout)", 'oughoutthray'], ["(pigl 'apple)", 'appleay'],
    ["(same-shape? '(the fool on the hill) '(you like me too much))", '#t'],
    ["(same-shape? '(the fool on the hill) '(and your bird can sing))", '#f'],
    ["(merge '(4 7 18 40 99) '(3 6 9 12 24 36 50))", '(3 4 6 7 9 12 18 24 36 40 50 99)'], ["(merge '() '(1 2))", '(1 2)'],
    // 14.16: cases that expose likely failures (ends with a vowel, two vowels in a row, three in a row)
    ["(syllables 'soaring)", '2'], ["(syllables 'queue)", '1'], ["(syllables 'banana)", '3'], ["(syllables 'free)", '1'],
    ["(syllables 'beautiful)", '3'], ["(syllables 'rhythm)", '0'], ["(syllables 'idea)", '2'],
  ]);
});

test('exercises, chapter 15: advanced recursion', () => {
  const i = loaded('simply-ex-14-15');
  check(i, [
    ['(to-binary 9)', '1001'], ['(to-binary 23)', '10111'], ['(to-binary 0)', '0'], ['(to-binary 255)', '11111111'],
    // 15.2: a palindrome reads the same backward letter by letter, spaces ignored
    ["(palindrome? '(flee to me remote elf))", '#t'], ["(palindrome? '(flee to me remote control))", '#f'],
    ["(palindrome? '())", '#t'], ["(palindrome? '(a))", '#t'],
    ["(substrings 'bat)", '(b ba bat a at t)'], ["(count (substrings 'brat))", '10'],
    ["(substring? 'ssip 'mississippi)", '#t'], ["(substring? 'misip 'mississippi)", '#f'],
    ["(substring? 'ppi 'mississippi)", '#t'], ["(substring? 'x 'mississippi)", '#f'],
    // 15.5: 7 digits with three letters each is 2187 spellings; the textbook shows the first and last
    ['(count (phone-spell 2235766))', '2187'], ['(first (phone-spell 2235766))', 'aadjpmm'],
    ['(last (phone-spell 2235766))', 'ccflsoo'], ['(phone-spell 23)', '(ad ae af bd be bf cd ce cf)'],
    ["(unscramble '(this is the roach the gladiator killed))", '(this is the gladiator that killed the roach)'],
    ["(unscramble '(this is the rat the cat the dog the boy the girl saw owned chased bit))",
      '(this is the girl that saw the boy that owned the dog that chased the cat that bit the rat)'],
  ]);
});

test('exercises, chapter 16: designing patterns for the pattern matcher', () => {
  const i = library();
  const matches = (pattern, sentence) => val(`(match '(${pattern}) '(${sentence}))`, i) !== 'failed';
  // 16.1: a sentence containing the word c at least three times
  assert.ok(matches('* c * c * c *', 'a c b c d c'));
  assert.ok(matches('* c * c * c *', 'c c c'));
  assert.ok(matches('* c * c * c *', 'c c c c'));
  assert.ok(!matches('* c * c * c *', 'c a c'));
  // 16.2: two copies of a smaller sentence
  assert.equal(val("(match '(*x *x) '(a b a b))", i), '(x a b !)');
  assert.equal(val("(match '(*x *x) '(a b a c))", i), 'failed');
  assert.equal(val("(match '(*x *x) '())", i), '(x !)');
  // 16.3: no more than three words; 16.4: at least three words
  for (const [s, n] of [['', 0], ['a', 1], ['a b', 2], ['a b c', 3], ['a b c d', 4], ['a b c d e', 5]]) {
    assert.equal(matches('? ? ?', s), n <= 3, `at most three: ${s}`);
    assert.equal(matches('& & &', s), n >= 3, `at least three: ${s}`);
  }
  // 16.5: (*x *y *y *x) matches length 2 and 4, never length 3
  assert.equal(val("(match '(*x *y *y *x) '(a a))", i), '(x a ! y !)');
  assert.equal(matches('*x *y *y *x', 'a b c'), false);
  assert.equal(val("(match '(*x *y *y *x) '(a b b a))", i), '(x a ! y b !)');
  // 16.6: (*x *y &y &x): the later & placeholders need at least one word, so x and y both have
  // at least one word and the shortest match has four; lengths 2 and 3 cannot match
  assert.equal(matches('*x *y &y &x', 'a a'), false);
  assert.equal(matches('*x *y &y &x', 'a b c'), false);
  assert.equal(val("(match '(*x *y &y &x) '(a b b a))", i), '(x a ! y b !)');
});

test('exercises, chapter 16: the matcher agrees with a brute-force search on every short sentence', () => {
  const i = library();
  // an independent oracle: does the sentence split as X Y Y X (any X, any Y; or Y non-empty for the & form)?
  const splits = (s, minX, minY) => {
    for (let x = minX; x * 2 <= s.length; x++) {
      for (let y = minY; x * 2 + y * 2 <= s.length; y++) {
        if (x * 2 + y * 2 !== s.length) continue;
        const X = s.slice(0, x), Y = s.slice(x, x + y), Y2 = s.slice(x + y, x + 2 * y), X2 = s.slice(x + 2 * y);
        if (X.join() === X2.join() && Y.join() === Y2.join()) return true;
      }
    }
    return false;
  };
  const all = [];
  const gen = (prefix, n) => { all.push(prefix); if (n === 0) return; for (const w of ['a', 'b']) gen([...prefix, w], n - 1); };
  gen([], 6);
  assert.equal(all.length, 127);
  let hits = 0;
  for (const s of all) {
    const text = s.join(' ');
    const star = val(`(match '(*x *y *y *x) '(${text}))`, i) !== 'failed';
    const amp = val(`(match '(*x *y &y &x) '(${text}))`, i) !== 'failed';
    assert.equal(star, splits(s, 0, 0), `*x *y *y *x on (${text})`);
    assert.equal(amp, splits(s, 1, 1), `*x *y &y &x on (${text})`);
    if (star) hits++;
  }
  assert.ok(hits > 20);
  // 16.7: the sentences of length six or less that start with a b a and match (*x *y *y *x), over the words a and b
  const wanted = all.filter((s) => s.length >= 3 && s.slice(0, 3).join(' ') === 'a b a' && splits(s, 0, 0));
  const found = all.filter((s) => s.length >= 3 && s.slice(0, 3).join(' ') === 'a b a'
    && val(`(match '(*x *y *y *x) '(${s.join(' ')}))`, i) !== 'failed');
  assert.deepEqual(found, wanted);
});

test('exercises, chapter 16: odd inputs the exercises ask about', () => {
  const i = library();
  // 16.10: a * inside the sentence is just a word
  assert.equal(val("(match '(*x me *y) '(love * me do))", i), '(x love * ! y do !)');
  assert.equal(val("(match '(a !) '(a *))", i), '()');
  // 16.19: a ! inside the sentence. The textbook's own program stores matches in a sentence whose
  // entries end in !, so it answers failed here (the exercise is about that flaw); this one keeps
  // matches in a list and answers correctly.
  assert.equal(val("(match '(?x is *y !x) '(! is an exclamation point !))", i), '(x ! ! y an exclamation point !)');
  // an unnamed placeholder is never stored
  assert.equal(val("(match '(* me *) '(love * me do))", i), '()');
});

test('exercises, chapter 17: lists', () => {
  const i = loaded('simply-ex-17-19');
  const people = "'(Rod Chris Colin Hugh Paul)";
  const table = "'((Rod Argent) (Chris White) (Colin Blunstone) (Hugh Grundy) (Paul Atkinson))";
  check(i, [
    // 17.1: what is printed (case is kept: this engine is case-sensitive)
    [`(car ${people})`, 'Rod'], [`(cadr ${people})`, 'Chris'], [`(cdr ${people})`, '(Chris Colin Hugh Paul)'],
    ["(cons '(Rod Argent) '(Chris White))", '((Rod Argent) Chris White)'],
    ["(append '(Rod Argent) '(Chris White))", '(Rod Argent Chris White)'],
    ["(list '(Rod Argent) '(Chris White))", '((Rod Argent) (Chris White))'],
    [`(caadr ${table})`, 'Chris'], [`(assoc 'Colin ${table})`, '(Colin Blunstone)'], [`(assoc 'Argent ${table})`, '#f'],
    // 17.2
    ["(f1 '(a b c) '(d e f))", '((b c d))'], ["(f2 '(a b c) '(d e f))", '((b c) e)'],
    ["(f3 '(a b c) '(d e f))", '(a b c a b c)'], ["(f4 '(a b c) '(d e f))", '((a d) (b c e f))'],
    // 17.3: map returns a list of procedures; applying them shows what they add
    ["(map (lambda (p) (p 10)) (map (lambda (x) (lambda (y) (+ x y))) '(1 2 3 4)))", '(11 12 13 14)'],
    // 17.4: the helper builds the list backward
    ["(mystery '(a b c d))", '(d c b a)'], ["(mystery '())", '()'],
    // 17.5 - 17.10: the builtins rebuilt
    ['(my-max 3 9 2)', '9'], ['(my-max 5)', '5'], ["(my-append '(a b) '(c) '() '(d e))", '(a b c d e)'], ['(my-append)', '()'],
    ["(my-sentence 'a '(b c) 'd)", '(a b c d)'], ['(my-sentence)', '()'],
    ["(my-list-member 'c '(a b c d))", '(c d)'], ["(my-list-member 'z '(a b))", '#f'],
    ["(my-list-ref '(a b c) 2)", 'c'], ["(my-length '(a b c))", '3'], ["(my-length '())", '0'],
    // 17.11 - 17.14
    ["(before-in-list? '(back in the ussr) 'in 'ussr)", '#t'], ["(before-in-list? '(back in the ussr) 'the 'back)", '#f'],
    ["(before-in-list? '(back in the ussr) 'in 'zzz)", '#f'],
    ["(flatten-sentence '(((a b) c (d e)) (f g) ((((h))) (i j) k)))", '(a b c d e f g h i j k)'],
    ["(deep-count '(a (b c) ((d))))", '4'], ["(deep-count-original '(a (b c) ((d))))", '4'], ["(deep-count '())", '0'],
    ["(branch '(3) '((a b) (c d) (e f) (g h)))", '(e f)'], ["(branch '(3 2) '((a b) (c d) (e f) (g h)))", 'f'],
    ["(branch '(2 3 1 2) '((a b) ((c d) (e f) ((g h) (i j)) k) (l m)))", 'h'],
    // 17.16
    ["(valid-infix? '(4 + 3 * (5 - 2)))", '#t'], ["(valid-infix? '(4 + 3 * (5 2)))", '#f'],
    ["(valid-infix? '(4 +))", '#f'], ["(valid-infix? '(4))", '#t'], ["(valid-infix? '(+ 4))", '#f'],
  ]);
  assert.match(val("(car 'Rod)", i), /^;The object Rod, passed as the first argument to car/);
  // the rebuilt procedures agree with the real ones
  check(i, [
    ["(equal? (my-append '(1 2) '(3)) (append '(1 2) '(3)))", '#t'],
    ["(equal? (my-list-member 'b '(a b c)) (member 'b '(a b c)))", '#t'],
    ["(= (my-length '(1 2 3 4)) (length '(1 2 3 4)))", '#t'],
    ["(equal? (my-list-ref '(a b c d) 3) (list-ref '(a b c d) 3))", '#t'],
    ["(= (my-max 4 8 1 6) (max 4 8 1 6))", '#t'],
    ["(equal? (my-sentence 'x '(y) 'z) (sentence 'x '(y) 'z))", '#t'],
  ]);
});

test('exercises, chapter 18: trees', () => {
  const i = loaded('simply-ex-17-19');
  const tree = "(make-node 'a (list (make-node 'b '()) (make-node 'c (list (make-node 'd '())))))";
  check(i, [
    [`(datum ${tree})`, 'a'], [`(map datum (children ${tree}))`, '(b c)'],
    [`(depth ${tree})`, '3'], ["(depth (make-node 'x '()))", '1'], [`(count-nodes ${tree})`, '4'],
    ["(prune (make-node 'a '()))", '#f'], [`(prune ${tree})`, '(a (c))'],
    ["(compute (parse-scheme '(* (+ 4 3) 2)))", '14'], ['(compute (parse-scheme 7))', '7'],
    ["(compute (parse-scheme '(- (* 3 3) (/ 8 2))))", '5'],
  ]);
});

test('exercises, chapter 19: building every, keep, accumulate, repeated and friends', () => {
  const i = loaded('simply-ex-17-19');
  check(i, [
    // 19.1: every combines the results into one sentence, map keeps them as separate lists
    ["(every cdr '((john lennon) (paul mccartney) (george harrison) (ringo starr)))", '(lennon mccartney harrison starr)'],
    ["(map cdr '((john lennon) (paul mccartney)))", '((lennon) (mccartney))'],
    ["(every cadr '((john lennon) (paul mccartney)))", '(lennon mccartney)'],
    // 19.2: keep rebuilt; a word gives a word, a sentence gives a sentence
    ["(my-keep even? '(1 2 3 4))", '(2 4)'], ['(my-keep even? 12345)', '24'], ["(my-keep vowel? 'birthday)", 'ia'],
    ["(my-keep vowel? 'rhythm)", '""'], ["(my-keep even? '(1 3))", '()'],
    ["(equal? (my-keep even? '(1 2 3 4)) (keep even? '(1 2 3 4)))", '#t'],
    // 19.3, 19.4
    ["(three-arg-accumulate + 0 '(4 5 6))", '15'], ["(three-arg-accumulate + 0 '())", '0'],
    ["(three-arg-accumulate cons '() '(a b c d e))", '(a b c d e)'],
    ["(left-accumulate - '(2 3 4 5))", '-10'], ["(accumulate - '(2 3 4 5))", '-2'], ["(left-accumulate + '(2 3 4 5))", '14'],
    ["(left-accumulate word '(a b c))", 'abc'],
    // 19.5 - 19.8
    ["(true-for-all? even? '(2 4 6 8))", '#t'], ["(true-for-all? even? '(2 6 3 4))", '#f'],
    ["(true-for-any-pair? equal? '(a b c b a))", '#f'], ["(true-for-any-pair? equal? '(a b c c d))", '#t'],
    ["(true-for-any-pair? < '(20 16 5 8 6))", '#t'],
    ["(true-for-all-pairs? equal? '(a b c c d))", '#f'], ["(true-for-all-pairs? equal? '(a a a a a))", '#t'],
    ["(true-for-all-pairs? < '(20 16 5 8 6))", '#f'], ["(true-for-all-pairs? < '(3 7 19 22 43))", '#t'],
    ["(true-for-all-pairs-via-any? equal? '(a a a a a))", '#t'], ["(true-for-all-pairs-via-any? < '(3 7 19 22 43))", '#t'],
    ["(true-for-all-pairs-via-any? < '(20 16 5 8 6))", '#f'],
    // 19.9: sort with a predicate, on numbers and on words; the builtin sort agrees
    ["(my-sort '(4 23 7 5 16 3) <)", '(3 4 5 7 16 23)'], ["(my-sort '(4 23 7 5 16 3) >)", '(23 16 7 5 4 3)'],
    ["(my-sort '(john paul george ringo) before?)", '(george john paul ringo)'], ["(my-sort '() <)", '()'],
    ["(equal? (my-sort '(4 23 7 5 16 3) <) (sort '(4 23 7 5 16 3) <))", '#t'],
    // 19.10 - 19.13
    ["(datum (tree-map square (make-node 3 (list (make-node 4 '())))))", '9'],
    ["(map datum (children (tree-map square (make-node 3 (list (make-node 4 '()))))))", '(16)'],
    ['((my-repeated square 2) 3)', '81'], ["((my-repeated bf 3) 'abcdef)", 'def'], ['((my-repeated square 0) 7)', '7'],
    ["(tree-reduce + (make-node 3 (list (make-node 4 '()) (make-node 7 '()) (make-node 2 (list (make-node 3 '()) (make-node 8 '()))))))", '27'],
    ["(deep-reduce word '(r ((a (m b) (l)) (e (r)))))", 'rambler'], ["(deep-reduce + '(1 (2 3) ((4))))", '10'],
  ]);
});

// runs source, answering each request for input with the next scripted line (then end of input)
function runScripted(i, src, inputs) {
  const job = i.startRun(src);
  let k = 0, out = '', value = null, error = null;
  for (let guard = 0; guard < 10000; guard++) {
    const r = job.step(1000);
    for (const s of r.segments) {
      if (s.kind === 'stdout') out += s.text;
      else if (s.kind === 'value') value = s.text;
      else if (s.kind === 'error') error = s.text;
    }
    if (r.state === 'input') { job.provideInput(k < inputs.length ? inputs[k++] : null); continue; }
    if (r.state !== 'running') break;
  }
  return { out, value, error };
}

test('exercises, chapter 20: input and output', () => {
  const i = loaded('simply-ex-20-23');
  // 20.1: the second clause prints its message and returns its value
  const clause = "(cond ((= 2 3) (show '(lady madonna)) '(i call your name)) ((< 2 3) (show '(the night before)) '(hello little girl)) (else '(p.s. i love you)))";
  assert.equal(stdout(clause, i), '(the night before)\n');
  assert.equal(val(clause, i), '(hello little girl)');
  // 20.2, 20.3: newline prints a line break and returns nothing worth printing; show rebuilt from display and newline
  assert.equal(stdout('(newline)', i), '\n');
  assert.equal(val('(newline)', i), '');
  assert.equal(stdout("(my-show '(a (b c) \"s\"))", i), stdout("(show '(a (b c) \"s\"))", i));
  // 20.4: a conversation
  const talk = runScripted(i, '(converse)', ['Ada Lovelace', "I'm fine."]);
  assert.equal(talk.out, "Hello, I'm the computer.  What's your name? Hi, Ada.  How are you? Glad to hear it.\n");
  // 20.5: the first column is as wide as the longest last name plus two
  assert.equal(stdout("(name-table '((piotr tchaikovsky) (nicolay rimsky-korsakov) (sergei rachmaninov) (modest musorgsky)))", i), [
    'tchaikovsky      piotr',
    'rimsky-korsakov  nicolay',
    'rachmaninov      sergei',
    'musorgsky        modest', ''].join('\n'));
  assert.equal(stdout("(name-table '((bill evans) (paul motian) (scott lefaro)))", i), [
    'evans   bill',
    'motian  paul',
    'lefaro  scott', ''].join('\n'));
  // 20.6, 20.7: ask again until the answer is a whole number from 1 to 9 naming a free square
  const ask = runScripted(i, "(ask-for-square '_x_______)", ['hello', '15', '2.5', '2', '3']);
  assert.equal(ask.out, [
    'Which square? Please type a number.',
    'Which square? Please type a number from 1 to 9.',
    'Which square? Please type a number from 1 to 9.',
    'Which square? That square is taken.',
    'Which square? '].join('\n'));
  assert.equal(ask.value, '3');
});

test('exercises, chapter 22: the file exercises, run on string ports', () => {
  const i = loaded('simply-ex-20-23');
  check(i, [
    ['(let ((out (open-output-string))) (copy-ports (list (open-input-string "john lennon\\npaul mccartney\\n") (open-input-string "george harrison\\n")) out) (get-output-string out))',
      '"john lennon\\npaul mccartney\\ngeorge harrison\\n"'],
    ['(count-lines (open-input-string "a b\\nc\\n\\nd e f\\n"))', '4'],
    ['(count-words (open-input-string "a b\\nc\\n\\nd e f\\n"))', '6'],
    ['(count-characters (open-input-string "ab c\\nd"))', '6'],
    // 22.5: consecutive repeats are dropped, a repeat after another line is kept
    ['(let ((out (open-output-string))) (drop-repeated-lines (open-input-string "John Lennon\\nPaul McCartney\\nPaul McCartney\\nGeorge Harrison\\nPaul McCartney\\nRingo Starr\\n") out) (get-output-string out))',
      '"John Lennon\\nPaul McCartney\\nGeorge Harrison\\nPaul McCartney\\nRingo Starr\\n"'],
    ["(let ((out (open-output-string))) (lines-containing (open-input-string \"the long and winding road\\nhey jude\\nthe fool on the hill\\n\") 'the out) (get-output-string out))",
      '"the long and winding road\\nthe fool on the hill\\n"'],
    // 22.8: join on account names; an item in one file only is left out. (A number such as 04397
    // is read as the number 4397, so its leading zero is not kept.)
    ['(let ((out (open-output-string))) (join (open-input-string "((john alec entwistle) 04397 john)\\n((keith moon) 09382 kmoon)\\n((peter townshend) 10428 pete)\\n((roger daltrey) 01025 roger)\\n") (open-input-string "(john 87 90 76 68 95)\\n(kmoon 80 88 95 77 89)\\n(pete 100 92 80 65 72)\\n(roger 85 96 83 62 74)\\n") 3 1 out) (get-output-string out))',
      '"((john alec entwistle) 4397 john 87 90 76 68 95)\\n((keith moon) 9382 kmoon 80 88 95 77 89)\\n((peter townshend) 10428 pete 100 92 80 65 72)\\n((roger daltrey) 1025 roger 85 96 83 62 74)\\n"'],
    ['(let ((out (open-output-string))) (join (open-input-string "(a 1)\\n(c 3)\\n(d 4)\\n") (open-input-string "(b 20)\\n(c 30)\\n(e 50)\\n") 1 1 out) (get-output-string out))',
      '"(c 3 30)\\n"'],
  ]);
});

test('exercises, chapter 23: vectors', () => {
  const i = loaded('simply-ex-20-23');
  check(i, [
    ["(sum-vector '#(6 7 8))", '21'], ['(sum-vector (vector))', '0'],
    ["(let ((vec (vector 'one 'two 'three 'four))) (my-vector-fill! vec 'yeah) vec)", '#(yeah yeah yeah yeah)'],
    ["(vector-append2 '#(not a) '#(second time))", '#(not a second time)'], ["(vector-append2 (vector) '#(a))", '#(a)'],
    ["(my-vector->list '#(1 2 3))", '(1 2 3)'], ['(my-vector->list (vector))', '()'],
    ["(my-vector-map square '#(1 2 3))", '#(1 4 9)'],
    ['(let ((v (vector 1 2 3))) (list (my-vector-map! square v) v))', '(#(1 4 9) #(1 4 9))'],
    // 23.11: orders per table; the bill resets the table
    ["(begin (order 3 'potstickers) (order 3 'wor-won-ton) (order 5 'egg-rolls) (order 3 'shin-shin-special-prawns) (list (bill 5) (bill 3) (bill 3)))", '(2.75 13.85 0)'],
    // 23.12: selection sort of a vector, with the textbook's five intermediate stages
    ['(let ((v (vector 23 4 18 7 95 60))) (list (selection-sort-stages! v) v))',
      '((#(4 23 18 7 95 60) #(4 7 18 23 95 60) #(4 7 18 23 95 60) #(4 7 18 23 95 60) #(4 7 18 23 60 95)) #(4 7 18 23 60 95))'],
    // 23.13: the swap from the exercise overwrites the first box before reading it back
    ['(let ((v (vector 1 2))) (broken-swap! v 0 1) v)', '#(2 2)'], ['(let ((v (vector 1 2))) (vector-swap! v 0 1) v)', '#(2 1)'],
    // 23.14, 23.15
    ["(let ((m (make-matrix 3 5))) (matrix-set! m 2 1 '(her majesty)) (list (matrix-ref m 2 1) (matrix-ref m 0 0) (matrix-ref m 1 1)))", '((her majesty) 0 0)'],
    ["(let ((a (make-array '(4 5 6)))) (array-set! a '(3 2 3) '(the end)) (list (array-ref a '(3 2 3)) (array-ref a '(0 0 0)) (array-ref a '(3 2 2))))", '((the end) 0 0)'],
    // 23.16 (a): sentences as vectors
    ["(vs-sentence 'a 'b 'c)", '#(a b c)'], ["(vs-butfirst (vs-sentence 'a 'b 'c))", '#(b c)'], ["(vs-butlast (vs-sentence 'a 'b 'c))", '#(a b)'],
    ["(list (vs-first (vs-sentence 'a 'b)) (vs-last (vs-sentence 'a 'b)) (vs-empty? (vs-sentence)))", '(a b #t)'],
  ]);
  // 23.8: the 200th lap of the first car to get there prints the message, once
  const laps = loaded('simply-ex-20-23');
  run('(do ((k 0 (+ k 1))) ((= k 199)) (lap 34))', laps);
  assert.equal(stdout('(lap 34)', laps), 'Car 34 wins!\n');
  assert.equal(stdout('(lap 34)', laps), '');
  run('(do ((k 0 (+ k 1))) ((= k 200)) (lap 7))', laps);
  assert.equal(stdout('(lap 7)', laps), '');                      // car 34 already won
  // 23.9: the leader is the car with the most laps
  const race = loaded('simply-ex-20-23');
  run('(begin (do ((k 0 (+ k 1))) ((= k 5)) (lap 3)) (do ((k 0 (+ k 1))) ((= k 9)) (lap 7)))', race);
  assert.equal(val('(leader)', race), '7');
  // 23.10: the exercise's version asks lap for the counts, and every call to lap adds a lap
  const before = val('(sum-vector *laps*)', race);
  run('(leader-by-calling-lap-helper 0 1)', race);
  assert.ok(Number(val('(sum-vector *laps*)', race)) > Number(before));
});

test('exercises, chapters 2 and 3: functions, expressions, and the table of missing entries', () => {
  const i = library();
  check(i, [
    // 2.1: the missing pieces of the table
    ["(word 'now 'here)", 'nowhere'], ["(sentence 'now 'here)", '(now here)'], ["(first 'blackbird)", 'b'],
    ["(first '(blackbird))", 'blackbird'], ['(+ 3 4)', '7'], ["(every bf '(thank you girl))", '(hank ou irl)'],
    ["(member? 'e 'aardvark)", '#f'], ["(member? 'the '(the band))", '#t'],
    ["(keep (lambda (w) (member? w '(a e i o u))) '(i will))", '(i)'], ["(keep (lambda (w) (member? w '(a e i o u))) 'eieio)", 'eieio'],
    ["(every last '(honey pie))", '(y e)'], ["(keep (lambda (w) (member? w '(a e i o u))) 'taxman)", 'aa'],
    // 3.5, 3.6: the same values however they are drawn
    ['(sqrt (+ 6 (* 5 2)))', '4'], ['(+ (+ (+ 1 2) 3) 4)', '10'], ['(+ 3 4 5 6 7)', '25'], ['(+ (+ 3 4) (+ 5 6 7))', '25'],
    ['(+ (+ 3 (+ 4 5) 6) 7)', '25'],
    // 3.7: this engine keeps exact fractions
    ['(/ 1 3)', '1/3'], ['(exact->inexact (/ 1 3))', '0.3333333333333333'],
    // 3.8: procedures that accept any number of arguments
    ['(+)', '0'], ['(*)', '1'], ['(word)', '""'], ['(sentence)', '()'], ['(max 3 9 2)', '9'], ['(min 3 9 2)', '2'], ['(+ 1 2 3 4 5)', '15'],
    // 3.9: five expressions whose value is ten
    ['10', '10'], ['(+ 5 5)', '10'], ['(+ 4 3 3)', '10'], ['(+ (* 2 3) (- 8 4))', '10'], ["(count '(a b c d e f g h i j))", '10'],
  ]);
  assert.match(val('(first (word))', i), /^;Invalid argument to FIRST/);
});

test('projects: scoring a bridge hand', () => {
  const i = loaded('simply-ex-projects');
  const a = "'(sa s10 hq ck c4)";
  const b = "'(sa s10 s7 s6 s2 hq hj h9 ck c4 dk d9 d3)";
  const c = "'(h3 d7 sk s3 c10 dq d8 s9 s4 d10 c7 d4 s2)";
  check(i, [
    ["(card-val 'cq)", '2'], ["(card-val 's7)", '0'], ["(card-val 'ha)", '4'], ["(card-val 'dj)", '1'], ["(card-val 'ck)", '3'],
    ["(card-val 'c10)", '0'],
    [`(high-card-points ${a})`, '9'], [`(high-card-points ${b})`, '13'], ["(high-card-points '())", '0'],
    [`(count-suit 's ${a})`, '2'], [`(count-suit 'c ${b})`, '2'], [`(count-suit 'd ${c})`, '5'],
    [`(suit-counts ${a})`, '(2 1 2 0)'], [`(suit-counts ${b})`, '(5 3 2 3)'], [`(suit-counts ${c})`, '(5 1 2 5)'],
    ['(suit-dist-points 2)', '1'], ['(suit-dist-points 7)', '0'], ['(suit-dist-points 0)', '3'], ['(suit-dist-points 1)', '2'],
    [`(hand-dist-points ${b})`, '1'], [`(hand-dist-points ${c})`, '3'],
    [`(bridge-val ${b})`, '14'], [`(bridge-val ${c})`, '8'],
  ]);
});

test('projects: spelling out a number', () => {
  const i = loaded('simply-ex-projects');
  check(i, [
    ['(number-name 5513345)', '(five million five hundred thirteen thousand three hundred forty five)'],
    ['(number-name (factorial 20))', '(two quintillion four hundred thirty two quadrillion nine hundred two trillion eight billion one hundred seventy six million six hundred forty thousand)'],
    // the special cases the project lists: a zero digit, a whole group of zeros, the teens
    ['(number-name 1000529)', '(one million five hundred twenty nine)'], ['(number-name 110)', '(one hundred ten)'],
    ['(number-name 15)', '(fifteen)'], ['(number-name 40)', '(forty)'], ['(number-name 1000000)', '(one million)'],
    ['(number-name 12000)', '(twelve thousand)'], ['(number-name 0)', '(zero)'],
  ]);
});

test('projects: naming a poker hand (the textbook\'s four samples; the other hand names are this solution\'s own)', () => {
  const i = loaded('simply-ex-projects');
  check(i, [
    ["(poker-value '(h4 s4 c6 s6 c4))", '(full house - fours over sixes)'],
    ["(poker-value '(h7 s3 c5 c4 d6))", '(seven-high straight)'],
    ["(poker-value '(dq d10 dj da dk))", '(royal flush - diamonds)'],
    ["(poker-value '(da d6 d3 c9 h6))", '(pair of sixes)'],
    ["(compute-ranks '(q 3 4 3 4))", '(one q two 3 two 4)'],
    // the remaining categories, and the ace at either end of a straight but never in the middle
    ["(poker-value '(h7 h8 h9 h10 hj))", '(jack-high straight flush - hearts)'],
    ["(poker-value '(s3 d3 h3 c3 s9))", '(four of a kind - threes)'],
    ["(poker-value '(h2 h9 h4 hk h7))", '(flush - hearts)'],
    ["(poker-value '(s5 d5 c5 h2 s9))", '(three of a kind - fives)'],
    ["(poker-value '(s5 d5 c9 h9 s2))", '(two pair - nines and fives)'],
    ["(poker-value '(sa d2 c3 h4 s5))", '(five-high straight)'], ["(poker-value '(ha h2 h3 h4 h5))", '(five-high straight flush - hearts)'],
    ["(poker-value '(sq sk sa d2 d3))", '(nothing)'], ["(poker-value '(s2 d5 c9 hj sk))", '(nothing)'],
  ]);
});
