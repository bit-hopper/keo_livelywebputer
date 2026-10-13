#lang simply

;; Solutions for the practice exercises on lists, trees and building the higher-order procedures.
;; Our own code. Re-implementations of builtins carry a my- prefix so they can be compared with
;; the real ones.

(define (vowel? letter) (member? letter '(a e i o u)))

;; ---- chapter 17: lists
(define (f1 a b) (list (append (cdr a) (list (car b)))))
(define (f2 a b) (list (cdr a) (cadr b)))
(define (f3 a b) (append a a))
(define (f4 a b) (list (list (car a) (car b)) (append (cdr a) (cdr b))))

(define (mystery lst) (mystery-helper lst '()))
(define (mystery-helper lst other)
  (if (null? lst)
      other
      (mystery-helper (cdr lst) (cons (car lst) other))))

(define (max2 a b) (if (> b a) b a))
(define (my-max first-num . rest)
  (if (null? rest)
      first-num
      (max2 first-num (apply my-max rest))))

(define (append2 a b)
  (if (null? a)
      b
      (cons (car a) (append2 (cdr a) b))))
(define (my-append . lists)
  (cond ((null? lists) '())
        ((null? (cdr lists)) (car lists))
        (else (append2 (car lists) (apply my-append (cdr lists))))))

(define (as-list thing) (if (list? thing) thing (list thing)))
(define (my-sentence . things)
  (if (null? things)
      '()
      (append (as-list (car things)) (apply my-sentence (cdr things)))))

(define (my-list-member thing lst)
  (cond ((null? lst) #f)
        ((equal? thing (car lst)) lst)
        (else (my-list-member thing (cdr lst)))))
(define (my-list-ref lst n)
  (if (= n 0)
      (car lst)
      (my-list-ref (cdr lst) (- n 1))))
(define (my-length lst)
  (if (null? lst) 0 (+ 1 (my-length (cdr lst)))))

(define (before-in-list? lst a b)
  (let ((after-a (my-list-member a lst)))
    (and after-a (my-list-member b (cdr after-a)) #t)))

(define (flatten structure)
  (cond ((null? structure) '())
        ((word? structure) (list structure))
        (else (append (flatten (car structure)) (flatten (cdr structure))))))
(define (flatten-sentence structure) (apply sentence (flatten structure)))

(define (deep-count lst)
  (cond ((null? lst) 0)
        ((word? lst) 1)
        (else (+ (deep-count (car lst)) (deep-count (cdr lst))))))
(define (deep-count-original lst)
  (cond ((null? lst) 0)
        ((word? (car lst)) (+ 1 (deep-count-original (cdr lst))))
        (else (+ (deep-count-original (car lst)) (deep-count-original (cdr lst))))))

(define (branch path structure)
  (if (null? path)
      structure
      (branch (cdr path) (list-ref structure (- (car path) 1)))))

(define (operator? thing) (member? thing '(+ - * /)))
(define (valid-operand? thing)
  (or (number? thing) (and (list? thing) (valid-infix? thing))))
(define (valid-infix? expr)
  (and (pair? expr)
       (valid-operand? (car expr))
       (or (null? (cdr expr))
           (and (operator? (cadr expr))
                (pair? (cddr expr))
                (valid-infix? (cddr expr))))))

;; ---- chapter 18: trees (make-node, datum and children come with the library)
(define (leaf? tree) (null? (children tree)))
(define (depth tree)
  (if (leaf? tree)
      1
      (+ 1 (apply max (map depth (children tree))))))
(define (count-nodes tree)
  (+ 1 (apply + (map count-nodes (children tree)))))
(define (prune-forest forest)
  (cond ((null? forest) '())
        ((leaf? (car forest)) (prune-forest (cdr forest)))
        (else (cons (prune (car forest)) (prune-forest (cdr forest))))))
(define (prune tree)
  (if (leaf? tree)
      #f
      (make-node (datum tree) (prune-forest (children tree)))))

(define (parse-scheme expr)
  (if (list? expr)
      (make-node (car expr) (map parse-scheme (cdr expr)))
      (make-node expr '())))
(define (compute tree)
  (if (leaf? tree)
      (datum tree)
      (apply (case (datum tree) ((+) +) ((-) -) ((*) *) ((/) /))
             (map compute (children tree)))))

;; ---- chapter 19
(define (combine-like stuff) (if (word? stuff) word sentence))
(define (my-keep pred stuff)
  (cond ((empty? stuff) (if (word? stuff) "" '()))
        ((pred (first stuff))
         ((combine-like stuff) (first stuff) (my-keep pred (bf stuff))))
        (else (my-keep pred (bf stuff)))))

(define (three-arg-accumulate combiner base stuff)
  (if (empty? stuff)
      base
      (combiner (first stuff) (three-arg-accumulate combiner base (bf stuff)))))

(define (left-accumulate combiner stuff)
  (left-helper combiner (first stuff) (bf stuff)))
(define (left-helper combiner so-far rest)
  (if (empty? rest)
      so-far
      (left-helper combiner (combiner so-far (first rest)) (bf rest))))

(define (true-for-all? pred sent)
  (cond ((empty? sent) #t)
        ((pred (first sent)) (true-for-all? pred (bf sent)))
        (else #f)))

(define (true-for-any-pair? pred sent)
  (cond ((< (count sent) 2) #f)
        ((pred (first sent) (first (bf sent))) #t)
        (else (true-for-any-pair? pred (bf sent)))))
(define (true-for-all-pairs? pred sent)
  (cond ((< (count sent) 2) #t)
        ((pred (first sent) (first (bf sent))) (true-for-all-pairs? pred (bf sent)))
        (else #f)))
(define (true-for-all-pairs-via-any? pred sent)
  (not (true-for-any-pair? (lambda (a b) (not (pred a b))) sent)))

(define (insert-by pred item sorted)
  (cond ((null? sorted) (list item))
        ((pred item (car sorted)) (cons item sorted))
        (else (cons (car sorted) (insert-by pred item (cdr sorted))))))
(define (my-sort lst pred)
  (if (null? lst)
      '()
      (insert-by pred (car lst) (my-sort (cdr lst) pred))))

(define (tree-map f tree)
  (make-node (f (datum tree))
             (map (lambda (child) (tree-map f child)) (children tree))))

(define (my-repeated f n)
  (if (= n 0)
      (lambda (x) x)
      (lambda (x) (f ((my-repeated f (- n 1)) x)))))

(define (forest-reduce f forest)
  (if (null? (cdr forest))
      (tree-reduce f (car forest))
      (f (tree-reduce f (car forest)) (forest-reduce f (cdr forest)))))
(define (tree-reduce f tree)
  (if (leaf? tree)
      (datum tree)
      (f (datum tree) (forest-reduce f (children tree)))))

(define (deep-reduce f structure)
  (if (word? structure)
      structure
      (reduce f (map (lambda (part) (deep-reduce f part)) structure))))
