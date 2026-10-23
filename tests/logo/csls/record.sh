#!/usr/bin/env bash
# Records what the REFERENCE prints for a csls program plus our driver script. From WSL, at the repo root, with the corpus
# fetched (node tests/logo/fetch-reference.js) and the reference built (LOGO.md 2.3):
#   tests/logo/csls/record.sh pour          # writes tests/logo/csls/pour.ucblogo-output.txt
#   tests/logo/csls/record.sh               # every driver
# Only the text after the driver's marker line is kept, so the output holds nothing of the program's own source. The files
# may carry carriage returns from a Windows checkout; they are stripped here.
BIN=${UCBLOGO:-/tmp/ucbinst/bin/ucblogo}
DIR=tests/logo/csls
names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  for f in $DIR/*.driver.lg; do b=$(basename "$f" .driver.lg); names+=("$b"); done
fi
for n in "${names[@]}"; do
  tmp=$(mktemp)
  { tr -d '\r' < tests/logo/reference/csls/$n.lg; echo; tr -d '\r' < $DIR/$n.driver.lg; } > "$tmp"
  timeout 120 stdbuf -o0 -e0 "$BIN" < "$tmp" 2>&1 | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | tr -d '\r' \
    | sed -n '/^=====DRIVER=====$/,$p' | sed '1d' > $DIR/$n.ucblogo-output.txt
  rm -f "$tmp"
  echo "recorded $n: $(wc -l < $DIR/$n.ucblogo-output.txt) lines"
done
