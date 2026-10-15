#!/bin/bash
# usage: runchunks.sh file.sml   (chunks separated by lines containing only (*--*))
# Runs each chunk in a fresh sml process on top of all earlier chunks that ran without
# an Error / uncaught exception, and prints only that chunk's own output.
f="$1"
work=$(mktemp -d)
sed 's/\r$//' "$f" > "$work/in.sml"
awk -v dir="$work" 'BEGIN{n=0; fn=sprintf("%s/c_%03d.sml",dir,n)} /^\(\*--\*\)$/ {n++; fn=sprintf("%s/c_%03d.sml",dir,n); next} {print > fn}' "$work/in.sml"
: > "$work/ok.sml"
for c in "$work"/c_*.sml; do
  echo "######## $(basename $c)"
  sed 's/^/    | /' "$c" | head -40
  { cat "$work/ok.sml"; echo '"@@MARK@@";'; cat "$c"; } | timeout 60 sml 2>&1 > "$work/out.txt"
  sed -n '/@@MARK@@/,$p' "$work/out.txt" | tail -n +2 | sed 's/^- //' | head -60
  if ! grep -qE "Error:|uncaught exception" <(sed -n '/@@MARK@@/,$p' "$work/out.txt"); then cat "$c" >> "$work/ok.sml"; fi
done
rm -rf "$work"
