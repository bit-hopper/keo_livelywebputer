// Larger programs in the style of the books' exercises (written for this test
// suite; no book text). They exercise the engine the way real use will:
// recursion over lists, higher-order procedures, closures, mutation, streams,
// continuations, and an interpreter running inside the interpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newInterp, val } from './helpers.js';

test('list-recursion exercises (atoms, lats, nested lists)', () => {
  const i = newInterp();
  const src = `
    (define atom? (lambda (x) (and (not (pair? x)) (not (null? x)))))
    (define lat?
      (lambda (l)
        (cond ((null? l) #t)
              ((atom? (car l)) (lat? (cdr l)))
              (else #f))))
    (define rember
      (lambda (a lat)
        (cond ((null? lat) '())
              ((eq? a (car lat)) (cdr lat))
              (else (cons (car lat) (rember a (cdr lat)))))))
    (define multirember
      (lambda (a lat)
        (cond ((null? lat) '())
              ((eq? a (car lat)) (multirember a (cdr lat)))
              (else (cons (car lat) (multirember a (cdr lat)))))))
    (define firsts
      (lambda (l)
        (cond ((null? l) '())
              (else (cons (car (car l)) (firsts (cdr l)))))))
    (define insertR
      (lambda (new old lat)
        (cond ((null? lat) '())
              ((eq? (car lat) old) (cons old (cons new (cdr lat))))
              (else (cons (car lat) (insertR new old (cdr lat)))))))
    (define rember*
      (lambda (a l)
        (cond ((null? l) '())
              ((atom? (car l))
               (cond ((eq? (car l) a) (rember* a (cdr l)))
                     (else (cons (car l) (rember* a (cdr l))))))
              (else (cons (rember* a (car l)) (rember* a (cdr l)))))))
    (define occur*
      (lambda (a l)
        (cond ((null? l) 0)
              ((atom? (car l))
               (cond ((eq? (car l) a) (add1 (occur* a (cdr l))))
                     (else (occur* a (cdr l)))))
              (else (+ (occur* a (car l)) (occur* a (cdr l)))))))
    (define o+ (lambda (n m) (cond ((zero? m) n) (else (add1 (o+ n (sub1 m)))))))
    (define o* (lambda (n m) (cond ((zero? m) 0) (else (o+ n (o* n (sub1 m)))))))
    (define o-expt (lambda (n m) (cond ((zero? m) 1) (else (o* n (o-expt n (sub1 m)))))))
    (define value
      (lambda (nexp)
        (cond ((atom? nexp) nexp)
              ((eq? (car (cdr nexp)) '+) (o+ (value (car nexp)) (value (car (cdr (cdr nexp))))))
              ((eq? (car (cdr nexp)) '*) (o* (value (car nexp)) (value (car (cdr (cdr nexp))))))
              (else (o-expt (value (car nexp)) (value (car (cdr (cdr nexp)))))))))
    (define eqlist?
      (lambda (l1 l2)
        (cond ((and (null? l1) (null? l2)) #t)
              ((or (null? l1) (null? l2)) #f)
              ((and (atom? (car l1)) (atom? (car l2)))
               (and (equal? (car l1) (car l2)) (eqlist? (cdr l1) (cdr l2))))
              ((or (atom? (car l1)) (atom? (car l2))) #f)
              (else (and (eqlist? (car l1) (car l2)) (eqlist? (cdr l1) (cdr l2)))))))
  `;
  assert.equal(val(src + "(list (lat? '(a b c)) (lat? '(a (b) c)))", i), '(#t #f)');
  assert.equal(val("(rember 'mint '(lamb chops and mint jelly))", i), '(lamb chops and jelly)');
  assert.equal(val("(multirember 'cup '(coffee cup tea cup and hick cup))", i), '(coffee tea and hick)');
  assert.equal(val("(firsts '((a b) (c d) (e f)))", i), '(a c e)');
  assert.equal(val("(insertR 'topping 'fudge '(ice cream with fudge for dessert))", i), '(ice cream with fudge topping for dessert)');
  assert.equal(val("(rember* 'cup '((coffee) cup ((tea) cup) (and (hick)) cup))", i), '((coffee) ((tea)) (and (hick)))');
  assert.equal(val("(occur* 'banana '((banana) (split ((((banana ice))) (cream (banana)) sherbet)) (banana) (bread) (banana brandy)))", i), '5');
  assert.equal(val("(value '(1 + (3 * 4)))", i), '13');
  assert.equal(val("(eqlist? '(beef ((sausage)) (and (soda))) '(beef ((sausage)) (and (soda))))", i), '#t');
  assert.equal(val("(eqlist? '(a (b)) '(a b))", i), '#f');
});

