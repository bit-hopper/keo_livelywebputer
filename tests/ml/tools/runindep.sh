#!/bin/bash
# usage: runindep.sh file.sml   (chunks separated by lines containing only (*--*))
# Chunk 0 is a shared prelude; every other chunk is run on its own on top of the prelude, all inside ONE sml process
# (each chunk is `use`d from its own file inside a handler, so an Error in one does not stop the next). Prints, per chunk, a header line
# "######## c_NNN" followed by that chunk's own compiler output.
f="$1"; work=$(mktemp -d)
sed 's/\r$//' "$f" > "$work/in.sml"
awk -v dir="$work" 'BEGIN{n=0; fn=sprintf("%s/c_%03d.sml",dir,n)}
  /^\(\*--\*\)$/ {n++; fn=sprintf("%s/c_%03d.sml",dir,n); next} {print > fn}' "$work/in.sml"
{
  echo "use \"$work/c_000.sml\";"
  for c in "$work"/c_*.sml; do
    b=$(basename "$c" .sml)
    [ "$b" = "c_000" ] && continue
    echo "val _ = print \"######## $b\n\";"
    echo "val _ = (use \"$c\") handle _ => ();"
  done
} > "$work/driver.sml"
timeout 600 sml < "$work/driver.sml" 2>&1 | sed 's/^- //' | grep -v '^\[opening\|^Standard ML of New Jersey\|^val it = () : unit$'
rm -rf "$work"
