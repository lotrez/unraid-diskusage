<?php
// diskusage plugin - AJAX endpoint
// actions: start (POST+CSRF), stop (POST+CSRF), status (GET), result (GET)

header('Content-Type: application/json; charset=utf-8');

$plugin     = 'diskusage';
$dataDir    = '/boot/config/plugins/' . $plugin;
$emhttpDir  = '/usr/local/emhttp/plugins/' . $plugin;
$statusFile = $dataDir . '/status.json';
$outFile    = $dataDir . '/lastscan.tsv';
$lockFile   = $dataDir . '/scan.pid';
$logFile    = $dataDir . '/scan.log';
$cfgFile    = $dataDir . '/' . $plugin . '.cfg';

function fail($code, $msg) {
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $msg]);
    exit;
}

function scan_pid() {
    global $lockFile;
    $pid = @file_get_contents($lockFile);
    if ($pid === false) return 0;
    $pid = (int)trim($pid);
    if ($pid <= 1) return 0;
    // kill -0 via shell: php may lack the posix extension
    @shell_exec('kill -0 ' . $pid . ' 2>/dev/null');
    exec('kill -0 ' . $pid . ' 2>/dev/null', $o, $rc);
    return $rc === 0 ? $pid : 0;
}

function csrf_ok() {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') return true;
    $var = @parse_ini_file('/var/local/emhttp/var.ini');
    $token = is_array($var) && isset($var['csrf_token']) ? $var['csrf_token'] : '';
    return $token !== '' && isset($_POST['csrf_token']) && hash_equals($token, $_POST['csrf_token']);
}

$action = isset($_REQUEST['action']) ? $_REQUEST['action'] : '';

switch ($action) {

case 'status':
    $st = @file_get_contents($statusFile);
    $j = $st ? json_decode($st, true) : null;
    if (!is_array($j)) $j = [];
    $pid = scan_pid();
    $j['running'] = $pid > 0;
    if ($pid > 0) $j['pid'] = $pid;
    if (!isset($j['state'])) $j['state'] = 'idle';
    // reconcile: status says running but the process is gone (reboot / kill)
    if ($j['state'] === 'running' && $pid <= 0) {
        $j['state'] = 'error';
        $j['message'] = 'scanner was interrupted';
    }
    $j['hasResult'] = is_file($outFile);
    if ($j['hasResult']) {
        $j['resultSize'] = filesize($outFile);
        $j['resultMtime'] = filemtime($outFile);
    }
    echo json_encode($j);
    break;

case 'result':
    if (!is_file($outFile)) fail(404, 'no scan result yet');
    header('Content-Type: text/plain; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Content-Length: ' . filesize($outFile));
    readfile($outFile);
    break;

case 'log':
    if (!is_file($logFile)) fail(404, 'no log');
    header('Content-Type: text/plain; charset=utf-8');
    readfile($logFile);
    break;

case 'start':
    if (!csrf_ok()) fail(403, 'invalid security token - refresh the page');
    if (scan_pid() > 0) fail(409, 'a scan is already running');

    $path = isset($_POST['path']) ? $_POST['path'] : '';
    // strict whitelist: /mnt/... style paths only, no quotes/backslashes/metachars
    if (!preg_match('#^(/[A-Za-z0-9._+@ -]+)+$#D', $path)) fail(400, 'invalid path');
    if (strpos($path, '/..') !== false || substr($path, -1) === '.') fail(400, 'invalid path');
    if (!is_dir($path)) fail(400, 'path is not a directory');
    // scanning /mnt itself would double-count shares through the FUSE view
    if ($path === '/mnt') fail(400, 'scan a share root (/mnt/user), a disk (/mnt/disk1) or subfolder instead of /mnt');

    $minfile = isset($_POST['minfile']) ? (int)$_POST['minfile'] : 1048576;
    $minfile = max(1024, min(1073741824, $minfile));

    // persist as the plugin's user config (survives reboot)
    @mkdir($dataDir, 0755, true);
    file_put_contents($cfgFile, 'SCAN_PATH="' . $path . '"' . "\n" . 'MIN_FILE="' . $minfile . '"' . "\n");

    // initial status so the UI flips to "running" immediately
    $init = json_encode([
        'state' => 'running', 'root' => $path, 'entries' => 0,
        'start' => time(), 'elapsed' => 0, 'minfile' => $minfile,
    ]);
    file_put_contents($statusFile . '.tmp', $init . "\n");
    rename($statusFile . '.tmp', $statusFile);

    $script = $emhttpDir . '/scripts/scan.sh';
    if (!is_file($script)) fail(500, 'scan.sh missing - reinstall the plugin');

    $setsid = trim((string)@shell_exec('command -v setsid 2>/dev/null'));
    $cmd = ($setsid !== '' ? escapeshellarg($setsid) . ' ' : '')
         . 'nohup /bin/bash ' . escapeshellarg($script) . ' '
         . escapeshellarg($path) . ' ' . $minfile
         . ' >> ' . escapeshellarg($logFile) . ' 2>&1 & echo $!';
    $pid = trim((string)shell_exec($cmd));
    if (!ctype_digit($pid)) fail(500, 'failed to launch scanner');

    echo json_encode(['ok' => true, 'pid' => (int)$pid]);
    break;

case 'stop':
    if (!csrf_ok()) fail(403, 'invalid security token - refresh the page');
    $pid = scan_pid();
    if ($pid <= 0) fail(409, 'no scan is running');
    exec('kill -TERM ' . $pid . ' 2>/dev/null', $o, $rc);
    echo json_encode(['ok' => $rc === 0]);
    break;

default:
    fail(400, 'unknown action');
}
