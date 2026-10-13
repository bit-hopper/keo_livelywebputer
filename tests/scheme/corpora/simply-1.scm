#lang simply

;; Word games in the usual style: words are taken apart with first / butfirst,
;; sentences are built with se, and every / keep / accumulate do the looping.

(define (vowel? letter)
  (member? letter 'aeiou))

;; pig latin
(define (pigl wd)
  (if (vowel? (first wd))
      (word wd 'ay)
      (pigl (word (bf wd) (first wd)))))

(define (pig-sentence sent)
  (every pigl sent))

;; plurals
(define (plural wd)
  (if (and (equal? (last wd) 'y) (not (vowel? (last (bl wd)))))
      (word (bl wd) 'ies)
      (word wd 's)))

;; counting
(define (count-vowels wd)
  (count (keep vowel? wd)))

(define (acronym sent)
  (accumulate word (every first (keep (lambda (w) (> (count w) 3)) sent))))

;; recursion over the words of a sentence
(define (reverse-words sent)
  (if (empty? sent)
      sent
      (se (reverse-words (bf sent)) (first sent))))

(define (longest-word sent)
  (accumulate (lambda (a b) (if (>= (count a) (count b)) a b)) sent))

(define (initials sent)
  (every first sent))

;; palindromes and letter games
(define (reverse-word wd)
  (accumulate (lambda (a b) (word b a)) wd))

(define (palindrome? wd)
  (equal? wd (reverse-word wd)))

(define (letter-pairs wd)
  (if (< (count wd) 2)
      '()
      (se (word (first wd) (first (bf wd))) (letter-pairs (bf wd)))))

(define (ordered? sent)
  (cond ((< (count sent) 2) #t)
        ((before? (first sent) (first (bf sent))) (ordered? (bf sent)))
        (else #f)))

(define (insert-sorted wd sent)
  (cond ((empty? sent) (se wd))
        ((before? wd (first sent)) (se wd sent))
        (else (se (first sent) (insert-sorted wd (bf sent))))))

(define (sort-sentence sent)
  (if (empty? sent)
      sent
      (insert-sorted (first sent) (sort-sentence (bf sent)))))

;; numbers are words too
(define (sum-digits n)
  (accumulate + n))

(define (digits-ascending? n)
  (ordered? (every (lambda (d) d) n)))

(define (count-of wd letter)
  (appearances letter wd))

;; higher-order helpers
(define (twice f) (repeated f 2))

(define (add-ay-all sent)
  (every (lambda (w) (word w 'ay)) sent))

;; a small database using match
(define (greeting? sent)
  (match '(hello *) sent))

(define (who-is sent)
  (match '(my name is *name) sent))
