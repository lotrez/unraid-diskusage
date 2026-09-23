/* diskusage plugin - page glue (jQuery, AJAX, status polling) */
/* global $, swal, DU */
var duTimers = {};
var DU_CFG = window.DU_CFG || {};
var DU_API = DU_CFG.api || '/plugins/diskusage/php/api.php';
var duLastStatus = null;

function duApi(action, data, dataType) {
    return $.ajax({
        url: DU_API,
        method: data ? 'POST' : 'GET',
        data: data ? Object.assign({ action: action }, data) : { action: action },
        dataType: dataType || 'json'
    });
}

function duStatus(text, cls) {
    $('#duStatus')
        .attr('class', 'du-status' + (cls ? ' ' + cls : ''))
        .text(text);
}

function duErr(xhr) {
    var msg = 'request failed';
    if (xhr) {
        if (xhr.status === 403) msg = 'security token expired - refreshing';
        else if (xhr.responseText) {
            try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) { msg = 'HTTP ' + xhr.status; }
        } else msg = 'HTTP ' + xhr.status;
    }
    duStatus('Error: ' + msg, 'du-err');
    if (window.swal) swal('Disk Usage', msg, xhr && xhr.status === 403 ? 'warning' : 'error');
    if (xhr && xhr.status === 403) setTimeout(function () { location.reload(); }, 1500);
}

function duLockUi(running) {
    $('#duScan').prop('disabled', !!running);
    $('#duStop').prop('disabled', !running);
}

function duPollStart() {
    if (duTimers.poll) return;
    duLockUi(true);
    duTimers.poll = setInterval(function () {
        duApi('status').done(function (st) {
            duLastStatus = st;
            if (st.running) {
                duStatus('Scanning ' + (st.root || '') + ' — ' +
                    (st.entries || 0).toLocaleString() + ' entries · ' +
                    (st.elapsed || 0) + 's', 'du-busy');
            } else {
                duPollStop();
                duLoad(st);
            }
        }).fail(function () { /* transient network error: keep polling */ });
    }, 1200);
}

function duPollStop() {
    if (duTimers.poll) { clearInterval(duTimers.poll); duTimers.poll = null; }
}

function duStart() {
    var path = String($('#duPath').val() || '').trim();
    var minfile = String($('#duMinFile').val() || '1048576');
    if (!path) { duStatus('Enter a path to scan.', 'du-err'); return; }
    duApi('start', { path: path, minfile: minfile })
        .done(function (r) {
            if (!r || !r.ok) { duErr(null); return; }
            duStatus('Starting scan…', 'du-busy');
            duPollStart();
        })
        .fail(duErr);
}

function duStop() {
    duApi('stop', {}).done(function () {
        duStatus('Stopping…', 'du-busy');
    }).fail(duErr);
}

function duLoad(st) {
    st = st || duLastStatus || {};
    duStatus('Loading results…', 'du-busy');
    duApi('result', null, 'text').done(function (text) {
        var recs, built;
        try {
            recs = DU.parse(text);
            built = DU.build(recs);
        } catch (e) {
            duStatus('Failed to parse results: ' + e.message, 'du-err');
            return;
        }
        var sum = recs.sum || {};
        var total = built.root ? built.root.tA : 0;
        var when = st.resultMtime ? new Date(st.resultMtime * 1000) : new Date();
        var metaBits = [];
        metaBits.push(built.rootPath);
        metaBits.push((sum.entries != null && sum.entries >= 0 ? sum.entries.toLocaleString() + ' entries' : 'entries n/a'));
        metaBits.push(DU.fmt(total) + ' allocated');
        if (st.elapsed != null && st.elapsed >= 0) metaBits.push('scanned in ' + st.elapsed + 's');
        metaBits.push(when.toLocaleString());

        DU.render({
            map: document.getElementById('duMap'),
            empty: document.getElementById('duMapEmpty'),
            tree: document.getElementById('duTree'),
            ext: document.getElementById('duExt'),
            top: document.getElementById('duTop'),
            crumbs: document.getElementById('duCrumbs'),
            metric: document.getElementById('duMetric'),
            meta: document.getElementById('duMeta'),
            sel: document.getElementById('duSel')
        }, built, { text: metaBits.join('  ·  ') });

        duStatus('Last scan: ' + DU.fmt(total) + ' in ' + (st.elapsed != null ? st.elapsed + 's' : '?') +
            ' — ' + (sum.entries != null ? sum.entries.toLocaleString() + ' entries' : ''),
            st.state === 'stopped' ? 'du-warn' : '');
        duLockUi(false);
    }).fail(function () {
        duStatus('No scan yet — press Scan.', '');
        duLockUi(false);
    });
}

function duRefresh() {
    duApi('status').done(function (st) {
        duLastStatus = st;
        if (st.running) {
            duStatus('Scan already running…', 'du-busy');
            duPollStart();
        } else if (st.hasResult) {
            duLoad(st);
        } else {
            duStatus('No scan yet — press Scan.', '');
            duLockUi(false);
        }
    }).fail(duErr);
}

$(function () {
    $('#duScan').on('click.du', duStart);
    $('#duStop').on('click.du', duStop);
    duRefresh();
});

$(window).on('beforeunload.du', function () {
    duPollStop();
    DU.destroy();
});
