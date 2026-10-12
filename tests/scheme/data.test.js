import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newInterp, val, run } from './helpers.js';

const cases = (pairs, interp) => { for (const [src, want] of pairs) assert.equal(val(src, interp), want, src); };

test('pairs and lists', () => {
  const i = newInterp();
  cases([
    ["(cons 1 2)", '(1 . 2)'], ["(cons 1 '(2 3))", '(1 2 3)'], ["(car '(a b))", 'a'], ["(cdr '(a b))", '(b)'],
    ["(cadr '(1 2 3))", '2'], ["(cddr '(1 2 3))", '(3)'], ["(caddr '(1 2 3))", '3'], ["(cdddr '(1 2 3 4))", '(4)'], ["(caar '((1) 2))", '1'],
    ["(list 1 2 3)", '(1 2 3)'], ["(length '(1 2 3))", '3'], ["(length '())", '0'],
    ["(append '(1 2) '(3) '() '(4 5))", '(1 2 3 4 5)'], ["(append)", '()'], ["(append '(1) 2)", '(1 . 2)'],
    ["(reverse '(1 2 3))", '(3 2 1)'], ["(list-tail '(1 2 3 4) 2)", '(3 4)'], ["(list-ref '(a b c) 1)", 'b'],
    ["(list-copy '(1 2 3))", '(1 2 3)'], ["(last-pair '(1 2 3))", '(3)'], ["(list-head '(1 2 3 4) 2)", '(1 2)'],
    ["(memq 'c '(a b c d))", '(c d)'], ["(memq 'z '(a b))", '#f'], ["(member '(1) '((0) (1) (2)))", '((1) (2))'],
    ["(assq 'b '((a . 1) (b . 2)))", '(b . 2)'], ["(assoc 2.0 '((1 . a) (2 . b)) =)", '(2 . b)'], ["(assoc \"b\" '((\"a\" . 1) (\"b\" . 2)))", '("b" . 2)'],
    ["(member 2.0 '(1 2 3) =)", '(2 3)'],
    ["(iota 5)", '(0 1 2 3 4)'], ["(iota 3 1)", '(1 2 3)'], ["(list? '(1 2))", '#t'], ["(list? '(1 . 2))", '#f'], ["(pair? '())", '#f'], ["(null? '())", '#t'],
    ["(let ((p (list 1 2))) (set-car! p 9) (set-cdr! (cdr p) '(3)) p)", '(9 2 3)'],
    ["(first '(1 2 3))", '1'], ["(second '(1 2 3))", '2'], ["(third '(1 2 3))", '3'], ["(last '(1 2 3))", '3'],
    ["(delete 2 '(1 2 3 2))", '(1 3)'], ["(delete-duplicates '(1 2 1 3 2))", '(1 2 3)'],
    ["(list-index even? '(1 3 5 6))", '3'], ["(cons* 1 2 '(3))", '(1 2 3)'],
    ["(equal? '(1 (2 #(3))) '(1 (2 #(3))))", '#t'], ["(eq? '() '())", '#t'], ["(eqv? 2 2)", '#t'], ["(eq? \"a\" \"a\")", '#f'],
  ], i);
});

test('higher-order list procedures', () => {
  const i = newInterp();
  cases([
    ["(map + '(1 2 3) '(10 20 30))", '(11 22 33)'], ["(map (lambda (x) (* x x)) '(1 2 3))", '(1 4 9)'], ["(map + '(1 2) '(1 2 3))", '(2 4)'],
    ["(let ((acc '())) (for-each (lambda (x y) (set! acc (cons (+ x y) acc))) '(1 2) '(10 20)) acc)", '(22 11)'],
    ["(filter odd? '(1 2 3 4 5))", '(1 3 5)'], ["(remove odd? '(1 2 3 4 5))", '(2 4)'],
    ["(reduce + 0 '(1 2 3 4))", '10'], ["(reduce + 0 '())", '0'], ["(fold-left list '() '(1 2 3))", '(((() 1) 2) 3)'],
    ["(fold-right list '() '(1 2 3))", '(1 (2 (3 ())))'], ["(fold cons '() '(1 2 3))", '(3 2 1)'],
    ["(append-map (lambda (x) (list x x)) '(1 2))", '(1 1 2 2)'], ["(filter-map (lambda (x) (and (even? x) (* x x))) '(1 2 3 4))", '(4 16)'],
    ["(find even? '(1 3 4 5))", '4'], ["(any even? '(1 3 4))", '#t'], ["(every even? '(2 4))", '#t'], ["(count even? '(1 2 4))", '2'],
    ["(call-with-values (lambda () (partition even? '(1 2 3 4))) list)", '((2 4) (1 3))'],
    ["(sort '(3 1 2) <)", '(1 2 3)'], ["(sort '(\"b\" \"a\") string<?)", '("a" "b")'], ["(sort (vector 3 1 2) >)", '#(3 2 1)'],
    ["(sort '((1 . b) (0 . a) (1 . a)) (lambda (x y) (< (car x) (car y))))", '((0 . a) (1 . b) (1 . a))'],
    ["(list-tabulate 4 (lambda (i) (* i i)))", '(0 1 4 9)'],
    ["(map (lambda (x) x) 5)", ';The object 5, passed as the second argument to map, is not the correct type.'],
    ["(apply map list '((1 2 3) (4 5 6)))", '((1 4) (2 5) (3 6))'],
  ], i);
});

