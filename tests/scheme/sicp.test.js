// SICP-dialect corpora: our own transcriptions of the kind of definitions the
// text builds up, loaded into a fresh interpreter (first line `#lang sicp`) and
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
  return i;
}

test('library: nil, put and get', () => {
  const i = newInterp();
  assert.equal(val("#lang sicp\n(list nil (null? nil))", i), '(() #t)');
  assert.equal(val("(put 'op '(a b) 42)", i), '');
  assert.equal(val("(get 'op '(a b))", i), '42');
  assert.equal(val("(get 'op '(a c))", i), '#f');
  assert.equal(val("(get 'other '(a b))", i), '#f');
  assert.equal(val("(put 'op '(a b) 43) (get 'op '(a b))", i), '43');
  // keys compare structurally, as the book's table does with equal?
  assert.equal(val("(put 'f (list 'x 'y) 'hit) (get 'f (list 'x 'y))", i), 'hit');
});

test('chapter 1: procedures and higher-order procedures', () => {
  check('sicp-1', [
    ['(< (abs (- (newton-sqrt 9) 3)) 0.01)', '#t'],
    ['(average 1 2)', '3/2'],
    ['(fast-expt 2 10)', '1024'],
    ['(fast-expt 3 5)', '243'],
    ['(fast-expt 2 100)', '1267650600228229401496703205376'],
    ['(gcd* 206 40)', '2'],
    ['(fib 10)', '55'],
    ['(fib 100)', '354224848179261915075'],
    ['(count-change 100)', '292'],
    ['(pascal 4 2)', '6'],
    ['(smallest-divisor 199)', '199'],
    ['(smallest-divisor 19999)', '7'],
    ['(list (prime? 97) (prime? 91) (prime? 1))', '(#t #f #f)'],
    ['(expmod 2 10 1000)', '24'],
    ['(fermat-test 561 5)', '#t'],
    ['(sum-cubes 1 10)', '3025'],
    ['(sum-iter cube 1 inc 10)', '3025'],
    ['(< (abs (- (integral cube 0 1 0.01) 0.25)) 0.001)', '#t'],
    ['(factorial 20)', '2432902008176640000'],
    ['(factorial 25)', '15511210043330985984000000'],
    ['(accumulate-range + 0 (lambda (x) x) 1 inc 100)', '5050'],
    ['(< (abs (- (fixed-point cos 1.0) 0.7390851)) 0.0001)', '#t'],
    ['((repeated square 2) 5)', '625'],
    ['(< (abs (- (newtons-method (lambda (y) (- (square y) 2)) 1.0) 1.41421356)) 0.0001)', '#t'],
    ['(church->int (add-1 (add-1 zero)))', '2'],
    // tail calls: a long iterative process
    ['(sum-iter (lambda (x) x) 1 inc 100000)', '5000050000'],
  ]);
});

