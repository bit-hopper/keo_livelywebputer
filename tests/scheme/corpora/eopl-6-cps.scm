#lang eopl

;; The interpreter in continuation-passing style with continuations as
;; procedures, run under a trampoline: a call that would nest deeper returns a
;; thunk instead, and a driver loop keeps forcing thunks until a value appears.
;; Also a source-to-source pass that turns a small expression language into
;; continuation-passing form.

(define the-lexical-spec
  '((whitespace (whitespace) skip)
    (identifier (letter (arbno (or letter digit "_" "-" "?"))) symbol)
    (number (digit (arbno digit)) number)
    (number ("-" digit (arbno digit)) number)))

(define the-grammar
  '((program (expression) a-program)
    (expression (number) const-exp)
    (expression ("-" "(" expression "," expression ")") diff-exp)
    (expression ("zero?" "(" expression ")") zero?-exp)
    (expression ("if" expression "then" expression "else" expression) if-exp)
    (expression (identifier) var-exp)
    (expression ("let" identifier "=" expression "in" expression) let-exp)
    (expression ("proc" "(" identifier ")" expression) proc-exp)
    (expression ("(" expression expression ")") call-exp)
    (expression ("letrec" identifier "(" identifier ")" "=" expression "in" expression) letrec-exp)))

(sllgen:make-define-datatypes the-lexical-spec the-grammar)
(define scan&parse (sllgen:make-string-parser the-lexical-spec the-grammar))

(define-datatype expval expval?
  (num-val (value number?))
  (bool-val (boolean boolean?))
  (proc-val (proc proc?)))

(define-datatype proc proc?
  (procedure (var symbol?) (body expression?) (saved-env environment?)))

(define-datatype environment environment?
  (empty-env)
  (extend-env (var symbol?) (val expval?) (env environment?))
  (extend-env-rec (p-name symbol?) (b-var symbol?) (p-body expression?) (env environment?)))

(define (apply-env env search-var)
  (cases environment env
    (empty-env () (eopl:error 'apply-env "No binding for ~s" search-var))
    (extend-env (var val saved-env)
      (if (eqv? search-var var) val (apply-env saved-env search-var)))
    (extend-env-rec (p-name b-var p-body saved-env)
      (if (eqv? search-var p-name)
          (proc-val (procedure b-var p-body env))
          (apply-env saved-env search-var)))))

(define (expval->num val)
  (cases expval val (num-val (n) n) (else (eopl:error 'expval->num "Not a number: ~s" val))))
(define (expval->bool val)
  (cases expval val (bool-val (b) b) (else (eopl:error 'expval->bool "Not a boolean: ~s" val))))
(define (expval->proc val)
  (cases expval val (proc-val (p) p) (else (eopl:error 'expval->proc "Not a procedure: ~s" val))))

;; A procedure call returns a thunk (a bounce) rather than making the call.
(define (value-of/k exp env cont)
  (cases expression exp
    (const-exp (num) (cont (num-val num)))
    (var-exp (var) (cont (apply-env env var)))
    (proc-exp (var body) (cont (proc-val (procedure var body env))))
    (letrec-exp (p-name b-var p-body letrec-body)
      (value-of/k letrec-body (extend-env-rec p-name b-var p-body env) cont))
    (zero?-exp (exp1)
      (value-of/k exp1 env (lambda (v) (cont (bool-val (zero? (expval->num v)))))))
    (let-exp (var exp1 body)
      (value-of/k exp1 env (lambda (v) (value-of/k body (extend-env var v env) cont))))
    (if-exp (exp1 exp2 exp3)
      (value-of/k exp1 env
        (lambda (v)
          (if (expval->bool v) (value-of/k exp2 env cont) (value-of/k exp3 env cont)))))
    (diff-exp (exp1 exp2)
      (value-of/k exp1 env
        (lambda (v1)
          (value-of/k exp2 env
            (lambda (v2) (cont (num-val (- (expval->num v1) (expval->num v2)))))))))
    (call-exp (rator rand)
      (value-of/k rator env
        (lambda (f)
          (value-of/k rand env
            (lambda (arg) (apply-procedure/k (expval->proc f) arg cont))))))))

(define (apply-procedure/k proc1 val cont)
  (lambda ()
    (cases proc proc1
      (procedure (var body saved-env)
        (value-of/k body (extend-env var val saved-env) cont)))))

(define (trampoline bounce)
  (if (procedure? bounce) (trampoline (bounce)) bounce))

(define (value-of-program pgm)
  (cases program pgm
    (a-program (exp1)
      (trampoline (value-of/k exp1 (empty-env) (lambda (v) v))))))

(define (run string) (value-of-program (scan&parse string)))
(define (run-num string) (expval->num (run string)))

;; ---- a CPS transformation of a tiny language -------------------------------------
;; Source language (as lists):  number | symbol | (if e e e) | (+ e e) | (f e)
;; "Simple" expressions (numbers, variables, sums of simple ones) stay put; any
;; call is turned into one that takes an explicit continuation argument.

(define (simple? e)
  (cond ((number? e) #t)
        ((symbol? e) #t)
        ((eqv? (car e) '+) (and (simple? (cadr e)) (simple? (caddr e))))
        (else #f)))

(define fresh-counter-box (list 0))
(define (fresh-var)
  (set-car! fresh-counter-box (+ 1 (car fresh-counter-box)))
  (string->symbol (string-append "v" (number->string (car fresh-counter-box)))))
(define (reset-fresh!) (set-car! fresh-counter-box 0))

;; (cps e k) -> code that delivers the value of e to k, where k is a Scheme
;; procedure from code to code
(define (cps e k)
  (cond
    ((simple? e) (k e))
    ((eqv? (car e) 'if)
     (let ((j (fresh-var)) (v (fresh-var)))
       (list 'let-cont j v (k v)
             (cps (cadr e)
                  (lambda (t) (list 'if t
                                    (cps (caddr e) (lambda (a) (list j a)))
                                    (cps (cadddr e) (lambda (b) (list j b)))))))))
    ((eqv? (car e) '+)
     (cps (cadr e)
          (lambda (a) (cps (caddr e) (lambda (b) (k (list '+ a b)))))))
    (else
     (cps (cadr e)
          (lambda (arg)
            (let ((v (fresh-var)))
              (list (car e) arg (list 'lambda (list v) (k v)))))))))