test('symbols, characters, strings', () => {
  const i = newInterp();
  cases([
    ['(symbol->string (quote abc))', '"abc"'], ['(string->symbol "x y")', '|x y|'], ['(symbol-append (quote foo) (quote bar))', 'foobar'],
    ['(eq? (string->symbol "abc") (quote abc))', '#t'], ['(string? "a")', '#t'], ['(symbol? (quote a))', '#t'],
    ['(char->integer #\\a)', '97'], ['(integer->char 65)', '#\\A'], ['(char-upcase #\\a)', '#\\A'], ['(char<? #\\a #\\b)', '#t'],
    ['(char-alphabetic? #\\a)', '#t'], ['(char-numeric? #\\5)', '#t'], ['(char-whitespace? #\\space)', '#t'],
    ['(string-length "hello")', '5'], ['(string-ref "abc" 1)', '#\\b'], ['(substring "hello" 1 3)', '"el"'], ['(substring "hello" 2)', '"llo"'],
    ['(string-append "a" "b" "c")', '"abc"'], ['(string-append)', '""'], ['(string-upcase "abc")', '"ABC"'],
    ['(string=? "a" "a")', '#t'], ['(string<? "a" "b")', '#t'], ['(string<? "b" "a")', '#f'], ['(string-ci=? "Ab" "aB")', '#t'],
    ['(string->list "abc")', '(#\\a #\\b #\\c)'], ['(list->string (list #\\a #\\b))', '"ab"'], ['(string->number "12")', '12'],
    ['(number->string 12)', '"12"'], ['(string-index "hello" #\\l)', '2'], ['(string-search-forward "lo" "hello" 0)', '3'],
    ['(string-pad-left "5" 3)', '"  5"'], ['(string-pad-left "12345" 3)', '"345"'], ['(string-pad-right "ab" 4)', '"ab  "'],
    ['(string-null? "")', '#t'], ['(string-reverse "abc")', '"cba"'], ['(string-copy "abc")', '"abc"'],
    ['(let ((s (make-string 3 #\\x))) (string-set! s 1 #\\y) s)', '"xyx"'], ['(string #\\a #\\b)', '"ab"'],
    ['(string-join (list "a" "b" "c") ", ")', '"a, b, c"'],
    ['(let ((acc 0)) (string-for-each (lambda (c) (set! acc (+ acc 1))) "abcd") acc)', '4'],
    ['(string-map char-upcase "abc")', '"ABC"'], ['(string-count "banana" #\\a)', '3'],
    ['(string-length "λλ")', '2'],
  ], i);
});

test('vectors', () => {
  const i = newInterp();
  cases([
    ['(vector 1 2 3)', '#(1 2 3)'], ['(make-vector 3 0)', '#(0 0 0)'], ['(vector-length #(1 2))', '2'], ['(vector-ref #(a b c) 2)', 'c'],
    ['(let ((v (vector 1 2 3))) (vector-set! v 0 9) v)', '#(9 2 3)'], ['(vector->list #(1 2 3))', '(1 2 3)'], ['(list->vector (list 1 2))', '#(1 2)'],
    ['(vector-fill! (make-vector 2 0) 7)', ''], ['(let ((v (make-vector 2 0))) (vector-fill! v 7) v)', '#(7 7)'],
    ['(vector-map (lambda (x) (* x x)) #(1 2 3))', '#(1 4 9)'], ['(let ((n 0)) (vector-for-each (lambda (x) (set! n (+ n x))) #(1 2 3)) n)', '6'],
    ['(vector-grow #(1 2) 4)', '#(1 2 #f #f)'], ['(subvector #(1 2 3 4) 1 3)', '#(2 3)'], ['(vector-append #(1) #(2 3))', '#(1 2 3)'],
    ['(vector-copy #(1 2 3))', '#(1 2 3)'], ['(vector? #(1))', '#t'], ['(vector? (list 1))', '#f'],
    ['(vector-ref #(1 2) -1)', ';The object -1, passed as the second argument to vector-ref, is not in the correct range.'],
    ['(vector-ref #(1 2) 1.5)', ';The object 1.5, passed as the second argument to vector-ref, is not the correct type.'],
    ['(equal? #(1 2) #(1 2))', '#t'], ['(eq? #(1) #(1))', '#f'],
  ], i);
});