test('the applicative-order Y combinator builds recursion from lambda alone', () => {
  const i = newInterp();
  const src = `
    (define Y
      (lambda (le)
        ((lambda (f) (f f))
         (lambda (f) (le (lambda (x) ((f f) x)))))))
    (define length-y
      (Y (lambda (length)
           (lambda (l) (cond ((null? l) 0) (else (+ 1 (length (cdr l)))))))))
    (define fact-y
      (Y (lambda (f) (lambda (n) (if (= n 0) 1 (* n (f (- n 1))))))))
  `;
  assert.equal(val(src + "(list (length-y '(a b c d)) (fact-y 10))", i), '(4 3628800)');
});

test('escape continuations, set!, and shared mutable state', () => {
  const i = newInterp();
  const src = `
    (define (rember-upto-last a lat)
      (call/cc
        (lambda (skip)
          (let loop ((l lat))
            (cond ((null? l) '())
                  ((eq? (car l) a) (skip (loop (cdr l))))
                  (else (cons (car l) (loop (cdr l)))))))))
    (define (make-account balance)
      (define (withdraw amount)
        (if (>= balance amount) (begin (set! balance (- balance amount)) balance) "Insufficient funds"))
      (define (deposit amount) (set! balance (+ balance amount)) balance)
      (lambda (m)
        (cond ((eq? m 'withdraw) withdraw) ((eq? m 'deposit) deposit) (else (error "Unknown request" m)))))
  `;
  assert.equal(val(src + "(rember-upto-last 'roots '(noodles spaghetti spatzle bean-thread roots potatoes yam others rice))", i), '(potatoes yam others rice)');
  assert.equal(val("(define acc (make-account 100)) (list ((acc 'withdraw) 30) ((acc 'deposit) 50) ((acc 'withdraw) 500))", i), '(70 120 "Insufficient funds")');
  assert.equal(val("((acc 'frobnicate) 1)", i), ';Unknown request frobnicate');
});

test('textbook numeric/recursion exercises: Newton sqrt, count-change, accumulate, queens', () => {
  const i = newInterp();
  const src = `
    (define (sqrt-iter guess x)
      (if (good-enough? guess x) guess (sqrt-iter (improve guess x) x)))
    (define (improve guess x) (average guess (/ x guess)))
    (define (average x y) (/ (+ x y) 2))
    (define (good-enough? guess x) (< (abs (- (square guess) x)) 0.001))
    (define (my-sqrt x) (sqrt-iter 1.0 x))
    (define (count-change amount) (cc amount 5))
    (define (cc amount kinds)
      (cond ((= amount 0) 1)
            ((or (< amount 0) (= kinds 0)) 0)
            (else (+ (cc amount (- kinds 1)) (cc (- amount (first-denomination kinds)) kinds)))))
    (define (first-denomination k)
      (cond ((= k 1) 1) ((= k 2) 5) ((= k 3) 10) ((= k 4) 25) ((= k 5) 50)))
    (define (accumulate op initial sequence)
      (if (null? sequence) initial (op (car sequence) (accumulate op initial (cdr sequence)))))
    (define (flatmap proc seq) (accumulate append '() (map proc seq)))
    (define (enumerate-interval a b) (if (> a b) '() (cons a (enumerate-interval (+ a 1) b))))
    (define (queens board-size)
      (define (queen-cols k)
        (if (= k 0)
            (list '())
            (filter (lambda (positions) (safe? k positions))
                    (flatmap (lambda (rest-of-queens)
                               (map (lambda (new-row) (adjoin-position new-row k rest-of-queens))
                                    (enumerate-interval 1 board-size)))
                             (queen-cols (- k 1))))))
      (queen-cols board-size))
    (define (adjoin-position row col rest) (cons (list row col) rest))
    (define (safe? k positions)
      (let ((new (car positions)))
        (every (lambda (other)
                 (not (or (= (car new) (car other))
                          (= (abs (- (car new) (car other))) (abs (- (cadr new) (cadr other)))))))
               (cdr positions))))
  `;
  assert.equal(val(src + '(> (abs (- (my-sqrt 9) 3)) 0.01)', i), '#f');
  assert.equal(val('(count-change 100)', i), '292');
  assert.equal(val('(accumulate + 0 (enumerate-interval 1 100))', i), '5050');
  assert.equal(val('(length (queens 6))', i), '4');
  assert.equal(val('(length (queens 8))', i), '92');
});

