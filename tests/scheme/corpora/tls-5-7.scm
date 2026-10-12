#lang tls
;; nested lists, arithmetic expressions, sets and relations

(define rember*
  (lambda (a l)
    (cond ((null? l) '())
          ((atom? (car l))
           (cond ((eq? (car l) a) (rember* a (cdr l)))
                 (else (cons (car l) (rember* a (cdr l))))))
          (else (cons (rember* a (car l)) (rember* a (cdr l)))))))

(define insertR*
  (lambda (new old l)
    (cond ((null? l) '())
          ((atom? (car l))
           (cond ((eq? (car l) old) (cons old (cons new (insertR* new old (cdr l)))))
                 (else (cons (car l) (insertR* new old (cdr l))))))
          (else (cons (insertR* new old (car l)) (insertR* new old (cdr l)))))))

(define occur*
  (lambda (a l)
    (cond ((null? l) 0)
          ((atom? (car l))
           (cond ((eq? (car l) a) (add1 (occur* a (cdr l))))
                 (else (occur* a (cdr l)))))
          (else (+ (occur* a (car l)) (occur* a (cdr l)))))))

(define subst*
  (lambda (new old l)
    (cond ((null? l) '())
          ((atom? (car l))
           (cond ((eq? (car l) old) (cons new (subst* new old (cdr l))))
                 (else (cons (car l) (subst* new old (cdr l))))))
          (else (cons (subst* new old (car l)) (subst* new old (cdr l)))))))

(define member*
  (lambda (a l)
    (cond ((null? l) #f)
          ((atom? (car l)) (or (eq? (car l) a) (member* a (cdr l))))
          (else (or (member* a (car l)) (member* a (cdr l)))))))

(define leftmost
  (lambda (l)
    (cond ((atom? (car l)) (car l))
          (else (leftmost (car l))))))

(define eqlist?
  (lambda (l1 l2)
    (cond ((and (null? l1) (null? l2)) #t)
          ((or (null? l1) (null? l2)) #f)
          ((and (atom? (car l1)) (atom? (car l2)))
           (and (eq? (car l1) (car l2)) (eqlist? (cdr l1) (cdr l2))))
          ((or (atom? (car l1)) (atom? (car l2))) #f)
          (else (and (eqlist? (car l1) (car l2)) (eqlist? (cdr l1) (cdr l2)))))))

;; arithmetic expressions in prefix form, with an operator picker
(define numbered?
  (lambda (aexp)
    (cond ((atom? aexp) (number? aexp))
          (else (and (numbered? (car (cdr aexp)))
                     (numbered? (car (cdr (cdr aexp)))))))))

(define 1st-sub-exp (lambda (aexp) (car (cdr aexp))))
(define 2nd-sub-exp (lambda (aexp) (car (cdr (cdr aexp)))))
(define operator (lambda (aexp) (car aexp)))

(define atom-to-function
  (lambda (x)
    (cond ((eq? x '+) +)
          ((eq? x '*) *)
          (else expt))))

(define value
  (lambda (nexp)
    (cond ((atom? nexp) nexp)
          (else ((atom-to-function (operator nexp))
                 (value (1st-sub-exp nexp))
                 (value (2nd-sub-exp nexp)))))))

;; sets
(define member?
  (lambda (a lat)
    (cond ((null? lat) #f)
          (else (or (eq? a (car lat)) (member? a (cdr lat)))))))

(define set?
  (lambda (lat)
    (cond ((null? lat) #t)
          ((member? (car lat) (cdr lat)) #f)
          (else (set? (cdr lat))))))

(define multirember
  (lambda (a lat)
    (cond ((null? lat) '())
          ((eq? a (car lat)) (multirember a (cdr lat)))
          (else (cons (car lat) (multirember a (cdr lat)))))))

(define makeset
  (lambda (lat)
    (cond ((null? lat) '())
          (else (cons (car lat) (makeset (multirember (car lat) (cdr lat))))))))

(define subset?
  (lambda (set1 set2)
    (cond ((null? set1) #t)
          (else (and (member? (car set1) set2) (subset? (cdr set1) set2))))))

(define eqset? (lambda (s1 s2) (and (subset? s1 s2) (subset? s2 s1))))

(define intersect
  (lambda (s1 s2)
    (cond ((null? s1) '())
          ((member? (car s1) s2) (cons (car s1) (intersect (cdr s1) s2)))
          (else (intersect (cdr s1) s2)))))

(define union
  (lambda (s1 s2)
    (cond ((null? s1) s2)
          ((member? (car s1) s2) (union (cdr s1) s2))
          (else (cons (car s1) (union (cdr s1) s2))))))

;; pairs and relations
(define a-pair?
  (lambda (x)
    (cond ((atom? x) #f)
          ((null? x) #f)
          ((null? (cdr x)) #f)
          ((null? (cdr (cdr x))) #t)
          (else #f))))

(define first (lambda (p) (car p)))
(define second (lambda (p) (car (cdr p))))
(define build (lambda (s1 s2) (cons s1 (cons s2 '()))))

(define revpair (lambda (pair) (build (second pair) (first pair))))
(define revrel
  (lambda (rel)
    (cond ((null? rel) '())
          (else (cons (revpair (car rel)) (revrel (cdr rel)))))))

(define firsts
  (lambda (l)
    (cond ((null? l) '())
          (else (cons (car (car l)) (firsts (cdr l)))))))
(define fun?
  (lambda (rel) (set? (firsts rel))))
(define fullfun?
  (lambda (fun) (set? (firsts (revrel fun)))))
