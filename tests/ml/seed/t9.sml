val l = [1,2,3];
(*--*)
1 :: l;
(*--*)
l @ [4,5];
(*--*)
[[1],[2,3],[]];
(*--*)
val e = [];
(*--*)
[1, true];
(*--*)
1 :: 2;
(*--*)
[1,2] = [1,2];
(*--*)
[1,2] <> [1,3];
(*--*)
(fn x => x) = (fn x => x);
(*--*)
[(fn x => x)] = [(fn x => x)];
(*--*)
fun len [] = 0 | len (_ :: t) = 1 + len t;
(*--*)
len [5,6,7];
(*--*)
fun second (_ :: y :: _) = y | second _ = 0;
(*--*)
second [1,2,3];
(*--*)
second [1];
(*--*)
fun only [x] = x;
(*--*)
only [4];
(*--*)
only [4,5];
(*--*)
fun r [] = 0 | r _ = 1 | r (x :: xs) = 2;
(*--*)
fun nested [[x]] = x | nested _ = 0;
(*--*)
nested [[9]];
(*--*)
val (a :: b) = [1,2,3];
(*--*)
hd [7,8];
(*--*)
tl [7,8];
(*--*)
hd [];
(*--*)
tl [];
(*--*)
(hd [] handle Empty => 0);
(*--*)
null [];
(*--*)
null [1];
(*--*)
length [1,2,3,4];
(*--*)
rev [1,2,3];
(*--*)
rev "abc";
(*--*)
map (fn x => x + 1) [1,2,3];
(*--*)
map (fn x => (x, x)) ["a","b"];
(*--*)
val s = "hello";
(*--*)
size s;
(*--*)
s ^ " world";
(*--*)
"a" ^ 5;
(*--*)
"a" = "a";
(*--*)
"a" <> "b";
(*--*)
"tab\there";
(*--*)
"quote\"back\\slash";
(*--*)
"line\nbreak";
(*--*)
"\065\066";
(*--*)
"ctl\001end";
(*--*)
"hi\200there";
(*--*)
#"a";
(*--*)
#"\n";
(*--*)
#"a" = #"a";
(*--*)
ord #"a";
(*--*)
chr 98;
(*--*)
chr ~1;
(*--*)
str #"z";
(*--*)
explode "abc";
(*--*)
implode [#"x", #"y", #"z"];
(*--*)
concat ["ab", "cd", "ef"];
(*--*)
concat [];
(*--*)
fun greet "bob" = 1 | greet "ann" = 2 | greet _ = 0;
(*--*)
greet "ann";
(*--*)
fun vowel #"a" = true | vowel #"e" = true | vowel _ = false;
(*--*)
vowel #"e";
(*--*)
SOME 3;
(*--*)
NONE;
(*--*)
[SOME 1, NONE, SOME 3];
(*--*)
valOf (SOME 2);
(*--*)
valOf NONE;
(*--*)
isSome (SOME 1);
(*--*)
isSome NONE;
(*--*)
fun opt (SOME x) = x | opt NONE = 0;
(*--*)
fun opt2 (SOME x) = x;
(*--*)
Int.toString 42;
(*--*)
Int.toString ~7;
(*--*)
print "hello\n";
(*--*)
print (Int.toString 5 ^ "\n");
(*--*)
(print "a"; print "b"; 3);
(*--*)
print 5;
(*--*)
datatype 'a list = Empty | Cons of 'a * 'a list;
(*--*)
Cons(1, Cons(2, Empty));
(*--*)
fun clen Empty = 0 | clen (Cons(_, t)) = 1 + clen t;
(*--*)
clen (Cons(1, Cons(2, Empty)));
(*--*)
[1,2,3];
(*--*)
clen [1,2,3];
(*--*)
datatype shape = Circle of int | Poly of int list;
(*--*)
Poly [1,2,3];
(*--*)
Poly [];
(*--*)
fun pair_up x = [x, x];
(*--*)
fun flat [] = [] | flat (x :: xs) = x @ flat xs;
(*--*)
flat [[1],[2,3],[4]];
(*--*)
val big = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25];
(*--*)
"a" < "b";
(*--*)
1 :: [] :: [];
(*--*)
op ::;
(*--*)
map (op ::) [(1, []), (2, [3])];
(*--*)
[1,2] @ 3;
(*--*)
fun cmp (a, b) = a = b;
(*--*)
cmp ([1], [1]);