test('hash tables', () => {
  const i = newInterp();
  cases([
    ['(define h (make-equal-hash-table)) (hash-table-set! h "k" 1) (hash-table-set! h (list 1 2) 2) (hash-table-set! h 3.5 3) (list (hash-table-ref/default h "k" 0) (hash-table-ref/default h (list 1 2) 0) (hash-table-ref/default h 3.5 0) (hash-table-ref/default h "z" 0))', '(1 2 3 0)'],
    ['(hash-table-count h)', '3'], ['(hash-table-contains? h "k")', '#t'], ['(hash-table-delete! h "k") (hash-table-contains? h "k")', '#f'],
    ['(hash-table-update! h 3.5 (lambda (v) (+ v 10)) (lambda () 0)) (hash-table-ref h 3.5)', '13'],
    ['(hash-table-update!/default h (quote new) (lambda (v) (+ v 1)) 0) (hash-table-ref/default h (quote new) #f)', '1'],
    ['(hash-table-ref h (quote missing) (lambda () (quote fallback)))', 'fallback'],
    ['(sort (map cdr (hash-table->alist h)) <)', '(1 2 13)'],
    ['(define e (make-strong-eqv-hash-table)) (hash-table-set! e 1 (quote one)) (hash-table-set! e "s" (quote str)) (list (hash-table-ref/default e 1 #f) (hash-table-ref/default e "s" #f))', '(one #f)'],
    ['(let ((n 0)) (hash-table-walk h (lambda (k v) (set! n (+ n 1)))) n)', '3'],
    ['(hash-table-keys (make-equal-hash-table))', '()'],
  ], i);
});

test('equivalence predicates', () => {
  const i = newInterp();
  cases([
    ['(eqv? "" "")', '#f'], ['(eqv? 1/2 1/2)', '#t'], ['(eqv? 1.5 1.5)', '#t'], ['(eq? (quote a) (quote a))', '#t'], ['(eqv? #\\a #\\a)', '#t'],
    ['(equal? "abc" "abc")', '#t'], ['(equal? 1 1.0)', '#f'], ['(not 3)', '#f'], ['(not #f)', '#t'], ['(boolean? #f)', '#t'],
    ['(procedure? car)', '#t'], ['(procedure? (lambda () 1))', '#t'], ['(procedure? 5)', '#f'],
  ], i);
});

test('printing: display vs write, nested quotes, procedures', () => {
  const i = newInterp();
  assert.equal(run('(display "hi") (write "hi") (display #\\a) (write #\\a) (display (list "a" #\\b (quote c)))', i), 'out:hi"hi"a#\\a(a b c)');
  assert.equal(run("(write '(1 \"two\" #\\3 (4 . 5) #(6 7)))", i), 'out:(1 "two" #\\3 (4 . 5) #(6 7))');
  assert.equal(val("''a", i), '(quote a)');
  assert.equal(val("'(quasiquote (a (unquote b)))", i), '(quasiquote (a (unquote b)))');
  assert.equal(val('(list (if #f #f))', i), '(#!unspecific)');
  assert.equal(val('(list #t #f)', i), '(#t #f)');
  assert.equal(val('(write-line "x")', i), '');
  assert.equal(run('(write-line (list 1 "a"))', i), 'out:(1 "a")\n');
});

test('cyclic structures print without hanging', () => {
  const i = newInterp();
  assert.match(val('(let ((l (list 1 2 3))) (set-cdr! (cddr l) l) l)', i), /^\(1 2 3 1 2 3.*\.\.\.\)$|\.\.\./);
  assert.equal(val('(let ((l (list 1 2))) (set-cdr! (cdr l) l) (list? l))', i), '#f');
});

test('association lists and streams of data', () => {
  const i = newInterp();
  cases([
    ["(del-assq 'a '((a . 1) (b . 2)))", '((b . 2))'],
    ["(define al '((a . 1))) (list (assq 'a al) (assq 'z al))", '((a . 1) #f)'],
  ], i);
});
