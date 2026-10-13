#lang eopl

;; An interpreter whose control context is an explicit data structure: every
;; pending computation is a continuation variant, and apply-cont consumes them.
;; Extended with try/catch and raise, found by walking the continuation.

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
    (expression ("letrec" identifier "(" identifier ")" "=" expression "in" expression) letrec-exp)
    (expression ("try" expression "catch" "(" identifier ")" expression) try-exp)
    (expression ("raise" expression) raise-exp)))

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

(define-datatype continuation continuation?
  (end-cont)
  (zero1-cont (cont continuation?))
  (let-exp-cont (var symbol?) (body expression?) (env environment?) (cont continuation?))
  (if-test-cont (exp2 expression?) (exp3 expression?) (env environment?) (cont continuation?))
  (diff1-cont (exp2 expression?) (env environment?) (cont continuation?))
  (diff2-cont (val1 expval?) (cont continuation?))
  (rator-cont (rand expression?) (env environment?) (cont continuation?))
  (rand-cont (val1 expval?) (cont continuation?))
  (try-cont (var symbol?) (handler expression?) (env environment?) (cont continuation?))
  (raise1-cont (cont continuation?)))

(define (value-of/k exp env cont)
  (cases expression exp
    (const-exp (num) (apply-cont cont (num-val num)))
    (var-exp (var) (apply-cont cont (apply-env env var)))
    (proc-exp (var body) (apply-cont cont (proc-val (procedure var body env))))
    (letrec-exp (p-name b-var p-body letrec-body)
      (value-of/k letrec-body (extend-env-rec p-name b-var p-body env) cont))
    (zero?-exp (exp1) (value-of/k exp1 env (zero1-cont cont)))
    (let-exp (var exp1 body) (value-of/k exp1 env (let-exp-cont var body env cont)))
    (if-exp (exp1 exp2 exp3) (value-of/k exp1 env (if-test-cont exp2 exp3 env cont)))
    (diff-exp (exp1 exp2) (value-of/k exp1 env (diff1-cont exp2 env cont)))
    (call-exp (rator rand) (value-of/k rator env (rator-cont rand env cont)))
    (try-exp (exp1 var handler) (value-of/k exp1 env (try-cont var handler env cont)))
    (raise-exp (exp1) (value-of/k exp1 env (raise1-cont cont)))))

(define (apply-cont cont val)
  (cases continuation cont
    (end-cont () val)
    (zero1-cont (saved-cont)
      (apply-cont saved-cont (bool-val (zero? (expval->num val)))))
    (let-exp-cont (var body saved-env saved-cont)
      (value-of/k body (extend-env var val saved-env) saved-cont))
    (if-test-cont (exp2 exp3 saved-env saved-cont)
      (if (expval->bool val)
          (value-of/k exp2 saved-env saved-cont)
          (value-of/k exp3 saved-env saved-cont)))
    (diff1-cont (exp2 saved-env saved-cont)
      (value-of/k exp2 saved-env (diff2-cont val saved-cont)))
    (diff2-cont (val1 saved-cont)
      (apply-cont saved-cont (num-val (- (expval->num val1) (expval->num val)))))
    (rator-cont (rand saved-env saved-cont)
      (value-of/k rand saved-env (rand-cont val saved-cont)))
    (rand-cont (val1 saved-cont)
      (apply-procedure (expval->proc val1) val saved-cont))
    (try-cont (var handler saved-env saved-cont)
      (apply-cont saved-cont val))
    (raise1-cont (saved-cont)
      (apply-handler val saved-cont))))

(define (apply-procedure proc1 val cont)
  (cases proc proc1
    (procedure (var body saved-env)
      (value-of/k body (extend-env var val saved-env) cont))))

;; Walk outwards through the continuation until a try frame is found.
(define (apply-handler val cont)
  (cases continuation cont
    (try-cont (var handler saved-env saved-cont)
      (value-of/k handler (extend-env var val saved-env) saved-cont))
    (end-cont () (eopl:error 'apply-handler "Uncaught exception: ~s" val))
    (zero1-cont (saved-cont) (apply-handler val saved-cont))
    (let-exp-cont (var body saved-env saved-cont) (apply-handler val saved-cont))
    (if-test-cont (exp2 exp3 saved-env saved-cont) (apply-handler val saved-cont))
    (diff1-cont (exp2 saved-env saved-cont) (apply-handler val saved-cont))
    (diff2-cont (val1 saved-cont) (apply-handler val saved-cont))
    (rator-cont (rand saved-env saved-cont) (apply-handler val saved-cont))
    (rand-cont (val1 saved-cont) (apply-handler val saved-cont))
    (raise1-cont (saved-cont) (apply-handler val saved-cont))))

(define (expval->num val)
  (cases expval val (num-val (n) n) (else (eopl:error 'expval->num "Not a number: ~s" val))))
(define (expval->bool val)
  (cases expval val (bool-val (b) b) (else (eopl:error 'expval->bool "Not a boolean: ~s" val))))
(define (expval->proc val)
  (cases expval val (proc-val (p) p) (else (eopl:error 'expval->proc "Not a procedure: ~s" val))))

(define (value-of-program pgm)
  (cases program pgm
    (a-program (exp1) (value-of/k exp1 (empty-env) (end-cont)))))

(define (run string) (value-of-program (scan&parse string)))
(define (run-num string) (expval->num (run string)))