test('chapter 2: data abstraction, sequences, symbolic data, generic operations', () => {
  const i = check('sicp-2', [
    ['(rat->string (make-rat 6 -8))', '"-3/4"'],
    ['(rat->string (add-rat (make-rat 1 2) (make-rat 1 3)))', '"5/6"'],
    ['(rat->string (mul-rat (make-rat 2 3) (make-rat 3 4)))', '"1/2"'],
    ['(car* (cons* 1 2))', '1'],
    ['(cdr* (cons* 1 2))', '2'],
    ['(add-interval (make-interval 1 2) (make-interval 3 4))', '(4 . 6)'],
    ['(mul-interval (make-interval -1 2) (make-interval 3 4))', '(-4 . 8)'],
    ["(accumulate + 0 '(1 2 3 4 5))", '15'],
    ["(accumulate cons nil '(1 2 3))", '(1 2 3)'],
    ['(enumerate-interval 1 5)', '(1 2 3 4 5)'],
    ['(flatmap (lambda (i) (map (lambda (j) (list i j)) (enumerate-interval 1 (- i 1)))) (enumerate-interval 1 3))', '((2 1) (3 1) (3 2))'],
    ["(count-leaves '((1 2) (3 (4 5))))", '5'],
    ["(deep-reverse '((1 2) (3 4)))", '((4 3) (2 1))'],
    ["(fringe '(1 (2 (3 4)) 5))", '(1 2 3 4 5)'],
    ["(subsets '(1 2 3))", '(() (3) (2) (2 3) (1) (1 3) (1 2) (1 2 3))'],
    ["(accumulate-n + 0 '((1 2 3) (4 5 6) (7 8 9) (10 11 12)))", '(22 26 30)'],
    ["(dot-product '(1 2 3) '(4 5 6))", '32'],
    ["(matrix-*-vector '((1 2) (3 4)) '(1 1))", '(3 7)'],
    ["(transpose '((1 2 3) (4 5 6)))", '((1 4) (2 5) (3 6))'],
    ["(matrix-*-matrix '((1 2) (3 4)) '((5 6) (7 8)))", '((19 22) (43 50))'],
    ['(length (queens 6))', '4'],
    ['(length (queens 8))', '92'],
    ["(deriv '(+ x 3) 'x)", '1'],
    ["(deriv '(* x y) 'x)", 'y'],
    ["(deriv '(* (* x y) (+ x 3)) 'x)", '(+ (* x y) (* y (+ x 3)))'],
    ["(deriv '(^ x 2) 'x)", ';unknown expression type -- DERIV (^ x 2)'],
    ["(element-of-set? 3 '(1 2 3))", '#t'],
    ["(intersection-set '(1 3 5 7) '(3 4 5 6 7))", '(3 5 7)'],
    ["(tree->list (fold-left (lambda (t x) (tree-insert x t)) '() '(5 3 8 1 4 7 9 3)))", '(1 3 4 5 7 8 9)'],
    ["(decode '(0 1 1 0 0 1 0 1 0 1 1 1 0) sample-tree)", '(A D A B B C A)'],
    ['(weight sample-tree)', '8'],
    ['(symbols sample-tree)', '(A B D C)'],
    ["(install-rectangular-package)", 'done'],
    ["(install-polar-package)", 'done'],
    ["(real-part (cons 'rectangular (cons 3 4)))", '3'],
    ["(magnitude (cons 'rectangular (cons 3 4)))", '5'],
    ["(magnitude ((get 'make-from-mag-ang 'polar) 2 0))", '2'],
    ["(apply-generic 'magnitude 5)", ';Bad tagged datum -- TYPE-TAG 5'],
  ]);
  assert.match(val("(apply-generic 'real-part (cons 'nope 1))", i), /^;No method for these types -- APPLY-GENERIC \(real-part \(nope\)\)/);
});

