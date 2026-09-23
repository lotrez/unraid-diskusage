# unraid-diskusage

A WinDirStat-style disk usage analyzer for Unraid — because the forum threads asking
for one ([2016](https://forums.unraid.net/topic/45743-utility-like-windirstat/),
[2019](https://forums.unraid.net/topic/72186-windirstat-for-unraid)) were never answered.

Adds **Settings → Disk Usage** to the Unraid webGUI:

- **Treemap** of any share, disk or folder — rectangles sized by disk usage, colored by file type, double-click to drill down
- **Folder tree** with sizes and percentages
- **Extension legend** (top file types by size) and **largest-files list**
- **Allocated vs apparent** size toggle (`df` numbers vs WinDirStat numbers)
- Background scan with live progress; results persist on the flash drive across reboots

## Install

### A. Permanent (recommended): one self-contained plugin file

```bash
# on your Mac (or anywhere): build the plugin
./build.sh 2026.09.23

# copy the whole repo to the server, then on the server:
scp -r . root@tower:/tmp/unraid-diskusage
ssh root@tower
bash /tmp/unraid-diskusage/build.sh          # rebuild on-server (tar/base64) — or skip if you built locally
plugin install /tmp/unraid-diskusage/diskusage.plg
```

The `.plg` embeds its own payload (base64 tar.gz), so `plugin install` is all it takes.
It survives reboots (Unraid re-runs the plg from the flash drive at boot).

### B. Quick dev install (for iterating)

```bash
scp -r . root@tower:/tmp/unraid-diskusage
ssh root@tower 'bash /tmp/unraid-diskusage/dev-install.sh'
```

Files land directly in `/usr/local/emhttp/plugins/diskusage` — refresh the browser to see
changes. **This does not survive a reboot.**

### Uninstall

Plugins page → Disk Usage → Remove (removes everything including saved scans),
or `plugin remove diskusage.plg`.

## Usage

1. Settings → **Disk Usage**
2. Pick a path:
   - `/mnt/user` — the merged view of all shares (what you'd see over SMB)
   - `/mnt/disk2` — a single physical disk (fastest way to find what's filling *that* disk)
   - any subfolder, e.g. `/mnt/user/appdata`
   - **avoid `/mnt`** — it would walk the same data twice (shares + disks)
3. Choose the smallest file to track individually (smaller = more detail, bigger result file)
4. **Scan** — progress is shown live. `du`-style walks are seek-bound on HDDs:
   expect minutes to tens of minutes on a full array.

### Understanding the numbers

| Metric | Meaning |
|---|---|
| **Allocated** (default) | Disk blocks actually used — what `df` and Unraid's Main tab count. Best for "why is my disk full". |
| **Apparent** | `st_size` totals — what WinDirStat shows. Best for "how big are my files". |

They differ for sparse files, block rounding, and filesystem overhead.

## How it works

```
find (GNU on Unraid / BSD fallback)      one pass: type, blocks, st_size, nlink, dev:ino
  └─ awk (POSIX)                          streams: dir lines, files ≥ min size, per-dir buckets
                                          for small files, extension totals, top-200 heap,
                                          progress status every 5s
       └─ lastscan.tsv on the flash       /boot/config/plugins/diskusage/
            └─ du-core.js in the browser  builds the tree, folds folders < 0.05% of total
                                          into their parent, renders treemap + panes (ECharts)
```

- **Hard links** are counted once (inode tracking), **symlinks** are not counted (target is)
- Files below the chosen threshold are aggregated per folder — extension stats and the
  largest-files list still cover every file exactly
- The scan runs detached (`setsid`/`nohup`); Stop or array shutdown (`stopping` /
  `unmounting_disks` events) kill it cleanly
- Filenames containing **newlines** would break the line-based TSV (rare; tab-containing
  names are handled)

## Repo layout

```
diskusage.plg                generated, self-contained installer (build.sh)
build.sh                     builds the plg from source/
dev-install.sh               quick non-persistent install for development
source/usr/local/emhttp/plugins/diskusage/
  diskusage.page             webGUI page (Settings → Disk Usage)
  php/api.php                start/stop/status/result endpoint (CSRF-protected)
  scripts/scan.sh            find + awk scanner → lastscan.tsv
  javascript/du-core.js      TSV → tree → ECharts treemap + panes (no jQuery)
  javascript/du-page.js      page glue: AJAX, status polling
  javascript/echarts.min.js  vendored Apache ECharts 5.5.1
  styles/diskusage.css
  event/{stopping,unmounting_disks}   kill a running scan on shutdown
test/                        fixture builder + assertions + offline HTML preview
```

## Testing without a server

```bash
./test/run_tests.sh          # builds a fixture tree, scans it, asserts TSV + tree invariants
./test/make_preview.sh DIR   # scans DIR and writes test/preview.html — open in a browser
```

`preview.html` renders the real treemap UI offline (same `du-core.js` the plugin uses).

## References

- [Community plugin docs](https://plugin-docs.mstrhakr.com/) — `.plg` / `.page` formats (this project follows them)
- ECharts treemap: https://echarts.apache.org/en/option.html#series-treemap
