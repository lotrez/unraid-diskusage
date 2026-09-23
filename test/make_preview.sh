#!/bin/bash
# Scan a directory and build an offline preview.html of the plugin UI.
# usage: make_preview.sh [dir]     (default: test/fixture)
#        MINFILE=65536 make_preview.sh /some/big/dir
set -euo pipefail
cd "$(dirname "$0")"

DIR="${1:-fixture}"
[ -d "$DIR" ] || bash make_fixture.sh "$DIR"
ABS="$(cd "$DIR" && pwd)"

mkdir -p out
rm -f out/lastscan.tsv out/status.json out/scan.pid

echo "scanning $ABS ..."
DU_DATA_DIR="$PWD/out" bash ../source/usr/local/emhttp/plugins/diskusage/scripts/scan.sh \
    "$ABS" "${MINFILE:-10000}"
echo "$(cat out/status.json)"

node gen_preview.mjs
echo "wrote $PWD/preview.html"
