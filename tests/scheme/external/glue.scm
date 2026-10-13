#lang eopl
;; What that code expects from its host beyond the language itself, and its own
;; test harness (its host-compatibility file) written again on top of guard.

(define (print-struct . x) #t)
(define (flush-output . x) #t)
(define (pretty-display x) (display x) (newline))
(define (printf fmt . args) (display (%format-string fmt args)))
(define (exn? x) (condition? x))
(define (exn-message x) (condition/report-string x))

(define-syntax with-handlers
  (syntax-rules ()
    ((_ ((pred handler) ...) body ...)
     (guard (e ((pred e) (handler e)) ...) body ...))))

(define (apply-safely proc args)
  (with-handlers ((exn? (lambda (exn) (cons #f (exn-message exn)))))
    (cons #t (apply proc args))))

(define (run-experiment fn args correct-answer equal-answer?)
  (let* ((result (apply-safely fn args))
         (error-thrown? (not (car result)))
         (ans (cdr result)))
    (cons (if (eqv? correct-answer 'error) error-thrown? (equal-answer? ans correct-answer))
          ans)))

(define stop-after-first-error (make-parameter #f))
(define run-quietly (make-parameter #t))

;; Prints the failing tests, then "no bugs found" or the list of failed names.
(define (run-tests! run-fn equal-answer? tests)
  (let ((tests-failed '()))
    (for-each
     (lambda (test-item)
       (let ((name (car test-item)) (pgm (cadr test-item)) (correct-answer (caddr test-item)))
         (let* ((result (run-experiment run-fn (list pgm) correct-answer equal-answer?))
                (correct? (car result))
                (actual-answer (cdr result)))
           (if (not correct?)
               (begin
                 (printf "test: ~a~%" name)
                 (printf "~a~%" pgm)
                 (printf "correct outcome: ~a~%" correct-answer)
                 (printf "actual outcome:  ")
                 (pretty-display actual-answer)
                 (printf "incorrect~%~%")
                 (set! tests-failed (cons name tests-failed)))))))
     tests)
    (if (null? tests-failed)
        (printf "no bugs found~%")
        (printf "incorrect answers on tests: ~a~%" (reverse tests-failed)))))
