#lang tls
;; functions that build and consume functions; collectors; the Y chapter

(define rember-f
  (lambda (test?)
    (lambda (a l)
      (cond ((null? l) '())
            ((test? (car l) a) (cdr l))
            (else (cons (car l) ((rember-f test?) a (cdr l))))))))

(define eq?-c (lambda (a) (lambda (x) (eq? x a))))

(define insertL-f
  (lambda (test?)
    (lambda (new old l)
      (cond ((null? l) '())
            ((test? (car l) old) (cons new l))
            (else (cons (car l) ((insertL-f test?) new old (cdr l))))))))

(define multirember-f
  (lambda (test?)
    (lambda (a lat)
      (cond ((null? lat) '())
            ((test? a (car lat)) ((multirember-f test?) a (cdr lat)))
            (else (cons (car lat) ((multirember-f test?) a (cdr lat))))))))

;; collectors
(define multirember&co
  (lambda (a lat col)
    (cond ((null? lat) (col '() '()))
          ((eq? (car lat) a)
           (multirember&co a (cdr lat)
                           (lambda (newlat seen) (col newlat (cons (car lat) seen)))))
          (else
           (multirember&co a (cdr lat)
                           (lambda (newlat seen) (col (cons (car lat) newlat) seen)))))))

(define multiinsertLR
  (lambda (new oldL oldR lat)
    (cond ((null? lat) '())
          ((eq? (car lat) oldL)
           (cons new (cons oldL (multiinsertLR new oldL oldR (cdr lat)))))
          ((eq? (car lat) oldR)
           (cons oldR (cons new (multiinsertLR new oldL oldR (cdr lat)))))
          (else (cons (car lat) (multiinsertLR new oldL oldR (cdr lat)))))))

(define evens-only*
  (lambda (l)
    (cond ((null? l) '())
          ((atom? (car l))
           (cond ((even? (car l)) (cons (car l) (evens-only* (cdr l))))
                 (else (evens-only* (cdr l)))))
          (else (cons (evens-only* (car l)) (evens-only* (cdr l)))))))

;; one pass: the evens kept, their product, and the sum of the odds
(define evens-only*&co
  (lambda (l col)
    (cond ((null? l) (col '() 1 0))
          ((atom? (car l))
           (cond ((even? (car l))
                  (evens-only*&co (cdr l)
                                  (lambda (newl p s) (col (cons (car l) newl) (* (car l) p) s))))
                 (else
                  (evens-only*&co (cdr l)
                                  (lambda (newl p s) (col newl p (+ (car l) s)))))))
          (else
           (evens-only*&co (car l)
                           (lambda (al ap as)
                             (evens-only*&co (cdr l)
                                             (lambda (dl dp ds)
                                               (col (cons al dl) (* ap dp) (+ as ds))))))))))

;; chapter 9
(define pick
  (lambda (n lat)
    (cond ((= n 1) (car lat))
          (else (pick (- n 1) (cdr lat))))))

(define keep-looking
  (lambda (a sorn lat)
    (cond ((number? sorn) (keep-looking a (pick sorn lat) lat))
          (else (eq? sorn a)))))

(define looking (lambda (a lat) (keep-looking a (pick 1 lat) lat)))

(define first (lambda (p) (car p)))
(define second (lambda (p) (car (cdr p))))
(define build (lambda (a b) (cons a (cons b '()))))
(define a-pair?
  (lambda (x) (and (pair? x) (pair? (cdr x)) (null? (cdr (cdr x))))))

(define shift
  (lambda (x)
    (build (first (first x)) (build (second (first x)) (second x)))))

(define align
  (lambda (pora)
    (cond ((atom? pora) pora)
          ((a-pair? (first pora)) (align (shift pora)))
          (else (build (first pora) (align (second pora)))))))

(define length*
  (lambda (pora)
    (cond ((atom? pora) 1)
          (else (+ (length* (first pora)) (length* (second pora)))))))

(define weight*
  (lambda (pora)
    (cond ((atom? pora) 1)
          (else (+ (* (weight* (first pora)) 2) (weight* (second pora)))))))

(define eternity (lambda (x) (eternity x)))

;; the applicative-order Y combinator, and length with no named recursion
(define Y
  (lambda (le)
    ((lambda (f) (f f))
     (lambda (f) (le (lambda (x) ((f f) x)))))))

(define Y-length
  (Y (lambda (length)
       (lambda (l)
         (cond ((null? l) 0)
               (else (add1 (length (cdr l)))))))))

;; length built up stage by stage: each stage only knows the previous one
(define length-0
  (lambda (l)
    (cond ((null? l) 0)
          (else (add1 (eternity (cdr l)))))))

(define length-<=1
  (lambda (l)
    (cond ((null? l) 0)
          (else (add1 (length-0 (cdr l)))))))
