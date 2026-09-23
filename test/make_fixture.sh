#!/bin/bash
# Build a deterministic fixture tree for scan tests.
# usage: make_fixture.sh [dir]   (default: test/fixture)
set -euo pipefail
cd "$(dirname "$0")"

DIR="${1:-fixture}"
rm -rf "$DIR"
mkdir -p "$DIR/A/small" "$DIR/B" "$DIR/C" "$DIR/dir D/nested" "$DIR/E"

# big video file (500000 bytes)
dd if=/dev/zero of="$DIR/A/big.mkv" bs=1000 count=500 2>/dev/null

# 40 small files -> must be bucketed (500 bytes each, threshold will be 10000)
for i in $(seq 1 40); do
    dd if=/dev/zero of="$DIR/A/small/s$i.txt" bs=500 count=1 2>/dev/null
done

# medium file -> kept as individual rect
dd if=/dev/zero of="$DIR/B/mid.zip" bs=1000 count=50 2>/dev/null

# pdf + nested content
dd if=/dev/zero of="$DIR/C/notes.pdf" bs=1000 count=20 2>/dev/null
dd if=/dev/zero of="$DIR/dir D/my file 1.mp3" bs=1000 count=30 2>/dev/null
dd if=/dev/zero of="$DIR/dir D/nested/track.flac" bs=1000 count=70 2>/dev/null
dd if=/dev/zero of="$DIR/E/tiny.db" bs=100 count=5 2>/dev/null

# hard link: must be counted exactly once
ln "$DIR/A/big.mkv" "$DIR/C/biglink.mkv"

# symlink: must not be counted at all
ln -s ../A/big.mkv "$DIR/C/link.mkv"

# empty dir: still a D line
mkdir -p "$DIR/emptydir"

echo "fixture built at $DIR"
