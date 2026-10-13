#lang simply

;; Solutions for the practice exercises on higher-order procedures and lambda. Our own code.

(define (vowel? letter) (member? letter '(a e i o u)))

;; ---- chapter 8
(define (ends-vowel? wd) (vowel? (last wd)))
(define (even-count? wd) (even? (count wd)))
(define (choose-members pred) (keep pred '(john paul george ringo)))

(define (amazify name) (word 'the-amazing- name))
(define (transform-members f) (every f '(john paul george ringo)))

(define (letter-name letter)
  (cadr (assoc letter
               '((a alpha) (b bravo) (c charlie) (d delta) (e echo) (f foxtrot) (g golf)
                 (h hotel) (i india) (j juliett) (k kilo) (l lima) (m mike) (n november)
                 (o oscar) (p papa) (q quebec) (r romeo) (s sierra) (t tango) (u uniform)
                 (v victor) (w whiskey) (x xray) (y yankee) (z zulu)))))
(define (spell-out wd) (every letter-name wd))

(define (letter-count sent) (accumulate + (every count sent)))

(define (exaggerate-word wd)
  (cond ((number? wd) (* 2 wd))
        ((equal? wd 'good) 'great)
        ((equal? wd 'bad) 'terrible)
        ((equal? wd 'nice) 'wonderful)
        (else wd)))
(define (exaggerate sent) (every exaggerate-word sent))

;; 8.9: procedures that hand a sentence back unchanged
(define keep-everything-every word)
(define keep-everything-keep word?)
(define keep-everything-accumulate se)

(define (true-for-all? pred sent) (= (count (keep pred sent)) (count sent)))

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
(define (grade-points grade) (+ (base-grade grade) (grade-modifier grade)))
(define (gpa grades) (/ (accumulate + (every grade-points grades)) (count grades)))

(define (um? wd) (equal? wd 'um))
(define (count-ums sent) (count (keep um? sent)))

(define (letter->digit letter)
  (cond ((member? letter 'abc) 2)
        ((member? letter 'def) 3)
        ((member? letter 'ghi) 4)
        ((member? letter 'jkl) 5)
        ((member? letter 'mno) 6)
        ((member? letter 'pqrs) 7)
        ((member? letter 'tuv) 8)
        (else 9)))
(define (phone-unspell wd) (accumulate word (every letter->digit wd)))

(define (subword wd start end)
  ((repeated bf (- start 1))
   ((repeated bl (- (count wd) end))
    wd)))

;; ---- chapter 9
(define second-explicit (lambda (stuff) (first (bf stuff))))
(define make-adder (lambda (num) (lambda (x) (+ num x))))

(define (let-it-be sent) (accumulate (lambda (x y) y) sent))

(define (who sent)
  (every (lambda (person) (se person sent)) '(pete roger john keith)))

(define (prepend-every prefix sent)
  (every (lambda (wd) (word prefix wd)) sent))

(define (sentence-version f)
  (lambda (sent) (every f sent)))

(define (letterwords letter sent)
  (keep (lambda (wd) (member? letter wd)) sent))

(define (hang-letter letter guesses)
  (if (member? letter guesses) letter '_))
(define (hang secret guesses)
  (accumulate word (every (lambda (letter) (hang-letter letter guesses)) secret)))

(define (common-words a b)
  (keep (lambda (wd) (member? wd b)) a))

(define (count-appearances item sent)
  (count (keep (lambda (wd) (equal? wd item)) sent)))

(define (unabbrev sent replacements)
  (every (lambda (wd) (if (number? wd) (item wd replacements) wd)) sent))

(define (first-last sent)
  (keep (lambda (wd) (equal? (first wd) (last wd))) sent))

(define (compose f g)
  (lambda (x) (f (g x))))

(define (substitute new old sent)
  (every (lambda (wd) (if (equal? wd old) new wd)) sent))

(define (type-check f pred)
  (lambda (x) (if (pred x) (f x) #f)))

(define (aplize f)
  (lambda (arg) (if (sentence? arg) (every f arg) (f arg))))

(define (keep-via-every pred sent)
  (every (lambda (wd) (if (pred wd) wd '())) sent))