test('chapter 3: state, queues, tables, the circuit simulator, streams', () => {
  const i = loaded('sicp-3');
  const t = (src, want) => assert.equal(val(src, i), want, src);
  t('(define acc (make-account 100))', '');
  t("((acc 'withdraw) 50)", '50');
  t("((acc 'withdraw) 60)", '"Insufficient funds"');
  t("((acc 'deposit) 40)", '90');
  t("(acc 'transfer)", ';Unknown request -- MAKE-ACCOUNT transfer');
  t('(define A (make-accumulator 5))', '');
  t('(A 10)', '15');
  t('(A 10)', '25');
  t('(define s (make-monitored sqrt))', '');
  t('(s 100)', '10');
  t("(s 'how-many-calls?)", '1');
  t("(s 'reset-count)", 'reset');
  t("(s 'how-many-calls?)", '0');
  t('(rand)', '1250496027');
  t('(= (rand) (rand))', '#f');

  t('(define q (make-queue))', '');
  t("(insert-queue! q 'a)", '((a) a)');
  t("(insert-queue! q 'b)", '((a b) b)');
  t('(delete-queue! q)', '((b) b)');
  t('(front-queue q)', 'b');
  t('(delete-queue! q)', '(() b)');
  t('(front-queue q)', ';FRONT called with an empty queue (() b)');

  t('(define tbl (make-table))', '');
  t("((tbl 'insert-proc!) 'a 'b 1)", 'ok');
  t("((tbl 'insert-proc!) 'a 'c 2)", 'ok');
  t("((tbl 'lookup-proc) 'a 'b)", '1');
  t("((tbl 'lookup-proc) 'a 'c)", '2');
  t("((tbl 'lookup-proc) 'a 'z)", '#f');
  t("((tbl 'lookup-proc) 'z 'b)", '#f');

  t('(define a (make-wire)) (define b (make-wire)) (define sum (make-wire)) (define c (make-wire))', '');
  t('(half-adder a b sum c)', 'ok');
  t('(set-signal! a 1) (propagate)', 'done');
  t('(list (get-signal sum) (get-signal c) (current-time the-agenda))', '(1 0 8)');
  t('(set-signal! b 1) (propagate)', 'done');
  t('(list (get-signal sum) (get-signal c) (current-time the-agenda))', '(0 1 16)');

  // streams, using the corpus's own stream-map / stream-ref / stream-filter
  t('(stream-ref integers 99)', '100');
  t('(stream-take integers2 5)', '(1 2 3 4 5)');
  t('(stream-take fibs 10)', '(0 1 1 2 3 5 8 13 21 34)');
  t('(stream-ref primes 49)', '229');
  t('(stream-ref factorials 10)', '3628800');
  t('(stream-take (partial-sums integers) 5)', '(1 3 6 10 15)');
  t('(< (abs (- (stream-ref (sqrt-stream 2) 5) 1.41421356)) 0.000001)', '#t');
  t('(< (abs (- (stream-ref (solve (lambda (y) y) 1 0.001) 1000) 2.716923932)) 0.00001)', '#t');
  // delay / force memoise
  t('(define n 0)', '');
  t('(define p (delay (begin (set! n (+ n 1)) n)))', '');
  t('(force p) (force p) n', '1');
});

// ---- milestone: the evaluator written in Scheme ---------------------------

const evalSource = corpus('sicp-4-eval');
const FORMS = `
(define (eval-forms forms env)
  (if (null? (cdr forms))
      (eval (car forms) env)
      (begin (eval (car forms) env) (eval-forms (cdr forms) env))))
(define (run-forms forms) (eval-forms forms (setup-environment)))
`;

function evaluatorInterp() {
  const i = newInterp();
  assert.equal(run('#lang sicp\n' + evalSource + FORMS, i), '');
  return i;
}

test('evaluator: runs programs written in the subset', () => {
  const i = evaluatorInterp();
  const t = (src, want) => assert.equal(val(src, i), want, src);
  t("(eval '(+ 1 2) the-global-environment)", '3');
  t("(run-forms '((define (fact n) (if (= n 0) 1 (* n (fact (- n 1))))) (fact 10)))", '3628800');
  t("(run-forms '((define (map f l) (if (null? l) '() (cons (f (car l)) (map f (cdr l))))) (map (lambda (x) (* x x)) '(1 2 3))))", '(1 4 9)');
  t("(run-forms '((define (make-counter) (let ((n 0)) (lambda () (set! n (+ n 1)) n))) (define c (make-counter)) (c) (c) (c)))", '3');
  t("(run-forms '((define (f x) (cond ((< x 0) 'neg) ((= x 0) 'zero) (else 'pos))) (list (f -1) (f 0) (f 5))))", '(neg zero pos)');
  t("(run-forms '((define x 1) (set! x (+ x 41)) x))", '42');
  t("(run-forms '((define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2))))) (fib 15)))", '610');
  t("(run-forms '(zzz))", ';Unbound variable zzz');
  assert.match(val("(run-forms '((car 5)))", i), /^;The object 5, passed as the first argument to car/);
  t("(run-forms '((5 5)))", ';Unknown procedure type -- APPLY 5');
  t("(run-forms '(((lambda (x) x))))", ';Too few arguments supplied (x) ()');
  // a user cell can still reach the saved original through its alias
  t("(apply-in-underlying-scheme + '(1 2 3))", '6');
});

