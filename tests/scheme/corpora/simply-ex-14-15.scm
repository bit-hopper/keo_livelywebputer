#lang simply

;; Solutions for the practice exercises on recursion patterns and advanced recursion. Our own code.

(define (vowel? letter) (member? letter '(a e i o u)))

;; ---- chapter 14
(define (remove-once wd sent)
  (cond ((empty? sent) '())
        ((equal? wd (first sent)) (bf sent))
        (else (se (first sent) (remove-once wd (bf sent))))))

(define (up wd)
  (if (empty? wd)
      '()
      (se (up (bl wd)) wd)))

(define (remdup sent)                     ; keeps the last copy of each word
  (cond ((empty? sent) '())
        ((member? (first sent) (bf sent)) (remdup (bf sent)))
        (else (se (first sent) (remdup (bf sent))))))

(define (odds sent)
  (cond ((empty? sent) '())
        ((empty? (bf sent)) sent)
        (else (se (first sent) (odds (bf (bf sent)))))))

(define (letter-count sent)
  (if (empty? sent)
      0
      (+ (count (first sent)) (letter-count (bf sent)))))

(define (my-member? thing stuff)
  (cond ((empty? stuff) #f)
        ((equal? thing (first stuff)) #t)
        (else (my-member? thing (bf stuff)))))

(define (differences nums)
  (if (< (count nums) 2)
      '()
      (se (- (first (bf nums)) (first nums)) (differences (bf nums)))))

(define (copies n wd)
  (if (= n 0) '() (se wd (copies (- n 1) wd))))
(define (expand sent)
  (cond ((empty? sent) '())
        ((and (number? (first sent)) (not (empty? (bf sent))))
         (se (copies (first sent) (first (bf sent))) (expand (bf (bf sent)))))
        (else (se (first sent) (expand (bf sent))))))

(define (location-helper wd sent n)
  (cond ((empty? sent) #f)
        ((equal? wd (first sent)) n)
        (else (location-helper wd (bf sent) (+ n 1)))))
(define (location wd sent) (location-helper wd sent 1))

(define (count-adjacent-duplicates sent)
  (cond ((< (count sent) 2) 0)
        ((equal? (first sent) (first (bf sent))) (+ 1 (count-adjacent-duplicates (bf sent))))
        (else (count-adjacent-duplicates (bf sent)))))

(define (remove-adjacent-duplicates sent)
  (cond ((< (count sent) 2) sent)
        ((equal? (first sent) (first (bf sent))) (remove-adjacent-duplicates (bf sent)))
        (else (se (first sent) (remove-adjacent-duplicates (bf sent))))))

(define (progressive-squares? nums)
  (cond ((< (count nums) 2) #t)
        ((= (square (first nums)) (first (bf nums))) (progressive-squares? (bf nums)))
        (else #f)))

;; pigl that also copes with a word that has no vowels at all
(define (pigl-rotating wd tries)
  (cond ((member? (first wd) 'aeiou) (word wd 'ay))
        ((= tries 0) (word wd 'ay))
        (else (pigl-rotating (word (bf wd) (first wd)) (- tries 1)))))
(define (pigl wd) (pigl-rotating wd (count wd)))

(define (same-shape? a b)
  (cond ((and (empty? a) (empty? b)) #t)
        ((or (empty? a) (empty? b)) #f)
        ((= (count (first a)) (count (first b))) (same-shape? (bf a) (bf b)))
        (else #f)))

(define (merge a b)
  (cond ((empty? a) b)
        ((empty? b) a)
        ((< (first a) (first b)) (se (first a) (merge (bf a) b)))
        (else (se (first b) (merge a (bf b))))))

(define (skip-vowels wd)
  (if (and (not (empty? wd)) (vowel? (first wd)))
      (skip-vowels (bf wd))
      wd))
(define (syllables wd)
  (cond ((empty? wd) 0)
        ((vowel? (first wd)) (+ 1 (syllables (skip-vowels (bf wd)))))
        (else (syllables (bf wd)))))

;; ---- chapter 15
(define (to-binary n)
  (if (< n 2)
      n
      (word (to-binary (quotient n 2)) (remainder n 2))))

(define (letters-palindrome? wd)
  (cond ((< (count wd) 2) #t)
        ((equal? (first wd) (last wd)) (letters-palindrome? (bf (bl wd))))
        (else #f)))
(define (palindrome? sent)               ; reads the same backward as forward, letter by letter
  (letters-palindrome? (accumulate word sent)))

(define (prefixes wd)
  (if (empty? wd) '() (se (prefixes (bl wd)) wd)))
(define (substrings wd)
  (if (empty? wd) '() (se (prefixes wd) (substrings (bf wd)))))

(define (starts-with? small big)
  (cond ((empty? small) #t)
        ((empty? big) #f)
        ((equal? (first small) (first big)) (starts-with? (bf small) (bf big)))
        (else #f)))
(define (substring? small big)
  (cond ((empty? small) #t)
        ((empty? big) #f)
        ((starts-with? small big) #t)
        (else (substring? small (bf big)))))

(define (digit-letters d)                 ; digits 2 through 9; 7 is prs and 9 is wxy, three letters each
  (item (- d 1) '(abc def ghi jkl mno prs tuv wxy)))
(define (prepend-letter letter spellings)
  (if (empty? spellings)
      '()
      (se (word letter (first spellings)) (prepend-letter letter (bf spellings)))))
(define (prepend-each letters spellings)
  (if (empty? letters)
      '()
      (se (prepend-letter (first letters) spellings) (prepend-each (bf letters) spellings))))
(define (phone-spell n)
  (if (empty? n)
      (se "")
      (prepend-each (digit-letters (first n)) (phone-spell (bf n)))))

(define (nouns-of s)
  (if (or (empty? s) (not (equal? (first s) 'the)))
      '()
      (se (first (bf s)) (nouns-of (bf (bf s))))))
(define (verbs-of s)
  (if (and (not (empty? s)) (equal? (first s) 'the))
      (verbs-of (bf (bf s)))
      s))
(define (chain nouns verbs)
  (if (empty? nouns)
      '()
      (se 'that (first verbs) 'the (last nouns) (chain (bl nouns) (bf verbs)))))
(define (unscramble sent)
  (let* ((rest (bf (bf sent)))
         (nouns (nouns-of rest))
         (verbs (verbs-of rest)))
    (se 'this 'is 'the (last nouns) (chain (bl nouns) verbs))))
