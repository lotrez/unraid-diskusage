#!/bin/bash
# Quick development install: copies source/ straight onto this Unraid server.
# Run this ON the server after copying the repo over (no reboot needed):
#
#   scp -r unraid-diskusage root@tower:/tmp/
#   ssh root@tower 'bash /tmp/unraid-diskusage/dev-install.sh'
#
# For a permanent install (survives reboot) use ./build.sh + plugin install instead.
set -euo pipefail
cd "$(dirname "$0")"

SRC="source/usr/local/emhttp/plugins/diskusage"
DST="/usr/local/emhttp/plugins/diskusage"

[ "$(id -u)" -eq 0 ] || { echo "run as root (Unraid console / sudo)"; exit 1; }
[ -d "$SRC" ] || { echo "missing $SRC"; exit 1; }

mkdir -p /boot/config/plugins/diskusage
mkdir -p "$DST"
cp -R "$SRC"/. "$DST"/
chmod 755 "$DST"/scripts/*.sh "$DST"/event/* 2>/dev/null || true

echo "installed -> $DST"
echo "Refresh the webGUI: Settings -> Disk Usage"
echo ""
echo "NOTE: files live in RAM and vanish on reboot. For a permanent install:"
echo "  ./build.sh && plugin install ./diskusage.plg"
