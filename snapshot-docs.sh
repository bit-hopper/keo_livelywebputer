#!/usr/bin/env bash
# Snapshot all gitignored .md/.txt doc files into the local-only "notes-local"
# branch, without checking it out and without touching main's index or
# working tree. notes-local is never pushed (see .git/hooks/pre-push).
set -e

BRANCH=notes-local
MSG=${1:-"docs: snapshot $(date '+%Y-%m-%d %H:%M:%S')"}

# Ignored .md files that are NOT already tracked anywhere, excluding vendor dirs.
FILES=$(git ls-files --others --ignored --exclude-standard -- '*.md' ':!node_modules' ':!*/node_modules/*')

if [ -z "$FILES" ]; then
  echo "No ignored .md/.txt files found to snapshot."
  exit 0
fi

git add -f $FILES
TREE=$(git write-tree)
git reset -- $FILES >/dev/null

if PARENT=$(git rev-parse --verify -q "$BRANCH"); then
  COMMIT=$(echo "$MSG" | git commit-tree "$TREE" -p "$PARENT")
else
  COMMIT=$(echo "$MSG" | git commit-tree "$TREE")
fi

git update-ref "refs/heads/$BRANCH" "$COMMIT"
echo "Snapshotted docs to $BRANCH ($COMMIT)"
