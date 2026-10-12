import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newInterp, val, stdout } from './helpers.js';

const cases = (pairs, interp) => { for (const [src, want] of pairs) assert.equal(val(src, interp), want, src); };

test('special forms', () => {
  const i = newInterp();
  cases([
    ['(if #t 1 2)', '1'], ['(if #f 1 2)', '2'], ['(if 0 (quote t) (quote f))', 't'], ["(if '() 'yes 'no)", 'yes'],
    ['(and)', '#t'], ['(and 1 2 3)', '3'], ['(and 1 #f 3)', '#f'], ['(or)', '#f'], ['(or #f 2)', '2'], ['(or #f #f)', '#f'],
    ['(when #t 1 2)', '2'], ['(unless #f 1 2)', '2'],
    ["(cond ((= 1 2) 'a) ((= 1 1) 'b) (else 'c))", 'b'], ["(cond (#f 1) (else 'z))", 'z'], ['(cond (5))', '5'],
    ['(let ((a 1) (b 2)) (+ a b))', '3'], ['(let* ((a 1) (b (+ a 1))) (* a b))', '2'], ['(let () 5)', '5'],
    ["(let loop ((i 0) (acc '())) (if (= i 3) acc (loop (+ i 1) (cons i acc))))", '(2 1 0)'],
    ['(letrec ((f (lambda (n) (if (= n 0) 1 (* n (f (- n 1))))))) (f 5))', '120'],
    ['(do ((i 0 (+ i 1)) (s 0 (+ s i))) ((= i 4) s))', '6'],
    ["(case 2 ((1) 'one) ((2 3) 'two-three) (else 'other))", 'two-three'],
    ["(case 'x ((x) 'ex) (else 'no))", 'ex'], ["(case 9 ((1) 'a))", ''],
    ['(begin 1 2 3)', '3'], ['((lambda (x y) (+ x y)) 3 4)', '7'],
  ], i);
});

test('define, set!, closures, internal defines', () => {
  const i = newInterp();
  cases([
    ['(define x 5) x', '5'], ['(set! x 6) x', '6'], ['(define (add a b) (+ a b)) (add 2 3)', '5'],
    ['(define (make-counter) (let ((n 0)) (lambda () (set! n (+ n 1)) n))) (define c (make-counter)) (c) (c) (c)', '3'],
    ['(define c2 (make-counter)) (c2)', '1'],
    ['(define (f) (define a 1) (define (g) (+ a 10)) (g)) (f)', '11'],
    ['(define (h x) (define y (* x 2)) (+ x y)) (h 5)', '15'],
    ['(let () (define (ev? n) (if (= n 0) #t (od? (- n 1)))) (define (od? n) (if (= n 0) #f (ev? (- n 1)))) (ev? 10))', '#t'],
    ['(define ((curried a) b) (+ a b)) ((curried 1) 2)', '3'],
    ['(set! undefined-var 1)', ';Unbound variable: undefined-var'],
    ['(define (uses-later) (later-defined 1)) (define (later-defined x) (* x 10)) (uses-later)', '10'],
  ], i);
});

test('varargs and optionals', () => {
  const i = newInterp();
  cases([
    ['((lambda args args) 1 2 3)', '(1 2 3)'], ['((lambda (a . rest) rest) 1 2 3)', '(2 3)'], ['((lambda (a . rest) rest) 1)', '()'],
    ['(define (f a #!optional b) (if (default-object? b) (list a) (list a b))) (list (f 1) (f 1 2))', '((1) (1 2))'],
    ['(apply + (list 1 2 3))', '6'], ['(apply max 1 5 (list 3 2))', '5'],
    ['(define (g . xs) (length xs)) (g)', '0'],
  ], i);
});

test('quasiquote', () => {
  const i = newInterp();
  cases([
    ['`(1 2)', '(1 2)'], ['`(1 ,(+ 1 1))', '(1 2)'], ['`(1 ,@(list 2 3) 4)', '(1 2 3 4)'], ['`#(1 ,(+ 1 1))', '#(1 2)'],
    ['`(a . ,(+ 1 2))', '(a . 3)'],
    ['`(1 `(2 ,(3 ,(+ 1 3))))', '(1 (quasiquote (2 (unquote (3 4)))))'],
    ['(let ((x 5)) `(x is ,x))', '(x is 5)'], ['`(,@(list 1) . 2)', '(1 . 2)'],
  ], i);
});

test('derived forms are immune to user redefinition of the names they expand to', () => {
  const i = newInterp();
  cases([
    ['(define (cons a b) (quote broken)) (define (list . x) (quote broken)) (define (append . x) (quote broken))', ''],
    ['`(1 ,(+ 1 1) ,@(vector->list #(3 4)))', '(1 2 3 4)'],
    ['(define (call-with-current-continuation f) (quote broken)) (guard (e (#t (quote caught))) (raise 1))', 'caught'],
    ['(define (if x) x) (cond (#f 1) (else 2))', '2'],
  ], i);
});

test('user redefinition of primitives does not break library procedures', () => {
  const i = newInterp();
  cases([
    ['(define (car x) 0) (define (cdr x) 0) (define (cons a b) 0) (define (null? x) #t) (define (reverse x) 0)', ''],
    ["(map (lambda (x) (* x 2)) '(1 2 3))", '(2 4 6)'],
    ["(sort '(3 1 2) <)", '(1 2 3)'],
    ["(filter odd? '(1 2 3 4 5))", '(1 3 5)'],
    ["(length '(1 2 3))", '3'],
    ['(define (map f l) (quote user-map)) (map 1 2)', 'user-map'],
    ["(list-index even? '(1 3 4))", '2'],
  ], i);
});

test('sharing: a closure captured in a loop sees fresh bindings per iteration', () => {
  const i = newInterp();
  cases([
    ['(define procs (let loop ((i 0) (acc (quote ()))) (if (= i 3) (reverse acc) (loop (+ i 1) (cons (lambda () i) acc))))) (map (lambda (p) (p)) procs)', '(0 1 2)'],
  ], i);
});

test('syntax errors are reported, not crashes', () => {
  const i = newInterp();
  cases([
    ['(if)', ';Ill-formed special form: (if)'], ['(let ((x)) x)', ';Unassigned variable: x'], ['(lambda)', ';Ill-formed special form: (lambda)'],
    ['(quote)', ';Ill-formed special form: (quote)'], ['(define)', ';Ill-formed special form: (define)'],
    ['if', ';Syntactic keyword may not be used as an expression: if'],
  ], i);
});

test('a name defined in a body is unassigned until its define runs', () => {
  const i = newInterp();
  cases([
    ['(define (f) (define a b) (define b 1) a) (f)', ';Unassigned variable: b'],
  ], i);
});

test('output ordering and display', () => {
  const i = newInterp();
  assert.equal(stdout('(display "a") (display "b") (newline) (display 42)', i), 'ab\n42');
});

test('top-level forms keep running state across runs', () => {
  const i = newInterp();
  val('(define counter 0)', i);
  val('(set! counter (+ counter 1))', i);
  assert.equal(val('counter', i), '1');
});
