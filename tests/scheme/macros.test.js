import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newInterp, val } from './helpers.js';

const cases = (pairs, interp) => { for (const [src, want] of pairs) assert.equal(val(src, interp), want, src); };

test('basic syntax-rules', () => {
  const i = newInterp();
  cases([
    ['(define-syntax inc! (syntax-rules () ((_ v) (set! v (+ v 1))) ((_ v n) (set! v (+ v n))))) (define x 1) (inc! x) (inc! x 10) x', '12'],
    ['(define-syntax unless2 (syntax-rules () ((_ c body ...) (if c #f (begin body ...))))) (unless2 #f 1 2 3)', '3'],
    ['(define-syntax my-list (syntax-rules () ((_ (a b) ...) (list (cons a b) ...)))) (my-list (1 2) (3 4))', '((1 . 2) (3 . 4))'],
    ['(define-syntax while (syntax-rules () ((_ c body ...) (let lp () (when c body ... (lp)))))) (define n 0) (while (< n 5) (set! n (+ n 1))) n', '5'],
    ['(define-syntax for (syntax-rules (in) ((_ x in lst body ...) (for-each (lambda (x) body ...) lst)))) (define acc 0) (for y in (list 1 2 3) (set! acc (+ acc y))) acc', '6'],
  ], i);
});

test('hygiene: introduced bindings do not capture user variables', () => {
  const i = newInterp();
  cases([
    ['(define-syntax swap! (syntax-rules () ((_ a b) (let ((tmp a)) (set! a b) (set! b tmp))))) (define tmp 1) (define other 2) (swap! tmp other) (list tmp other)', '(2 1)'],
    ['(define-syntax my-or (syntax-rules () ((_) #f) ((_ e) e) ((_ e r ...) (let ((t e)) (if t t (my-or r ...)))))) (let ((t 5)) (my-or #f t))', '5'],
    // introduced references keep their global meaning even if the user shadows them locally
    ['(define-syntax my-if (syntax-rules () ((_ c a b) (cond (c a) (else b))))) (let ((else #f)) (my-if #f 1 2))', '2'],
    ['(define-syntax add-one (syntax-rules () ((_ e) (+ 1 e)))) (let ((+ -)) (add-one 5))', '6'],
  ], i);
});

test('ellipsis: nested, tail patterns, literals, dotted', () => {
  const i = newInterp();
  cases([
    ['(define-syntax my-let* (syntax-rules () ((_ () body ...) (let () body ...)) ((_ ((n v) rest ...) body ...) (let ((n v)) (my-let* (rest ...) body ...))))) (my-let* ((a 1) (b (+ a 1)) (c (* b 2))) (list a b c))', '(1 2 4)'],
    ['(define-syntax nest (syntax-rules () ((_ ((a b ...) ...)) (quote ((b ... a) ...))))) (nest ((1 2 3) (4 5)))', '((2 3 1) (5 4))'],
    ['(define-syntax last-of (syntax-rules () ((_ a ... z) z))) (last-of 1 2 3 4)', '4'],
    ['(define-syntax butlast (syntax-rules () ((_ a ... z) (quote (a ...))))) (butlast 1 2 3 4)', '(1 2 3)'],
    ['(define-syntax lit (syntax-rules (=>) ((_ a => b) (cons a b)) ((_ a b c) (list a b c)))) (list (lit 1 => 2) (lit 1 2 3))', '((1 . 2) (1 2 3))'],
    ['(define-syntax dotted (syntax-rules () ((_ a . b) (quote (a b))))) (dotted 1 2 3)', '(1 (2 3))'],
    ['(define-syntax vec-m (syntax-rules () ((_ #(a b)) (+ a b)))) (vec-m #(1 2))', '3'],
    ['(define-syntax ell-escape (syntax-rules () ((_ a) (quote (a (... ...)))))) (ell-escape 5)', '(5 ...)'],
  ], i);
});

test('recursive macros and macro-defining macros', () => {
  const i = newInterp();
  cases([
    ['(define-syntax my-and (syntax-rules () ((_) #t) ((_ e) e) ((_ e r ...) (if e (my-and r ...) #f)))) (list (my-and) (my-and 1 2 3) (my-and 1 #f 3))', '(#t 3 #f)'],
    ['(define-syntax def-getter (syntax-rules () ((_ name val) (define (name) val)))) (def-getter get-five 5) (get-five)', '5'],
    ['(define-syntax def-macro (syntax-rules () ((_ name v) (define-syntax name (syntax-rules () ((_) v)))))) (def-macro seven 7) (seven)', '7'],
  ], i);
});

test('macros in local scope', () => {
  const i = newInterp();
  cases([
    ['(define (f) (define-syntax double (syntax-rules () ((_ e) (* 2 e)))) (double 21)) (f)', '42'],
    ['(let-syntax ((sq (syntax-rules () ((_ x) (* x x))))) (sq 7))', '49'],
    ['(letrec-syntax ((ev? (syntax-rules () ((_ n) (= 0 (modulo n 2)))))) (ev? 10))', '#t'],
    ['(define (g y) (define-syntax add-y (syntax-rules () ((_ e) (+ e y)))) (add-y 1)) (g 10)', '11'],
  ], i);
});

test('macro that expands into internal definitions', () => {
  const i = newInterp();
  cases([
    ['(define-syntax def2 (syntax-rules () ((_ a b v) (begin (define a v) (define b v))))) (define (f) (def2 p q 3) (+ p q)) (f)', '6'],
  ], i);
});

test('no matching rule is a syntax error', () => {
  const i = newInterp();
  cases([
    ['(define-syntax one-arg (syntax-rules () ((_ a) a))) (one-arg 1 2)', ';Ill-formed special form: (one-arg 1 2)'],
  ], i);
});

test('define-record-type', () => {
  const i = newInterp();
  cases([
    ['(define-record-type point (make-point x y) point? (x point-x) (y point-y set-point-y!)) (define p (make-point 3 4)) (list (point-x p) (point-y p) (point? p) (point? 5))', '(3 4 #t #f)'],
    ['(set-point-y! p 10) (point-y p)', '10'],
    ['(point-x 5)', ';The object 5, passed as the first argument to point-x, is not the correct type.'],
    ['(define-record-type <thing> (make-thing a) thing? (a thing-a) (b thing-b set-thing-b!)) (define t (make-thing 1)) (list (thing-a t) (thing-b t))', '(1 #f)'],
    ['(display-to-string-check)', ';Unbound variable: display-to-string-check'],
  ], i);
});
