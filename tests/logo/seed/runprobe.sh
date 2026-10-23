#!/usr/bin/env bash
# Runs a Logo probe through the CONSOLE reference build and prints what it printed, ANSI escapes stripped.
# Build the reference first (LOGO.md section 2.3); WSL, not Windows. Usage (from WSL, repo root):
#   tests/logo/seed/runprobe.sh tests/logo/seed/numbers-words-print.lg > tests/logo/seed/numbers-words-print.ucblogo-output.txt
# stdbuf matters: without it a killed run loses its buffered output. Probes that need a turtle use rungui.sh.
BIN=${UCBLOGO:-/tmp/ucbinst/bin/ucblogo}
timeout 60 stdbuf -o0 -e0 "$BIN" < "$1" 2>&1 | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | tr -d '\r'