test('evaluator: evaluates itself evaluating a program', () => {
  const i = evaluatorInterp();
  const t0 = Date.now();
  // the evaluator's own source, quoted as data, loaded into an environment of the evaluator;
  // `apply` in that environment is a primitive that understands the evaluator's own
  // procedure objects, so the inner evaluator's primitive calls can be forwarded
  const setup = `
(define evaluator-forms '(${evalSource}))
(define meta-env (setup-environment))
(define-variable! 'apply
  (list 'primitive (lambda (proc args) (apply proc args)))
  meta-env)
(eval-forms evaluator-forms meta-env)
`;
  assert.equal(run(setup, i), 'ok'); // the last form is a definition inside the evaluator
  const t = (src, want) => assert.equal(val(src, i), want, src);
  t("(eval '(+ 1 2) meta-env)", '3'); // sanity: the outer evaluator works on meta-env
  t("(eval '(eval '(* 6 7) the-global-environment) meta-env)", '42');
  t("(eval '(eval '((lambda (x) (* x x)) 12) the-global-environment) meta-env)", '144');
  t("(eval '(eval '(begin (define (f n) (if (= n 0) 1 (* n (f (- n 1))))) (f 6)) the-global-environment) meta-env)", '720');
  t("(eval '(eval '(zzz) the-global-environment) meta-env)", ';Unbound variable zzz');
  console.log('# self-hosting checks took', Date.now() - t0, 'ms');
});

// ---- milestone: the nondeterministic evaluator -----------------------------

const ambSource = corpus('sicp-4-amb');
function ambInterp() {
  const i = newInterp();
  assert.equal(run('#lang sicp\n' + evalSource + '\n' + ambSource, i), '');
  return i;
}

const REQUIRE = `
 (define (require p) (if (not p) (amb)))
 (define (an-element-of items)
   (require (not (null? items)))
   (amb (car items) (an-element-of (cdr items))))
 (define (an-integer-between low high)
   (require (<= low high))
   (amb low (an-integer-between (+ low 1) high)))`;

test('amb evaluator: choices, require, backtracking', () => {
  const i = ambInterp();
  const solve = (...forms) => val(`(amb-solve '(${forms.join('\n')}))`, i);
  assert.equal(solve('(amb 1 2 3)'), '(1 2 3)');
  assert.equal(solve('(amb)'), '()');
  assert.equal(solve(REQUIRE, '(let ((x (an-element-of (list 1 2 3 4 5 6)))) (require (even? x)) (* x x))'), '(4 16 36)');
  assert.equal(solve(REQUIRE, `
    (define (a-pythagorean-triple-between low high)
      (let ((i (an-integer-between low high)))
        (let ((j (an-integer-between i high)))
          (let ((k (an-integer-between j high)))
            (require (= (+ (* i i) (* j j)) (* k k)))
            (list i j k)))))
    (a-pythagorean-triple-between 3 20)`),
  '((3 4 5) (5 12 13) (6 8 10) (8 15 17) (9 12 15) (12 16 20))');
  // assignments are undone on backtracking
  assert.equal(solve(REQUIRE, '(define count 0)',
    '(let ((x (amb 1 2 3))) (set! count (+ count 1)) (require (= x 3)) (list x count))'), '((3 1))');
  // and / or, and sequences of definitions
  assert.equal(solve('(define (f x) (or (and (> x 5) (quote big)) (and (< x 0) (quote neg)) (quote small)))',
    '(list (f (amb 7 -1 2)))'), '((big) (neg) (small))');
});

test('amb evaluator: the multiple-dwelling puzzle', () => {
  const i = ambInterp();
  const t0 = Date.now();
  const got = val(`(amb-solve '(${REQUIRE}
    (define (distinct? items)
      (cond ((null? items) true)
            ((null? (cdr items)) true)
            ((member (car items) (cdr items)) false)
            (else (distinct? (cdr items)))))
    (define (multiple-dwelling)
      (let ((baker (amb 1 2 3 4 5)) (cooper (amb 1 2 3 4 5))
            (fletcher (amb 1 2 3 4 5)) (miller (amb 1 2 3 4 5))
            (smith (amb 1 2 3 4 5)))
        (require (distinct? (list baker cooper fletcher miller smith)))
        (require (not (= baker 5)))
        (require (not (= cooper 1)))
        (require (not (= fletcher 5)))
        (require (not (= fletcher 1)))
        (require (> miller cooper))
        (require (not (= (abs (- smith fletcher)) 1)))
        (require (not (= (abs (- fletcher cooper)) 1)))
        (list (list 'baker baker) (list 'cooper cooper) (list 'fletcher fletcher)
              (list 'miller miller) (list 'smith smith))))
    (multiple-dwelling)))`, i);
  assert.equal(got, '(((baker 3) (cooper 2) (fletcher 4) (miller 5) (smith 1)))');
  console.log('# multiple-dwelling took', Date.now() - t0, 'ms');
});

