#!/bin/bash
# diskusage - filesystem usage scanner for the Unraid "Disk Usage" plugin
#
# Walks ROOT and emits a TSV inventory consumed by javascript/du-core.js:
#
#   D<TAB>alloc<TAB>apparent<TAB>path      directory (own size only; totals derived client-side)
#   F<TAB>alloc<TAB>apparent<TAB>path      file kept as an individual rect (>= minfile)
#   B<TAB>alloc<TAB>apparent<TAB>parentdir small files aggregated per directory
#   E<TAB>ext<TAB>alloc<TAB>apparent<TAB>n extension totals (all files, exact)
#   T<TAB>alloc<TAB>apparent<TAB>path      top-N largest files
#   S<TAB>entries<TAB>files<TAB>dirs<TAB>bucketed    summary
#
# alloc     = allocated blocks * 512 (what df / Unraid's Main tab counts)
# apparent  = st_size sum (what WinDirStat shows)
#
# usage: scan.sh <root> <minfile-bytes>
#   DU_DATA_DIR overrides the output directory (defaults to the plugin data dir)

set -u

ROOT="${1:-}"
MINFILE="${2:-1048576}"
DATA_DIR="${DU_DATA_DIR:-/boot/config/plugins/diskusage}"

OUT="$DATA_DIR/lastscan.tsv"
STATUS="$DATA_DIR/status.json"
LOG="$DATA_DIR/scan.log"
LOCK="$DATA_DIR/scan.pid"

jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

write_status() { # $1 = full json body (without trailing newline handling)
    printf '%s\n' "$1" > "$STATUS.tmp" && mv -f "$STATUS.tmp" "$STATUS"
}

die() {
    write_status "{\"state\":\"error\",\"root\":\"$(jesc "$ROOT")\",\"message\":\"$(jesc "$1")\"}"
    rm -f "$LOCK"
    exit 1
}

mkdir -p "$DATA_DIR" 2>/dev/null || { echo "cannot create $DATA_DIR" >&2; exit 1; }
: > "$LOG" 2>/dev/null || true

# --- single-instance lock ---------------------------------------------------
if [ -f "$LOCK" ]; then
    oldpid=$(cat "$LOCK" 2>/dev/null)
    if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
        # another scan is running: do NOT clobber its status file
        echo "scan already running (pid $oldpid)" >&2
        exit 2
    fi
    rm -f "$LOCK"
fi
echo $$ > "$LOCK"

