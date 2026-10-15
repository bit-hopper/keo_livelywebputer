signature N = sig type number exception Too_small val succ : number -> number val pred : number -> number val is_zero : number -> bool end;
(*--*)
functor NumberAsInt() :> N = struct type number = int exception Too_small fun succ(n) = n + 1 fun pred(n) = if n = 0 then raise Too_small else n - 1 fun is_zero(n) = (n = 0) end;
(*--*)
functor NumberAsNum() :> N = struct datatype num = Zero | One_more_than of num type number = num exception Too_small fun succ(n) = One_more_than(n) fun pred(Zero) = raise Too_small | pred(One_more_than(n)) = n fun is_zero(Zero) = true | is_zero(a_num) = false end;
(*--*)
structure IntStruct = NumberAsInt();
structure NumStruct = NumberAsNum();
(*--*)
signature P = sig type number val plus : (number * number) -> number end;
(*--*)
functor PON(structure a_N : N) :> P where type number = a_N.number = struct type number = a_N.number fun plus(n,m) = if a_N.is_zero(n) then m else a_N.succ(plus(a_N.pred(n),m)) end;
(*--*)
structure IntArith = PON(structure a_N = IntStruct);
structure NumArith = PON(structure a_N = NumStruct);
(*--*)
IntArith.plus(1,2);
(*--*)
NumStruct.Zero;
(*--*)
(*--*)
signature N_C_R = sig type number exception Too_small val conceal : int -> number val succ : number -> number val pred : number -> number val is_zero : number -> bool val reveal : number -> int end;
(*--*)
functor NumberAsInt3() :> N_C_R = struct type number = int exception Too_small fun conceal(n) = n fun succ(n) = n + 1 fun pred(n) = if n = 0 then raise Too_small else n - 1 fun is_zero(n) = (n = 0) fun reveal(n) = n end;
(*--*)
functor NumberAsNum3() :> N_C_R = struct datatype num = Zero | One_more_than of num type number = num exception Too_small fun conceal(n) = if n = 0 then Zero else One_more_than(conceal(n - 1)) fun succ(n) = One_more_than(n) fun pred(Zero) = raise Too_small | pred(One_more_than(n)) = n fun is_zero(Zero) = true | is_zero(a_num) = false fun reveal(n) = if is_zero(n) then 0 else 1 + reveal(pred(n)) end;
(*--*)
structure IntStruct3 = NumberAsInt3();
structure NumStruct3 = NumberAsNum3();
(*--*)
functor PON3(structure a_N : N_C_R) :> P where type number = a_N.number = struct type number = a_N.number fun plus(n,m) = if a_N.is_zero(n) then m else a_N.succ(plus(a_N.pred(n),m)) end;
(*--*)
structure NumArith3 = PON3(structure a_N = NumStruct3);
structure IntArith3 = PON3(structure a_N = IntStruct3);
(*--*)
NumStruct3.reveal(NumArith3.plus(NumStruct3.conceal(1), NumStruct3.conceal(2)));
(*--*)
IntStruct3.reveal(NumArith3.plus(IntStruct3.conceal(1), IntStruct3.conceal(2)));
(*--*)
functor NumberAsInt2() :> N where type number = int = struct type number = int exception Too_small fun succ(n) = n + 1 fun pred(n) = if n = 0 then raise Too_small else n - 1 fun is_zero(n) = (n = 0) end;
(*--*)
structure IntStruct2 = NumberAsInt2();
(*--*)
structure IntArith2 = PON(structure a_N = IntStruct2);
(*--*)
IntArith2.plus(1,2);
(*--*)
datatype num = Zero | One_more_than of num;
(*--*)
functor NumberAsNum2() :> N where type number = num = struct datatype num = Zero | One_more_than of num type number = num exception Too_small fun succ(n) = One_more_than(n) fun pred(Zero) = raise Too_small | pred(One_more_than(n)) = n fun is_zero(Zero) = true | is_zero(a_num) = false end;
(*--*)
signature S = sig type number1 type number2 val similar : (number1 * number2) -> bool end;
(*--*)
functor Same(structure a_N : N structure b_N : N) :> S where type number1 = a_N.number where type number2 = b_N.number = struct type number1 = a_N.number type number2 = b_N.number fun sim(n,m) = if a_N.is_zero(n) then b_N.is_zero(m) else sim(a_N.pred(n),b_N.pred(m)) fun similar(n,m) = ((sim(n,m) handle a_N.Too_small => false) handle b_N.Too_small => false) end;
(*--*)
structure SimIntNum = Same(structure a_N = IntStruct structure b_N = NumStruct);
(*--*)
signature J = sig val new_plus : (int * int) -> int end;
(*--*)
functor NP0(structure a_N : N_C_R structure a_P : P) :> J = struct fun new_plus(x,y) = a_N.reveal(a_P.plus(a_N.conceal(x),a_N.conceal(y))) end;
(*--*)
functor NP(structure a_N : N_C_R structure a_P : P sharing type a_N.number = a_P.number) :> J = struct fun new_plus(x,y) = a_N.reveal(a_P.plus(a_N.conceal(x),a_N.conceal(y))) end;
(*--*)
structure NPStruct = NP(structure a_N = NumStruct3 structure a_P = NumArith3);
(*--*)
structure NP1 = NP(structure a_N = NumStruct3 structure a_P = IntArith3);
(*--*)
NPStruct.new_plus(2,3);
(*--*)
structure NPStruct2 = NP(structure a_N = NumberAsNum3() structure a_P = PON3(structure a_N = a_N));
(*--*)
signature T = sig type number val times : (number * number) -> number end;
(*--*)
functor TON(structure a_N : N structure a_P : P sharing type a_N.number = a_P.number) :> T where type number = a_N.number = struct type number = a_N.number fun times(n,m) = if a_N.is_zero(m) then m else a_P.plus(n,times(n,a_N.pred(m))) end;
(*--*)
structure Ti = TON(structure a_N = IntStruct structure a_P = IntArith);
(*--*)
functor F2(structure a_N : N) = struct end;
(*--*)
functor Pt(structure a_N : N) : P where type number = a_N.number = struct type number = a_N.number fun plus(n,m) = n end;
(*--*)
structure IA = Pt(structure a_N = IntStruct);
(*--*)
IA.plus(IntStruct.succ(IntStruct.pred(IntStruct.succ(Z))), 2);
