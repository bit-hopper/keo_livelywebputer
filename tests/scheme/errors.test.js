import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newInterp, val, run } from './helpers.js';

const cases = (pairs, interp) => { for (const [src, want] of pairs) assert.equal(val(src, interp), want, src); };

test('uncaught errors are reported in classic REPL style', () => {
  const i = newInterp();
  cases([
    ['(error "Something went wrong:" 42 (quote foo) "str" (list 1 2))', ';Something went wrong: 42 foo "str" (1 2)'],
    ["(error 'my-proc \"bad thing\" 7)", ';my-proc "bad thing" 7'],
    ['(error "no irritants")', ';no irritants'],
    ['(car (quote ()))', ';The object (), passed as the first argument to car, is not the correct type.'],
    ['(vector-ref (vector 1) 1)', ';The object 1, passed as the second argument to vector-ref, is not in the correct range.'],
    ['(undefined-thing)', ';Unbound variable: undefined-thing'],
    ['("notproc" 1)', ';The object "notproc" is not applicable.'],
    ['((lambda (a b) a) 1)', ';The procedure #[compound-procedure 12] has been called with 1 argument; it requires exactly 2 arguments.'],
    ['(define (f a #!optional b) a) (f)', ';The procedure #[compound-procedure 13 f] has been called with 0 arguments; it requires between 1 and 2 arguments.'],
    ['(define (g a . r) a) (g)', ';The procedure #[compound-procedure 14 g] has been called with 0 arguments; it requires at least 1 argument.'],
    ['(car 1 2)', ';The procedure #[compiled-procedure 15 ("car" #x10) #xbc car] has been called with 2 arguments; it requires exactly 1 argument.'],
    ['(raise 42)', ';The object 42, passed as the first argument to raise, is not the correct type.'],
    ['(assert (= 1 2))', ';Assertion failed'],
    ['(string-ref "abc" 10)', ';The object 10, passed as the second argument to string-ref, is not in the correct range.'],
    ['(length 5)', ';The object 5, passed as the first argument to length, is not the correct type.'],
    ["(length '(1 2 . 3))", ';The object (1 2 . 3), passed as the first argument to length, is not the correct type.'],
    ['(hash-table-ref (make-equal-hash-table) 1)', ';key not found: 1'],
    ['(symbol->string 5)', ';The object 5, passed as the first argument to symbol->string, is not the correct type.'],
  ], i);
});

test('an error stops the cell: later forms do not run, earlier output is kept', () => {
  const i = newInterp();
  const out = run('(display "before") (car 5) (display "after")', i);
  assert.match(out, /^out:before\|;The object 5/);
  assert.ok(!out.includes('after'));
});

test('guard catches errors and raised objects', () => {
  const i = newInterp();
  cases([
    ['(guard (e (#t (condition/report-string e))) (error "boom" 1 2))', '"boom 1 2"'],
    ['(guard (e ((string? e) (string-append "s:" e)) ((symbol? e) e)) (raise (quote sym)))', 'sym'],
    ['(guard (e ((string? e) (string-append "s:" e))) (raise "x"))', '"s:x"'],
    ['(guard (e ((error? e) (error-object-message e))) (error "msg" 1))', '"msg"'],
    ['(guard (e ((error? e) (error-object-irritants e))) (error "msg" 1 2))', '(1 2)'],
    ['(guard (e (#t (condition/report-string e))) (car 5))', '"The object 5, passed as the first argument to car, is not the correct type."'],
    ['(guard (e (#t (condition/report-string e))) (undefined-fn))', '"Unbound variable: undefined-fn"'],
    ['(guard (e (#t (condition/report-string e))) (/ 1 0))', '"Division by zero signalled by /."'],
    ['(guard (e (#t (quote caught))) (vector-ref (vector) 0))', 'caught'],
    ['(guard (e (#f 1)) (raise (quote unhandled)))', ';The object unhandled, passed as the first argument to raise, is not the correct type.'],
    ['(guard (e ((symbol? e) (list e 1))) (guard (e2 ((string? e2) 2)) (raise (quote inner))))', '(inner 1)'],
    ['(guard (e (#t (list (quote outer) e))) (guard (e2 ((string? e2) 2)) (raise 7)))', '(outer 7)'],
    ['(guard (e ((assq (quote a) e) => cdr) ((assq (quote b) e))) (raise (list (cons (quote a) 42))))', '42'],
    ['(guard (e (#t 1)) 5)', '5'],
    ['(guard (e (else (quote else-clause))) (raise 1))', 'else-clause'],
  ], i);
});

test('guard body runs in tail position relative to nothing special, with values passthrough', () => {
  const i = newInterp();
  cases([
    ['(call-with-values (lambda () (guard (e (#t 0)) (values 1 2))) list)', '(1 2)'],
    ['(define (loop n) (guard (e (#t (quote caught))) (if (= n 0) (raise 1) (loop (- n 1))))) (loop 1000)', 'caught'],
  ], i);
});

test('with-exception-handler and raise-continuable', () => {
  const i = newInterp();
  cases([
    ['(with-exception-handler (lambda (e) 10) (lambda () (+ 1 (raise-continuable (quote c)))))', '11'],
    ['(with-exception-handler (lambda (e) 0) (lambda () (raise-continuable 1) (quote after)))', 'after'],
    // handler returning from a non-continuable raise is itself an error
    ['(with-exception-handler (lambda (e) 0) (lambda () (raise (quote oops))))', ';Exception handler returned from non-continuable raise'],
    ['(with-exception-handler (lambda (e) 0) (lambda () (error "x")))', ';Exception handler returned from non-continuable raise'],
    // escaping out of a handler
    ['(call/cc (lambda (k) (with-exception-handler (lambda (e) (k (list (quote escaped) e))) (lambda () (raise (quote boom))))))', '(escaped boom)'],
    ['(call/cc (lambda (k) (with-exception-handler (lambda (e) (k (condition/report-string e))) (lambda () (car 7)))))', '"The object 7, passed as the first argument to car, is not the correct type."'],
    // nested handlers: inner handler runs with the outer handler in place
    ['(call/cc (lambda (k) (with-exception-handler (lambda (e) (k (list (quote outer) e))) (lambda () (with-exception-handler (lambda (e) (raise (list (quote wrapped) e))) (lambda () (raise 1)))))))', '(outer (wrapped 1))'],
  ], i);
});

test('error-object accessors and predicates', () => {
  const i = newInterp();
  cases([
    ['(error? (guard (e (#t e)) (error "x")))', '#t'], ['(error-object? 5)', '#f'],
    ['(error-object-message (guard (e (#t e)) (error "the message" 1)))', '"the message"'],
    ['(access-condition (guard (e (#t e)) (error "m" 1 2)) (quote irritants))', '(1 2)'],
    ['(condition/report-string (guard (e (#t e)) (raise-continuable (guard (e2 (#t e2)) (error "deep" 9)))))', '"deep 9"'],
  ], i);
});

test('errors inside handlers and dynamic-wind', () => {
  const i = newInterp();
  cases([
    ["(define log '()) (guard (e (#t (set! log (cons 'caught log)))) (dynamic-wind (lambda () (set! log (cons 'in log))) (lambda () (error \"x\")) (lambda () (set! log (cons 'out log))))) (reverse log)", '(in out caught)'],
  ], i);
});

test('the interpreter keeps working after any error', () => {
  const i = newInterp();
  run('(car 1)', i);
  run('(error "x")', i);
  run('(raise (quote y))', i);
  assert.equal(val('(+ 1 2)', i), '3');
});
