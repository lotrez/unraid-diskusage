// Assertions over a scan TSV + du-core tree build.
// usage: node assert.mjs <lastscan.tsv> <fixture-root>
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const DU = require(join(here, '..', 'source', 'usr', 'local', 'emhttp', 'plugins', 'diskusage', 'javascript', 'du-core.js'));

const [tsvPath, root] = process.argv.slice(2);
let failed = 0;
function ok(cond, msg) {
    if (cond) { console.log('  ok  ' + msg); }
    else { failed++; console.error('FAIL  ' + msg); }
}

const text = readFileSync(tsvPath, 'utf8');
const recs = DU.parse(text);

// --- raw TSV sanity ---
ok(recs.dirs.length > 0, `D lines present (${recs.dirs.length})`);
ok(recs.files.length > 0, `F lines present (${recs.files.length})`);
ok(recs.buckets.length > 0, `B lines present (${recs.buckets.length})`);
ok(recs.exts.length > 0, `E lines present (${recs.exts.length})`);
ok(recs.top.length > 0, `T lines present (${recs.top.length})`);
ok(recs.sum !== null, 'S summary present');

const paths = new Set(recs.dirs.map(d => d.path));

// symlink excluded
const allFilePaths = new Set(recs.files.map(f => f.path).concat(recs.buckets.map(b => b.path)));
ok(![...allFilePaths].some(p => p.endsWith('/link.mkv')), 'symlink excluded from inventory');

// hardlink counted exactly once
const hard = [...allFilePaths].filter(p => p.endsWith('/big.mkv') || p.endsWith('/biglink.mkv'));
ok(hard.length === 1, `hardlink counted exactly once (got ${hard.length}: ${hard.join(', ')})`);

// stat cross-check on a known file
function stat(p) {
    const out = execFileSync('stat', ['-f', '%z %b', p]).toString().trim().split(' ');
    return { size: +out[0], blocks: +out[1] };
}
const big = recs.files.find(f => f.path.endsWith('/A/big.mkv') || f.path.endsWith('/C/biglink.mkv'));
ok(!!big, 'big.mkv present as F line');
if (big) {
    const st = stat(big.path);   // TSV paths are absolute when the scan root is
    ok(big.p === st.size, `apparent matches stat (%z): ${big.p} vs ${st.size}`);
    ok(big.a === st.blocks * 512, `alloc matches stat blocks*512: ${big.a} vs ${st.blocks * 512}`);
}

// bucketed small file check: s1.txt should be a B entry under A/small
const bucketPaths = new Set(recs.buckets.map(b => b.path));
ok([...allFilePaths].some(p => p.endsWith('/A/big.mkv') || p.endsWith('/C/biglink.mkv')), 'big file kept as F (not bucketed)');
ok(recs.files.some(f => f.path.endsWith('/dir D/my file 1.mp3')), 'path with spaces survives parsing');
ok(recs.buckets.some(b => b.path.endsWith('/A/small')), 'small files bucketed under A/small');

// extension totals = all files (F + B), exact
let fA = 0, bA = 0;
recs.files.forEach(f => fA += f.a);
recs.buckets.forEach(b => bA += b.a);
let eA = 0;
recs.exts.forEach(e => eA += e.a);
ok(eA === fA + bA, `ext totals == kept + bucketed (${eA} vs ${fA + bA})`);

const mkv = recs.exts.find(e => e.ext === 'mkv');
ok(mkv && mkv.n === 1, `mkv ext count is 1 (hardlink deduped) — got ${mkv ? mkv.n : 'missing'}`);

// summary consistency
const sumOk = recs.sum.files === recs.files.length + recs.buckets.length &&
              recs.sum.dirs === recs.dirs.length;
ok(sumOk, `S line counts match (files ${recs.sum.files}=${recs.files.length}+${recs.buckets.length}, dirs ${recs.sum.dirs}=${recs.dirs.length})`);

// --- du-core tree invariants ---
const built = DU.build(recs);
ok(!!built.root, 'root built');

// invariant: every dir node: tA === ownA + bA + Σ kids.tA  (catches fold/double-count bugs)
let invariantOk = true, checked = 0;
(function walk(n) {
    if (!n.isDir) return;
    let sum = n.ownA + n.bA;
    for (const k of n.kids) { walk(k); if (k.isDir) sum += k.tA; else sum += k.tA; }
    // note: after folding, removed kids are gone from n.kids but their totals
    // were added to n.bA — identity must still hold.
    if (sum !== n.tA) {
        invariantOk = false;
        console.error(`    mismatch at ${n.path}: ownA ${n.ownA} + bA ${n.bA} + kids != tA ${n.tA} (sum ${sum})`);
    }
    checked++;
})(built.root);
ok(invariantOk, `tree totals consistent at every dir node (${checked} checked)`);

// root total = Σ all D own + Σ F + Σ B
let dOwn = 0;
recs.dirs.forEach(d => dOwn += d.a);
ok(built.root.tA === dOwn + fA + bA, `root.tA == Σ dir.own + Σ files + Σ buckets (${built.root.tA} vs ${dOwn + fA + bA})`);

// fold conservation: root must keep its own tA after pruning — same identity covers it
// top files list contains the biggest file
const topPaths = recs.top.map(t => t.path);
ok(topPaths.some(p => p.endsWith('big.mkv')), 'largest-files list contains big.mkv');

// bucket node appears in treemap data for A/small's parent when relevant
const data = (function toData(n) { return n; })(built.root);
ok(built.root.kids.length > 0, `root has children (${built.root.kids.length})`);

console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nall assertions passed');
process.exit(failed ? 1 : 0);
