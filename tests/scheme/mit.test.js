// MIT-flavoured extras: trace/untrace, define-structure, and (the-environment)
// inside procedures with eval. Expected values are worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newInterp, run, val, stdout } from './helpers.js';

// Object hash numbers come from a counter shared by the whole process, so the
// exact number depends on test order; normalise it.
const norm = (s) => s.replace(/(compound-procedure )\d+/g, '$1N').replace(/(#\[\w[\w-]* )\d+\]/g, '$1N]');

const FIB = '(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))\n';

// ---- trace / untrace --------------------------------------------------------

test('trace: reports each call and result, and the result is unchanged', () => {
  const i = newInterp();
  run(FIB + '(trace fib)', i);
  const out = norm(stdout('(fib 2)', i));
  assert.equal(out, [
    '[Entering #[compound-procedure N fib]',
    '    Args: 2]',
    '[Entering #[compound-procedure N fib]',
    '    Args: 1]',
    '[1',
    '      <== #[compound-procedure N fib]',
    '    Args: 1]',
    '[Entering #[compound-procedure N fib]',
    '    Args: 0]',
    '[0',
    '      <== #[compound-procedure N fib]',
    '    Args: 0]',
    '[1',
    '      <== #[compound-procedure N fib]',
    '    Args: 2]',
    '',
  ].join('\n'));
  assert.equal(val('(fib 2)', i), '1');
  // one "Entering" per call: calls(n) = 1 + calls(n-1) + calls(n-2), calls(0) = calls(1) = 1 -> 15 for n = 5
  const big = stdout('(fib 5)', i);
  assert.equal((big.match(/\[Entering/g) || []).length, 15);
  assert.equal(val('(fib 10)', i), '55');
});

test('trace: several arguments are aligned, no arguments print on one line', () => {
  const i = newInterp();
  run('(define (add a b c) (+ a b c)) (define (none) 7) (trace add none)', i);
  assert.equal(norm(stdout('(add 1 2 3)', i)), [
    '[Entering #[compound-procedure N add]',
    '    Args: 1',
    '          2',
    '          3]',
    '[6',
    '      <== #[compound-procedure N add]',
    '    Args: 1',
    '          2',
    '          3]',
    '',
  ].join('\n'));
  assert.equal(norm(stdout('(none)', i)), [
    '[Entering #[compound-procedure N none]]',
    '[7',
    '      <== #[compound-procedure N none]]',
    '',
  ].join('\n'));
});

test('trace: starts on a fresh line, untrace restores the original, tracing twice is harmless', () => {
  const i = newInterp();
  run(FIB, i);
  const original = val('fib', i);
  run('(trace fib)', i);
  assert.notEqual(val('fib', i), original);
  run('(trace fib)', i); // wrapping again must not nest wrappers
  const out = stdout('(display "x") (fib 1)', i);
  assert.match(out, /^x\n\[Entering /);
  assert.equal((out.match(/\[Entering/g) || []).length, 1);
  run('(untrace fib)', i);
  assert.equal(stdout('(fib 5)', i), '');
  assert.equal(val('(fib 5)', i), '5');
});

test('trace: errors and library safety', () => {
  const i = newInterp();
  assert.equal(val('(define x 5) (trace x)', i), ';Not a procedure -- TRACE x');
  assert.equal(val('(trace)', i), '');
  // a traced user procedure that raises still raises; the environment survives
  run('(define (boom n) (car n)) (trace boom)', i);
  assert.match(val('(boom 5)', i), /^;The object 5, passed as the first argument to car/);
  assert.equal(val('(+ 1 2)', i), '3');
  // tracing a procedure bound locally works through set!
  assert.equal(val('(define (g) (define (h x) (* x 2)) (trace h) (h 4)) (g)', i), '8');
});

// ---- define-structure -------------------------------------------------------

test('define-structure: constructor, predicate, accessors, modifiers', () => {
  const i = newInterp();
  run('(define-structure point x y)', i);
  const t = (src, want) => assert.equal(val(src, i), want, src);
  t('(define p (make-point 3 4)) (list (point-x p) (point-y p))', '(3 4)');
  t('(set-point-x! p 10) (point-x p)', '10');
  t('(set-point-y! p (+ (point-y p) 1)) (list (point-x p) (point-y p))', '(10 5)');
  t('(list (point? p) (point? 5) (point? (list 3 4)))', '(#t #f #f)');
  t('(map point-x (list (make-point 1 2) (make-point 5 6)))', '(1 5)');
  assert.equal(norm(val('p', i)), '#[point N]');
  // an accessor applied to something else is a wrong-type error naming the accessor
  assert.match(val('(point-x 5)', i), /^;The object 5, passed as the first argument to point-x, is not the correct type/);
  // two structures keep their own predicates
  run('(define-structure seg a b)', i);
  t('(list (seg? (make-seg 1 2)) (point? (make-seg 1 2)) (seg? p))', '(#t #f #f)');
});

test('define-structure: name forms, defaults, scope, and the unsupported option error', () => {
  const i = newInterp();
  const t = (src, want) => assert.equal(val(src, i), want, src);
  // the parenthesised name form without options, and fields written with defaults
  run('(define-structure (cell2) (val 0) next)', i);
  t('(define c (make-cell2 1 (quote z))) (list (cell2-val c) (cell2-next c))', '(1 z)');
  // a variable that has the structure's name is not clobbered
  run('(define coord 5) (define-structure coord lat lon)', i);
  t('coord', '5');
  t('(coord-lat (make-coord 1 2))', '1');
  // usable inside a procedure body
  t('(define (f) (define-structure pair2 l r) (let ((p (make-pair2 1 2))) (set-pair2-r! p 9) (list (pair2-l p) (pair2-r p)))) (f)', '(1 9)');
  // options are refused loudly rather than ignored
  assert.match(val('(define-structure (foo (conc-name f-)) a)', i), /^;define-structure options are not supported/);
  assert.match(val('(define-structure)', i), /^;Ill-formed special form/);
});

// ---- (the-environment) inside procedures -------------------------------------

test('the-environment: eval sees parameters, let variables, closures and globals', () => {
  const i = newInterp();
  const t = (src, want) => assert.equal(val(src, i), want, src);
  run('(define (mk a) (let ((b 2)) (the-environment)))\n(define e (mk 10))', i);
  t("(eval '(+ a b) e)", '12');
  t("(eval '(list a b (car (list a))) e)", '(10 2 10)'); // globals still reachable
  t("(eval '(if (> a 5) (quote big) (quote small)) e)", 'big'); // special forms still work
  t("(eval '(let loop ((k 0)) (if (< k a) (loop (+ k 1)) k)) e)", '10');
  // two activations keep separate variables
  run('(define e2 (mk 100))', i);
  t("(list (eval 'a e) (eval 'a e2))", '(10 100)');
  // a closure made by eval keeps the environment
  run("(define f (eval '(lambda (x) (+ x a b)) e))", i);
  t('(f 1)', '13');
  // nested scopes: the environment of an inner procedure includes the outer parameters
  t("(define (outer a) (lambda (b) (the-environment))) (eval '(list a b) ((outer 1) 2))", '(1 2)');
  // at the top level of a let
  t("(let ((x 1) (y 2)) (eval '(+ x y) (the-environment)))", '3');
  // a loop variable
  t("(do ((i 0 (+ i 1))) ((= i 3) (eval 'i (the-environment))))", '3');
  // internal definitions are visible
  t("(define (g) (define inner 3) (the-environment)) (eval 'inner (g))", '3');
});

test('the-environment: set! and define through eval', () => {
  const i = newInterp();
  const t = (src, want) => assert.equal(val(src, i), want, src);
  run(`(define (make-counter)
         (let ((n 0))
           (cons (lambda () (set! n (+ n 1)) n) (the-environment))))
       (define c (make-counter))`, i);
  t('((car c))', '1');
  t("(eval '(set! n 100) (cdr c))", '');
  t('((car c))', '101'); // the procedure sees the assignment made through eval
  t("(eval 'n (cdr c))", '101');
  // define of an existing name assigns it
  t("(eval '(define n 7) (cdr c)) ((car c))", '8');
  // define of a new name persists in that environment...
  t("(eval '(define extra 5) (cdr c))", '');
  t("(eval '(* extra n) (cdr c))", '40');
  // ...and a procedure defined there can use it
  t("(eval '(define (twice-extra) (* 2 extra)) (cdr c)) (eval '(twice-extra) (cdr c))", '10');
  // another activation does not see it as defined
  run('(define c2 (make-counter))', i);
  assert.match(val("(eval 'extra (cdr c2))", i), /^;Unassigned variable: extra/);
  t("(eval 'n (cdr c2))", '0');
});

test('the-environment: top level, errors, and forms that must not change', () => {
  const i = newInterp();
  const t = (src, want) => assert.equal(val(src, i), want, src);
  t('(define x 3) (eval (quote (* x x)) (the-environment))', '9');
  t('(eval (quote (+ 1 2)) system-global-environment)', '3');
  t('(eval (quote (+ 1 2)))', '3');
  assert.match(val('(eval 1 5)', i), /^;The object 5, passed as the second argument to eval, is not the correct type/);
  assert.match(val('(define (f) (the-environment 1)) (f)', i), /^;Ill-formed special form/);
  assert.match(val("(define (f a) (the-environment)) (eval 'zzz (f 1))", i), /^;Unbound variable: zzz/);
  // a procedure that captures its environment still runs in constant stack when it loops
  t('(define (loop n) (if (= n 0) (quote done) (loop (- n 1)))) (define (h) (the-environment) (loop 300000)) (h)', 'done');
});
