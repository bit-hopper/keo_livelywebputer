#!/usr/bin/env bash
# Builds the CONSOLE reference interpreter (Berkeley Logo / ucblogo, commit pinned below) under /tmp, in WSL or any Linux.
# This is the oracle that tests/logo/seed/runprobe.sh drives and that the recorded *.ucblogo-output.txt files came from
# (LOGO.md 2.3, 9.1, 14.4). Nothing in a normal test run needs it: the recorded outputs are committed, and CI has no WSL.
# Run it only to re-record a probe or to check a behaviour against the reference.
#
#   tests/logo/build-reference.sh          build if missing or stale, then print the binary's path
#   tests/logo/build-reference.sh --force  rebuild from scratch
#
# Idempotent: a stamp file in the install prefix records the commit it was built from, and nothing is rebuilt when the
# binary exists and the stamp matches. /tmp is volatile (a WSL restart wipes it), which is the reason this script exists.
# Why a console build: the distro package is the wxWidgets GUI build, which writes nothing to stdout when scripted.
# The console build has no turtle (FD crashes it); turtle probes go through rungui.sh and the GUI package instead.
#
# Needs git, gcc, make, autoconf/automake/libtool (autoreconf). No sudo is used. Two macros from autoconf-archive
# (AX_CFLAGS_WARN_ALL, AX_CHECK_COMPILE_FLAG) are usually not installed, so a two-line stub supplies them; the stub
# assumes the compiler accepts the flags. Do not use this script's output for anything but testing: it is not hardened.
#
# Environment overrides (mostly for testing the script itself): UCB_PREFIX (default /tmp/ucbinst), UCB_SRC (default
# /tmp/ucbsrc), UCB_M4 (default /tmp/m4stub), UCB_REPO (default the upstream GitHub repository).
set -euo pipefail

COMMIT=f0ca245e5215f39de7e24252fd2b1946c321c772
REPO=${UCB_REPO:-https://github.com/jrincayc/ucblogo-code}
PREFIX=${UCB_PREFIX:-/tmp/ucbinst}
SRC=${UCB_SRC:-/tmp/ucbsrc}
M4=${UCB_M4:-/tmp/m4stub}
BIN=$PREFIX/bin/ucblogo
STAMP=$PREFIX/.built-commit

if [ "${1:-}" != "--force" ] && [ -x "$BIN" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$COMMIT" ]; then
  echo "$BIN"
  exit 0
fi

for tool in git gcc make autoreconf; do
  command -v "$tool" >/dev/null 2>&1 || { echo "build-reference.sh: '$tool' is not installed" >&2; exit 1; }
done

rm -rf "$SRC" "$PREFIX" "$M4"
mkdir -p "$M4"
cat > "$M4/axstub.m4" <<'EOF'
AC_DEFUN([AX_CFLAGS_WARN_ALL],[])
AC_DEFUN([AX_CHECK_COMPILE_FLAG],[$2])
EOF

# Build output goes to a log that is shown only when a step fails: the C sources produce pages of harmless warnings.
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
step() { "$@" >>"$LOG" 2>&1 || { echo "build-reference.sh: failed: $*" >&2; tail -30 "$LOG" >&2; exit 1; }; }

step git clone --quiet "$REPO" "$SRC"
step git -C "$SRC" checkout --quiet "$COMMIT"
cd "$SRC"
export ACLOCAL_PATH="$M4"
step autoreconf --install
step ./configure --prefix="$PREFIX" --disable-wx --disable-x11 --disable-docs
step make -j"$(nproc 2>/dev/null || echo 2)"
step make install
echo "$COMMIT" > "$STAMP"

# A build that does not run is worse than none: check it prints.
out=$(printf 'print 1+2\nbye\n' | timeout 20 stdbuf -o0 -e0 "$BIN" 2>&1 | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | tr -d '\r')
case "$out" in
  *"Welcome to Berkeley Logo"*3*) ;;
  *) echo "build-reference.sh: built, but the smoke test failed. Output was:" >&2; echo "$out" >&2; rm -f "$STAMP"; exit 1 ;;
esac
echo "$BIN"
