#lang simply

;; Solutions written for the practice exercises of a word-and-sentence course (first part).
;; Our own code; each section is named by the exercise it answers.

;; ---- chapter 4: defining procedures
(define (fahrenheit->celsius f) (* (/ 5 9) (- f 32)))
(define (celsius->fahrenheit c) (+ (* (/ 9 5) c) 32))

(define (fourth-by-multiplying x) (* x x x x))
(define (fourth-by-squaring x) (square (square x)))

(define (absolute x) (sqrt (square x)))

(define (scientific coefficient exponent) (* coefficient (expt 10 exponent)))
(define (sci-exponent n)
  (let loop ((n n) (e 0))
    (cond ((>= n 10) (loop (/ n 10) (+ e 1)))
          ((< n 1) (loop (* n 10) (- e 1)))
          (else e))))
(define (sci-coefficient n) (/ n (expt 10 (sci-exponent n))))

(define (discount price percent) (* price (/ (- 100 percent) 100)))
(define (tip bill) (- (ceiling (* bill 1.15)) bill))

;; ---- chapter 5: words and sentences
(define (f1 a b) (se (bf a) (bl b)))
(define (f2 a b) (se (bf a) (bl b) (word (first a) (last b))))
(define (f3 a b) (se a a))
(define (f4 a b) (word (first (bf a)) (first (bf b))))

(define (third stuff) (first (bf (bf stuff))))
(define (first-two wd) (word (first wd) (first (bf wd))))
(define (two-first a b) (word (first a) (first b)))
(define (two-first-sent s) (two-first (first s) (first (bf s))))
(define (knight name) (se 'sir name))
(define (insert-and items) (se (bl items) 'and (last items)))
(define (middle-names name) (bf (bl name)))
(define (query statement)
  (se (first (bf statement))
      (first statement)
      (bl (bf (bf statement)))
      (word (last statement) '?)))

;; ---- chapter 6: true and false
(define (sign number)
  (cond ((< number 0) 'negative)
        ((= number 0) 'zero)
        (else 'positive)))

(define (utensil meal)
  (if (equal? meal 'chinese) 'chopsticks 'fork))

(define (european-time time)
  (let ((hour (first time)) (ampm (last time)))
    (if (equal? ampm 'am)
        (if (= hour 12) 24 hour)
        (if (= hour 12) 12 (+ hour 12)))))
(define (american-time hour)
  (cond ((or (= hour 24) (= hour 0)) '(12 am))
        ((= hour 12) '(12 pm))
        ((> hour 12) (se (- hour 12) 'pm))
        (else (se hour 'am))))

(define (teen? n) (and (>= n 13) (<= n 19)))

(define (type-of thing)
  (cond ((number? thing) 'number)
        ((boolean? thing) 'boolean)
        ((word? thing) 'word)
        ((sentence? thing) 'sentence)
        (else 'unknown)))

(define (indef-article wd)
  (if (member? (first wd) 'aeiou) (se 'an wd) (se 'a wd)))

(define (thismany n noun)
  (if (= n 1) (se n noun) (se n (word noun 's))))

(define (sort2 s)
  (if (<= (first s) (last s)) s (se (last s) (first s))))

(define (leap-year? y)
  (or (and (= 0 (remainder y 4)) (not (= 0 (remainder y 100))))
      (= 0 (remainder y 400))))
(define (days-in-month m y)
  (cond ((= m 2) (if (leap-year? y) 29 28))
        ((member? m '(4 6 9 11)) 30)
        (else 31)))
(define (valid-date? m d y)
  (and (>= m 1) (<= m 12) (>= d 1) (<= d (days-in-month m y))))

(define (plural wd)
  (cond ((and (equal? (last wd) 'y) (not (member? (last (bl wd)) 'aeiou))) (word (bl wd) 'ies))
        ((member? (last wd) 'sxz) (word wd 'es))
        ((and (member? (last wd) 'h) (member? (last (bl wd)) 'cs)) (word wd 'es))
        (else (word wd 's))))

(define (without-suffix name)
  (if (member? (last name) '(jr sr ii iii)) (bl name) name))
(define (greet name)
  (let ((name (without-suffix name)))
    (cond ((member? (first name) '(queen king)) '(hello your majesty))
          ((equal? (first name) 'dr) (se 'hello 'dr (last name)))
          ((and (equal? (first name) 'david) (equal? (last name) 'livingstone))
           '(dr livingstone i presume?))
          (else (se 'hello (first name))))))

(define (describe-time secs)
  (let ((year (* 86400 365.25)))
    (cond ((< secs 60) (se secs 'seconds))
          ((< secs 3600) (se (/ secs 60.) 'minutes))
          ((< secs 86400) (se (/ secs 3600.) 'hours))
          ((< secs year) (se (/ secs 86400.) 'days))
          ((< secs (* year 100)) (se (/ secs year) 'years))
          (else (se (/ secs (* year 100)) 'centuries)))))

;; ---- chapter 7: variables
(define (vowel? letter) (member? letter '(a e i o u)))

(define (gertrude wd)
  (let ((article (if (vowel? (first wd)) 'an 'a)))
    (se article wd 'is article wd 'is article wd)))

(define pi-sentence
  (let ((pi 3.14159) (pie '(lemon meringue)))
    (se 'pi 'is pi 'but 'pie 'is pie)))

(define (superlative adjective wd) (se (word adjective 'est) wd))

(define (sum-square a b)
  (let ((+ *) (* +))
    (* (+ a a) (+ b b))))