test('redefining cons/car/cdr with closures (message passing) works', () => {
  const i = newInterp();
  const src = `
    (define (cons x y) (lambda (m) (m x y)))
    (define (car z) (z (lambda (p q) p)))
    (define (cdr z) (z (lambda (p q) q)))
    (define pr (cons 1 2))
  `;
  assert.equal(val(src + '(list (car pr) (cdr pr))', i), '(1 2)');
  // library procedures still use the real pairs
  assert.equal(val("(map (lambda (x) (* x x)) (list 1 2 3))", i), '(1 4 9)');
  assert.equal(val("(sort (list 3 1 2) <)", i), '(1 2 3)');
});

test('symbolic differentiation', () => {
  const i = newInterp();
  const src = `
    (define (variable? x) (symbol? x))
    (define (same-variable? a b) (and (variable? a) (variable? b) (eq? a b)))
    (define (=number? e n) (and (number? e) (= e n)))
    (define (make-sum a b)
      (cond ((=number? a 0) b) ((=number? b 0) a) ((and (number? a) (number? b)) (+ a b)) (else (list '+ a b))))
    (define (make-product a b)
      (cond ((or (=number? a 0) (=number? b 0)) 0) ((=number? a 1) b) ((=number? b 1) a)
            ((and (number? a) (number? b)) (* a b)) (else (list '* a b))))
    (define (sum? x) (and (pair? x) (eq? (car x) '+)))
    (define (product? x) (and (pair? x) (eq? (car x) '*)))
    (define (deriv e v)
      (cond ((number? e) 0)
            ((variable? e) (if (same-variable? e v) 1 0))
            ((sum? e) (make-sum (deriv (cadr e) v) (deriv (caddr e) v)))
            ((product? e)
             (make-sum (make-product (cadr e) (deriv (caddr e) v))
                       (make-product (deriv (cadr e) v) (caddr e))))
            (else (error "unknown expression type -- DERIV" e))))
  `;
  assert.equal(val(src + "(deriv '(+ x 3) 'x)", i), '1');
  assert.equal(val("(deriv '(* x y) 'x)", i), 'y');
  assert.equal(val("(deriv '(* (* x y) (+ x 3)) 'x)", i), '(+ (* x y) (* y (+ x 3)))');
});

test('streams, the sieve, and delayed evaluation order', () => {
  const i = newInterp();
  const src = `
    (define (integers-from n) (cons-stream n (integers-from (+ n 1))))
    (define (sieve s)
      (cons-stream (stream-car s)
                   (sieve (stream-filter (lambda (x) (not (= 0 (remainder x (stream-car s))))) (stream-cdr s)))))
    (define primes (sieve (integers-from 2)))
    (define (add-streams a b) (stream-map + a b))
    (define fibs (cons-stream 0 (cons-stream 1 (add-streams (stream-cdr fibs) fibs))))
    (define ones (cons-stream 1 ones))
    (define integers (cons-stream 1 (add-streams ones integers)))
  `;
  assert.equal(val(src + '(stream-head primes 10)', i), '(2 3 5 7 11 13 17 19 23 29)');
  assert.equal(val('(stream-head fibs 12)', i), '(0 1 1 2 3 5 8 13 21 34 55 89)');
  assert.equal(val('(stream-ref integers 99)', i), '100');
});

