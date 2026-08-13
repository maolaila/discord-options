import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deriveCaptureHealth } from './capture-health.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOST = process.env.CONTROL_CONSOLE_HOST || '127.0.0.1';
const PORT = Number(process.env.CONTROL_CONSOLE_PORT || 18766);
const DEFAULT_ENV_FILE = process.env.MOOMOO_CONTROL_ENV_FILE || path.join(ROOT, '.env');
const MAX_LOG_LINES = 300;
const DEFAULT_RESTART_DELAY_MS = 15_000;
const RUNTIME_HEARTBEAT_FRESH_MS = 90_000;

const logsDir = path.join(ROOT, 'logs');
const processes = new Map();
const serverStartedAt = new Date().toISOString();

function nodeBin() {
  return process.execPath;
}

function powershellBin() {
  return 'powershell';
}

function nowIso() {
  return new Date().toISOString();
}

function isRunning(entry) {
  return Boolean(entry?.child && entry.child.exitCode === null && !entry.child.killed);
}

function normalizeNewLines(chunk) {
  return String(chunk || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function pushLog(entry, stream, chunk) {
  for (const line of normalizeNewLines(chunk)) {
    if (!line) continue;
    entry.log.push(`[${new Date().toLocaleTimeString()}] ${stream}: ${line}`);
  }
  if (entry.log.length > MAX_LOG_LINES) {
    entry.log.splice(0, entry.log.length - MAX_LOG_LINES);
  }
}

function makeEntry(name, label, command, args, options = {}) {
  return {
    name,
    label,
    command,
    args,
    cwd: ROOT,
    startedAt: null,
    stoppedAt: null,
    exitCode: null,
    signal: null,
    pid: null,
    error: null,
    oneShot: Boolean(options.oneShot),
    restartOnExit: Boolean(options.restartOnExit),
    restartDelayMs: Number(options.restartDelayMs || DEFAULT_RESTART_DELAY_MS),
    restartScheduledAt: null,
    manualStop: false,
    env: options.env || null,
    restartTimer: null,
    log: [],
    child: null,
  };
}

function getOrCreateEntry(name, label, command, args, options = {}) {
  const existing = processes.get(name);
  if (existing) return existing;
  const entry = makeEntry(name, label, command, args, options);
  processes.set(name, entry);
  return entry;
}

function startProcess(name, label, command, args, options = {}) {
  const entry = getOrCreateEntry(name, label, command, args, options);
  if (isRunning(entry)) {
    pushLog(entry, 'status', 'already running');
    return entry;
  }

  if (entry.restartTimer) {
    clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
  }

  entry.command = command;
  entry.args = args;
  entry.startedAt = nowIso();
  entry.stoppedAt = null;
  entry.exitCode = null;
  entry.signal = null;
  entry.error = null;
  entry.oneShot = Boolean(options.oneShot);
  entry.restartOnExit = Boolean(options.restartOnExit) && !entry.oneShot;
  entry.restartDelayMs = Number(options.restartDelayMs || DEFAULT_RESTART_DELAY_MS);
  entry.restartScheduledAt = null;
  entry.manualStop = false;
  entry.env = options.env || null;
  entry.log = [];

  const child = spawn(command, args, {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  entry.child = child;
  entry.pid = child.pid;
  pushLog(entry, 'status', `started pid=${child.pid}`);

  child.stdout.on('data', (chunk) => pushLog(entry, 'out', chunk));
  child.stderr.on('data', (chunk) => pushLog(entry, 'err', chunk));
  child.on('error', (error) => {
    entry.error = error.message;
    pushLog(entry, 'error', error.message);
  });
  child.on('exit', (code, signal) => {
    entry.exitCode = code;
    entry.signal = signal;
    entry.stoppedAt = nowIso();
    pushLog(entry, 'status', `exited code=${code} signal=${signal || ''}`);
    if (entry.restartOnExit && !entry.manualStop) {
      entry.restartScheduledAt = new Date(Date.now() + entry.restartDelayMs).toISOString();
      pushLog(entry, 'status', `restart scheduled at ${entry.restartScheduledAt}`);
      entry.restartTimer = setTimeout(() => {
        entry.restartTimer = null;
        if (!entry.manualStop) {
          startProcess(entry.name, entry.label, entry.command, entry.args, {
            env: entry.env,
            restartOnExit: entry.restartOnExit,
            restartDelayMs: entry.restartDelayMs,
          });
        }
      }, entry.restartDelayMs);
    }
  });
  return entry;
}

function stopProcess(name) {
  const entry = processes.get(name);
  if (!entry) return null;
  entry.manualStop = true;
  entry.restartScheduledAt = null;
  if (entry.restartTimer) {
    clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
  }
  if (!isRunning(entry)) return entry;
  pushLog(entry, 'status', 'stopping');
  entry.child.kill();
  return entry;
}

function envArgs(envFile) {
  const file = String(envFile || DEFAULT_ENV_FILE).trim();
  return file ? ['--env', file] : [];
}

function startBrowser() {
  return startProcess('browser', 'Discord Browser / CDP', powershellBin(), [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(ROOT, 'start-discord-cdp.ps1'),
    '-OpenDiscord',
  ], { oneShot: true });
}

function startCapture() {
  return startProcess('capture', 'Discord 0DTE Flow Capture', nodeBin(), [
    path.join(ROOT, 'apps', 'discord-capture', 'capture-discord.js'),
  ], { restartOnExit: true });
}

function runMoomooCheck(envFile) {
  return startProcess('moomooCheck', 'moomoo OpenD Health Check', nodeBin(), [
    path.join(ROOT, 'apps', 'opend-check', 'moomoo-check.mjs'),
    ...envArgs(envFile),
  ], { oneShot: true });
}

function startAll(envFile) {
  startBrowser();
  startCapture();
  runMoomooCheck(envFile);
}

function stopConsoleOwnedProcesses() {
  stopProcess('capture');
  stopProcess('browser');
  stopProcess('moomooCheck');
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { error: error.message };
  }
}

function fileInfo(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  try {
    const stat = fs.statSync(fullPath);
    return {
      path: relativePath,
      exists: true,
      length: stat.size,
      last_write_time: stat.mtime.toISOString(),
    };
  } catch {
    return {
      path: relativePath,
      exists: false,
      length: 0,
      last_write_time: '',
    };
  }
}

function tailNdjson(relativePath, count = 8) {
  const fullPath = path.join(ROOT, relativePath);
  if (!fs.existsSync(fullPath)) return [];
  const stat = fs.statSync(fullPath);
  const bytesToRead = Math.min(stat.size, 1024 * 1024);
  const fd = fs.openSync(fullPath, 'r');
  let text = '';
  try {
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
    text = buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
}

function pidIsRunning(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ageMs(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : null;
}

function externalJunkRuntime(junkStatus, runtimeLock) {
  const watcherPid = Number(junkStatus?.process_id || runtimeLock?.process_id || 0) || null;
  const watcherRunning = pidIsRunning(watcherPid);
  const heartbeatAgeMs = ageMs(junkStatus?.updated_at);
  const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= RUNTIME_HEARTBEAT_FRESH_MS;
  return {
    ownership: 'external',
    managed_by_console: false,
    watcher: {
      pid: watcherPid,
      running: watcherRunning,
      heartbeat_fresh: heartbeatFresh,
      heartbeat_age_ms: heartbeatAgeMs,
      updated_at: junkStatus?.updated_at || null,
    },
    supervisor: {
      managed_by_console: false,
      inferred_active: watcherRunning && heartbeatFresh,
      status: watcherRunning && heartbeatFresh ? 'active' : 'degraded_or_stopped',
      note: 'JUNKMAN supervisor and watcher are read-only here; this console never starts or stops them.',
    },
    runtime_lock: runtimeLock,
    recent_supervisor_log: tailText('logs/zero-dte-options-supervisor.log', 8),
  };
}

function tailText(relativePath, count = 8) {
  const fullPath = path.join(ROOT, relativePath);
  if (!fs.existsSync(fullPath)) return [];
  const stat = fs.statSync(fullPath);
  const bytesToRead = Math.min(stat.size, 256 * 1024);
  const fd = fs.openSync(fullPath, 'r');
  let text = '';
  try {
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
    text = buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-count);
}

function redactMoomooCheck(payload) {
  if (!payload) return null;
  return {
    checked_at: payload.checked_at || '',
    config: payload.config ? {
      env_loaded: payload.config.envLoaded,
      host: payload.config.host,
      websocket_port: payload.config.websocketPort,
      websocket_ssl: payload.config.websocketSsl,
      websocket_key_loaded: payload.config.websocketKeyLoaded,
      account_id: payload.config.accId,
      trading_environment: payload.config.trdEnv,
      trading_market: payload.config.trdMarket,
    } : null,
    global_state: payload.global_state?.s2c ? {
      qot_logined: payload.global_state.s2c.qotLogined,
      trd_logined: payload.global_state.s2c.trdLogined,
      market_us: payload.global_state.s2c.marketUS,
      server_version: payload.global_state.s2c.serverVer,
      server_build_number: payload.global_state.s2c.serverBuildNo,
    } : null,
    account_summary: (payload.account_summary || []).map((account) => ({
      account_id: account.accID,
      trading_environment: account.trdEnv,
      account_type: account.accType,
      trading_market_auth_list: account.trdMarketAuthList,
      simulated_account_type: account.simAccType,
    })),
  };
}

function processSnapshot(entry) {
  return {
    name: entry.name,
    label: entry.label,
    running: isRunning(entry),
    pid: entry.pid,
    started_at: entry.startedAt,
    stopped_at: entry.stoppedAt,
    exit_code: entry.exitCode,
    signal: entry.signal,
    error: entry.error,
    one_shot: entry.oneShot,
    restart_on_exit: entry.restartOnExit,
    restart_scheduled_at: entry.restartScheduledAt,
    last_log: entry.log.slice(-12),
  };
}

function statusPayload() {
  const captureStatus = readJson(path.join(logsDir, 'capture-status.json'));
  const junkStatus = readJson(path.join(logsDir, 'zero-dte-options-status.json'));
  const experimentSummary = readJson(path.join(logsDir, 'zero-dte-options-experiment-summary.json'));
  const runtimeLock = readJson(path.join(logsDir, 'zero-dte-options-runtime.lock.json'));
  const moomooCheck = redactMoomooCheck(readJson(path.join(logsDir, 'moomoo-check.json')));
  const captureHealth = deriveCaptureHealth(captureStatus, {
    processRunning: isRunning(processes.get('capture')),
  });

  return {
    server: {
      started_at: serverStartedAt,
      host: HOST,
      port: PORT,
      default_env_file: DEFAULT_ENV_FILE,
      scope: 'junkman_only',
    },
    processes: Object.fromEntries(
      [...processes.entries()].map(([name, entry]) => [name, processSnapshot(entry)]),
    ),
    external_junk_runtime: externalJunkRuntime(junkStatus, runtimeLock),
    capture_status: captureStatus,
    capture_health: captureHealth,
    junk_status: junkStatus,
    experiment_summary: experimentSummary,
    moomoo_check: moomooCheck,
    files: [
      fileInfo('logs/capture-status.json'),
      fileInfo('logs/zero-dte-options-flow-events.ndjson'),
      fileInfo('logs/zero-dte-options-status.json'),
      fileInfo('logs/zero-dte-options-runtime-state.json'),
      fileInfo('logs/zero-dte-options-runtime.lock.json'),
      fileInfo('logs/zero-dte-options-experiment-summary.json'),
      fileInfo('logs/zero-dte-options-trades.ndjson'),
      fileInfo('logs/zero-dte-options-decisions.ndjson'),
      fileInfo('logs/zero-dte-options-entry-plans.ndjson'),
      fileInfo('logs/zero-dte-options-exit-plans.ndjson'),
      fileInfo('logs/moomoo-check.json'),
    ],
    latest_flow_events: tailNdjson('logs/zero-dte-options-flow-events.ndjson', 10).reverse(),
    latest_trade_events: tailNdjson('logs/zero-dte-options-trades.ndjson', 12).reverse(),
    latest_decisions: tailNdjson('logs/zero-dte-options-decisions.ndjson', 8).reverse(),
  };
}

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res) {
  const body = dashboardHtmlPage();
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function routePost(req, res, pathname) {
  const body = await readBody(req);
  const envFile = body.env_file || body.envFile || DEFAULT_ENV_FILE;

  if (pathname === '/api/start-all') startAll(envFile);
  else if (pathname === '/api/start-browser') startBrowser();
  else if (pathname === '/api/start-capture') startCapture();
  else if (pathname === '/api/moomoo-check') runMoomooCheck(envFile);
  else if (pathname === '/api/stop-capture') stopProcess('capture');
  else if (pathname === '/api/stop-browser') stopProcess('browser');
  else if (pathname === '/api/stop-all') stopConsoleOwnedProcesses();
  else {
    sendJson(res, { error: 'unknown_endpoint' }, 404);
    return;
  }

  sendJson(res, { ok: true, status: statusPayload() });
}

async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/') return sendHtml(res);
  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return undefined;
  }
  if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, statusPayload());
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    return routePost(req, res, url.pathname);
  }
  return sendJson(res, { error: 'not_found' }, 404);
}

function dashboardHtmlPage() {
  const defaultEnvFile = DEFAULT_ENV_FILE
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>JUNKMAN Simulation Console</title>
  <style>
    :root { color-scheme: dark; --bg:#0f1216; --panel:#1b2229; --soft:#202932; --line:#34414d; --text:#edf2f7; --muted:#9ba8b6; --green:#37c97f; --red:#ff6b6b; --yellow:#e6bd4a; --blue:#71a7ff; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 "Segoe UI","Microsoft YaHei",Arial,sans-serif; }
    header { min-height:64px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:0 24px; background:#151a20; border-bottom:1px solid var(--line); }
    h1 { margin:0; font-size:20px; }
    main { max-width:1600px; margin:0 auto; padding:18px 24px 28px; display:grid; gap:16px; }
    .summary { display:grid; grid-template-columns:repeat(8,minmax(130px,1fr)); gap:10px; }
    .metric,.panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .metric { min-height:76px; padding:12px 14px; }
    .label { color:var(--muted); font-size:12px; margin-bottom:6px; }
    .value { font-size:17px; font-weight:650; overflow-wrap:anywhere; }
    .toolbar { display:grid; grid-template-columns:minmax(260px,1fr) repeat(7,minmax(120px,auto)); gap:10px; align-items:end; }
    label { color:var(--muted); font-size:12px; display:grid; gap:6px; }
    input,button { height:38px; border:1px solid var(--line); border-radius:6px; font:inherit; }
    input { width:100%; background:#101317; color:var(--text); padding:0 10px; }
    button { background:var(--soft); color:var(--text); font-weight:600; cursor:pointer; padding:0 12px; white-space:nowrap; }
    button.primary { background:#1f6f4a; border-color:#2b8b60; }
    button.danger { background:#6b2b2b; border-color:#8c3f3f; }
    button:disabled { opacity:.55; cursor:wait; }
    .grid-two { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .panel h2 { margin:0; padding:12px 14px; font-size:15px; border-bottom:1px solid var(--line); }
    .panel-body { padding:12px 14px; overflow:auto; }
    table { width:100%; border-collapse:collapse; table-layout:fixed; }
    th,td { padding:8px 6px; border-bottom:1px solid #2e3740; vertical-align:top; text-align:left; overflow-wrap:anywhere; }
    th { color:var(--muted); font-size:12px; font-weight:600; }
    .mono { font-family:Consolas,"Cascadia Mono",monospace; font-size:12px; }
    .ok { color:var(--green); } .bad { color:var(--red); } .warn { color:var(--yellow); } .info { color:var(--blue); }
    .hint { color:var(--muted); font-size:12px; }
    .log { min-height:120px; max-height:280px; overflow:auto; white-space:pre-wrap; background:#0d1014; border:1px solid #2a323b; border-radius:6px; padding:10px; }
    @media (max-width:1100px) { .summary { grid-template-columns:repeat(2,minmax(140px,1fr)); } .toolbar,.grid-two { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header><h1>JUNKMAN Simulation Console</h1><div class="mono" id="clock"></div></header>
  <main>
    <section class="summary">
      <div class="metric"><div class="label">Discord Flow Capture</div><div class="value" id="capture">-</div></div>
      <div class="metric"><div class="label">External JUNK Watcher</div><div class="value" id="watcher">-</div></div>
      <div class="metric"><div class="label">Strategy Phase</div><div class="value" id="phase">-</div></div>
      <div class="metric"><div class="label">OpenD</div><div class="value" id="opend">-</div></div>
      <div class="metric"><div class="label">Execution Environment</div><div class="value" id="mode">-</div></div>
      <div class="metric"><div class="label">Positions / Active Orders</div><div class="value" id="positions">-</div></div>
      <div class="metric"><div class="label">Daily Realized P&amp;L</div><div class="value" id="pnl">-</div></div>
      <div class="metric"><div class="label">Nightwatch Monthly Quota</div><div class="value" id="quota">-</div></div>
    </section>

    <section class="toolbar">
      <label>Local Environment File<input id="envFile" value="${defaultEnvFile}" /></label>
      <button class="primary" data-action="start-all">Start Capture Environment</button>
      <button data-action="start-browser">Start Discord / CDP</button>
      <button data-action="start-capture">Start Flow Capture</button>
      <button data-action="moomoo-check">Check OpenD</button>
      <button class="danger" data-action="stop-capture">Stop Capture</button>
      <button class="danger" data-action="stop-browser">Stop Browser Launcher</button>
      <button class="danger" data-action="stop-all">Stop Console-owned Processes</button>
    </section>
    <div class="hint">The external long-running task owns the JUNKMAN supervisor, watcher, and OpenD. This console only reads their state and never starts, stops, or restarts them.</div>

    <section class="grid-two">
      <div class="panel"><h2>Console-owned Processes</h2><div class="panel-body"><table><thead><tr><th>Process</th><th>Status</th><th>PID</th><th>Recent Log</th></tr></thead><tbody id="processRows"></tbody></table></div></div>
      <div class="panel"><h2>JUNKMAN Runtime</h2><div class="panel-body"><table><tbody id="runtimeRows"></tbody></table><div class="log mono" id="supervisorLog"></div></div></div>
    </section>

    <section class="panel"><h2>Exit-rule Experiment Lines</h2><div class="panel-body"><table><thead><tr><th>Line</th><th>Budget</th><th>Stop Loss</th><th>Take Profit</th><th>Status / Realized P&amp;L</th></tr></thead><tbody id="experimentRows"></tbody></table></div></section>

    <section class="grid-two">
      <div class="panel"><h2>Recent JUNKMAN Trade Events</h2><div class="panel-body"><table><thead><tr><th>Time</th><th>Event</th><th>Contract</th><th>Quantity / Price</th><th>P&amp;L / Reason</th></tr></thead><tbody id="tradeRows"></tbody></table></div></div>
      <div class="panel"><h2>Recent 0DTE Flow</h2><div class="panel-body"><table><thead><tr><th>Time</th><th>Side</th><th>Contract</th><th>Premium / Contracts</th><th>Eligibility</th></tr></thead><tbody id="flowRows"></tbody></table></div></div>
    </section>

    <section class="grid-two">
      <div class="panel"><h2>moomoo Simulation Accounts</h2><div class="panel-body"><table><thead><tr><th>Account</th><th>Environment</th><th>Market Access</th><th>Simulation Type</th></tr></thead><tbody id="accountRows"></tbody></table></div></div>
      <div class="panel"><h2>Console Logs</h2><div class="panel-body"><div class="log mono" id="consoleLog"></div></div></div>
    </section>
  </main>

  <script>
    const el = (id) => document.getElementById(id);
    let busy = false;
    const safe = (value) => String(value === null || value === undefined || value === '' ? '-' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    const time = (value) => { const d = new Date(value); return value && !Number.isNaN(d.getTime()) ? d.toLocaleString() : '-'; };
    const money = (value) => Number.isFinite(Number(value)) ? '$' + Number(value).toFixed(2) : '-';
    const state = (ok, yes, no) => '<span class="' + (ok ? 'ok' : 'warn') + '">' + safe(ok ? yes : no) + '</span>';

    async function post(action) {
      if (busy) return;
      busy = true;
      document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      try {
        const response = await fetch('/api/' + action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ env_file: el('envFile').value }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'request_failed');
        await refresh();
      } catch (error) {
        el('consoleLog').textContent = 'Action failed: ' + error.message + '\n' + el('consoleLog').textContent;
      } finally {
        busy = false;
        document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
      }
    }

    function renderProcesses(processes) {
      const names = ['browser', 'capture', 'moomooCheck'];
      el('processRows').innerHTML = names.map((name) => {
        const item = processes[name] || { label: name, running: false, last_log: [] };
        let status = '<span class="warn">not started</span>';
        if (item.running) status = '<span class="ok">running</span>';
        else if (item.one_shot && item.exit_code === 0) status = '<span class="ok">complete</span>';
        else if (item.exit_code !== null && item.exit_code !== undefined) status = '<span class="bad">exited</span>';
        return '<tr><td>' + safe(item.label) + '</td><td>' + status + '</td><td class="mono">' + safe(item.pid) + '</td><td class="mono">' + safe((item.last_log || []).slice(-3).join('\n')) + '</td></tr>';
      }).join('');
    }

    function renderRuntime(data) {
      const runtime = data.external_junk_runtime || {};
      const watcher = runtime.watcher || {};
      const status = data.junk_status || {};
      const rows = [
        ['External ownership', runtime.managed_by_console === false ? 'yes (read-only here)' : '-'],
        ['watcher', (watcher.running ? 'running' : 'stopped') + ' / pid=' + (watcher.pid || '-')],
        ['heartbeat', (watcher.heartbeat_fresh ? 'fresh' : 'stale') + ' / age=' + (watcher.heartbeat_age_ms ?? '-') + 'ms'],
        ['Strategy', status.strategy_label || status.strategy],
        ['Market', status.market_schedule?.market_open ? 'open' : 'closed'],
        ['Latest error', status.last_error || '-'],
        ['Broker recovery', status.broker_recovery?.status || '-'],
      ];
      el('runtimeRows').innerHTML = rows.map((row) => '<tr><th>' + safe(row[0]) + '</th><td>' + safe(row[1]) + '</td></tr>').join('');
      el('supervisorLog').textContent = (runtime.recent_supervisor_log || []).join('\n') || 'No supervisor log entries';
    }

    function renderExperiment(data) {
      const manifest = data.junk_status?.experiment?.manifest || {};
      const summaryLines = new Map((data.experiment_summary?.lines || []).map((line) => [line.line_id, line]));
      el('experimentRows').innerHTML = (manifest.lines || []).map((line) => {
        const profile = line.exit_profile || {};
        const result = summaryLines.get(line.line_id) || {};
        const takeProfit = profile.option_take_profit_enabled ? profile.option_take_profit_pct + '%' : 'off';
        return '<tr><td>' + safe(line.label || line.line_id) + (line.control ? ' <span class="info">control</span>' : '') + '</td><td>' + money(line.paper_equity_usd) + '</td><td>-' + safe(profile.option_stop_loss_pct) + '%</td><td>' + safe(takeProfit) + '</td><td>' + safe(result.status || 'waiting for paired samples') + ' / ' + money(result.realized_pnl_usd) + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="hint">No experiment-line data</td></tr>';
    }

    function renderTrades(rows) {
      el('tradeRows').innerHTML = (rows || []).map((row) => {
        const qty = row.qty ?? row.filled_qty ?? row.exited_qty;
        const price = row.fill_avg_price ?? row.exit_fill_avg_price ?? row.exit_fill_price ?? row.limit_price ?? row.price;
        const reason = row.trigger?.reason || row.reason || '-';
        return '<tr><td class="mono">' + safe(time(row.event_at)) + '</td><td>' + safe(row.event) + '</td><td class="mono">' + safe(row.code) + '</td><td>' + safe(qty) + ' @ ' + safe(price) + '</td><td>' + money(row.realized_pnl_usd) + ' / ' + safe(reason) + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="hint">No trade events</td></tr>';
    }

    function renderFlow(rows) {
      el('flowRows').innerHTML = (rows || []).map((row) => {
        const contract = [row.ticker, row.strike, row.right_code].filter((part) => part !== null && part !== undefined && part !== '').join(' ');
        return '<tr><td class="mono">' + safe(time(row.captured_at || row.message_timestamp)) + '</td><td>' + safe(row.color_emoji || row.color_indicator) + ' ' + safe(row.aggressor_side) + '</td><td>' + safe(contract) + '</td><td>' + money(row.premium_usd) + ' / ' + safe(row.contract_count) + '</td><td>' + (row.live_eligible ? '<span class="ok">live</span>' : '<span class="warn">context</span>') + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="hint">No Flow events</td></tr>';
    }

    function renderAccounts(check) {
      el('accountRows').innerHTML = (check?.account_summary || []).map((account) => {
        const simulated = Number(account.trading_environment) === 0;
        return '<tr><td class="mono">' + safe(account.account_id) + '</td><td>' + state(simulated, 'simulation', 'non-simulation') + '</td><td>' + safe((account.trading_market_auth_list || []).join(',')) + '</td><td>' + safe(account.simulated_account_type) + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="hint">OpenD check has not run yet</td></tr>';
    }

    function renderConsoleLog(processes) {
      const blocks = [];
      for (const name of ['capture', 'browser', 'moomooCheck']) {
        const rows = processes[name]?.last_log || [];
        if (rows.length) blocks.push('[' + name + ']\n' + rows.join('\n'));
      }
      el('consoleLog').textContent = blocks.join('\n\n') || 'No console-owned process logs';
    }

    async function refresh() {
      el('clock').textContent = new Date().toLocaleString();
      const response = await fetch('/api/status', { cache: 'no-store' });
      const data = await response.json();
      const status = data.junk_status || {};
      const watcher = data.external_junk_runtime?.watcher || {};
      const global = data.moomoo_check?.global_state || {};
      el('capture').innerHTML = state(
        data.capture_health?.healthy,
        data.capture_health?.state || 'healthy',
        data.capture_health?.state || 'stale / stopped',
      );
      el('watcher').innerHTML = state(watcher.running && watcher.heartbeat_fresh, 'running', 'degraded / stopped');
      el('phase').textContent = status.phase || '-';
      el('opend').innerHTML = state(global.qot_logined && global.trd_logined, 'connected', 'unchecked / disconnected');
      el('mode').innerHTML = status.execution_environment === 'simulate_only' && status.real_trading_allowed === false ? '<span class="ok">simulate_only</span>' : '<span class="bad">' + safe(status.execution_environment) + '</span>';
      el('positions').textContent = safe(status.risk?.open_position_count || 0) + ' / ' + safe(status.active_orders?.length || 0);
      const pnlValue = Number(status.risk?.daily_realized_pnl_usd || 0);
      el('pnl').innerHTML = '<span class="' + (pnlValue >= 0 ? 'ok' : 'bad') + '">' + money(pnlValue) + '</span>';
      el('quota').textContent = safe(status.quota?.monthly_remaining) + ' / ' + safe(status.quota?.monthly_limit);
      renderProcesses(data.processes || {});
      renderRuntime(data);
      renderExperiment(data);
      renderTrades(data.latest_trade_events || []);
      renderFlow(data.latest_flow_events || []);
      renderAccounts(data.moomoo_check);
      renderConsoleLog(data.processes || {});
    }

    document.querySelectorAll('button[data-action]').forEach((button) => {
      button.addEventListener('click', () => post(button.dataset.action));
    });
    refresh().catch((error) => { el('consoleLog').textContent = error.message; });
    setInterval(() => refresh().catch(() => {}), 2_000);
  </script>
</body>
</html>`;
}

await fsp.mkdir(logsDir, { recursive: true });
const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => sendJson(res, { error: error.message }, 500));
});

server.listen(PORT, HOST, () => {
  console.log(`JUNKMAN control console: http://${HOST}:${PORT}`);
});

function shutdown() {
  stopConsoleOwnedProcesses();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
