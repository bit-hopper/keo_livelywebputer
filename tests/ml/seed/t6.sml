datatype 'a list = Empty | Cons of 'a * 'a list;
datatype box = Bacon | Ix of int;
exception Out_of_range;
(*--*)
fun list_item(n,Empty) = raise Out_of_range
  | list_item(n,Cons(abox,rest)) = if n = 1 then abox else list_item(n-1,rest);
(*--*)
fun find(n,boxes) = (check(n,boxes,list_item(n,boxes)) handle Out_of_range => find(n div 2,boxes))
and check(n,boxes,Bacon) = n
  | check(n,boxes,Ix(i)) = find(i,boxes);
(*--*)
val t = Cons(Ix(5),Cons(Ix(4),Cons(Bacon,Cons(Ix(2),Cons(Ix(7),Empty)))));
(*--*)
find(1,t);
(*--*)
val t2 = Cons(Ix(5),Cons(Ix(4),Cons(Bacon,Cons(Ix(2),Cons(Ix(3),Empty)))));
(*--*)
fun path(n,boxes) = Cons(n, (check2(n,boxes,list_item(n,boxes)) handle Out_of_range => path(n div 2,boxes)))
and check2(n,boxes,Bacon) = Empty
  | check2(n,boxes,Ix(i)) = path(i,boxes);
(*--*)
val t3 = Cons(Ix(5),Cons(Ix(13),Cons(Ix(8),Empty)));
(*--*)
fun divides_evenly(n,c) = ((n mod c) = 0);
(*--*)
local
  fun has_no_divisors2(n,c) = if c = 1 then true else if divides_evenly(n,c) then false else has_no_divisors2(n,c-1)
in
  fun is_prime2(n) = has_no_divisors2(n,n-1)
end;
(*--*)
is_prime2(37);
(*--*)
has_no_divisors2(7,6);
(*--*)
datatype 'a slist = Empty2 | Scons of ('a sexp) * ('a slist)
and 'a sexp = An_atom of 'a | A_slist of ('a slist);
(*--*)
datatype fruit = Peach | Apple | Pear | Lemon | Fig;
(*--*)
fun eq_fruit(Peach,Peach) = true | eq_fruit(Apple,Apple) = true | eq_fruit(Pear,Pear) = true | eq_fruit(Lemon,Lemon) = true | eq_fruit(Fig,Fig) = true | eq_fruit(a_fruit,another_fruit) = false;
(*--*)
fun occurs_in_slist(a,Empty2) = 0
  | occurs_in_slist(a,Scons(s,y)) = occurs_in_sexp(a,s) + occurs_in_slist(a,y)
and occurs_in_sexp(a,An_atom(b)) = if eq_fruit(b,a) then 1 else 0
  | occurs_in_sexp(a,A_slist(y)) = occurs_in_slist(a,y);
(*--*)
occurs_in_slist(Fig,Scons(An_atom(Fig),Scons(A_slist(Scons(An_atom(Fig),Scons(An_atom(Peach),Empty2))),Scons(An_atom(Fig),Scons(An_atom(Lemon),Empty2)))));
(*--*)
fun f_a(x) = x andalso not(x) orelse true;
(*--*)
fun cs(x) = case x of Empty => 0 | Cons(a,b) => 1;
(*--*)
fun nontail(0) = 0 | nontail(n) = 1 + nontail(n-1);
(*--*)
nontail(2000000);
(*--*)
fun loop(n) = loop(n+1);
(*--*)
val x = 5 val y = x + 1;
(*--*)
fun fact(n) = if n = 0 then 1 else n * fact(n-1);
(*--*)
fact(25);
(*--*)
type pair = int * bool;
(*--*)
fun swap((a,b):int * bool) = (b,a);
(*--*)
fun f(x,y) = x + y;
(*--*)
f(1);
(*--*)
f 1 2;
(*--*)
val g = f;
(*--*)
(fn x => x + 1) 2;
(*--*)
datatype t = A | B of int * int;
(*--*)
fun show(B(x,y)) = x + y | show(A) = 0;
(*--*)
B(1,2);
(*--*)
B;
(*--*)
(B(1,2), A, (), true);
