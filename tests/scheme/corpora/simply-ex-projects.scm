#lang simply

;; Solutions for three of the larger projects: scoring a bridge hand, spelling out a number, and
;; naming a poker hand. Our own code.

;; ---- bridge: a card is a word like h5 or dk, a hand is a sentence of cards
(define (card-val card)
  (let ((rank (bf card)))
    (cond ((equal? rank 'a) 4)
          ((equal? rank 'k) 3)
          ((equal? rank 'q) 2)
          ((equal? rank 'j) 1)
          (else 0))))

(define (high-card-points hand)
  (accumulate + (every card-val hand)))

(define (count-suit suit hand)
  (count (keep (lambda (card) (equal? (first card) suit)) hand)))

(define (suit-counts hand)
  (every (lambda (suit) (count-suit suit hand)) '(s h c d)))

(define (suit-dist-points n)
  (cond ((= n 2) 1)
        ((= n 1) 2)
        ((= n 0) 3)
        (else 0)))

(define (hand-dist-points hand)
  (accumulate + (every suit-dist-points (suit-counts hand))))

(define (bridge-val hand)
  (+ (high-card-points hand) (hand-dist-points hand)))

;; ---- spelling out a number
(define (factorial n) (if (= n 0) 1 (* n (factorial (- n 1)))))

(define small-names
  '(one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen
    sixteen seventeen eighteen nineteen))
(define tens-names '(twenty thirty forty fifty sixty seventy eighty ninety))
(define big-names
  '(thousand million billion trillion quadrillion quintillion sextillion septillion octillion
    nonillion decillion))

(define (below-hundred n)
  (cond ((= n 0) '())
        ((< n 20) (se (item n small-names)))
        (else (se (item (- (quotient n 10) 1) tens-names) (below-hundred (remainder n 10))))))

(define (below-thousand n)
  (if (>= n 100)
      (se (item (quotient n 100) small-names) 'hundred (below-hundred (remainder n 100)))
      (below-hundred n)))

(define (name-groups n place)
  (if (= n 0)
      '()
      (let ((group (remainder n 1000)))
        (se (name-groups (quotient n 1000) (+ place 1))
            (if (= group 0)
                '()
                (se (below-thousand group) (if (= place 0) '() (item place big-names))))))))

(define (number-name n)
  (if (= n 0) '(zero) (name-groups n 0)))

;; ---- poker
(define (suit card) (first card))
(define (rank card) (bf card))
(define (rank-value r)
  (cond ((equal? r 'a) 14)
        ((equal? r 'k) 13)
        ((equal? r 'q) 12)
        ((equal? r 'j) 11)
        (else r)))
(define (rank-singular v)
  (item v '(ace two three four five six seven eight nine ten jack queen king ace)))
(define (rank-plural v)
  (let ((s (rank-singular v)))
    (if (equal? (last s) 'x) (word s 'es) (word s 's))))
(define (suit-plural s)
  (cond ((equal? s 's) 'spades)
        ((equal? s 'h) 'hearts)
        ((equal? s 'c) 'clubs)
        (else 'diamonds)))

(define (count-word n)
  (item n '(one two three four)))
(define (compute-ranks ranks)
  (if (empty? ranks)
      '()
      (let ((r (first ranks)))
        (se (count-word (appearances r ranks))
            r
            (compute-ranks (keep (lambda (x) (not (equal? x r))) (bf ranks)))))))

(define (ranks-with-count n grouped)
  (cond ((empty? grouped) '())
        ((equal? (first grouped) n) (se (first (bf grouped)) (ranks-with-count n (bf (bf grouped)))))
        (else (ranks-with-count n (bf (bf grouped))))))

(define (sorted-values hand)
  (sort (map (lambda (card) (rank-value (rank card))) hand) <))
(define (consecutive? vals)
  (or (null? (cdr vals))
      (and (= (+ (car vals) 1) (cadr vals)) (consecutive? (cdr vals)))))
(define (straight-high hand)             ; the high card of a straight, or #f
  (let ((vals (sorted-values hand)))
    (cond ((consecutive? vals) (car (reverse vals)))
          ((equal? vals '(2 3 4 5 14)) 5)
          (else #f))))
(define (flush? hand)
  (= (count (keep (lambda (card) (equal? (suit card) (suit (first hand)))) hand)) (count hand)))

(define (poker-value hand)
  (let* ((grouped (compute-ranks (every rank hand)))
         (high (straight-high hand))
         (flush (flush? hand))
         (suit-name (suit-plural (suit (first hand)))))
    (cond ((and flush high (= high 14)) (se 'royal 'flush '- suit-name))
          ((and flush high) (se (word (rank-singular high) '-high) 'straight 'flush '- suit-name))
          ((member? 'four grouped)
           (se 'four 'of 'a 'kind '- (rank-plural (rank-value (first (ranks-with-count 'four grouped))))))
          ((and (member? 'three grouped) (member? 'two grouped))
           (se 'full 'house '-
               (rank-plural (rank-value (first (ranks-with-count 'three grouped))))
               'over
               (rank-plural (rank-value (first (ranks-with-count 'two grouped))))))
          (flush (se 'flush '- suit-name))
          (high (se (word (rank-singular high) '-high) 'straight))
          ((member? 'three grouped)
           (se 'three 'of 'a 'kind '- (rank-plural (rank-value (first (ranks-with-count 'three grouped))))))
          ((= 2 (count (ranks-with-count 'two grouped)))
           (let ((pairs (sort (map rank-value (ranks-with-count 'two grouped)) >)))
             (se 'two 'pair '- (rank-plural (car pairs)) 'and (rank-plural (cadr pairs)))))
          ((member? 'two grouped)
           (se 'pair 'of (rank-plural (rank-value (first (ranks-with-count 'two grouped))))))
          (else '(nothing)))))
