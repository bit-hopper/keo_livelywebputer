// Book-dialect corpora: each file under corpora/ is our own transcription of the
// kind of definitions those books build up, loaded into a fresh interpreter and
// checked against values worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newInterp, run, val } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = (name) => fs.readFileSync(path.join(here, 'corpora', name + '.scm'), 'utf8');

function loaded(name) {
  const i = newInterp();
  const out = run(corpus(name), i);
  assert.equal(out, '', name + ' should load silently, got: ' + out);
  return i;
}

function check(name, pairs) {
  const i = loaded(name);
  for (const [src, want] of pairs) assert.equal(val(src, i), want, src);
}

test('case with => is available to book code', () => {
  assert.equal(val("(case 5 ((5) => add1) (else 0))", newInterp()), '6');
});

test('tls library: atom?, letcc, try', () => {
  const i = newInterp();
  assert.equal(val("#lang tls\n(list (atom? 'a) (atom? '()) (atom? '(a)) (atom? 3))", i), '(#t #f #f #t)');
  assert.equal(val('(+ 1 (letcc k (+ 10 (k 5))))', i), '6');
  assert.equal(val('(try out (out 3) 9)', i), '9');
  assert.equal(val('(try out 4 9)', i), '4');
  // the escape name is the caller's, so it can be used anywhere inside the first expression
  assert.equal(val('(try out (+ 1 (* 2 (out 7))) 0)', i), '0');
});

test('tls library: a cell may redefine atom?', () => {
  const i = newInterp();
  assert.equal(val("#lang tls\n(define (atom? x) 'mine) (atom? 1)", i), 'mine');
});

test('chapters 1-4: lists and numbers (with user-defined >, <, = and length)', () => {
  check('tls-1-4', [
    ["(lat? '(a b c))", '#t'],
    ["(lat? '((a) b))", '#f'],
    ["(member? 'c '(a b c))", '#t'],
    ["(rember 'b '(a b c b))", '(a c b)'],
    ["(firsts '((a b) (c d) (e f)))", '(a c e)'],
    ["(insertR 'x 'b '(a b c))", '(a b x c)'],
    ["(insertL 'x 'b '(a b c))", '(a x b c)'],
    ["(subst 'x 'b '(a b c))", '(a x c)'],
    ["(multirember 'a '(a b a c))", '(b c)'],
    ["(multiinsertR 'n 'o '(o x o))", '(o n x o n)'],
    ["(multisubst 'n 'o '(o x o))", '(n x n)'],
    ['(o+ 46 12)', '58'],
    ['(o- 14 3)', '11'],
    ["(addtup '(3 5 2 8))", '18'],
    ['(x 5 3)', '15'],
    ["(tup+ '(3 6 9 11 4) '(8 5 2 0 7))", '(11 11 11 11 11)'],
    ["(tup+ '(1 2) '(1 2 3))", '(2 4 3)'],
    ['(> 12 133)', '#f'],
    ['(< 4 6)', '#t'],
    ['(= 3 3)', '#t'],
    ['(^ 2 5)', '32'],
    ['(div 15 4)', '3'],
    ["(length '(a b c))", '3'],
    ["(pick 4 '(a b c d e))", 'd'],
    ["(rempick 3 '(a b c d))", '(a b d)'],
    ["(no-nums '(5 pears 6 prunes 9 dates))", '(pears prunes dates)'],
    ["(all-nums '(5 pears 6 prunes 9 dates))", '(5 6 9)'],
    ["(eqan? 2 2)", '#t'],
    ["(eqan? 'a 2)", '#f'],
    ["(occur 'a '(a b a))", '2'],
    // library procedures keep working although the cell redefined <, > and length
    ["(sort '(3 1 2) <)", '(1 2 3)'],
    ["(map add1 '(1 2))", '(2 3)'],
    ["(list-tail '(a b c d) 2)", '(c d)'],
  ]);
});

