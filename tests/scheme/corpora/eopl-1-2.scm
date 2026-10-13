#lang eopl

;; Our own exercises in the style of the opening chapters: recursive list
;; programs, then data types for lambda-calculus expressions, environments
;; and trees.

;; ---- list programs ---------------------------------------------------------

(define (list-set lst n x)
  (if (zero? n)
      (cons x (cdr lst))
      (cons (car lst) (list-set (cdr lst) (- n 1) x))))

(define (occurs-free? var exp)
  (cond ((symbol? exp) (eqv? var exp))
        ((eqv? (car exp) 'lambda)
         (and (not (eqv? var (car (cadr exp))))
              (occurs-free? var (caddr exp))))
        (else (or (occurs-free? var (car exp))
                  (occurs-free? var (cadr exp))))))

(define (number-elements lst)
  (if (null? lst)
      '()
      (g (list 0 (car lst)) (number-elements (cdr lst)))))
(define (g first rest)
  (cons first (map (lambda (p) (list (+ 1 (car p)) (cadr p))) rest)))

;; ---- lambda-calculus expressions as a datatype --------------------------------
;; identifier? is defined after the datatype that mentions it: field checks run
;; when a value is built, not when the type is declared.

(define-datatype lc-exp lc-exp?
  (var-exp (var identifier?))
  (lambda-exp (bound-var identifier?) (body lc-exp?))
  (app-exp (rator lc-exp?) (rand lc-exp?)))

(define identifier?
  (lambda (x) (and (symbol? x) (not (eqv? x 'lambda)))))

(define (parse-expression datum)
  (cond ((symbol? datum) (var-exp datum))
        ((and (pair? datum) (eqv? (car datum) 'lambda))
         (lambda-exp (car (cadr datum)) (parse-expression (caddr datum))))
        ((pair? datum)
         (app-exp (parse-expression (car datum)) (parse-expression (cadr datum))))
        (else (eopl:error 'parse-expression "Invalid concrete syntax ~s" datum))))

(define (unparse-lc-exp exp)
  (cases lc-exp exp
    (var-exp (var) var)
    (lambda-exp (bound-var body)
      (list 'lambda (list bound-var) (unparse-lc-exp body)))
    (app-exp (rator rand)
      (list (unparse-lc-exp rator) (unparse-lc-exp rand)))))

(define (free-vars exp)
  (cases lc-exp exp
    (var-exp (var) (list var))
    (lambda-exp (bound-var body)
      (remove bound-var (free-vars body)))
    (app-exp (rator rand)
      (let loop ((vs (append (free-vars rator) (free-vars rand))) (seen '()))
        (cond ((null? vs) (reverse seen))
              ((memq (car vs) seen) (loop (cdr vs) seen))
              (else (loop (cdr vs) (cons (car vs) seen))))))))
(define (remove x lst)
  (cond ((null? lst) '())
        ((eqv? x (car lst)) (remove x (cdr lst)))
        (else (cons (car lst) (remove x (cdr lst))))))

;; ---- environments --------------------------------------------------------------

(define-datatype environment environment?
  (empty-env)
  (extend-env (var symbol?) (val always?) (env environment?)))

(define (apply-env env search-var)
  (cases environment env
    (empty-env () (eopl:error 'apply-env "No binding for ~s" search-var))
    (extend-env (var val saved-env)
      (if (eqv? search-var var) val (apply-env saved-env search-var)))))

(define (has-binding? env search-var)
  (cases environment env
    (empty-env () #f)
    (extend-env (var val saved-env)
      (or (eqv? search-var var) (has-binding? saved-env search-var)))))

(define (env-size env)
  (cases environment env
    (empty-env () 0)
    (extend-env (var val saved-env) (+ 1 (env-size saved-env)))))

;; ---- trees -------------------------------------------------------------------------

(define-datatype bintree bintree?
  (leaf-node (num integer?))
  (interior-node (key symbol?) (left bintree?) (right bintree?)))

(define (leaf-sum tree)
  (cases bintree tree
    (leaf-node (num) num)
    (interior-node (key left right) (+ (leaf-sum left) (leaf-sum right)))))

(define (bintree-to-list tree)
  (cases bintree tree
    (leaf-node (num) (list 'leaf-node num))
    (interior-node (key left right)
      (list 'interior-node key (bintree-to-list left) (bintree-to-list right)))))

;; a list-valued field checked with list-of
(define-datatype forest forest?
  (grove (name symbol?) (trees (list-of bintree?))))

(define (forest-total f)
  (cases forest f
    (grove (name trees)
      (let loop ((ts trees) (total 0))
        (if (null? ts) total (loop (cdr ts) (+ total (leaf-sum (car ts)))))))))
