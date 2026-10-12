#lang sicp
;; A register-machine simulator: registers, a stack with statistics, a machine
;; that is a message-passing procedure, and an assembler that turns controller
;; text into closures. Machines described at the bottom exercise it.

;; ---- registers and the stack ---------------------------------------------

(define (make-register name)
  (let ((contents '*unassigned*))
    (define (dispatch message)
      (cond ((eq? message 'get) contents)
            ((eq? message 'set) (lambda (value) (set! contents value)))
            (else (error "Unknown request -- REGISTER" message))))
    dispatch))

(define (get-contents register) (register 'get))
(define (set-contents! register value) ((register 'set) value))

(define (make-stack)
  (let ((items '()) (number-pushes 0) (max-depth 0) (current-depth 0))
    (define (push x)
      (set! items (cons x items))
      (set! number-pushes (+ number-pushes 1))
      (set! current-depth (+ current-depth 1))
      (set! max-depth (max max-depth current-depth))
      'done)
    (define (pop)
      (if (null? items)
          (error "Empty stack -- POP")
          (let ((top (car items)))
            (set! items (cdr items))
            (set! current-depth (- current-depth 1))
            top)))
    (define (initialize)
      (set! items '())
      (set! number-pushes 0)
      (set! max-depth 0)
      (set! current-depth 0)
      'done)
    (define (statistics) (list number-pushes max-depth))
    (define (dispatch message)
      (cond ((eq? message 'push) push)
            ((eq? message 'pop) (pop))
            ((eq? message 'initialize) (initialize))
            ((eq? message 'statistics) (statistics))
            (else (error "Unknown request -- STACK" message))))
    dispatch))

(define (pop stack) (stack 'pop))
(define (push stack value) ((stack 'push) value))

;; ---- the machine -----------------------------------------------------------

(define (make-new-machine)
  (let ((pc (make-register 'pc))
        (flag (make-register 'flag))
        (stack (make-stack))
        (the-instruction-sequence '()))
    (let ((the-ops
           (list (list 'initialize-stack (lambda () (stack 'initialize)))))
          (register-table (list (list 'pc pc) (list 'flag flag))))
      (define (allocate-register name)
        (if (assoc name register-table)
            (error "Multiply defined register:" name)
            (set! register-table
                  (cons (list name (make-register name)) register-table)))
        'register-allocated)
      (define (lookup-register name)
        (let ((entry (assoc name register-table)))
          (if entry
              (cadr entry)
              (error "Unknown register:" name))))
      (define (execute)
        (let ((insts (get-contents pc)))
          (if (null? insts)
              'done
              (begin ((instruction-execution-proc (car insts)))
                     (execute)))))
      (define (dispatch message)
        (cond ((eq? message 'start)
               (set-contents! pc the-instruction-sequence)
               (execute))
              ((eq? message 'install-instruction-sequence)
               (lambda (seq) (set! the-instruction-sequence seq)))
              ((eq? message 'allocate-register) allocate-register)
              ((eq? message 'get-register) lookup-register)
              ((eq? message 'install-operations)
               (lambda (ops) (set! the-ops (append the-ops ops))))
              ((eq? message 'stack) stack)
              ((eq? message 'operations) the-ops)
              (else (error "Unknown request -- MACHINE" message))))
      dispatch)))

(define (make-machine register-names ops controller-text)
  (let ((machine (make-new-machine)))
    (for-each (lambda (register-name)
                ((machine 'allocate-register) register-name))
              register-names)
    ((machine 'install-operations) ops)
    ((machine 'install-instruction-sequence)
     (assemble controller-text machine))
    machine))

(define (get-register machine register-name)
  ((machine 'get-register) register-name))

(define (get-register-contents machine register-name)
  (get-contents (get-register machine register-name)))

(define (set-register-contents! machine register-name value)
  (set-contents! (get-register machine register-name) value)
  'done)

(define (start machine) (machine 'start))

;; ---- the assembler ---------------------------------------------------------

(define (assemble controller-text machine)
  (extract-labels controller-text
                  (lambda (insts labels)
                    (update-insts! insts labels machine)
                    insts)))

(define (extract-labels text receive)
  (if (null? text)
      (receive '() '())
      (extract-labels
       (cdr text)
       (lambda (insts labels)
         (let ((next-inst (car text)))
           (if (symbol? next-inst)
               (receive insts
                        (cons (make-label-entry next-inst insts) labels))
               (receive (cons (make-instruction next-inst) insts)
                        labels)))))))

(define (update-insts! insts labels machine)
  (let ((pc (get-register machine 'pc))
        (flag (get-register machine 'flag))
        (stack (machine 'stack))
        (ops (machine 'operations)))
    (for-each
     (lambda (inst)
       (set-instruction-execution-proc!
        inst
        (make-execution-procedure
         (instruction-text inst) labels machine pc flag stack ops)))
     insts)))

(define (make-instruction text) (cons text '()))
(define (instruction-text inst) (car inst))
(define (instruction-execution-proc inst) (cdr inst))
(define (set-instruction-execution-proc! inst proc) (set-cdr! inst proc))

(define (make-label-entry label-name insts) (cons label-name insts))

(define (lookup-label labels label-name)
  (let ((entry (assoc label-name labels)))
    (if entry
        (cdr entry)
        (error "Undefined label -- ASSEMBLE" label-name))))

(define (make-execution-procedure inst labels machine pc flag stack ops)
  (let ((kind (car inst)))
    (cond ((eq? kind 'assign) (make-assign inst machine labels ops pc))
          ((eq? kind 'test) (make-test inst machine labels ops flag pc))
          ((eq? kind 'branch) (make-branch inst machine labels flag pc))
          ((eq? kind 'goto) (make-goto inst machine labels pc))
          ((eq? kind 'save) (make-save inst machine stack pc))
          ((eq? kind 'restore) (make-restore inst machine stack pc))
          ((eq? kind 'perform) (make-perform inst machine labels ops pc))
          (else (error "Unknown instruction type -- ASSEMBLE" inst)))))

(define (advance-pc pc)
  (set-contents! pc (cdr (get-contents pc))))

(define (make-assign inst machine labels operations pc)
  (let ((target (get-register machine (cadr inst)))
        (value-exp (cddr inst)))
    (let ((value-proc
           (if (operation-exp? value-exp)
               (make-operation-exp value-exp machine labels operations)
               (make-primitive-exp (car value-exp) machine labels))))
      (lambda ()
        (set-contents! target (value-proc))
        (advance-pc pc)))))

(define (make-test inst machine labels operations flag pc)
  (let ((condition (cdr inst)))
    (if (operation-exp? condition)
        (let ((condition-proc
               (make-operation-exp condition machine labels operations)))
          (lambda ()
            (set-contents! flag (condition-proc))
            (advance-pc pc)))
        (error "Bad TEST instruction -- ASSEMBLE" inst))))

(define (make-branch inst machine labels flag pc)
  (let ((dest (cadr inst)))
    (if (eq? (car dest) 'label)
        (let ((insts (lookup-label labels (cadr dest))))
          (lambda ()
            (if (get-contents flag)
                (set-contents! pc insts)
                (advance-pc pc))))
        (error "Bad BRANCH instruction -- ASSEMBLE" inst))))

(define (make-goto inst machine labels pc)
  (let ((dest (cadr inst)))
    (cond ((eq? (car dest) 'label)
           (let ((insts (lookup-label labels (cadr dest))))
             (lambda () (set-contents! pc insts))))
          ((eq? (car dest) 'reg)
           (let ((reg (get-register machine (cadr dest))))
             (lambda () (set-contents! pc (get-contents reg)))))
          (else (error "Bad GOTO instruction -- ASSEMBLE" inst)))))

(define (make-save inst machine stack pc)
  (let ((reg (get-register machine (cadr inst))))
    (lambda ()
      (push stack (get-contents reg))
      (advance-pc pc))))

(define (make-restore inst machine stack pc)
  (let ((reg (get-register machine (cadr inst))))
    (lambda ()
      (set-contents! reg (pop stack))
      (advance-pc pc))))

(define (make-perform inst machine labels operations pc)
  (let ((action (cdr inst)))
    (if (operation-exp? action)
        (let ((action-proc
               (make-operation-exp action machine labels operations)))
          (lambda ()
            (action-proc)
            (advance-pc pc)))
        (error "Bad PERFORM instruction -- ASSEMBLE" inst))))

(define (make-primitive-exp exp machine labels)
  (cond ((eq? (car exp) 'const)
         (let ((c (cadr exp))) (lambda () c)))
        ((eq? (car exp) 'label)
         (let ((insts (lookup-label labels (cadr exp))))
           (lambda () insts)))
        ((eq? (car exp) 'reg)
         (let ((r (get-register machine (cadr exp))))
           (lambda () (get-contents r))))
        (else (error "Unknown expression type -- ASSEMBLE" exp))))

(define (operation-exp? exp)
  (and (pair? exp) (pair? (car exp)) (eq? (car (car exp)) 'op)))

(define (make-operation-exp exp machine labels operations)
  (let ((op (lookup-prim (cadr (car exp)) operations))
        (aprocs (map (lambda (e) (make-primitive-exp e machine labels))
                     (cdr exp))))
    (lambda ()
      (apply op (map (lambda (p) (p)) aprocs)))))

(define (lookup-prim symbol operations)
  (let ((entry (assoc symbol operations)))
    (if entry
        (cadr entry)
        (error "Unknown operation -- ASSEMBLE" symbol))))

;; ---- machines to run -------------------------------------------------------

(define (run-machine machine settings result-register)
  (for-each (lambda (s) (set-register-contents! machine (car s) (cadr s)))
            settings)
  (start machine)
  (get-register-contents machine result-register))

(define gcd-machine
  (make-machine
   '(a b t)
   (list (list 'rem remainder) (list '= =))
   '(test-b
     (test (op =) (reg b) (const 0))
     (branch (label gcd-done))
     (assign t (op rem) (reg a) (reg b))
     (assign a (reg b))
     (assign b (reg t))
     (goto (label test-b))
     gcd-done)))

(define fact-machine
  (make-machine
   '(n val continue)
   (list (list '= =) (list '- -) (list '* *))
   '((perform (op initialize-stack))
     (assign continue (label fact-done))
     fact-loop
     (test (op =) (reg n) (const 1))
     (branch (label base-case))
     (save continue)
     (save n)
     (assign n (op -) (reg n) (const 1))
     (assign continue (label after-fact))
     (goto (label fact-loop))
     after-fact
     (restore n)
     (restore continue)
     (assign val (op *) (reg n) (reg val))
     (goto (reg continue))
     base-case
     (assign val (const 1))
     (goto (reg continue))
     fact-done)))

(define fib-machine
  (make-machine
   '(n val continue)
   (list (list '< <) (list '- -) (list '+ +))
   '((perform (op initialize-stack))
     (assign continue (label fib-done))
     fib-loop
     (test (op <) (reg n) (const 2))
     (branch (label immediate-answer))
     (save continue)
     (assign continue (label afterfib-n-1))
     (save n)
     (assign n (op -) (reg n) (const 1))
     (goto (label fib-loop))
     afterfib-n-1
     (restore n)
     (restore continue)
     (assign n (op -) (reg n) (const 2))
     (save continue)
     (assign continue (label afterfib-n-2))
     (save val)
     (goto (label fib-loop))
     afterfib-n-2
     (assign n (reg val))
     (restore val)
     (restore continue)
     (assign val (op +) (reg val) (reg n))
     (goto (reg continue))
     immediate-answer
     (assign val (reg n))
     (goto (reg continue))
     fib-done)))

(define recorded '())
(define (record! x) (set! recorded (append recorded (list x))))

(define countdown-machine
  (make-machine
   '(n)
   (list (list '= =) (list '- -) (list 'record record!))
   '(top
     (test (op =) (reg n) (const 0))
     (branch (label finished))
     (perform (op record) (reg n))
     (assign n (op -) (reg n) (const 1))
     (goto (label top))
     finished)))

(define sum-machine
  (make-machine
   '(n total)
   (list (list '= =) (list '+ +) (list '- -))
   '((assign total (const 0))
     top
     (test (op =) (reg n) (const 0))
     (branch (label finished))
     (assign total (op +) (reg total) (reg n))
     (assign n (op -) (reg n) (const 1))
     (goto (label top))
     finished)))