test('chapters 5-7: nested lists, expressions, sets, relations', () => {
  check('tls-5-7', [
    ["(rember* 'cup '((coffee) cup ((tea) cup) (and (hick)) cup))", '((coffee) ((tea)) (and (hick)))'],
    ["(insertR* 'n 'o '(o (a o) ((o))))", '(o n (a o n) ((o n)))'],
    ["(occur* 'a '(a (b a) ((a))))", '3'],
    ["(subst* 'n 'o '(o (a o) ((o))))", '(n (a n) ((n)))'],
    ["(member* 'x '(a (b (x))))", '#t'],
    ["(member* 'z '(a (b)))", '#f'],
    ["(leftmost '(((a) b) c))", 'a'],
    ["(eqlist? '(a (b c) d) '(a (b c) d))", '#t'],
    ["(eqlist? '(a (b c)) '(a (b d)))", '#f'],
    ["(numbered? '(+ 3 (* 4 5)))", '#t'],
    ["(numbered? '(+ 3 (* x 5)))", '#f'],
    ["(value '(+ 3 (* 4 5)))", '23'],
    ["(value '(* 2 (* 3 (+ 1 1))))", '12'],
    ["(value '(^ 2 3))", '8'],
    ["(set? '(a b c))", '#t'],
    ["(set? '(a b a))", '#f'],
    ["(makeset '(a b a c b))", '(a b c)'],
    ["(subset? '(a b) '(b c a))", '#t'],
    ["(eqset? '(a b) '(b a))", '#t'],
    ["(intersect '(a b c) '(c a z))", '(a c)'],
    ["(union '(a b) '(b c))", '(a b c)'],
    ["(a-pair? '(1 2))", '#t'],
    ["(a-pair? '(1))", '#f'],
    ["(revrel '((a 1) (b 2)))", '((1 a) (2 b))'],
    ["(fun? '((a 1) (b 2)))", '#t'],
    ["(fun? '((a 1) (a 2)))", '#f'],
    ["(fullfun? '((a 1) (b 2)))", '#t'],
    ["(fullfun? '((a 1) (b 1)))", '#f'],
  ]);
});

test('chapters 8-9: functions as values, collectors, the Y combinator', () => {
  check('tls-8-9', [
    ["((rember-f eq?) 'b '(a b c))", '(a c)'],
    ["((rember-f =) 5 '(1 5 3))", '(1 3)'],
    ["((eq?-c 'x) 'x)", '#t'],
    ["((insertL-f eq?) 'n 'b '(a b c))", '(a n b c)'],
    ["((multirember-f eq?) 'a '(a b a c))", '(b c)'],
    ["(multirember&co 'a '(b a c a) (lambda (n s) (list n s)))", '((b c) (a a))'],
    ["(multiinsertLR 'n 'l 'r '(l x r))", '(n l x r n)'],
    ["(evens-only* '((9 1 2 8) 3 10 ((9 9) 7 6) 2))", '((2 8) 10 (() 6) 2)'],
    ["(evens-only*&co '((9 1 2 8) 3 10 ((9 9) 7 6) 2) (lambda (l p s) (cons s (cons p l))))", '(38 1920 (2 8) 10 (() 6) 2)'],
    ["(looking 'caviar '(6 2 4 caviar 5 7 3))", '#t'],
    ["(looking 'caviar '(6 2 grits caviar 5 7 3))", '#f'],
    ["(shift '((a b) c))", '(a (b c))'],
    ["(align '((a b) c))", '(a (b c))'],
    ["(length* '((a b) c))", '3'],
    ["(weight* '((a b) c))", '7'],
    ["(weight* '(a (b c)))", '5'],
    ["(length-0 '())", '0'],
    ["(length-<=1 '())", '0'],
    ["(length-<=1 '(a))", '1'],
    ["(Y-length '(a b c d))", '4'],
    ['(Y-length (iota 10000))', '10000'],
  ]);
});

