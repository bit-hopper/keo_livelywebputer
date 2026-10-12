import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newInterp, val, run, stdout } from './helpers.js';

const cases = (pairs, interp) => { for (const [src, want] of pairs) assert.equal(val(src, interp), want, src); };

test('proper tail calls in every tail position', () => {
  const i = newInterp();
  cases([
    ['(define (loop n) (if (= n 0) (quote done) (loop (- n 1)))) (loop 300000)', 'done'],
    ['(define (c n) (cond ((= n 0) (quote done)) (else (c (- n 1))))) (c 300000)', 'done'],
    ['(define (a n) (and #t (if (= n 0) (quote done) (a (- n 1))))) (a 300000)', 'done'],
    ['(define (o n) (or #f (if (= n 0) (quote done) (o (- n 1))))) (o 300000)', 'done'],
    ['(define (w n) (when #t (if (= n 0) (quote done) (w (- n 1))))) (w 300000)', 'done'],
    ['(define (cs n) (case n ((0) (quote done)) (else (cs (- n 1))))) (cs 300000)', 'done'],
    ['(define (b n) (begin 1 (if (= n 0) (quote done) (b (- n 1))))) (b 300000)', 'done'],
    ['(define (l n) (let ((m (- n 1))) (if (< m 0) (quote done) (l m)))) (l 300000)', 'done'],
    ['(define (ls n) (let* ((m (- n 1))) (if (< m 0) (quote done) (ls m)))) (ls 300000)', 'done'],
    ['(define (lr n) (letrec ((m (- n 1))) (if (< m 0) (quote done) (lr m)))) (lr 300000)', 'done'],
    ['(define (ap n) (if (= n 0) (quote done) (apply ap (list (- n 1))))) (ap 300000)', 'done'],
    ['(define (ev? n) (if (= n 0) #t (od? (- n 1)))) (define (od? n) (if (= n 0) #f (ev? (- n 1)))) (ev? 300001)', '#f'],
    ['(define (dw n) (do ((i 0 (+ i 1))) ((= i n) (quote done)))) (dw 300000)', 'done'],
  ], i);
});

test('deep non-tail recursion is limited by memory, not the JS stack', () => {
  const i = newInterp();
  cases([
    ['(define (count n) (if (= n 0) 0 (+ 1 (count (- n 1))))) (count 100000)', '100000'],
    ["(define (build n) (if (= n 0) '() (cons n (build (- n 1))))) (length (build 200000))", '200000'],
    ["(length (map (lambda (x) x) (iota 200000)))", '200000'],
    ["(define (sum l) (if (null? l) 0 (+ (car l) (sum (cdr l))))) (sum (iota 100000))", '4999950000'],
    ["(vector-length (list->vector (iota 200000)))", '200000'],
  ], i);
});

test('runaway recursion aborts cleanly and the interpreter stays usable', () => {
  const i = newInterp();
  assert.equal(val('(define (inf n) (+ 1 (inf n))) (inf 1)', i), ';Aborting!: maximum recursion depth exceeded');
  assert.equal(val('(+ 1 2)', i), '3');
});

test('call/cc: escape, re-entry, generators', () => {
  const i = newInterp();
  cases([
    ['(call/cc (lambda (k) (+ 1 (k 42))))', '42'],
    ['(+ 1 (call/cc (lambda (k) 10)))', '11'],
    ["(define (find-first pred l) (call/cc (lambda (return) (for-each (lambda (x) (if (pred x) (return x))) l) #f))) (find-first even? '(1 3 4 5))", '4'],
    // re-entry: a stored continuation re-runs the rest of the body
    [`(define (reenter)
        (define saved #f) (define count 0)
        (+ 100 (call/cc (lambda (k) (set! saved k) 1)))
        (set! count (+ count 1))
        (if (< count 3) (saved count))
        count)
      (reenter)`, '3'],
    // generator via re-entrant continuations
    [`(define (make-gen lst)
        (define return #f)
        (define resume #f)
        (define (start)
          (for-each (lambda (x) (call/cc (lambda (next) (set! resume next) (return x)))) lst)
          (return 'done))
        (lambda ()
          (call/cc (lambda (r)
            (set! return r)
            (if resume (resume #f) (start))))))
      (define g (make-gen '(a b c)))
      (list (g) (g) (g) (g))`, '(a b c done)'],
    ['(call-with-escape-continuation (lambda (k) (k 7) 8))', '7'],
    ['(procedure? (call/cc (lambda (k) k)))', '#t'],
    ['(+ 1 (call/cc (lambda (k) (dynamic-wind (lambda () #f) (lambda () (k 5)) (lambda () #f)))))', '6'],
  ], i);
});

