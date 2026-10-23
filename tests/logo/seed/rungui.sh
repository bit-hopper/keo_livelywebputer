#!/usr/bin/env bash
# Runs a turtle probe through the apt-installed GUI build (/usr/bin/ucblogo, needs WSLg's DISPLAY) and prints the file the probe wrote.
# The probe itself must `openwrite "/tmp/<name>.out` + `setwrite` and finish with `setwrite []  close ...  bye`;
# ANY error in the script hangs the GUI build (it waits for the window), hence the timeout. Usage: rungui.sh probe.lg /tmp/<name>.out
rm -f "$2"
timeout 40 /usr/bin/ucblogo "$1" </dev/null >/dev/null 2>&1
cat "$2"
