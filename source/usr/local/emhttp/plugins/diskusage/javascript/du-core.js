/* diskusage plugin - core library (no jQuery dependency)
 * Parses scan TSV output, builds the directory tree, renders:
 * treemap (ECharts), folder tree, extension legend, largest-files list.
 * All names are inserted with textContent / canvas text only (XSS-safe).
 */
var DU = (function () {
    'use strict';

    var DIR_BG = '#262a33';
    var BUCKET_BG = '#565c6b';
    var CAT_COLOR = {
        video:   '#e05c4e',
        audio:   '#e8933a',
        image:   '#e8c53a',
        archive: '#9bc34f',
        disc:    '#4fb36c',
        doc:     '#3fb0a5',
        code:    '#4a94d8',
        db:      '#7a6fd0',
        other:   '#8a8f98'
    };
    var EXT_CAT = (function () {
        var m = {};
        function add(cat, list) { list.split(' ').forEach(function (e) { m[e] = cat; }); }
        add('video', 'mp4 mkv avi mov wmv flv webm m4v mpg mpeg ts m2ts vob ogv 3gp');
        add('audio', 'mp3 flac wav ogg m4a aac opus wma alac aiff mid midi');
        add('image', 'jpg jpeg png gif svg bmp tiff tif webp heic heif raw cr2 nef arw dng psd ico');
        add('archive', 'zip rar 7z tar gz xz bz2 z lz lz4 zst tgz tbz tbz2 cab');
        add('disc', 'iso img nrg bin dmg mdf');
        add('doc', 'pdf doc docx odt rtf txt md xls xlsx ods csv ppt pptx odp epub mobi srt ass vtt');
        add('code', 'js ts jsx tsx py java c cpp h hpp cs go rs rb php html css scss json xml yml yaml sh bash ps1 lua swift kt scala pl sql proto dockerfile makefile cmake');
        add('db', 'db sqlite sqlite3 sql bak');
        return m;
    })();

    /* ---------------- formatting ---------------- */

    function fmt(b) {
        if (b == null || isNaN(b)) return '-';
        var u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'], i = 0, v = Math.abs(b);
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        var s;
        if (i === 0) s = String(Math.round(v));
        else if (v >= 100) s = v.toFixed(0);
        else if (v >= 10) s = v.toFixed(1);
        else s = v.toFixed(2);
        return (b < 0 ? '-' : '') + s + ' ' + u[i];
    }

    function pct(part, whole) {
        if (!whole) return '';
        var p = part / whole * 100;
        if (p === 0) return '';
        if (p >= 100) return '100%';
        if (p >= 10) return p.toFixed(1) + '%';
        if (p >= 0.1) return p.toFixed(2) + '%';
        return '<0.1%';
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function extOf(path) {
        var base = path.slice(path.lastIndexOf('/') + 1);
        var i = base.lastIndexOf('.');
        if (i <= 0) return '(none)';
        var e = base.slice(i + 1).toLowerCase();
        if (!e || e.length > 15) return '(none)';
        return e;
    }

    function catOfExt(ext) { return EXT_CAT[ext] || null; }
    function colorForExt(ext) { return CAT_COLOR[catOfExt(ext) || 'other']; }
    function colorForPath(path) { return colorForExt(extOf(path)); }

    function dirname(path) {
        var i = path.lastIndexOf('/');
        if (i <= 0) return '/';
        return path.slice(0, i);
    }

    /* ---------------- parse ---------------- */

    function parse(text) {
        var recs = { dirs: [], files: [], buckets: [], exts: [], top: [], sum: null };
        var lines = String(text).split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!line) continue;
            var t = line.split('\t');
            var kind = t[0];
            if (kind === 'D') recs.dirs.push({ a: +t[1], p: +t[2], path: t.slice(3).join('\t') });
            else if (kind === 'F') recs.files.push({ a: +t[1], p: +t[2], path: t.slice(3).join('\t') });
            else if (kind === 'B') recs.buckets.push({ a: +t[1], p: +t[2], path: t.slice(3).join('\t') });
            else if (kind === 'E') recs.exts.push({ ext: t[1], a: +t[2], p: +t[3], n: +t[4] });
            else if (kind === 'T') recs.top.push({ a: +t[1], p: +t[2], path: t.slice(3).join('\t') });
            else if (kind === 'S') recs.sum = { entries: +t[1], files: +t[2], dirs: +t[3], bucketed: +t[4] };
        }
        return recs;
    }

    /* ---------------- tree build ---------------- */

    function makeNode(path, isDir) {
        return {
            path: path,
            name: path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1),
            isDir: !!isDir,
            ownA: 0, ownP: 0,          // own (non-descendant) size
            bA: 0, bP: 0,              // bucketed small files (+ folded small dirs)
            tA: 0, tP: 0,              // total incl. descendants
            kids: [],
            depth: 0,
            parent: null
        };
    }

    function build(recs) {
        var byPath = Object.create(null);

        function ensure(path, isDir) {
            var n = byPath[path];
            if (!n) { n = makeNode(path, isDir); byPath[path] = n; }
            if (isDir) n.isDir = true;
            return n;
        }

        var root = null;
        for (var i = 0; i < recs.dirs.length; i++) {
            var d = recs.dirs[i];
            var n = ensure(d.path, true);
            n.ownA = d.a; n.ownP = d.p;
            if (!root || d.path.length < root.path.length) root = n;
        }
        if (!root) root = makeNode('/', true);

        for (i = 0; i < recs.files.length; i++) {
            var f = recs.files[i];
            var pn = ensure(dirname(f.path), true);
            var leaf = ensure(f.path, false);
            leaf.ownA = leaf.tA = f.a;
            leaf.ownP = leaf.tP = f.p;
            leaf.parent = pn;
            if (pn.kids.indexOf(leaf) === -1) pn.kids.push(leaf);
        }

        for (i = 0; i < recs.buckets.length; i++) {
            var b = recs.buckets[i];
            var bp = ensure(b.path, true);
            bp.bA += b.a; bp.bP += b.p;
        }

        // link dir hierarchy + compute depth
        Object.keys(byPath).forEach(function (key) {
            var n = byPath[key];
            if (!n.isDir || n === root) return;
            var pn = byPath[dirname(n.path)];
            if (!pn) pn = root;
            n.parent = pn;
            if (pn.kids.indexOf(n) === -1) pn.kids.push(n);
        });

        // totals, bottom-up (iterative to survive pathological depth)
        var dirs = [];
        Object.keys(byPath).forEach(function (key) { if (byPath[key].isDir) dirs.push(byPath[key]); });
        dirs.sort(function (x, y) { return y.path.length - x.path.length; }); // deepest first
        for (i = 0; i < dirs.length; i++) {
            var dn = dirs[i];
            dn.tA = dn.ownA + dn.bA;
            dn.tP = dn.ownP + dn.bP;
            for (var k = 0; k < dn.kids.length; k++) {
                if (dn.kids[k] === dn) continue;
                dn.tA += dn.kids[k].tA;
                dn.tP += dn.kids[k].tP;
            }
        }
        // depth via parent chain
        dirs.sort(function (x, y) { return x.path.length - y.path.length; });
        for (i = 0; i < dirs.length; i++) {
            dirs[i].depth = dirs[i].parent ? dirs[i].parent.depth + 1 : 0;
        }

        // fold folders smaller than 0.05% of root into their parent's bucket
        var thr = (root.tA || 0) * 0.0005;
        if (thr > 0) {
            dirs.sort(function (x, y) { return y.depth - x.depth; }); // deepest first
            for (i = 0; i < dirs.length; i++) {
                var fn = dirs[i];
                if (fn === root || !fn.parent || fn.tA >= thr) continue;
                var pi = fn.parent.kids.indexOf(fn);
                if (pi !== -1) fn.parent.kids.splice(pi, 1);
                fn.parent.bA += fn.tA;
                fn.parent.bP += fn.tP;
                fn.orphan = true;
                delete byPath[fn.path];
            }
        }

        function sortKids(n) {
            n.kids.sort(function (x, y) {
                var d = (y.isDir ? 1 : 0) - (x.isDir ? 1 : 0);
                if (d !== 0) return d;
                return y.tA - x.tA;
            });
            for (var k = 0; k < n.kids.length; k++) if (n.kids[k].isDir) sortKids(n.kids[k]);
        }
        sortKids(root);

        return {
            root: root,
            byPath: byPath,
            recs: recs,
            rootPath: root.path
        };
    }

    /* ---------------- treemap ---------------- */

    function toEcharts(n, metric, isRoot) {
        var val = metric === 'a' ? n.tA : n.tP;
        var d = {
            name: isRoot ? n.path : n.name,
            value: val,
            duPath: n.path,
            itemStyle: { color: DIR_BG },
            _kind: 'dir'
        };
        if (isRoot) d.label = { show: false };   // root label = upperLabel only (no duplicate)
        var hasBucket = (metric === 'a' ? n.bA : n.bP) > 0;
        if (n.kids.length || hasBucket) {
            d.children = [];
            for (var i = 0; i < n.kids.length; i++) {
                var kid = n.kids[i];
                if (kid.isDir) d.children.push(toEcharts(kid, metric, false));
                else d.children.push({
                    name: kid.name,
                    value: metric === 'a' ? kid.tA : kid.tP,
                    duPath: kid.path,
                    itemStyle: { color: colorForPath(kid.path) },
                    _kind: 'file'
                });
            }
            if (hasBucket) {
                d.children.push({
                    name: 'small files',
                    value: metric === 'a' ? n.bA : n.bP,
                    duPath: n.path,
                    itemStyle: { color: BUCKET_BG },
                    _kind: 'bucket'
                });
            }
        } else if (!n.isDir) {
            d.itemStyle.color = colorForPath(n.path);
            d._kind = 'file';
        }
        return d;
    }

    /* ---------------- state ---------------- */

    var S = {
        built: null,
        metric: 'a',
        stack: [],          // drill stack of dir nodes
        refs: null,
        chart: null,
        onResize: null
    };

    function current() { return S.stack.length ? S.stack[S.stack.length - 1] : (S.built ? S.built.root : null); }

    /* ---------------- treemap render ---------------- */

    function renderMap() {
        if (!S.refs || !S.refs.map || typeof echarts === 'undefined') return;
        var node = current();
        if (!node) return;

        if (!S.chart) {
            S.chart = echarts.init(S.refs.map, null, { renderer: 'canvas' });
        }
        var data = toEcharts(node, S.metric, true);
        var selfTotal = S.metric === 'a' ? node.tA : node.tP;
        var globalTotal = S.metric === 'a' ? S.built.root.tA : S.built.root.tP;

        S.chart.setOption({
            backgroundColor: 'transparent',
            tooltip: {
                trigger: 'item',
                formatter: function (p) {
                    if (!p.data) return '';
                    return esc(p.data.name) + '<br>' + fmt(p.value) +
                        (globalTotal ? ' &middot; ' + pct(p.value, globalTotal) : '');
                }
            },
            series: [{
                type: 'treemap',
                data: [data],
                roam: false,
                nodeClick: false,
                breadcrumb: { show: false },
                animation: false,
                label: {
                    show: true,
                    color: '#e8eaf0',
                    fontSize: 12,
                    formatter: function (p) {
                        if (!p.data || p.data._kind === 'bucket') return p.name;
                        return p.name + '\n' + fmt(p.value);
                    }
                },
                upperLabel: {
                    show: true,
                    height: 18,
                    color: '#cfd4e0',
                    fontSize: 11,
                    formatter: function (p) { return p.name + '  ' + fmt(p.value); }
                },
                itemStyle: { borderColor: '#171a21', borderWidth: 1, gapWidth: 1 },
                levels: [
                    // depth 0 = implicit wrapper around our root: suppress its header row,
                    // otherwise it draws a stray "832 KB"-style line above the real root label
                    { label: { show: false }, upperLabel: { show: false }, itemStyle: { borderWidth: 0, gapWidth: 3 } },
                    { itemStyle: { borderWidth: 0, gapWidth: 2 } },
                    { itemStyle: { borderColor: '#171a21', borderWidth: 1, gapWidth: 1 } }
                ]
            }]
        });

        if (S.refs.empty) S.refs.empty.style.display = 'none';
        renderCrumbs(selfTotal, globalTotal);
    }

    function renderCrumbs(selfTotal, globalTotal) {
        if (!S.refs || !S.refs.crumbs) return;
        var el = S.refs.crumbs;
        el.textContent = '';

        var up = document.createElement('button');
        up.type = 'button';
        up.className = 'du-chip du-chip-up';
        up.textContent = '▲ up';
        up.disabled = S.stack.length <= 1;
        up.addEventListener('click', function () {
            if (S.stack.length > 1) { S.stack.pop(); renderMap(); renderTree(); }
        });
        el.appendChild(up);

        S.stack.forEach(function (n, idx) {
            if (idx > 0) el.appendChild(document.createTextNode(' '));
            var c = document.createElement('button');
            c.type = 'button';
            c.className = 'du-chip' + (idx === S.stack.length - 1 ? ' du-chip-here' : '');
            c.textContent = n.path;
            c.title = n.path;
            c.addEventListener('click', function () {
                S.stack = S.stack.slice(0, idx + 1);
                renderMap(); renderTree();
            });
            el.appendChild(c);
        });

        if (S.refs.sel) {
            S.refs.sel.textContent = selfTotal === globalTotal
                ? S.built.rootPath + '  ·  ' + fmt(selfTotal)
                : S.built.rootPath + '  ·  ' + fmt(selfTotal) + ' shown  /  ' + fmt(globalTotal) + ' total';
        }
    }

    /* ---------------- tree pane ---------------- */

    var KID_CAP = 400;

    function renderTree() {
        if (!S.refs || !S.refs.tree) return;
        var el = S.refs.tree;
        el.textContent = '';
        var node = current();
        if (!node) return;
        var globalTotal = S.metric === 'a' ? S.built.root.tA : S.built.root.tP;
        el.appendChild(treeNodeEl(node, globalTotal, 0, true));
    }

    function treeNodeEl(n, globalTotal, depth, open) {
        var wrap = document.createElement('div');
        wrap.className = 'du-tnode';

        var row = document.createElement('div');
        row.className = 'du-row' + (n.isDir ? ' du-row-dir' : '');
        row.style.paddingLeft = (4 + depth * 14) + 'px';

        var val = S.metric === 'a' ? n.tA : n.tP;

        var name = document.createElement('span');
        name.className = 'du-rname';
        var caret = '';
        if (n.isDir) caret = (open ? '▾ ' : '▸ ');
        else if (n._bucket) caret = '· ';
        else caret = '   ';
        name.textContent = caret + n.name;

        var size = document.createElement('span');
        size.className = 'du-rsize';
        size.textContent = fmt(val);

        var pc = document.createElement('span');
        pc.className = 'du-rpct';
        pc.textContent = pct(val, globalTotal);

        row.appendChild(name); row.appendChild(size); row.appendChild(pc);
        wrap.appendChild(row);

        if (n.isDir) {
            var kidsEl = document.createElement('div');
            kidsEl.className = 'du-kids';
            kidsEl.style.display = open ? '' : 'none';

            row.addEventListener('click', function () {
                var shown = kidsEl.style.display !== 'none';
                kidsEl.style.display = shown ? 'none' : '';
                name.textContent = (shown ? '▸ ' : '▾ ') + n.name;
            });
            row.addEventListener('dblclick', function () {
                if (n !== current()) { S.stack.push(n); renderMap(); renderTree(); }
            });

            var capLeft = KID_CAP;
            for (var i = 0; i < n.kids.length; i++) {
                if (capLeft-- <= 0) break;
                kidsEl.appendChild(treeNodeEl(n.kids[i], globalTotal, depth + 1, false));
            }
            if (n.kids.length > KID_CAP) {
                var more = document.createElement('div');
                more.className = 'du-row du-more';
                more.style.paddingLeft = (4 + (depth + 1) * 14) + 'px';
                more.textContent = '+ ' + (n.kids.length - KID_CAP) + ' more entries…';
                kidsEl.appendChild(more);
            }
            if ((S.metric === 'a' ? n.bA : n.bP) > 0) {
                var bucket = {
                    name: 'small files & folders',
                    isDir: false,
                    _bucket: true,
                    tA: n.bA, tP: n.bP,
                    path: n.path
                };
                kidsEl.appendChild(treeNodeEl(bucket, globalTotal, depth + 1, false));
            }
            wrap.appendChild(kidsEl);
        }
        return wrap;
    }

    /* ---------------- extension legend ---------------- */

    function renderExt() {
        if (!S.refs || !S.refs.ext) return;
        var el = S.refs.ext;
        el.textContent = '';
        var recs = S.built.recs;
        if (!recs.exts.length) return;

        var head = document.createElement('div');
        head.className = 'du-panetitle';
        head.textContent = 'File types';
        el.appendChild(head);

        var list = recs.exts.slice().sort(function (a, b) {
            return (S.metric === 'a' ? b.a - a.a : b.p - a.p);
        });
        var show = list.slice(0, 30);
        var rest = list.slice(30);
        var restA = 0, restP = 0, restN = 0;
        rest.forEach(function (e) { restA += e.a; restP += e.p; restN += e.n; });

        var total = S.metric === 'a' ? S.built.root.tA : S.built.root.tP;

        show.forEach(function (e) {
            var v = S.metric === 'a' ? e.a : e.p;
            var row = document.createElement('div');
            row.className = 'du-xrow';
            row.title = e.ext + ' — ' + e.n + ' file(s)';

            var sw = document.createElement('span');
            sw.className = 'du-swatch';
            sw.style.background = colorForExt(e.ext);

            var nm = document.createElement('span');
            nm.className = 'du-xname';
            nm.textContent = '.' + e.ext;

            var sz = document.createElement('span');
            sz.className = 'du-rsize';
            sz.textContent = fmt(v);

            var pc = document.createElement('span');
            pc.className = 'du-rpct';
            pc.textContent = pct(v, total);

            row.appendChild(sw); row.appendChild(nm); row.appendChild(sz); row.appendChild(pc);
            el.appendChild(row);
        });

        if (rest.length) {
            var more = document.createElement('div');
            more.className = 'du-xrow du-more';
            var v2 = S.metric === 'a' ? restA : restP;
            more.textContent = '… ' + rest.length + ' more types';
            var sz2 = document.createElement('span');
            sz2.className = 'du-rsize';
            sz2.textContent = fmt(v2);
            more.appendChild(sz2);
            el.appendChild(more);
        }
    }

    /* ---------------- largest files ---------------- */

    function renderTop() {
        if (!S.refs || !S.refs.top) return;
        var el = S.refs.top;
        el.textContent = '';
        var recs = S.built.recs;
        if (!recs.top.length) return;

        var head = document.createElement('div');
        head.className = 'du-panetitle';
        head.textContent = 'Largest files';
        el.appendChild(head);

        var list = recs.top.slice().sort(function (a, b) {
            return (S.metric === 'a' ? b.a - a.a : b.p - a.p);
        }).slice(0, 100);

        var table = document.createElement('table');
        table.className = 'du-tbl';
        list.forEach(function (f, i) {
            var tr = document.createElement('tr');
            var td0 = document.createElement('td');
            td0.className = 'du-tnum';
            td0.textContent = (i + 1) + '.';
            var td1 = document.createElement('td');
            td1.className = 'du-tpath';
            td1.textContent = f.path;
            td1.title = f.path;
            var td2 = document.createElement('td');
            td2.className = 'du-rsize';
            td2.textContent = fmt(S.metric === 'a' ? f.a : f.p);
            tr.appendChild(td0); tr.appendChild(td1); tr.appendChild(td2);
            table.appendChild(tr);
        });
        el.appendChild(table);
    }

    /* ---------------- metric buttons ---------------- */

    function renderMetric() {
        if (!S.refs || !S.refs.metric) return;
        var el = S.refs.metric;
        el.textContent = '';
        [['a', 'Allocated'], ['p', 'Apparent']].forEach(function (pair) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'du-mbtn' + (S.metric === pair[0] ? ' du-mbtn-on' : '');
            b.textContent = pair[1];
            b.title = pair[0] === 'a'
                ? 'Disk blocks actually used (what df / the Main tab counts)'
                : 'Logical file sizes (what WinDirStat shows)';
            b.addEventListener('click', function () {
                if (S.metric === pair[0]) return;
                S.metric = pair[0];
                renderAll();
            });
            el.appendChild(b);
        });
    }

    function renderAll() {
        renderMetric();
        renderMap();
        renderTree();
        renderExt();
        renderTop();
    }

    /* ---------------- public API ---------------- */

    function render(refs, built, meta) {
        destroy(false);
        S.refs = refs;
        S.built = built;
        S.metric = 'a';
        S.stack = [built.root];
        renderAll();
        if (refs.meta) {
            refs.meta.textContent = '';
            if (meta && meta.text) refs.meta.appendChild(document.createTextNode(meta.text));
        }
        if (!S.onResize && typeof window !== 'undefined') {
            S.onResize = function () { if (S.chart) S.chart.resize(); };
            window.addEventListener('resize', S.onResize);
        }
    }

    function destroy(removeListener) {
        if (S.chart) { try { S.chart.dispose(); } catch (e) {} S.chart = null; }
        if (removeListener !== false && S.onResize && typeof window !== 'undefined') {
            window.removeEventListener('resize', S.onResize);
            S.onResize = null;
        }
        if (removeListener !== false) { S.built = null; S.stack = []; S.refs = null; }
    }

    return {
        parse: parse,
        build: build,
        render: render,
        destroy: destroy,
        fmt: fmt,
        pct: pct,
        extOf: extOf,
        colorForExt: colorForExt,
        colorForPath: colorForPath,
        _state: S
    };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DU;
