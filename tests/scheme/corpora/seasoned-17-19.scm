#lang tls
;; shared mutable structure, and coroutines built from re-entrant continuations

;; a tiny "kons" cell type with an access counter, kept behind procedures
(define kounter 0)
(define set-kounter (lambda (n) (set! kounter n)))

(define kons
  (lambda (kar kdr)
    (lambda (selector)
      (selector #f kar kdr))))
(define kar (lambda (c) (c (lambda (s a d) a))))
(define kdr (lambda (c) (c (lambda (s a d) d))))

(define lots
  (lambda (m)
    (cond ((zero? m) '())
          (else (cons 'egg (lots (sub1 m)))))))

(define lenkth
  (lambda (l)
    (cond ((null? l) 0)
          (else (add1 (lenkth (cdr l)))))))

;; a queue with O(1) enqueue through a tail pointer
(define make-queue
  (lambda ()
    (let ((front '()) (back '()))
      (lambda (msg . args)
        (cond ((eq? msg 'put)
               (let ((cell (cons (car args) '())))
                 (cond ((null? front) (set! front cell) (set! back cell))
                       (else (set-cdr! back cell) (set! back cell)))
                 (car args)))
              ((eq? msg 'take)
               (let ((v (car front)))
                 (set! front (cdr front))
                 v))
              ((eq? msg 'empty?) (null? front))
              ((eq? msg 'contents) front))))))

;; a cyclic list built with set-cdr!; take n from it
(define make-cycle
  (lambda (l)
    (letrec ((last (lambda (p) (cond ((null? (cdr p)) p) (else (last (cdr p)))))))
      (set-cdr! (last l) l)
      l)))
(define take-n
  (lambda (n l)
    (cond ((zero? n) '())
          (else (cons (car l) (take-n (sub1 n) (cdr l)))))))

;; leaves of two trees, compared one at a time with a re-entrant generator
(define tree-walk
  (lambda (tree yield)
    (cond ((null? tree) 'done)
          ((atom? tree) (yield tree))
          (else (tree-walk (car tree) yield) (tree-walk (cdr tree) yield)))))

(define make-leaf-gen
  (lambda (tree)
    (let ((return #f) (resume #f))
      (lambda ()
        (letcc r
          (set! return r)
          (cond (resume (resume 'go))
                (else
                 (tree-walk tree
                            (lambda (leaf)
                              (letcc k
                                (set! resume k)
                                (return leaf))))
                 (return 'end))))))))

(define same-fringe?
  (lambda (t1 t2)
    (let ((g1 (make-leaf-gen t1)) (g2 (make-leaf-gen t2)))
      (letrec ((loop (lambda ()
                       (let ((a (g1)) (b (g2)))
                         (cond ((not (eq? a b)) #f)
                               ((eq? a 'end) #t)
                               (else (loop)))))))
        (loop)))))

;; cooperative threads: a ready list of thunks; yield parks the caller and
;; jumps back to the scheduler
(define ready '())
(define sched-k #f)
(define spawn
  (lambda (thunk)
    (set! ready (append ready (list thunk)))))
(define yield
  (lambda ()
    (letcc k
      (set! ready (append ready (list (lambda () (k 'resumed)))))
      (sched-k 'next))))
(define log-out '())
(define note (lambda (x) (set! log-out (cons x log-out))))
(define run-all
  (lambda ()
    (letcc done
      (letrec ((loop (lambda ()
                       (cond ((null? ready) (done (reverse log-out)))
                             (else (let ((t (car ready)))
                                     (set! ready (cdr ready))
                                     (letcc s (set! sched-k s) (t))
                                     (loop)))))))
        (loop)))))
