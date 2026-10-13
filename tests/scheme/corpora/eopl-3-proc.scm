#lang eopl

;; The same language grown with procedures and recursive procedures, written
;; with square brackets here and there as some code does.

(define the-lexical-spec
  '([whitespace (whitespace) skip]
    [comment ("%" (arbno (not #\newline))) skip]
    [identifier (letter (arbno (or letter digit "_" "-" "?"))) symbol]
    [number (digit (arbno digit)) number]
    [number ("-" digit (arbno digit)) number]))

(define the-grammar
  '([program (expression) a-program]
    [expression (number) const-exp]
    [expression ("-" "(" expression "," expression ")") diff-exp]
    [expression ("zero?" "(" expression ")") zero?-exp]
    [expression ("if" expression "then" expression "else" expression) if-exp]
    [expression (identifier) var-exp]
    [expression ("let" identifier "=" expression "in" expression) let-exp]
    [expression ("proc" "(" identifier ")" expression) proc-exp]
    [expression ("(" expression expression ")") call-exp]
    [expression ("letrec" identifier "(" identifier ")" "=" expression "in" expression)
                letrec-exp]))

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

(define (expval->num val)
  (cases expval val (num-val (n) n) (else (eopl:error 'expval->num "Not a number: ~s" val))))
(define (expval->bool val)
  (cases expval val (bool-val (b) b) (else (eopl:error 'expval->bool "Not a boolean: ~s" val))))
(define (expval->proc val)
  (cases expval val (proc-val (p) p) (else (eopl:error 'expval->proc "Not a procedure: ~s" val))))

(define (apply-env env search-var)
  (cases environment env
    (empty-env () (eopl:error 'apply-env "No binding for ~s" search-var))
    (extend-env (var val saved-env)
      (if (eqv? search-var var) val (apply-env saved-env search-var)))
    (extend-env-rec (p-name b-var p-body saved-env)
      (if (eqv? search-var p-name)
          (proc-val (procedure b-var p-body env))
          (apply-env saved-env search-var)))))

(define (apply-procedure proc1 val)
  (cases proc proc1
    (procedure (var body saved-env)
      (value-of body (extend-env var val saved-env)))))

(define (value-of exp env)
  (cases expression exp
    (const-exp (num) (num-val num))
    (var-exp (var) (apply-env env var))
    (diff-exp (exp1 exp2)
      (num-val (- (expval->num (value-of exp1 env)) (expval->num (value-of exp2 env)))))
    (zero?-exp (exp1) (bool-val (zero? (expval->num (value-of exp1 env)))))
    (if-exp (exp1 exp2 exp3)
      (if (expval->bool (value-of exp1 env)) (value-of exp2 env) (value-of exp3 env)))
    (let-exp (var exp1 body)
      (value-of body (extend-env var (value-of exp1 env) env)))
    (proc-exp (var body) (proc-val (procedure var body env)))
    (call-exp (rator rand)
      (apply-procedure (expval->proc (value-of rator env)) (value-of rand env)))
    (letrec-exp (p-name b-var p-body letrec-body)
      (value-of letrec-body (extend-env-rec p-name b-var p-body env)))))

(define (value-of-program pgm)
  (cases program pgm (a-program (exp1) (value-of exp1 (empty-env)))))

(define (run string) (value-of-program (scan&parse string)))
(define (run-num string) (expval->num (run string)))