test('dynamic-wind runs before/after in the right order, including escapes and re-entry', () => {
  const i = newInterp();
  cases([
    ["(define trace '()) (define (note x) (set! trace (cons x trace))) (dynamic-wind (lambda () (note 'in)) (lambda () (note 'body) 'v) (lambda () (note 'out))) (reverse trace)", '(in body out)'],
    ["(set! trace '()) (call/cc (lambda (k) (dynamic-wind (lambda () (note 'in)) (lambda () (k 1) (note 'never)) (lambda () (note 'out))))) (reverse trace)", '(in out)'],
    ["(set! trace '()) (define k2 #f) (define n 0) (dynamic-wind (lambda () (note 'in)) (lambda () (call/cc (lambda (k) (set! k2 k))) (note 'body)) (lambda () (note 'out))) (set! n (+ n 1)) (if (< n 2) (k2 #f)) (reverse trace)", '(in body out in body out)'],
    ["(set! trace '()) (dynamic-wind (lambda () (note 'a-in)) (lambda () (dynamic-wind (lambda () (note 'b-in)) (lambda () (note 'x)) (lambda () (note 'b-out)))) (lambda () (note 'a-out))) (reverse trace)", '(a-in b-in x b-out a-out)'],
  ], i);
});

test('multiple values', () => {
  const i = newInterp();
  cases([
    ['(call-with-values (lambda () (values 1 2 3)) list)', '(1 2 3)'],
    ['(call-with-values (lambda () 5) (lambda (x) (* x 2)))', '10'],
    ['(call-with-values (lambda () (values)) list)', '()'],
    ['(receive (a . rest) (values 1 2 3) (list a rest))', '(1 (2 3))'],
    ['(let-values (((q r) (floor/ 7 2))) (list q r))', ';Unbound variable: floor/'],
    ['(define-values (a b) (values 10 20)) (+ a b)', '30'],
    ['(let-values (((a b) (values 1 2)) ((c) (values 3))) (list a b c))', '(1 2 3)'],
  ], i);
});

test('promises and streams', () => {
  const i = newInterp();
  cases([
    ['(define p (delay (begin (display "once") 5))) (list (force p) (force p))', '(5 5)'],
    ['(force 3)', '3'],
    ['(define s (cons-stream 1 (cons-stream 2 (quote ())))) (stream-car (stream-cdr s))', '2'],
    ['(define (ints n) (cons-stream n (ints (+ n 1)))) (stream-head (ints 1) 5)', '(1 2 3 4 5)'],
    ['(stream-ref (stream-filter odd? (ints 1)) 10)', '21'],
    ['(stream-head (stream-map + (ints 1) (ints 10)) 3)', '(11 13 15)'],
    ['(stream-pair? (ints 1))', '#t'], ['(stream-pair? (quote ()))', '#f'], ['(stream-null? the-empty-stream)', '#t'],
    ['(define-syntax my-delay (syntax-rules () ((_ e) (lambda () e)))) ((my-delay 3))', '3'],
  ], i);
  assert.equal(stdout('(define q (delay (begin (display "once") 5))) (force q) (force q)', i), 'once');
});

test('named let and do loops produce correct results with large iteration counts', () => {
  const i = newInterp();
  cases([
    ['(let loop ((i 0) (s 0)) (if (> i 100000) s (loop (+ i 1) (+ s i))))', '5000050000'],
    ['(do ((i 0 (+ i 1)) (v (make-vector 5 0))) ((= i 5) v) (vector-set! v i (* i i)))', '#(0 1 4 9 16)'],
  ], i);
});

test('exit stops the run', () => {
  const i = newInterp();
  const r = i.evalSync('(display "before") (exit 3) (display "after")');
  assert.equal(r.state, 'exit');
  assert.equal(r.exitCode, 3);
  assert.equal(r.segments.map((s) => s.text).join(''), 'before');
});

test('eval', () => {
  const i = newInterp();
  cases([
    ["(eval '(+ 1 2) system-global-environment)", '3'],
    ["(eval (list '* 6 7) user-initial-environment)", '42'],
    ["(define zz 10) (eval 'zz (the-environment))", '10'],
  ], i);
});

test('case clauses with => call the procedure on the key', () => {
  const i = newInterp();
  cases([
    ['(case 3 ((1 2) (quote low)) ((3 4) => (lambda (k) (* k 10))) (else (quote none)))', '30'],
    ['(case 9 ((1 2) (quote low)) ((3 4) => (lambda (k) (* k 10))) (else => (lambda (k) (+ k 1))))', '10'],
    ['(case 1 ((1 2) (quote low)) ((3 4) => (lambda (k) k)))', 'low'],
    ['(define n 0) (define (bump) (set! n (+ n 1)) n) (case (bump) ((1) => list) (else (quote no)))', '(1)'],
    ['n', '1'],
    ['(define (cs n) (case n ((0) => (lambda (k) (quote done))) (else (cs (- n 1))))) (cs 300000)', 'done'],
  ], i);
});
