#lang tls
;; accumulators and letrec; escapes with letcc and try; assignment

;; --- recursion with extra arguments, and letrec to hide helpers
(define two-in-a-row?
  (letrec ((W (lambda (a lat)
                (cond ((null? lat) #f)
                      (else (or (eq? a (car lat)) (W (car lat) (cdr lat))))))))
    (lambda (lat)
      (cond ((null? lat) #f)
            (else (W (car lat) (cdr lat)))))))

(define sum-of-prefixes
  (lambda (tup)
    (letrec ((S (lambda (sss tup)
                  (cond ((null? tup) '())
                        (else (cons (+ sss (car tup)) (S (+ sss (car tup)) (cdr tup))))))))
      (S 0 tup))))

(define pick
  (lambda (n lat)
    (cond ((= n 1) (car lat))
          (else (pick (- n 1) (cdr lat))))))

(define scramble
  (lambda (tup)
    (letrec ((P (lambda (tup rp)
                  (cond ((null? tup) '())
                        (else (cons (pick (car tup) (cons (car tup) rp))
                                    (P (cdr tup) (cons (car tup) rp))))))))
      (P tup '()))))

(define multirember
  (lambda (a lat)
    (letrec ((mr (lambda (lat)
                   (cond ((null? lat) '())
                         ((eq? a (car lat)) (mr (cdr lat)))
                         (else (cons (car lat) (mr (cdr lat))))))))
      (mr lat))))

(define member?
  (lambda (a lat)
    (letrec ((yes? (lambda (l)
                     (cond ((null? l) #f)
                           ((eq? (car l) a) #t)
                           (else (yes? (cdr l)))))))
      (yes? lat))))

(define union
  (lambda (set1 set2)
    (letrec ((U (lambda (set)
                  (cond ((null? set) set2)
                        ((member? (car set) set2) (U (cdr set)))
                        (else (cons (car set) (U (cdr set))))))))
      (U set1))))

;; --- escapes
(define intersectall
  (lambda (lset)
    (letcc hop
      (letrec ((A (lambda (lset)
                    (cond ((null? (car lset)) (hop '()))
                          ((null? (cdr lset)) (car lset))
                          (else (I (car lset) (A (cdr lset)))))))
               (I (lambda (s1 s2)
                    (letrec ((J (lambda (s1)
                                  (cond ((null? s1) '())
                                        ((member? (car s1) s2) (cons (car s1) (J (cdr s1))))
                                        (else (J (cdr s1)))))))
                      (cond ((null? s2) (hop '()))
                            (else (J s1)))))))
        (cond ((null? lset) '())
              (else (A lset)))))))

(define rember-upto-last
  (lambda (a lat)
    (letcc skip
      (letrec ((R (lambda (lat)
                    (cond ((null? lat) '())
                          ((eq? (car lat) a) (skip (R (cdr lat))))
                          (else (cons (car lat) (R (cdr lat))))))))
        (R lat)))))

;; --- try: a primary expression, with a fallback when the escape is used
(define find-first
  (lambda (a l)
    (letrec ((F (lambda (l)
                  (cond ((null? l) '())
                        ((eq? (car l) a) (car l))
                        (else (F (cdr l)))))))
      (F l))))

(define safe-head
  (lambda (l)
    (try bad (cond ((null? l) (bad 'empty)) (else (car l))) 'nothing)))

(define rember1*
  (lambda (a l)
    (letrec ((R (lambda (l oh)
                  (cond ((null? l) (oh 'no))
                        ((atom? (car l))
                         (cond ((eq? (car l) a) (cdr l))
                               (else (cons (car l) (R (cdr l) oh)))))
                        (else
                         (let ((new-car (letcc oh2 (R (car l) oh2))))
                           (cond ((atom? new-car) (cons (car l) (R (cdr l) oh)))
                                 (else (cons new-car (cdr l))))))))))
      (let ((new-l (letcc oh (R l oh))))
        (cond ((atom? new-l) l)
              (else new-l))))))

;; --- assignment: counters, and a stored escape
(define counter-maker
  (lambda ()
    (let ((n 0))
      (lambda () (set! n (add1 n)) n))))

(define make-adder-log
  (lambda ()
    (let ((log '()))
      (lambda (msg)
        (cond ((eq? msg 'dump) (reverse log))
              (else (set! log (cons msg log)) msg))))))

(define Y!
  (lambda (L)
    (letrec ((h (L (lambda (arg) (h arg)))))
      h)))

(define length!
  (Y! (lambda (length)
        (lambda (l)
          (cond ((null? l) 0)
                (else (add1 (length (cdr l)))))))))

;; memoizing through assignment
(define make-memo
  (lambda (f)
    (let ((seen '()) (calls 0))
      (lambda (x)
        (cond ((eq? x 'calls) calls)
              ((assv x seen) => cdr)
              (else (let ((v (f x)))
                      (set! calls (add1 calls))
                      (set! seen (cons (cons x v) seen))
                      v)))))))
