#lang sicp
;; procedures, recursion, higher-order procedures

(define (average x y) (/ (+ x y) 2))

(define (improve guess x) (average guess (/ x guess)))
(define (good-enough? guess x) (< (abs (- (square guess) x)) 0.001))
(define (sqrt-iter guess x)
  (if (good-enough? guess x) guess (sqrt-iter (improve guess x) x)))
(define (newton-sqrt x) (sqrt-iter 1.0 x))

(define (fast-expt b n)
  (cond ((= n 0) 1)
        ((even? n) (square (fast-expt b (/ n 2))))
        (else (* b (fast-expt b (- n 1))))))

(define (gcd* a b) (if (= b 0) a (gcd* b (remainder a b))))

(define (fib n)
  (define (iter a b count)
    (if (= count 0) b (iter (+ a b) a (- count 1))))
  (iter 1 0 n))

(define (count-change amount)
  (define (cc amount kinds)
    (cond ((= amount 0) 1)
          ((or (< amount 0) (= kinds 0)) 0)
          (else (+ (cc amount (- kinds 1))
                   (cc (- amount (first-denomination kinds)) kinds)))))
  (define (first-denomination kinds)
    (cond ((= kinds 1) 1) ((= kinds 2) 5) ((= kinds 3) 10)
          ((= kinds 4) 25) ((= kinds 5) 50)))
  (cc amount 5))

(define (pascal row col)
  (if (or (= col 0) (= col row)) 1
      (+ (pascal (- row 1) (- col 1)) (pascal (- row 1) col))))

(define (smallest-divisor n)
  (define (find-divisor test)
    (cond ((> (square test) n) n)
          ((= 0 (remainder n test)) test)
          (else (find-divisor (+ test 1)))))
  (find-divisor 2))
(define (prime? n) (and (> n 1) (= n (smallest-divisor n))))

(define (expmod base exp m)
  (cond ((= exp 0) 1)
        ((even? exp) (remainder (square (expmod base (/ exp 2) m)) m))
        (else (remainder (* base (expmod base (- exp 1) m)) m))))
(define (fermat-test n a) (= (expmod a n n) a))

(define (sum term a next b)
  (if (> a b) 0 (+ (term a) (sum term (next a) next b))))
(define (sum-iter term a next b)
  (define (iter a result)
    (if (> a b) result (iter (next a) (+ result (term a)))))
  (iter a 0))
(define (inc n) (+ n 1))
(define (cube x) (* x x x))
(define (sum-cubes a b) (sum cube a inc b))

(define (integral f a b dx)
  (define (add-dx x) (+ x dx))
  (* (sum f (+ a (/ dx 2.0)) add-dx b) dx))

(define (product term a next b)
  (if (> a b) 1 (* (term a) (product term (next a) next b))))
(define (factorial n) (product (lambda (x) x) 1 inc n))

(define (accumulate-range combiner null-value term a next b)
  (if (> a b) null-value
      (combiner (term a) (accumulate-range combiner null-value term (next a) next b))))

(define (fixed-point f first-guess)
  (define (close-enough? v1 v2) (< (abs (- v1 v2)) 0.00001))
  (define (try guess)
    (let ((next (f guess)))
      (if (close-enough? guess next) next (try next))))
  (try first-guess))

(define (compose f g) (lambda (x) (f (g x))))
(define (repeated f n) (if (= n 1) f (compose f (repeated f (- n 1)))))

(define dx 0.00001)
(define (deriv g) (lambda (x) (/ (- (g (+ x dx)) (g x)) dx)))
(define (newton-transform g) (lambda (x) (- x (/ (g x) ((deriv g) x)))))
(define (newtons-method g guess) (fixed-point (newton-transform g) guess))

;; church numerals (exercise-style)
(define zero (lambda (f) (lambda (x) x)))
(define (add-1 n) (lambda (f) (lambda (x) (f ((n f) x)))))
(define (church->int n) ((n (lambda (k) (+ k 1))) 0))