test('a small evaluator written in Scheme evaluates programs (including recursion)', () => {
  const i = newInterp();
  const evaluator = `
    (define (m-eval exp env)
      (cond ((number? exp) exp)
            ((string? exp) exp)
            ((boolean? exp) exp)
            ((symbol? exp) (m-lookup exp env))
            ((eq? (car exp) 'quote) (cadr exp))
            ((eq? (car exp) 'if)
             (if (m-eval (cadr exp) env) (m-eval (caddr exp) env) (m-eval (cadddr exp) env)))
            ((eq? (car exp) 'lambda) (list 'closure (cadr exp) (cddr exp) env))
            ((eq? (car exp) 'define)
             (if (pair? (cadr exp))
                 (m-define! (caadr exp) (list 'closure (cdadr exp) (cddr exp) env) env)
                 (m-define! (cadr exp) (m-eval (caddr exp) env) env))
             'ok)
            ((eq? (car exp) 'set!) (m-set! (cadr exp) (m-eval (caddr exp) env) env) 'ok)
            ((eq? (car exp) 'begin) (m-eval-seq (cdr exp) env))
            ((eq? (car exp) 'cond) (m-eval-cond (cdr exp) env))
            (else (m-apply (m-eval (car exp) env) (map (lambda (e) (m-eval e env)) (cdr exp))))))
    (define (m-eval-seq exps env)
      (if (null? (cdr exps)) (m-eval (car exps) env)
          (begin (m-eval (car exps) env) (m-eval-seq (cdr exps) env))))
    (define (m-eval-cond clauses env)
      (cond ((null? clauses) #f)
            ((eq? (caar clauses) 'else) (m-eval-seq (cdar clauses) env))
            ((m-eval (caar clauses) env) (m-eval-seq (cdar clauses) env))
            (else (m-eval-cond (cdr clauses) env))))
    (define (m-apply f args)
      (cond ((eq? (car f) 'primitive) (apply (cadr f) args))
            ((eq? (car f) 'closure)
             (m-eval-seq (caddr f) (cons (make-frame (cadr f) args) (cadddr f))))
            (else (error "Unknown procedure type" f))))
    (define (make-frame vars vals) (cons 'frame (map cons vars vals)))
    (define (frame-lookup var frame) (assq var (cdr frame)))
    (define (m-lookup var env)
      (if (null? env) (error "Unbound variable" var)
          (let ((b (frame-lookup var (car env))))
            (if b (cdr b) (m-lookup var (cdr env))))))
    (define (m-define! var val env)
      (let ((b (frame-lookup var (car env))))
        (if b (set-cdr! b val) (set-cdr! (car env) (cons (cons var val) (cdr (car env)))))))
    (define (m-set! var val env)
      (if (null? env) (error "Unbound variable -- SET!" var)
          (let ((b (frame-lookup var (car env))))
            (if b (set-cdr! b val) (m-set! var val (cdr env))))))
    (define (make-global-env)
      (list (make-frame '(+ - * = < car cdr cons null? list)
                        (map (lambda (p) (list 'primitive p)) (list + - * = < car cdr cons null? list)))))
    (define (run exp) (m-eval exp (make-global-env)))
  `;
  assert.equal(val(evaluator + "(run '(+ 1 2))", i), '3');
  assert.equal(val("(run '((lambda (x y) (* x y)) 6 7))", i), '42');
  assert.equal(val("(run '(begin (define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2))))) (fib 15)))", i), '610');
  assert.equal(val(`(run '(begin
        (define (map f l) (if (null? l) (quote ()) (cons (f (car l)) (map f (cdr l)))))
        (define (make-counter) ((lambda (n) (lambda () (begin (set! n (+ n 1)) n))) 0))
        (define c (make-counter))
        (c) (c)
        (list (c) (map (lambda (x) (* x x)) (list 1 2 3)))))`, i), '(3 (1 4 9))');
  assert.equal(val("(run '(undefined-name))", i), ';Unbound variable undefined-name');
});

test('amb-style backtracking built from call/cc', () => {
  const i = newInterp();
  const src = `
    (define fail-stack '())
    (define (fail) (if (null? fail-stack) (error "no more choices") (let ((back (car fail-stack))) (set! fail-stack (cdr fail-stack)) (back back))))
    (define (amb choices)
      (let ((cc (call/cc (lambda (k) k))))
        (if (null? choices)
            (fail)
            (let ((choice (car choices)))
              (set! choices (cdr choices))
              (set! fail-stack (cons cc fail-stack))
              choice))))
    (define (require p) (if (not p) (fail)))
    (define (pythag)
      (let* ((a (amb '(1 2 3 4 5 6 7 8 9 10 11 12 13)))
             (b (amb '(1 2 3 4 5 6 7 8 9 10 11 12 13)))
             (c (amb '(1 2 3 4 5 6 7 8 9 10 11 12 13))))
        (require (< a b))
        (require (= (+ (* a a) (* b b)) (* c c)))
        (list a b c)))
  `;
  assert.equal(val(src + '(pythag)', i), '(3 4 5)');
});
