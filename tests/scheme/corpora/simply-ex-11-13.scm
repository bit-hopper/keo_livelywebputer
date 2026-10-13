#lang simply

;; Solutions for the practice exercises on recursion. Our own code.
;; These deliberately use plain recursion (no every / keep / accumulate), as the exercises ask.

;; ---- chapter 11
(define (downup4 wd)
  (se wd (bl wd) (bl (bl wd)) (bl (bl (bl wd))) (bl (bl wd)) (bl wd) wd))

(define (count-ums sent)
  (cond ((empty? sent) 0)
        ((equal? (first sent) 'um) (+ 1 (count-ums (bf sent))))
        (else (count-ums (bf sent)))))

(define (unspell-letter letter)
  (cond ((member? letter 'abc) 2)
        ((member? letter 'def) 3)
        ((member? letter 'ghi) 4)
        ((member? letter 'jkl) 5)
        ((member? letter 'mno) 6)
        ((member? letter 'pqrs) 7)
        ((member? letter 'tuv) 8)
        ((member? letter 'wxyz) 9)
        (else 0)))
(define (phone-unspell wd)
  (if (empty? wd)
      ""
      (word (unspell-letter (first wd)) (phone-unspell (bf wd)))))

(define (initials sent)
  (if (empty? sent)
      '()
      (se (first (first sent)) (initials (bf sent)))))

(define (countdown n)
  (if (= n 0)
      '(blastoff!)
      (se n (countdown (- n 1)))))

(define (copies n wd)
  (if (= n 0)
      '()
      (se wd (copies (- n 1) wd))))

;; ---- chapter 12
(define (addup nums)
  (if (empty? nums)
      0
      (+ (first nums) (addup (bf nums)))))

(define (acronym sent)
  (if (= (count sent) 1)
      (first (first sent))
      (word (first (first sent))
            (acronym (bf sent)))))

(define (factorial-minus-one n)         ; base case moved to -1: every answer becomes 0
  (if (= n -1)
      1
      (* n (factorial-minus-one (- n 1)))))

(define (exaggerate-word wd)
  (cond ((number? wd) (* 2 wd))
        ((equal? wd 'good) 'great)
        ((equal? wd 'bad) 'terrible)
        (else wd)))
(define (exaggerate sent)
  (if (empty? sent)
      '()
      (se (exaggerate-word (first sent)) (exaggerate (bf sent)))))

(define (base-grade grade)
  (let ((letter (first grade)))
    (cond ((member? letter '(a A)) 4)
          ((member? letter '(b B)) 3)
          ((member? letter '(c C)) 2)
          ((member? letter '(d D)) 1)
          (else 0))))
(define (grade-modifier grade)
  (cond ((equal? (last grade) '+) .33)
        ((equal? (last grade) '-) -.33)
        (else 0)))
(define (grade-sum grades)
  (if (empty? grades)
      0
      (+ (base-grade (first grades)) (grade-modifier (first grades)) (grade-sum (bf grades)))))
(define (gpa grades) (/ (grade-sum grades) (count grades)))

(define (spell-digit digit)
  (item (+ 1 digit) '(zero one two three four five six seven eight nine)))
(define (spell-number n)
  (if (empty? n)
      '()
      (se (spell-digit (first n)) (spell-number (bf n)))))

(define (numbers sent)
  (cond ((empty? sent) '())
        ((number? (first sent)) (se (first sent) (numbers (bf sent))))
        (else (numbers (bf sent)))))

(define (real-word? wd)
  (not (member? wd '(a the an in of and for to with))))
(define (real-words sent)
  (cond ((empty? sent) '())
        ((real-word? (first sent)) (se (first sent) (real-words (bf sent))))
        (else (real-words (bf sent)))))

(define (remove unwanted sent)
  (cond ((empty? sent) '())
        ((equal? (first sent) unwanted) (remove unwanted (bf sent)))
        (else (se (first sent) (remove unwanted (bf sent))))))

(define (my-count stuff)
  (if (empty? stuff)
      0
      (+ 1 (my-count (bf stuff)))))

(define (roman-value letter)
  (cond ((member? letter '(i I)) 1)
        ((member? letter '(v V)) 5)
        ((member? letter '(x X)) 10)
        ((member? letter '(l L)) 50)
        ((member? letter '(c C)) 100)
        ((member? letter '(d D)) 500)
        ((member? letter '(m M)) 1000)
        (else 0)))
(define (arabic numeral)
  (cond ((empty? numeral) 0)
        ((empty? (bf numeral)) (roman-value (first numeral)))
        ((< (roman-value (first numeral)) (roman-value (first (bf numeral))))
         (- (arabic (bf numeral)) (roman-value (first numeral))))
        (else (+ (roman-value (first numeral)) (arabic (bf numeral))))))

;; 12.13: seconds as centuries, years, weeks, days, hours, minutes, seconds (a year is 365.25 days)
(define unit-names '((centuries century) (years year) (weeks week) (days day) (hours hour) (minutes minute) (seconds second)))
(define unit-sizes '(3155760000 31557600 604800 86400 3600 60 1))
(define (unit-name entry count smart?)
  (if (and smart? (= count 1)) (cadr entry) (car entry)))
(define (describe-units secs names sizes smart?)
  (cond ((null? names) '())
        ((>= secs (car sizes))
         (se (quotient secs (car sizes))
             (unit-name (car names) (quotient secs (car sizes)) smart?)
             (describe-units (remainder secs (car sizes)) (cdr names) (cdr sizes) smart?)))
        (else (describe-units secs (cdr names) (cdr sizes) smart?))))
(define (describe-time-plural secs) (describe-units secs unit-names unit-sizes #f))
(define (describe-time secs) (describe-units secs unit-names unit-sizes #t))

;; ---- chapter 13: procedures the exercises ask to trace
(define (explode wd)
  (if (empty? wd)
      '()
      (se (first wd) (explode (bf wd)))))

(define (pigl wd)
  (if (member? (first wd) 'aeiou)
      (word wd 'ay)
      (pigl (word (bf wd) (first wd)))))

(define (downup-no-base wd)
  (se wd (downup-no-base (bl wd)) wd))

(define (forever n)
  (if (= n 0)
      1
      (+ 1 (forever n))))

(define (factorial n)
  (if (= n 0)
      1
      (* n (factorial (- n 1)))))
