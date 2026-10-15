datatype shish_kebab = Skewer | Onion of shish_kebab | Lamb of shish_kebab | Tomato of shish_kebab;
(*--*)
fun only_onions(Skewer) = true
  | only_onions(Onion(x)) = only_onions(x)
  | only_onions(Lamb(x)) = false
  | only_onions(Tomato(x)) = false;
(*--*)
(only_onions : shish_kebab -> bool);
(*--*)
only_onions(5);
(*--*)
datatype int open_faced_sandwich = Bread of int | Slice of int open_faced_sandwich;
(*--*)
datatype fish = Anchovy | Lox | Tuna;
(*--*)
datatype fish pizza = Bottom | Topping of (fish * (fish pizza));
(*--*)
datatype 'a pizza = Bottom | Topping of ('a * ('a pizza));
(*--*)
fun rem_fish(x,Bottom) = Bottom
  | rem_fish(x,Topping(x,p)) = rem_fish(x,p)
  | rem_fish(x,Topping(t,p)) = Topping(t,rem_fish(x,p));
(*--*)
datatype pizza2 = Crust | Cheese of pizza2 | Anchovy2 of pizza2;
(*--*)
fun remove_anchovy(Crust) = Crust
  | remove_anchovy(Anchovy2(x)) = remove_anchovy(x)
  | remove_anchovy(C(x)) = C(remove_anchovy(x));
(*--*)
fun f1(Crust) = 1 | f1(Cheese(x)) = 2;
(*--*)
fun f2(Crust) = 1 | f2(x) = 2 | f2(Cheese(y)) = 3;
(*--*)
datatype meza = Shrimp | Calamari | Escargots | Hummus;
datatype main = Steak | Ravioli | Chicken | Eggplant;
datatype dessert = Sundae | Mousse | Torte;
(*--*)
fun add_a_steak2(x) = (x,Steak);
(*--*)
(add_a_steak2 : 'a -> ('a * main));
(*--*)
(add_a_steak2 : meza -> (meza * main));
(*--*)
(add_a_steak2 : int -> (int * main));
(*--*)
fun has_steak(a_meza,Steak,a_dessert) = true
  | has_steak(a_meza,a_main,a_dessert) = false;
(*--*)
(has_steak : ('a * main * 'b) -> bool);
(*--*)
(has_steak : (meza * main * dessert) -> bool);
(*--*)
(has_steak : ('a * main * 'a) -> bool);
(*--*)
has_steak(5,Steak,true);
(*--*)
fun has_steak2(a:meza,Steak,d:dessert):bool = true
  | has_steak2(a:meza,ns,d:dessert):bool = false;
(*--*)
has_steak2(5,Steak,true);
(*--*)
fun eq_int(n:int,m:int) = (n = m);
fun less_than(n:int,m:int) = (n < m);
(*--*)
eq_int(17,Tuna);
(*--*)
(7 div 2, ~7 div 2, ~7 mod 2, 15 mod 4, 10 div 2);
(*--*)
1 div 0;
(*--*)
4611686018427387903 + 1;
(*--*)
Cheese(Crust) = Cheese(Crust);
(*--*)
fun eq_funcs(f:int->int,g:int->int) = (f = g);
(*--*)
datatype chain = Link of (int * (int -> chain));
fun ints(n) = Link(n+1, ints);
(*--*)
ints(0);
(*--*)
fun fibs(n)(m) = Link(n+m, fibs(m));
(*--*)
fibs;
(*--*)
fibs(1)(1);
(*--*)
fun subst_c(pred)(n,[]) = [] | subst_c(pred)(n,e::t) = if pred(e) then n::subst_c(pred)(n,t) else e::subst_c(pred)(n,t);
(*--*)
(subst_c : ('a -> bool) -> (('a * ('a list)) -> ('a list)));
(*--*)
fun subst_c2(pred) = fn (n,[]) => [] | (n,e::t) => if pred(e) then n::subst_c2(pred)(n,t) else e::subst_c2(pred)(n,t);
(*--*)
exception No_bacon of int;
(*--*)
val e = No_bacon(0);
(*--*)
raise No_bacon(3);
(*--*)
(raise No_bacon(3)) handle No_bacon(an_int) => an_int + 1;
(*--*)
fun g(x) = if x = 0 then raise No_bacon(0) else x;
(*--*)
(g(0)) handle No_bacon(5) => 1;
(*--*)
val deep = let fun count(0) = 0 | count(n) = 1 + count(n-1) in count(1000000) end;
(*--*)
val big = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25];
(*--*)
Compiler.Control.Print.printDepth := 100;
(*--*)
val big = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25];
(*--*)
val (a, b) = (1, true);
(*--*)
fun pair_up(x:'a) = (x,x);
(*--*)
fun id(x) = x;
(*--*)
val z = id(id);
(*--*)
val w = [];
(*--*)
fun f(x) = x + 1 and g2(y) = f(y) * 2;
(*--*)
fun h(0) = 1;
(*--*)
fun k(true) = 1 | k(false) = 0 | k(true) = 2;
(*--*)
if 1 then 2 else 3;
(*--*)
if true then 2 else false;
(*--*)
fn x => x x;
(*--*)
fun f(x) = (f : int -> int);