[ -n "$ROOT" ]   || die "no scan path given"
[ -d "$ROOT" ]   || die "scan path does not exist or is not a directory"
case "$ROOT" in
    /mnt/*|/test*) ;; # normal targets
    *)   # allow anything for local testing, warn in log
         echo "warning: scanning outside /mnt: $ROOT" >> "$LOG" ;;
esac

# --- status plumbing --------------------------------------------------------
START=$(date +%s)
AWKPID=""
WATCHPID=""

cleanup() {
    [ -n "$AWKPID" ]    && kill "$AWKPID" 2>/dev/null    # awk dies -> find gets SIGPIPE
    [ -n "$WATCHPID" ]  && kill "$WATCHPID" 2>/dev/null
    rm -f "$LOCK"
}
trap 'cleanup; exit 143' TERM
trap cleanup EXIT

write_status "{\"state\":\"running\",\"root\":\"$(jesc "$ROOT")\",\"entries\":0,\"start\":$START,\"elapsed\":0}"

# --- find mode detection ----------------------------------------------------
# GNU find (Unraid/Slackware) supports -printf; BSD find (macOS) needs stat.
if find "$ROOT" -maxdepth 0 -printf '.' >/dev/null 2>&1; then
    MODE=gnu
else
    MODE=bsd
fi

run_find() {
    if [ "$MODE" = gnu ]; then
        # type, blocks(512), st_size, nlink, dev:ino, path
        find "$ROOT" \( -type f -o -type d \) \
            -printf '%y\t%b\t%s\t%n\t%D:%i\t%p\n'
    else
        # BSD/macOS stat: build the format with REAL tab characters (BSD stat
        # may not interpret \t escapes) — %% produces a literal %
        FMT=$(printf '%%HT\t%%b\t%%z\t%%l\t%%d:%%i\t%%N')
        find "$ROOT" \( -type f -o -type d \) \
            -exec stat -f "$FMT" {} +
    fi
}

# --- scan -------------------------------------------------------------------
run_find 2>>"$LOG" | awk \
    -v minfile="$MINFILE" \
    -v quote="$([ "$MODE" = bsd ] && echo 1 || echo 0)" '
function heap_swap(a, b,   t) {
    t = h_key[a]; h_key[a] = h_key[b]; h_key[b] = t
    t = h_app[a]; h_app[a] = h_app[b]; h_app[b] = t
    t = h_path[a]; h_path[a] = h_path[b]; h_path[b] = t
}
function heap_up(i,   p) {
    while (i > 1) {
        p = int(i / 2)
        if (h_key[p] <= h_key[i]) break
        heap_swap(p, i); i = p
    }
}
function heap_down(i,   l, r, m) {
    while (1) {
        l = 2 * i; r = l + 1; m = i
        if (l <= nh && h_key[l] < h_key[m]) m = l
        if (r <= nh && h_key[r] < h_key[m]) m = r
        if (m == i) break
        heap_swap(m, i); i = m
    }
}
function heap_push(k, a, p) {
    if (nh < topn) { nh++; h_key[nh] = k; h_app[nh] = a; h_path[nh] = p; heap_up(nh) }
    else if (k > h_key[1]) { h_key[1] = k; h_app[1] = a; h_path[1] = p; heap_down(1) }
}

BEGIN {
    FS = "\t"
    topn = 200
    nh = 0; entries = 0; files = 0; dirs = 0; bucketed = 0
}

{
    line = $0
    p1 = index(line, "\t");   if (!p1) next
    type = substr(line, 1, p1 - 1)
    rest = substr(line, p1 + 1)

    p2 = index(rest, "\t");   if (!p2) next
    blocks = substr(rest, 1, p2 - 1) + 0
    rest = substr(rest, p2 + 1)

    p3 = index(rest, "\t");   if (!p3) next
    app = substr(rest, 1, p3 - 1) + 0
    rest = substr(rest, p3 + 1)

    p4 = index(rest, "\t");   if (!p4) next
    nlink = substr(rest, 1, p4 - 1) + 0
    rest = substr(rest, p4 + 1)

    p5 = index(rest, "\t");   if (!p5) next
    ident = substr(rest, 1, p5 - 1)
    path = substr(rest, p5 + 1)

    if (quote == 1 && substr(path, 1, 1) == SQ && substr(path, length(path), 1) == SQ)
        path = substr(path, 2, length(path) - 2)

    alloc = blocks * 512

    if (tolower(substr(type, 1, 1)) == "d") {   # GNU %y: "d", BSD %HT: "Directory"
        dirs++; entries++
        printf "D\t%d\t%d\t%s\n", alloc, app, path
    } else {
        # hard links: count each inode once (matches du semantics)
        if (nlink > 1) {
            if (ident in seen) next
            seen[ident] = 1
        }
        files++; entries++

        base = path; sub(/.*\//, "", base)
        ext = base
        if (sub(/^.*\./, "", ext) == 0) ext = "(none)"
        ext = tolower(ext)
        if (length(ext) > 15) ext = "(none)"
        ea[ext] += alloc; ep[ext] += app; ec[ext]++

        if (app >= minfile || alloc >= minfile) {
            printf "F\t%d\t%d\t%s\n", alloc, app, path
            heap_push(alloc, app, path)
        } else {
            parent = path
            sub(/\/[^\/]*$/, "", parent)
            if (parent == "") parent = "/"
            printf "B\t%d\t%d\t%s\n", alloc, app, parent
            bucketed++
        }
    }
}

END {
    for (e in ea) printf "E\t%s\t%d\t%d\t%d\n", e, ea[e], ep[e], ec[e]
    for (i = 1; i <= nh; i++) printf "T\t%d\t%d\t%s\n", h_key[i], h_app[i], h_path[i]
    printf "S\t%d\t%d\t%d\t%d\n", entries, files, dirs, bucketed
}
' > "$OUT.tmp" &
AWKPID=$!

# progress watcher: report entry counts while awk runs (POSIX awk has no clock)
(
    jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
    R="$(jesc "$ROOT")"
    while kill -0 "$AWKPID" 2>/dev/null; do
        n=$(wc -l < "$OUT.tmp" 2>/dev/null | tr -d ' ')
        now=$(date +%s)
        printf '{"state":"running","root":"%s","entries":%s,"start":%s,"elapsed":%s}\n' \
            "$R" "${n:-0}" "$START" "$((now - START))" > "$STATUS.tmp" 2>/dev/null \
            && mv -f "$STATUS.tmp" "$STATUS" 2>/dev/null
        sleep 5
    done
) &
WATCHPID=$!

wait "$AWKPID"
RC=$?
AWKPID=""
kill "$WATCHPID" 2>/dev/null || true
wait "$WATCHPID" 2>/dev/null || true
WATCHPID=""

NOW=$(date +%s)
ELAPSED=$((NOW - START))

if [ "$RC" -eq 0 ] && [ -s "$OUT.tmp" ]; then
    mv -f "$OUT.tmp" "$OUT"
    sum=$(tail -n 1 "$OUT")
    case "$sum" in
        S$(printf '\t')*)
            IFS=$(printf '\t') read -r _ s_entries s_files s_dirs s_bucketed <<< "$sum" ;;
        *) s_entries=-1; s_files=-1; s_dirs=-1; s_bucketed=-1 ;;
    esac
    [ -n "${s_entries:-}" ] || s_entries=-1
    write_status "{\"state\":\"done\",\"root\":\"$(jesc "$ROOT")\",\"entries\":$s_entries,\"files\":${s_files:--1},\"dirs\":${s_dirs:--1},\"bucketed\":${s_bucketed:--1},\"start\":$START,\"elapsed\":$ELAPSED,\"minfile\":$MINFILE}"
    exit 0
else
    rm -f "$OUT.tmp"
    if [ "$RC" -eq 143 ]; then
        write_status "{\"state\":\"stopped\",\"root\":\"$(jesc "$ROOT")\",\"start\":$START,\"elapsed\":$ELAPSED}"
    else
        die "scan failed (exit $RC) - see scan.log"
    fi
fi