test('amb evaluator: parsing a sentence by backtracking over input consumption', () => {
  const i = ambInterp();
  const program = `(amb-solve '(${REQUIRE}
    (define nouns '(noun student professor cat class))
    (define verbs '(verb studies lectures eats sleeps))
    (define articles '(article the a))
    (define unparsed '())
    (define (parse-word word-list)
      (require (not (null? unparsed)))
      (require (memq (car unparsed) (cdr word-list)))
      (let ((found-word (car unparsed)))
        (set! unparsed (cdr unparsed))
        (list (car word-list) found-word)))
    (define (parse-noun-phrase) (list 'noun-phrase (parse-word articles) (parse-word nouns)))
    (define (parse-sentence) (list 'sentence (parse-noun-phrase) (parse-word verbs)))
    (define (parse input)
      (set! unparsed input)
      (let ((sent (parse-sentence)))
        (require (null? unparsed))
        sent))
    (parse '(the cat eats))))`;
  assert.equal(val(program, i), '((sentence (noun-phrase (article the) (noun cat)) (verb eats)))');
  assert.equal(val(program.replace("'(the cat eats)", "'(the cat)"), i), '()');
});

// ---- milestone: the register-machine simulator -----------------------------

test('register machines: gcd, factorial with stack statistics, fibonacci', () => {
  const i = loaded('sicp-5-regs');
  const t = (src, want) => assert.equal(val(src, i), want, src);
  t("(run-machine gcd-machine '((a 206) (b 40)) 'a)", '2');
  // the same machine runs again with new inputs
  t("(run-machine gcd-machine '((a 17) (b 5)) 'a)", '1');
  // gcd of two Fibonacci numbers is the Fibonacci number at the gcd of the indices
  t("(run-machine gcd-machine (list (list 'a 354224848179261915075) (list 'b 12586269025)) 'a)", '12586269025');
  t("(run-machine fact-machine '((n 5)) 'val)", '120');
  // two pushes for each of the n-1 recursive levels, all outstanding at the deepest point
  t("((fact-machine 'stack) 'statistics)", '(8 8)');
  t("(run-machine fact-machine '((n 10)) 'val)", '3628800');
  t("((fact-machine 'stack) 'statistics)", '(18 18)');
  t("(run-machine fact-machine '((n 1)) 'val)", '1');
  t("((fact-machine 'stack) 'statistics)", '(0 0)');
  t("(run-machine fib-machine '((n 10)) 'val)", '55');
  t("(run-machine fib-machine '((n 20)) 'val)", '6765');
  t("(map (lambda (k) (run-machine fib-machine (list (list 'n k)) 'val)) '(0 1 2 3 4 5 6))", '(0 1 1 2 3 5 8)');
});

test('register machines: perform, long loops, errors', () => {
  const i = loaded('sicp-5-regs');
  const t = (src, want) => assert.equal(val(src, i), want, src);
  t("(set! recorded '()) (run-machine countdown-machine '((n 3)) 'n)", '0');
  t('recorded', '(3 2 1)');
  // 500,000 instructions through one execute loop: only proper tail calls get this far
  const t0 = Date.now();
  t("(run-machine sum-machine '((n 100000)) 'total)", '5000050000');
  console.log('# 100k-iteration machine took', Date.now() - t0, 'ms');
  t("(get-register-contents gcd-machine 'zzz)", ';Unknown register: zzz');
  t("(make-machine '(a) '() '((goto (label nowhere))))", ';Undefined label -- ASSEMBLE nowhere');
  t("(make-machine '(a) '() '((assign a (op nope) (const 1))))", ';Unknown operation -- ASSEMBLE nope');
  t("(make-machine '(a a) '() '())", ';Multiply defined register: a');
});
