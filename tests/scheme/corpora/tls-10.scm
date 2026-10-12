#lang tls
;; a small evaluator for a Scheme subset, written in Scheme: environments are
;; tables (lists of entries), every expression kind has an action

(define first (lambda (p) (car p)))
(define second (lambda (p) (car (cdr p))))
(define third (lambda (p) (car (cdr (cdr p)))))
(define build (lambda (a b) (cons a (cons b '()))))

(define new-entry build)

(define lookup-in-entry-help
  (lambda (name names values entry-f)
    (cond ((null? names) (entry-f name))
          ((eq? (car names) name) (car values))
          (else (lookup-in-entry-help name (cdr names) (cdr values) entry-f)))))

(define lookup-in-entry
  (lambda (name entry entry-f)
    (lookup-in-entry-help name (first entry) (second entry) entry-f)))

(define extend-table cons)

(define lookup-in-table
  (lambda (name table table-f)
    (cond ((null? table) (table-f name))
          (else (lookup-in-entry name (car table)
                                 (lambda (name) (lookup-in-table name (cdr table) table-f)))))))

(define atom-to-action
  (lambda (e)
    (cond ((number? e) *const)
          ((eq? e #t) *const)
          ((eq? e #f) *const)
          ((eq? e 'cons) *const)
          ((eq? e 'car) *const)
          ((eq? e 'cdr) *const)
          ((eq? e 'null?) *const)
          ((eq? e 'eq?) *const)
          ((eq? e 'atom?) *const)
          ((eq? e 'zero?) *const)
          ((eq? e 'add1) *const)
          ((eq? e 'sub1) *const)
          ((eq? e 'number?) *const)
          (else *identifier))))

(define list-to-action
  (lambda (e)
    (cond ((atom? (car e))
           (cond ((eq? (car e) 'quote) *quote)
                 ((eq? (car e) 'lambda) *lambda)
                 ((eq? (car e) 'cond) *cond)
                 (else *application)))
          (else *application))))

(define expression-to-action
  (lambda (e)
    (cond ((atom? e) (atom-to-action e))
          (else (list-to-action e)))))

(define meaning (lambda (e table) ((expression-to-action e) e table)))
(define value (lambda (e) (meaning e '())))

(define *const
  (lambda (e table)
    (cond ((number? e) e)
          ((eq? e #t) #t)
          ((eq? e #f) #f)
          (else (build 'primitive e)))))

(define *quote (lambda (e table) (second e)))

(define initial-table (lambda (name) (car '())))
(define *identifier (lambda (e table) (lookup-in-table e table initial-table)))

(define *lambda
  (lambda (e table) (build 'non-primitive (cons table (cdr e)))))

(define table-of first)
(define formals-of second)
(define body-of third)

(define evcon
  (lambda (lines table)
    (cond ((else? (question-of (car lines))) (meaning (answer-of (car lines)) table))
          ((meaning (question-of (car lines)) table) (meaning (answer-of (car lines)) table))
          (else (evcon (cdr lines) table)))))

(define else?
  (lambda (x) (cond ((atom? x) (eq? x 'else)) (else #f))))
(define question-of first)
(define answer-of second)
(define cond-lines-of cdr)

(define *cond (lambda (e table) (evcon (cond-lines-of e) table)))

(define evlis
  (lambda (args table)
    (cond ((null? args) '())
          (else (cons (meaning (car args) table) (evlis (cdr args) table))))))

(define *application
  (lambda (e table)
    (apply-fn (meaning (function-of e) table) (evlis (arguments-of e) table))))
(define function-of car)
(define arguments-of cdr)

(define primitive? (lambda (l) (eq? (first l) 'primitive)))
(define non-primitive? (lambda (l) (eq? (first l) 'non-primitive)))

(define apply-fn
  (lambda (fun vals)
    (cond ((primitive? fun) (apply-primitive (second fun) vals))
          ((non-primitive? fun) (apply-closure (second fun) vals)))))

(define apply-primitive
  (lambda (name vals)
    (cond ((eq? name 'cons) (cons (first vals) (second vals)))
          ((eq? name 'car) (car (first vals)))
          ((eq? name 'cdr) (cdr (first vals)))
          ((eq? name 'null?) (null? (first vals)))
          ((eq? name 'eq?) (eq? (first vals) (second vals)))
          ((eq? name 'atom?) (:atom? (first vals)))
          ((eq? name 'zero?) (zero? (first vals)))
          ((eq? name 'add1) (add1 (first vals)))
          ((eq? name 'sub1) (sub1 (first vals)))
          ((eq? name 'number?) (number? (first vals))))))

;; the evaluator's notion of an atom also counts its own function objects
(define :atom?
  (lambda (x)
    (cond ((atom? x) #t)
          ((null? x) #f)
          ((eq? (car x) 'primitive) #t)
          ((eq? (car x) 'non-primitive) #t)
          (else #f))))

(define apply-closure
  (lambda (closure vals)
    (meaning (body-of closure)
             (extend-table (new-entry (formals-of closure) vals) (table-of closure)))))
