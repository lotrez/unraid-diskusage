#!/bin/bash
# End-to-end local test: syntax checks, fixture build, real scan, assertions.
set -euo pipefail
cd "$(dirname "$0")"

SCAN="../source/usr/local/emhttp/plugins/diskusage/scripts/scan.sh"
CORE="../source/usr/local/emhttp/plugins/diskusage/javascript/du-core.js"
PAGE="../source/usr/local/emhttp/plugins/diskusage/javascript/du-page.js"

echo "== syntax checks =="
bash -n "$SCAN"
bash -n make_fixture.sh
bash -n make_preview.sh
bash -n ../build.sh
bash -n ../dev-install.sh
node --check "$CORE"
node --check "$PAGE"
echo "  ok"

echo "== fixture =="
bash make_fixture.sh fixture

echo "== scan =="
rm -rf out
mkdir -p out
DU_DATA_DIR="$PWD/out" bash "$SCAN" "$PWD/fixture" 10000
echo "  status: $(cat out/status.json)"
grep -q '"state":"done"' out/status.json
echo "  TSV lines: $(wc -l < out/lastscan.tsv | tr -d ' ')"

echo "== assertions =="
node assert.mjs "$PWD/out/lastscan.tsv" "$PWD/fixture"

echo "== lock released =="
[ ! -f out/scan.pid ] && echo "  ok (no stale lock)"

echo
echo "ALL TESTS PASSED"
