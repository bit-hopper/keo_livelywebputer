;;; Library selected by a cell's first line:  #lang simply
;;;
;;; The word-and-sentence vocabulary that introductory courses build on.
;;; A WORD is a symbol, string or number; a SENTENCE is a list of words.
;;; Our own implementation of the documented behaviour, not a copy of any
;;; existing library file.
;;;
;;;   word? sentence? empty?
;;;   first last butfirst bf butlast bl item count
;;;   word sentence se member? before? appearances
;;;   every keep accumulate repeated
;;;   show show-line align
;;;   read-line (no argument: the typed line as a sentence)
;;;   match (pattern matcher, see the end of the file)
;;;
;;; These replace the core's list-oriented first / last / count / every. The
;;; core's own procedures don't call them, so nothing in the core changes
;;; behaviour. Keep any mutable state behind procedures: this file is compiled
;;; against the system globals, and top-level variables a library assigns later
;;; are not seen by user code.

;;; ---------------------------------------------------------------- helpers
;;; (names start with % so they stay out of the way of user definitions)

(define (%bad who x)
  (error (string-append "Invalid argument to " who ":") x))

;; the text of a word
(define (%ws w)
  (cond ((symbol? w) (symbol->string w))
        ((string? w) w)
        (else (number->string w))))

;; digits with at most one point, optional leading minus: reads as a number
(define (%numeric-text? s)
  (let ((n (string-length s)))
    (and (> n 0)
         (let loop ((i (if (char=? (string-ref s 0) #\-) 1 0)) (digits 0) (points 0))
           (cond ((= i n) (and (> digits 0) (<= points 1)))
                 ((char-numeric? (string-ref s i)) (loop (+ i 1) (+ digits 1) points))
                 ((char=? (string-ref s i) #\.) (loop (+ i 1) digits (+ points 1)))
                 (else #f))))))

;; the word whose text is s: a number if it looks like one, "" if empty
(define (%string->word s)
  (cond ((= (string-length s) 0) "")
        ((%numeric-text? s) (string->number s))
        (else (string->symbol s))))

(define (%all-words? l)
  (cond ((null? l) #t)
        ((word? (car l)) (%all-words? (cdr l)))
        (else #f)))

;; the letters of a word, each as a word
(define (%letters w)
  (map (lambda (c) (%string->word (string c))) (string->list (%ws w))))

(define (%elements x who)
  (cond ((word? x) (%letters x))
        ((sentence? x) x)
        (else (%bad who x))))

;;; ---------------------------------------------------------------- predicates

(define (word? x)
  (or (symbol? x) (string? x) (number? x)))

(define (sentence? x)
  (and (list? x) (%all-words? x)))

(define (empty? x)
  (or (null? x) (and (string? x) (= (string-length x) 0))))

;;; ---------------------------------------------------------------- selectors

(define (first x)
  (cond ((pair? x) (car x))
        ((and (word? x) (> (string-length (%ws x)) 0))
         (%string->word (substring (%ws x) 0 1)))
        (else (%bad "first" x))))

(define (last x)
  (cond ((pair? x) (car (last-pair x)))
        ((and (word? x) (> (string-length (%ws x)) 0))
         (let ((s (%ws x)))
           (%string->word (substring s (- (string-length s) 1) (string-length s)))))
        (else (%bad "last" x))))

(define (butfirst x)
  (cond ((pair? x) (cdr x))
        ((and (word? x) (> (string-length (%ws x)) 0))
         (let ((s (%ws x))) (%string->word (substring s 1 (string-length s)))))
        (else (%bad "butfirst" x))))

(define (butlast x)
  (cond ((pair? x) (list-head x (- (length x) 1)))
        ((and (word? x) (> (string-length (%ws x)) 0))
         (let ((s (%ws x))) (%string->word (substring s 0 (- (string-length s) 1)))))
        (else (%bad "butlast" x))))

(define bf butfirst)
(define bl butlast)

(define (count x)
  (cond ((word? x) (string-length (%ws x)))
        ((sentence? x) (length x))
        (else (%bad "count" x))))

(define (item n x)
  (let ((elements (%elements x "item")))
    (if (and (integer? n) (>= n 1) (<= n (length elements)))
        (list-ref elements (- n 1))
        (%bad "item" n))))

;;; ---------------------------------------------------------------- constructors

(define (word . args)
  (let loop ((l args) (parts '()))
    (cond ((null? l) (%string->word (apply string-append (reverse parts))))
          ((word? (car l)) (loop (cdr l) (cons (%ws (car l)) parts)))
          (else (%bad "word" (car l))))))

(define (sentence . args)
  (let loop ((l args) (parts '()))
    (cond ((null? l) (apply append (reverse parts)))
          ((word? (car l)) (loop (cdr l) (cons (list (car l)) parts)))
          ((sentence? (car l)) (loop (cdr l) (cons (car l) parts)))
          (else (error "Argument to sentence not a word or sentence:" (car l))))))

(define se sentence)

;;; ---------------------------------------------------------------- comparisons

(define (member? x s)
  (cond ((word? s)
         (and (word? x)
              (let loop ((l (%letters s)))
                (cond ((null? l) #f)
                      ((equal? (car l) x) #t)
                      (else (loop (cdr l)))))))
        ((sentence? s)
         (let loop ((l s))
           (cond ((null? l) #f)
                 ((equal? (car l) x) #t)
                 (else (loop (cdr l))))))
        (else (%bad "member?" s))))

(define (before? a b)
  (if (not (word? a)) (%bad "before?" a))
  (if (not (word? b)) (%bad "before?" b))
  (if (and (number? a) (number? b))
      (< a b)
      (string<? (%ws a) (%ws b))))

(define (appearances x s)
  (let loop ((l (%elements s "appearances")) (n 0))
    (cond ((null? l) n)
          ((equal? (car l) x) (loop (cdr l) (+ n 1)))
          (else (loop (cdr l) n)))))

;;; ---------------------------------------------------------------- higher-order

;; Apply f to each word of a sentence (each letter of a word); the results are
;; combined into one sentence.
(define (every f s)
  (let loop ((l (%elements s "every")) (acc '()))
    (if (null? l)
        (apply sentence (reverse acc))
        (loop (cdr l) (cons (f (car l)) acc)))))

;; The words of a sentence satisfying pred, as a sentence; the letters of a
;; word satisfying pred, as a word.
(define (keep pred s)
  (let ((kept (let loop ((l (%elements s "keep")) (acc '()))
                (cond ((null? l) (reverse acc))
                      ((pred (car l)) (loop (cdr l) (cons (car l) acc)))
                      (else (loop (cdr l) acc))))))
    (if (word? s) (apply word kept) kept)))

;; Combine the words (letters) with a two-argument procedure, from the right.
(define (accumulate f s)
  (let ((l (%elements s "accumulate")))
    (cond ((null? l)
           (cond ((eq? f +) 0)
                 ((eq? f *) 1)
                 ((eq? f word) "")
                 ((or (eq? f sentence) (eq? f se)) '())
                 (else (error "Can't accumulate empty input with that function:" f))))
          (else
           (let loop ((l l))
             (if (null? (cdr l))
                 (car l)
                 (f (car l) (loop (cdr l)))))))))

;; (repeated f n) is the procedure that applies f n times.
(define (repeated f n)
  (lambda (x)
    (let loop ((i n) (x x))
      (if (<= i 0) x (loop (- i 1) (f x))))))

;;; ---------------------------------------------------------------- output

;; Print a value as it would be written, then a newline.
(define (show x)
  (write x)
  (newline))

;; Print the words of a sentence separated by spaces, without the parentheses.
(define (show-line s)
  (let loop ((l s) (first? #t))
    (if (pair? l)
        (begin (if (not first?) (display " "))
               (display (car l))
               (loop (cdr l) #f))))
  (newline))

;; (align x width): a word is left-justified and padded or cut to width;
;; a number is right-justified, with its decimals rounded when they don't fit.
(define (align x width)
  (define (pad-right s) (string-append s (make-string (max 0 (- width (string-length s))) #\space)))
  (cond ((and (number? x) (exact? x) (integer? x))
         (let ((s (number->string x)))
           (if (> (string-length s) width)
               (make-string width #\*)
               (string-pad-left s width))))
        ((number? x)
         (let loop ((places 6))
           (let* ((scale (expt 10 places))
                  (s (number->string (/ (round (* x scale)) scale))))
             (cond ((<= (string-length s) width) (string-pad-left s width))
                   ((> places 0) (loop (- places 1)))
                   (else (make-string width #\*))))))
        ((word? x)
         (let ((s (%ws x)))
           (if (> (string-length s) width) (substring s 0 width) (pad-right s))))
        (else (%bad "align" x))))

;;; ---------------------------------------------------------------- input

(define %primitive-read-line read-line)

;; With no argument, read a line from the console and return its words as a
;; sentence (numbers become numbers). With a port, behaves as usual.
(define (read-line . port)
  (if (pair? port)
      (apply %primitive-read-line port)
      (let ((line (%primitive-read-line)))
        (if (eof-object? line)
            line
            (let loop ((chars (string->list line)) (cur '()) (acc '()))
              (define (flush) (if (null? cur) acc (cons (%string->word (list->string (reverse cur))) acc)))
              (cond ((null? chars) (reverse (flush)))
                    ((char-whitespace? (car chars)) (loop (cdr chars) '() (flush)))
                    (else (loop (cdr chars) (cons (car chars) cur) acc))))))))

;;; ---------------------------------------------------------------- pattern matcher
;;;
;;; (match pattern sentence) -> #f when it fails, #t when it succeeds with no
;;; named placeholders, otherwise a sentence  name value... ! name value... !
;;; Placeholders (a name may follow the symbol, as in *rest or ?x):
;;;   *   any number of words, including none
;;;   &   one or more words
;;;   ?   zero or one word
;;;   !   exactly one word
;;; A name used twice must match the same words both times.

(define (%placeholder? w)
  (and (symbol? w)
       (let ((s (symbol->string w)))
         (and (> (string-length s) 0)
              (memv (string-ref s 0) '(#\* #\& #\? #\!))
              #t))))

(define (%placeholder-kind w) (string-ref (symbol->string w) 0))

(define (%placeholder-name w)
  (let ((s (symbol->string w)))
    (if (= (string-length s) 1) #f (string->symbol (substring s 1 (string-length s))))))

;; known: list of (name . words), most recent first
(define (%match-from pattern sent known)
  (cond ((null? pattern) (if (null? sent) known #f))
        ((%placeholder? (car pattern))
         (let* ((kind (%placeholder-kind (car pattern)))
                (name (%placeholder-name (car pattern)))
                (bound (and name (assq name known)))
                (lo (if (or (char=? kind #\&) (char=? kind #\!)) 1 0))
                (hi (cond ((char=? kind #\!) 1) ((char=? kind #\?) 1) (else (length sent)))))
           (let try ((n lo))
             (cond ((> n (min hi (length sent))) #f)
                   (else
                    (let ((taken (list-head sent n)))
                      (or (and (or (not bound) (equal? (cdr bound) taken))
                               (%match-from (cdr pattern) (list-tail sent n)
                                            (if (and name (not bound))
                                                (cons (cons name taken) known)
                                                known)))
                          (try (+ n 1)))))))))
        ((and (pair? sent) (equal? (car pattern) (car sent)))
         (%match-from (cdr pattern) (cdr sent) known))
        (else #f)))

(define (match pattern sent)
  (let ((known (%match-from pattern sent '())))
    (cond ((not known) #f)
          ((null? known) #t)
          (else (apply append
                       (map (lambda (entry) (append (list (car entry)) (cdr entry) '(!)))
                            (reverse known)))))))
