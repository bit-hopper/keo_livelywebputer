#lang eopl

;; A small expression language with let, written the usual way: a scanner and
;; grammar specification, datatypes generated from the grammar, and an
;; evaluator over an environment datatype.

(define the-lexical-spec
  '((whitespace (whitespace) skip)
    (comment ("%" (arbno (not #\newline))) skip)
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
    (expression ("let" identifier "=" expression "in" expression) let-exp)))

(sllgen:make-define-datatypes the-lexical-spec the-grammar)

(define scan&parse (sllgen:make-string-parser the-lexical-spec the-grammar))

;; ---- values and environments -------------------------------------------------

(define-datatype expval expval?
  (num-val (value number?))
  (bool-val (boolean boolean?)))

(define (expval->num val)
  (cases expval val
    (num-val (num) num)
    (else (eopl:error 'expval->num "Not a number: ~s" val))))

(define (expval->bool val)
  (cases expval val
    (bool-val (bool) bool)
    (else (eopl:error 'expval->bool "Not a boolean: ~s" val))))

(define-datatype environment environment?
  (empty-env)
  (extend-env (var symbol?) (val expval?) (env environment?)))

(define (apply-env env search-var)
  (cases environment env
    (empty-env () (eopl:error 'apply-env "No binding for ~s" search-var))
    (extend-env (var val saved-env)
      (if (eqv? search-var var) val (apply-env saved-env search-var)))))

;; ---- the evaluator ---------------------------------------------------------------

(define (value-of exp env)
  (cases expression exp
    (const-exp (num) (num-val num))
    (var-exp (var) (apply-env env var))
    (diff-exp (exp1 exp2)
      (num-val (- (expval->num (value-of exp1 env))
                  (expval->num (value-of exp2 env)))))
    (zero?-exp (exp1)
      (bool-val (zero? (expval->num (value-of exp1 env)))))
    (if-exp (exp1 exp2 exp3)
      (if (expval->bool (value-of exp1 env))
          (value-of exp2 env)
          (value-of exp3 env)))
    (let-exp (var exp1 body)
      (value-of body (extend-env var (value-of exp1 env) env)))))

(define (value-of-program pgm)
  (cases program pgm
    (a-program (exp1) (value-of exp1 (empty-env)))))

(define (run string)
  (value-of-program (scan&parse string)))

(define (run-num string) (expval->num (run string)))