test('chapter 10: the table-driven evaluator', () => {
  check('tls-10', [
    ['(value (quote (add1 5)))', '6'],
    ["(value '((lambda (x) (cons x '(b))) 'a))", '(a b)'],
    ["(value '(cond ((null? '()) 1) (else 2)))", '1'],
    ["(value '(cond ((eq? 'a 'b) 1) (else 2)))", '2'],
    ["(value '((lambda (x y) (cons x y)) 1 2))", '(1 . 2)'],
    ["(value '((lambda (f) (f f 5)) (lambda (f n) (cond ((zero? n) 0) (else (add1 (f f (sub1 n))))))))", '5'],
    ["(value 'car)", '(primitive car)'],
    ["(value '(lambda (x) x))", '(non-primitive (() (x) x))'],
    ["(lookup-in-table 'b '(((a b) (1 2))) (lambda (n) 'none))", '2'],
    ["(lookup-in-table 'q '(((a b) (1 2))) (lambda (n) 'none))", 'none'],
    ["(value '(atom? (quote x)))", '#t'],
    ["(value '(atom? (quote (x))))", '#f'],
  ]);
  // the evaluator can be applied to a closure it built itself
  const i = loaded('tls-10');
  assert.match(val("(value 'unbound-name)", i), /^;The object \(\), passed as the first argument to car/);
});

test('chapters 11-16: letrec, escapes, try, assignment', () => {
  check('seasoned-11-16', [
    ["(two-in-a-row? '(a b b c))", '#t'],
    ["(two-in-a-row? '(a b a))", '#f'],
    ["(sum-of-prefixes '(2 1 9 17 0))", '(2 3 12 29 29)'],
    ["(scramble '(1 2 1 3))", '(1 1 1 2)'],
    ["(multirember 'a '(a b a c))", '(b c)'],
    ["(union '(a b) '(b c))", '(a b c)'],
    ["(intersectall '((a b c) (c a d e) (e f g h a b)))", '(a)'],
    ["(intersectall '((a b) () (a)))", '()'],
    ["(intersectall '())", '()'],
    ["(rember-upto-last 'roots '(a roots b roots c d))", '(c d)'],
    ["(rember-upto-last 'x '(a b))", '(a b)'],
    ["(safe-head '(7 8))", '7'],
    ["(safe-head '())", 'nothing'],
    ["(rember1* 'a '((x a) b a))", '((x) b a)'],
    ["(rember1* 'z '((x) y))", '((x) y)'],
    ['(let ((c (counter-maker))) (c) (c) (c))', '3'],
    ['(let ((a (counter-maker)) (b (counter-maker))) (a) (a) (b))', '1'],
    ["(let ((l (make-adder-log))) (l 'x) (l 'y) (l 'dump))", '(x y)'],
    ["(length! '(a b c))", '3'],
    ['(let ((m (make-memo (lambda (x) (* x x))))) (m 4) (m 4) (m 5) (m (quote calls)))', '2'],
    ['(let ((m (make-memo (lambda (x) (* x x))))) (m 4) (m 4))', '16'],
  ]);
});

test('chapters 17-19: shared structure, generators, cooperative threads', () => {
  const i = loaded('seasoned-17-19');
  const t = (src, want) => assert.equal(val(src, i), want, src);
  t('(kar (kons 1 2))', '1');
  t('(kdr (kons 1 2))', '2');
  t('(lenkth (lots 5))', '5');
  t('(let ((q (make-queue))) (q (quote put) 1) (q (quote put) 2) (q (quote put) 3) (let* ((a (q (quote take))) (b (q (quote take)))) (list a b (q (quote empty?)))))', '(1 2 #f)');
  t('(take-n 7 (make-cycle (list 1 2 3)))', '(1 2 3 1 2 3 1)');
  t("(same-fringe? '((a b) c) '(a (b (c))))", '#t');
  t("(same-fringe? '((a b) c) '(a (c b)))", '#f');
  t("(same-fringe? '(a b) '(a b c))", '#f');
  t("(begin (spawn (lambda () (note 'a1) (yield) (note 'a2))) (spawn (lambda () (note 'b1) (yield) (note 'b2))) (run-all))", '(a1 b1 a2 b2)');
});
