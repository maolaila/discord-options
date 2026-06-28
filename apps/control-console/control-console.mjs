import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOST = process.env.CONTROL_CONSOLE_HOST || '127.0.0.1';
const PORT = Number(process.env.CONTROL_CONSOLE_PORT || 18766);
const DEFAULT_ENV_FILE = process.env.MOOMOO_CONTROL_ENV_FILE || path.join(ROOT, '.env');
const MAX_LOG_LINES = 300;

const logsDir = path.join(ROOT, 'logs');
const processes = new Map();
const serverStartedAt = new Date().toISOString();

function nodeBin() {
  return process.execPath;
}

function powershellBin() {
  return 'powershell';
}

function isRunning(entry) {
  return Boolean(entry?.child && entry.child.exitCode === null && !entry.child.killed);
}

function nowIso() {
  return new Date().toISOString();
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
    log: [],
    child: null,
  };
}

function getOrCreateEntry(name, label, command, args, options) {
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

  entry.command = command;
  entry.args = args;
  entry.startedAt = nowIso();
  entry.stoppedAt = null;
  entry.exitCode = null;
  entry.signal = null;
  entry.error = null;
  entry.oneShot = Boolean(options.oneShot);
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
  });
  return entry;
}

function stopProcess(name) {
  const entry = processes.get(name);
  if (!entry || !isRunning(entry)) return entry || null;
  pushLog(entry, 'status', 'stopping');
  entry.child.kill();
  return entry;
}

function envArgs(envFile) {
  const file = String(envFile || DEFAULT_ENV_FILE).trim();
  return file ? ['--env', file] : [];
}

function realConfirmEnv() {
  return { MOOMOO_REAL_TRADING_CONFIRM: 'I_UNDERSTAND' };
}

function startBrowser() {
  return startProcess('browser', 'Discord 浏览器', powershellBin(), [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(ROOT, 'start-discord-cdp.ps1'),
    '-OpenDiscord',
  ], { oneShot: true });
}

function startCapture() {
  return startProcess('capture', 'Discord 抓包', nodeBin(), [
    path.join(ROOT, 'apps', 'discord-capture', 'capture-discord.js'),
  ]);
}

function startWatchPlan(envFile) {
  stopProcess('watchSim');
  return startProcess('watchPlan', 'Moomoo 干跑监听', nodeBin(), [
    path.join(ROOT, 'apps', 'options-sim', 'moomoo-signal-trader.mjs'),
    '--watch',
    '--dry-run',
    ...envArgs(envFile),
  ]);
}

function startWatchSim(envFile) {
  stopProcess('watchPlan');
  return startProcess('watchSim', 'Moomoo 模拟监听', nodeBin(), [
    path.join(ROOT, 'apps', 'options-sim', 'moomoo-signal-trader.mjs'),
    '--watch',
    '--execute-simulate',
    ...envArgs(envFile),
  ]);
}

function startExitMonitor(envFile) {
  return startProcess('exitMonitor', 'Moomoo 卖出监控', nodeBin(), [
    path.join(ROOT, 'apps', 'options-sim', 'moomoo-exit-monitor.mjs'),
    '--watch',
    ...envArgs(envFile),
  ]);
}

function runMoomooCheck(envFile) {
  return startProcess('moomooCheck', 'OpenD 检查', nodeBin(), [
    path.join(ROOT, 'apps', 'opend-check', 'moomoo-check.mjs'),
    ...envArgs(envFile),
  ], { oneShot: true });
}

function startStockRebalancePlan(envFile) {
  return startProcess('stockPlan', '股票调仓计划', nodeBin(), [
    path.join(ROOT, 'apps', 'stock-rebalance', 'stock-rebalance-live.mjs'),
    '--plan-only',
    ...envArgs(envFile),
  ], { oneShot: true });
}

function startStockRebalance(envFile) {
  return startProcess('stockRebalance', '股票实盘调仓', nodeBin(), [
    path.join(ROOT, 'apps', 'stock-rebalance', 'stock-rebalance-live.mjs'),
    '--wait-open',
    '--execute-real',
    ...envArgs(envFile),
  ], { oneShot: true, env: realConfirmEnv() });
}

function startAtrStop(envFile) {
  return startProcess('atrStop', 'ATR 实盘止损', nodeBin(), [
    path.join(ROOT, 'apps', 'atr-stop', 'atr-trailing-stop.mjs'),
    '--watch',
    '--execute-real',
    ...envArgs(envFile),
  ], { env: realConfirmEnv() });
}

function startAll(mode, envFile) {
  startBrowser();
  startCapture();
  runMoomooCheck(envFile);
  if (mode === 'simulate') {
    startWatchSim(envFile);
    startExitMonitor(envFile);
  } else {
    startWatchPlan(envFile);
  }
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
      lastWriteTime: stat.mtime.toISOString(),
    };
  } catch {
    return {
      path: relativePath,
      exists: false,
      length: 0,
      lastWriteTime: '',
    };
  }
}

function tailNdjson(relativePath, count = 5) {
  const fullPath = path.join(ROOT, relativePath);
  if (!fs.existsSync(fullPath)) return [];
  const text = fs.readFileSync(fullPath, 'utf8');
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

function redactMoomooCheck(payload) {
  if (!payload) return null;
  return {
    checked_at: payload.checked_at || '',
    config: payload.config || null,
    global_state: payload.global_state?.s2c ? {
      qotLogined: payload.global_state.s2c.qotLogined,
      trdLogined: payload.global_state.s2c.trdLogined,
      marketUS: payload.global_state.s2c.marketUS,
      serverVer: payload.global_state.s2c.serverVer,
      serverBuildNo: payload.global_state.s2c.serverBuildNo,
    } : null,
    account_summary: payload.account_summary || [],
  };
}

function processSnapshot(entry) {
  return {
    name: entry.name,
    label: entry.label,
    running: isRunning(entry),
    pid: entry.pid,
    startedAt: entry.startedAt,
    stoppedAt: entry.stoppedAt,
    exitCode: entry.exitCode,
    signal: entry.signal,
    error: entry.error,
    oneShot: entry.oneShot,
    lastLog: entry.log.slice(-12),
  };
}

function statusPayload() {
  const captureStatus = readJson(path.join(logsDir, 'capture-status.json'));
  const latestPlan = readJson(path.join(logsDir, 'moomoo-order-plans-latest.json'));
  const latestTradeJournal = readJson(path.join(logsDir, 'trade-journal-latest.json'));
  const moomooCheck = redactMoomooCheck(readJson(path.join(logsDir, 'moomoo-check.json')));
  const exitStatus = readJson(path.join(logsDir, 'moomoo-exit-status.json'));
  const stockRebalanceStatus = readJson(path.join(logsDir, 'stock-rebalance-status.json'));
  const stockRebalancePlan = readJson(path.join(logsDir, 'stock-rebalance-plan-latest.json'));
  const atrStopStatus = readJson(path.join(logsDir, 'atr-stop-status.json'));
  const atrStopState = readJson(path.join(logsDir, 'atr-stop-state.json'));
  return {
    server: {
      startedAt: serverStartedAt,
      host: HOST,
      port: PORT,
      defaultEnvFile: DEFAULT_ENV_FILE,
    },
    processes: Object.fromEntries([...processes.entries()].map(([name, entry]) => [name, processSnapshot(entry)])),
    files: [
      fileInfo('logs/capture-status.json'),
      fileInfo('logs/option-signals.ndjson'),
      fileInfo('logs/order-intents.ndjson'),
      fileInfo('logs/moomoo-order-plans.ndjson'),
      fileInfo('logs/moomoo-order-plans-latest.json'),
      fileInfo('logs/moomoo-check.json'),
      fileInfo('logs/moomoo-exit-status.json'),
      fileInfo('logs/moomoo-exit-orders.ndjson'),
      fileInfo('logs/trade-journal.ndjson'),
      fileInfo('logs/trade-journal-latest.json'),
      fileInfo('logs/stock-rebalance-status.json'),
      fileInfo('logs/stock-rebalance-plan-latest.json'),
      fileInfo('logs/stock-rebalance-orders.ndjson'),
      fileInfo('logs/atr-stop-status.json'),
      fileInfo('logs/atr-stop-state.json'),
      fileInfo('logs/atr-stop-orders.ndjson'),
    ],
    captureStatus,
    latestPlan,
    latestTradeJournal,
    moomooCheck,
    exitStatus,
    stockRebalanceStatus,
    stockRebalancePlan,
    atrStopStatus,
    atrStopState,
    latestMessages: tailNdjson('logs/messages.ndjson', 8).reverse(),
    latestSignals: tailNdjson('logs/option-signals.ndjson', 8).reverse(),
    latestPlans: tailNdjson('logs/moomoo-order-plans.ndjson', 8).reverse(),
    latestExits: tailNdjson('logs/moomoo-exit-orders.ndjson', 8).reverse(),
    latestStockRebalanceOrders: tailNdjson('logs/stock-rebalance-orders.ndjson', 8).reverse(),
    latestAtrStopOrders: tailNdjson('logs/atr-stop-orders.ndjson', 8).reverse(),
    latestTradeJournalRows: tailNdjson('logs/trade-journal.ndjson', 8).reverse(),
  };
}

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res) {
  const body = dashboardHtmlPage();
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
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
  const envFile = body.envFile || DEFAULT_ENV_FILE;
  if (pathname === '/api/start-all-sim') startAll('simulate', envFile);
  else if (pathname === '/api/start-all-plan') startAll('plan', envFile);
  else if (pathname === '/api/start-browser') startBrowser();
  else if (pathname === '/api/start-capture') startCapture();
  else if (pathname === '/api/start-watch-sim') startWatchSim(envFile);
  else if (pathname === '/api/start-watch-plan') startWatchPlan(envFile);
  else if (pathname === '/api/start-exit-monitor') startExitMonitor(envFile);
  else if (pathname === '/api/moomoo-check') runMoomooCheck(envFile);
  else if (pathname === '/api/stock-rebalance-plan') startStockRebalancePlan(envFile);
  else if (pathname === '/api/start-stock-rebalance') startStockRebalance(envFile);
  else if (pathname === '/api/start-atr-stop') startAtrStop(envFile);
  else if (pathname === '/api/stop-capture') stopProcess('capture');
  else if (pathname === '/api/stop-watch') {
    stopProcess('watchPlan');
    stopProcess('watchSim');
    stopProcess('exitMonitor');
  } else if (pathname === '/api/stop-stock-rebalance') {
    stopProcess('stockPlan');
    stopProcess('stockRebalance');
  } else if (pathname === '/api/stop-atr-stop') {
    stopProcess('atrStop');
  } else if (pathname === '/api/stop-all') {
    stopProcess('capture');
    stopProcess('watchPlan');
    stopProcess('watchSim');
    stopProcess('exitMonitor');
    stopProcess('moomooCheck');
    stopProcess('stockPlan');
    stopProcess('stockRebalance');
    stopProcess('atrStop');
  } else {
    sendJson(res, { error: 'unknown endpoint' }, 404);
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
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) return routePost(req, res, url.pathname);
  sendJson(res, { error: 'not found' }, 404);
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
  <title>交易业务线控制台</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f1216;
      --top: #151a20;
      --panel: #1b2229;
      --panel-soft: #202932;
      --line: #34414d;
      --line-soft: #29333d;
      --text: #edf2f7;
      --muted: #9ba8b6;
      --green: #37c97f;
      --red: #ff6b6b;
      --yellow: #e6bd4a;
      --blue: #71a7ff;
      --cyan: #54d1c7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
    }
    header {
      min-height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 24px;
      background: var(--top);
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 650;
      letter-spacing: 0;
    }
    main {
      max-width: 1660px;
      margin: 0 auto;
      padding: 18px 24px 28px;
      display: grid;
      gap: 16px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(7, minmax(140px, 1fr));
      gap: 10px;
    }
    .metric, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric {
      min-height: 78px;
      padding: 12px 14px;
    }
    .metric .label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }
    .metric .value {
      font-size: 17px;
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(280px, 1.4fr) repeat(11, minmax(104px, auto));
      gap: 10px;
      align-items: end;
    }
    label {
      color: var(--muted);
      font-size: 12px;
      display: grid;
      gap: 6px;
    }
    input {
      width: 100%;
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #0c1014;
      color: var(--text);
      padding: 0 10px;
      font: inherit;
    }
    button {
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-soft);
      color: var(--text);
      font: inherit;
      font-weight: 650;
      cursor: pointer;
      padding: 0 12px;
      white-space: nowrap;
    }
    button.primary { background: #1f6d4a; border-color: #2b8a60; }
    button.secondary { background: #204e76; border-color: #2c6798; }
    button.danger { background: #6a2c2c; border-color: #8c4141; }
    button:disabled { opacity: .55; cursor: wait; }
    .grid-2 {
      display: grid;
      grid-template-columns: minmax(430px, .9fr) minmax(720px, 1.45fr);
      gap: 16px;
    }
    .grid-3 {
      display: grid;
      grid-template-columns: repeat(3, minmax(320px, 1fr));
      gap: 16px;
    }
    .panel h2 {
      margin: 0;
      padding: 12px 14px;
      font-size: 15px;
      font-weight: 650;
      border-bottom: 1px solid var(--line);
    }
    .panel-body { padding: 12px 14px; }
    .table-wrap {
      width: 100%;
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      padding: 8px 6px;
      border-bottom: 1px solid var(--line-soft);
      vertical-align: top;
      text-align: left;
      overflow-wrap: anywhere;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }
    .compact th, .compact td { padding: 6px; }
    .mono {
      font-family: Consolas, "Cascadia Mono", monospace;
      font-size: 12px;
    }
    .hint {
      color: var(--muted);
      font-size: 12px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 8px;
      border-radius: 999px;
      background: #29333c;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }
    .ok, .positive { color: var(--green); }
    .bad, .negative { color: var(--red); }
    .warn { color: var(--yellow); }
    .info { color: var(--blue); }
    .cyan { color: var(--cyan); }
    .log {
      height: 260px;
      overflow: auto;
      background: #0b0f13;
      border: 1px solid var(--line-soft);
      border-radius: 6px;
      padding: 10px;
      white-space: pre-wrap;
    }
    @media (max-width: 1280px) {
      .summary { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
      .toolbar { grid-template-columns: repeat(2, minmax(150px, 1fr)); }
      .grid-2, .grid-3 { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>交易业务线控制台</h1>
    <div class="mono" id="clock"></div>
  </header>
  <main>
    <section class="summary">
      <div class="metric"><div class="label">Discord 抓包</div><div class="value" id="statCapture">-</div></div>
      <div class="metric"><div class="label">期权模拟</div><div class="value" id="statOptions">-</div></div>
      <div class="metric"><div class="label">OpenD</div><div class="value" id="statOpenD">-</div></div>
      <div class="metric"><div class="label">最新信号</div><div class="value" id="statSignal">-</div></div>
      <div class="metric"><div class="label">最新计划</div><div class="value" id="statPlan">-</div></div>
      <div class="metric"><div class="label">股票调仓</div><div class="value" id="statStock">-</div></div>
      <div class="metric"><div class="label">ATR 止损</div><div class="value" id="statAtr">-</div></div>
    </section>

    <section class="toolbar">
      <label>OpenD 配置文件
        <input id="envFile" value="${defaultEnvFile}" />
      </label>
      <button class="primary" data-action="start-all-sim">全套模拟</button>
      <button class="secondary" data-action="start-all-plan">全套干跑</button>
      <button data-action="start-capture">抓包</button>
      <button data-action="start-watch-sim">期权模拟</button>
      <button data-action="start-exit-monitor">期权退出</button>
      <button data-action="stock-rebalance-plan">调仓计划</button>
      <button class="primary" data-action="start-stock-rebalance">执行调仓</button>
      <button data-action="start-atr-stop">ATR 止损</button>
      <button class="danger" data-action="stop-stock-rebalance">停调仓</button>
      <button class="danger" data-action="stop-atr-stop">停 ATR</button>
      <button class="danger" data-action="stop-all">停止全部</button>
    </section>

    <section class="grid-2">
      <div class="panel">
        <h2>进程</h2>
        <div class="panel-body table-wrap">
          <table class="compact">
            <thead><tr><th style="width:26%">名称</th><th style="width:18%">状态</th><th style="width:16%">PID</th><th>最近日志</th></tr></thead>
            <tbody id="processRows"></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h2>最新期权计划</h2>
        <div class="panel-body" id="latestPlan"></div>
      </div>
    </section>

    <section class="panel">
      <h2>ATR 止损线：当前持仓与止损距离</h2>
      <div class="panel-body table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:8%">标的</th>
              <th style="width:9%">状态</th>
              <th style="width:8%">股数</th>
              <th style="width:9%">现价</th>
              <th style="width:9%">ATR 点数</th>
              <th style="width:9%">止损价</th>
              <th style="width:10%">离止损</th>
              <th style="width:9%">入场价</th>
              <th style="width:11%">当前盈亏</th>
              <th style="width:10%">更新时间</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody id="atrRows"></tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h2>股票调仓线：当前标的与目标标的</h2>
      <div class="panel-body table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:9%">目标标的</th>
              <th style="width:9%">目标比例</th>
              <th style="width:9%">现价</th>
              <th style="width:10%">当前股数</th>
              <th style="width:10%">目标股数</th>
              <th style="width:9%">差额</th>
              <th style="width:11%">当前市值</th>
              <th style="width:11%">目标市值</th>
              <th>计划动作</th>
            </tr>
          </thead>
          <tbody id="stockRows"></tbody>
        </table>
        <div class="hint" id="stockOffSheet"></div>
      </div>
    </section>

    <section class="grid-2">
      <div class="panel">
        <h2>期权模拟：消息记录</h2>
        <div class="panel-body table-wrap">
          <table class="compact">
            <thead><tr><th style="width:22%">时间</th><th style="width:20%">频道</th><th style="width:18%">作者</th><th>内容</th></tr></thead>
            <tbody id="messageRows"></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h2>期权模拟：信号记录</h2>
        <div class="panel-body table-wrap">
          <table class="compact">
            <thead><tr><th>时间</th><th>合约</th><th>方向</th><th>门槛</th></tr></thead>
            <tbody id="signalRows"></tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="grid-3">
      <div class="panel">
        <h2>期权模拟：操作记录</h2>
        <div class="panel-body table-wrap">
          <table class="compact">
            <thead><tr><th>时间</th><th>事件</th><th>状态</th><th>摘要</th></tr></thead>
            <tbody id="journalRows"></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h2>OpenD 账户</h2>
        <div class="panel-body table-wrap">
          <table class="compact">
            <thead><tr><th>账户</th><th>环境</th><th>市场</th><th>模拟类型</th></tr></thead>
            <tbody id="accountRows"></tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="grid-2">
      <div class="panel">
        <h2>期权退出记录</h2>
        <div class="panel-body table-wrap">
          <table class="compact">
            <thead><tr><th>时间</th><th>标的</th><th>状态</th><th>触发</th></tr></thead>
            <tbody id="exitRows"></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h2>进程日志</h2>
        <div class="panel-body">
          <div class="log mono" id="processLog"></div>
        </div>
      </div>
    </section>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    let busy = false;
    function escapeHtml(value) {
      const raw = value === null || value === undefined || value === '' ? '-' : String(value);
      return raw.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }
    function text(value) { return escapeHtml(value); }
    function number(value, digits) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '-';
      return n.toFixed(digits).replace(/\\.?0+$/, '');
    }
    function money(value) {
      const n = Number(value);
      return Number.isFinite(n) ? '$' + n.toFixed(2) : '-';
    }
    function pct(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n.toFixed(2) + '%' : '-';
    }
    function signedMoney(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '-';
      const cls = n >= 0 ? 'positive' : 'negative';
      return '<span class="' + cls + '">' + (n >= 0 ? '+' : '') + '$' + n.toFixed(2) + '</span>';
    }
    function signedNumber(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '-';
      const cls = n >= 0 ? 'positive' : 'negative';
      return '<span class="' + cls + '">' + (n >= 0 ? '+' : '') + n + '</span>';
    }
    function fmtTime(value) {
      if (!value) return '-';
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? escapeHtml(value) : escapeHtml(d.toLocaleString());
    }
    function statusClass(value) {
      const s = String(value || '').toLowerCase();
      if (['held', 'ok', 'complete', 'planned', 'closed', 'sold'].includes(s)) return 'ok';
      if (s.includes('pending') || s.includes('waiting') || s.includes('plan')) return 'warn';
      if (s.includes('error') || s.includes('failed') || s.includes('disabled')) return 'bad';
      return 'info';
    }
    function badge(value) {
      return '<span class="badge ' + statusClass(value) + '">' + text(value) + '</span>';
    }
    function shortContract(s) {
      if (!s) return '-';
      return [s.ticker, s.expiration, String(s.strike || '') + (s.option_type || '')].filter(Boolean).join(' ');
    }
    async function post(action) {
      if (busy) return;
      busy = true;
      document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      try {
        await fetch('/api/' + action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ envFile: $('envFile').value })
        });
        await refresh();
      } finally {
        busy = false;
        document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
      }
    }
    function renderProcesses(processes) {
      const names = ['browser', 'capture', 'watchSim', 'exitMonitor', 'watchPlan', 'stockPlan', 'stockRebalance', 'atrStop', 'moomooCheck'];
      $('processRows').innerHTML = names.map((name) => {
        const p = processes[name] || { label: name, running: false, lastLog: [] };
        let state = '<span class="warn">未启动</span>';
        if (p.running) state = '<span class="ok">运行中</span>';
        else if (p.oneShot && p.exitCode === 0) state = '<span class="ok">已完成</span>';
        else if (p.exitCode !== null && p.exitCode !== undefined) state = '<span class="bad">已退出</span>';
        const last = (p.lastLog || []).slice(-3).join('\\n');
        return '<tr><td>' + text(p.label) + '</td><td>' + state + '</td><td class="mono">' + text(p.pid) + '</td><td class="mono">' + text(last) + '</td></tr>';
      }).join('');
    }
    function renderLatestPlan(plan) {
      if (!plan) {
        $('latestPlan').innerHTML = '<div class="hint">暂无期权交易计划</div>';
        return;
      }
      const signal = plan.signal || {};
      const order = plan.order || {};
      const quote = plan.quote?.basic || {};
      const gate = plan.gate || {};
      $('latestPlan').innerHTML =
        '<table><tbody>' +
        '<tr><th style="width:22%">状态</th><td>' + badge(plan.order_status) + ' <span class="badge">' + text(plan.mode) + '</span></td></tr>' +
        '<tr><th>信号</th><td>' + text(shortContract(signal)) + ' ' + text(signal.direction) + ' win=' + text(signal.win_rate_pct) + ' conf=' + text(signal.confidence) + ' risk=' + text(signal.risk_score) + '</td></tr>' +
        '<tr><th>合约</th><td class="mono">' + text(order.code || plan.contract?.security?.code) + '</td></tr>' +
        '<tr><th>报价</th><td>bid=' + text(quote.bidPrice) + ' ask=' + text(quote.askPrice) + ' cur=' + text(quote.curPrice) + ' update=' + text(quote.updateTime) + '</td></tr>' +
        '<tr><th>订单</th><td>' + text(order.side) + ' ' + text(order.qty) + ' @ ' + text(order.price) + '</td></tr>' +
        '<tr><th>拦截</th><td>' + text((gate.reasons || []).join(', ')) + '</td></tr>' +
        '</tbody></table>';
    }
    function renderAtr(data) {
      const rows = Object.values(data.atrStopState?.positions || {}).sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
      $('atrRows').innerHTML = rows.length ? rows.map((row) => {
        const distance = Number(row.distance_to_stop_pct);
        const distanceCell = Number.isFinite(distance)
          ? '<span class="' + (distance <= 2 ? 'warn' : 'ok') + '">' + pct(distance) + '</span>'
          : '-';
        const pnl = signedMoney(row.unrealized_pnl) + ' / ' + pct(row.unrealized_pnl_pct);
        return '<tr>' +
          '<td class="mono">' + text(row.symbol) + '</td>' +
          '<td>' + badge(row.status) + '</td>' +
          '<td>' + text(row.shares) + '</td>' +
          '<td>' + number(row.current_price, 2) + '</td>' +
          '<td>' + number(row.atr_points ?? row.current_atr, 4) + '</td>' +
          '<td>' + number(row.current_stop_price, 2) + '</td>' +
          '<td>' + distanceCell + '</td>' +
          '<td>' + number(row.entry_price, 2) + '</td>' +
          '<td>' + pnl + '</td>' +
          '<td class="mono">' + fmtTime(row.price_updated_at || row.updated_at || row.last_update_date) + '</td>' +
          '<td>' + text(row.error || row.sold_reason || row.pending_order_status || '') + '</td>' +
          '</tr>';
      }).join('') : '<tr><td colspan="11" class="hint">暂无 ATR 持仓状态</td></tr>';
    }
    function renderStock(data) {
      const plan = data.stockRebalancePlan || {};
      const orders = plan.orders || [];
      const orderMap = new Map();
      for (const order of orders) {
        const arr = orderMap.get(order.symbol) || [];
        arr.push(order.side + ' ' + order.qty + ' ' + order.reason);
        orderMap.set(order.symbol, arr);
      }
      const rows = plan.targets || [];
      $('stockRows').innerHTML = rows.length ? rows.map((row) => (
        '<tr>' +
        '<td class="mono">' + text(row.symbol) + '</td>' +
        '<td>' + pct(row.target_pct) + '</td>' +
        '<td>' + number(row.price, 2) + '</td>' +
        '<td>' + text(row.current_qty) + '</td>' +
        '<td>' + text(row.desired_qty) + '</td>' +
        '<td>' + signedNumber(row.delta_qty) + '</td>' +
        '<td>' + money(row.current_value) + '</td>' +
        '<td>' + money(row.target_value) + '</td>' +
        '<td>' + text((orderMap.get(row.symbol) || []).join('; ')) + '</td>' +
        '</tr>'
      )).join('') : '<tr><td colspan="9" class="hint">暂无股票调仓计划</td></tr>';
      const off = plan.off_sheet_positions || [];
      $('stockOffSheet').innerHTML = off.length
        ? '当前不在目标表内的持仓：' + off.map((row) => text(row.symbol) + ' x ' + text(row.qty)).join('，')
        : '当前没有发现目标表外持仓。';
    }
    function renderMessages(messages) {
      $('messageRows').innerHTML = (messages || []).length ? messages.map((row) => {
        const author = row.author?.global_name || row.author?.username || row.author?.id || '';
        const embedTitle = Array.isArray(row.embeds) && row.embeds[0] ? row.embeds[0].title || '' : '';
        const body = row.content || embedTitle || '[空消息]';
        return '<tr><td class="mono">' + fmtTime(row.captured_at || row.timestamp) + '</td><td class="mono">' + text(row.channel_id) + '</td><td>' + text(author) + '</td><td>' + text(body) + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="hint">暂无消息记录</td></tr>';
    }
    function renderSignals(signals) {
      $('signalRows').innerHTML = (signals || []).length ? signals.map((s) =>
        '<tr><td class="mono">' + fmtTime(s.received_at || s.captured_at || s.observed_at) + '</td><td>' + text(shortContract(s)) + '</td><td>' + text(s.direction) + '</td><td>win=' + text(s.win_rate_pct) + ' conf=' + text(s.confidence) + ' risk=' + text(s.risk_score) + '</td></tr>'
      ).join('') : '<tr><td colspan="4" class="hint">暂无信号</td></tr>';
    }
    function renderJournal(rows) {
      $('journalRows').innerHTML = (rows || []).length ? rows.map((row) => {
        const summary = row.signal ? shortContract(row.signal) : (row.source_buy_order_id_ex || row.trade_key || '');
        return '<tr><td class="mono">' + fmtTime(row.recorded_at || row.updated_at) + '</td><td>' + text(row.event_type || row.source) + '</td><td>' + badge(row.lifecycle_status || row.mode || '-') + '</td><td>' + text(summary) + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="hint">暂无操作记录</td></tr>';
    }
    function renderExits(rows) {
      $('exitRows').innerHTML = (rows || []).length ? rows.map((row) => {
        const trigger = row.trigger || row.exit_trigger || row.last_trigger || {};
        return '<tr><td class="mono">' + fmtTime(row.submitted_at || row.updated_at || row.triggered_at) + '</td><td class="mono">' + text(row.symbol || row.code || row.exit_order?.code) + '</td><td>' + badge(row.status || row.order_status || row.reason || '-') + '</td><td>' + text(trigger.reason || row.reason || '') + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="hint">暂无退出记录</td></tr>';
    }
    function renderAccounts(check) {
      const rows = check?.account_summary || [];
      $('accountRows').innerHTML = rows.length ? rows.map((a) =>
        '<tr><td class="mono">' + text(a.accID) + '</td><td>' + (Number(a.trdEnv) === 0 ? '<span class="ok">模拟</span>' : '<span class="warn">真实</span>') + '</td><td>' + text((a.trdMarketAuthList || []).join(',')) + '</td><td>' + text(a.simAccType) + '</td></tr>'
      ).join('') : '<tr><td colspan="4" class="hint">暂无账户检查结果</td></tr>';
    }
    function renderLogs(processes) {
      const names = ['capture', 'watchSim', 'exitMonitor', 'watchPlan', 'stockPlan', 'stockRebalance', 'atrStop', 'moomooCheck'];
      const parts = [];
      for (const name of names) {
        const p = processes[name];
        if (p?.lastLog?.length) parts.push('[' + p.label + ']\\n' + p.lastLog.join('\\n'));
      }
      $('processLog').textContent = parts.join('\\n\\n');
    }
    async function refresh() {
      $('clock').textContent = new Date().toLocaleString();
      const res = await fetch('/api/status');
      const data = await res.json();
      const p = data.processes || {};
      $('statCapture').innerHTML = p.capture?.running ? '<span class="ok">运行中</span>' : '<span class="warn">未运行</span>';
      $('statOptions').innerHTML = p.watchSim?.running && p.exitMonitor?.running
        ? '<span class="ok">模拟+退出</span>'
        : (p.watchSim?.running ? '<span class="ok">模拟监听</span>' : (p.watchPlan?.running ? '<span class="info">干跑监听</span>' : '<span class="warn">未运行</span>'));
      const gs = data.moomooCheck?.global_state;
      $('statOpenD').innerHTML = gs?.qotLogined && gs?.trdLogined ? '<span class="ok">已连接</span>' : '<span class="warn">待检查</span>';
      $('statSignal').textContent = shortContract((data.latestSignals || [])[0]);
      $('statPlan').textContent = data.latestPlan ? String(data.latestPlan.order_status || '-') : '-';
      $('statStock').innerHTML = p.stockRebalance?.running
        ? '<span class="ok">执行中</span>'
        : (p.stockPlan?.running ? '<span class="info">计划中</span>' : '<span class="warn">' + text(data.stockRebalanceStatus?.phase || '未运行') + '</span>');
      $('statAtr').innerHTML = p.atrStop?.running
        ? '<span class="ok">监控中</span>'
        : '<span class="warn">' + text(data.atrStopStatus?.phase || '未运行') + '</span>';
      renderProcesses(p);
      renderLatestPlan(data.latestPlan);
      renderAtr(data);
      renderStock(data);
      renderMessages(data.latestMessages || []);
      renderSignals(data.latestSignals || []);
      renderJournal(data.latestTradeJournalRows || []);
      renderExits(data.latestExits || []);
      renderAccounts(data.moomooCheck);
      renderLogs(p);
    }
    document.querySelectorAll('button[data-action]').forEach((button) => {
      button.addEventListener('click', () => post(button.dataset.action));
    });
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}

function htmlPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Discord 期权信号控制台</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #111418;
      --band: #171b20;
      --panel: #1d232a;
      --panel-2: #242b33;
      --line: #36404a;
      --text: #eef3f8;
      --muted: #9daab7;
      --green: #39c980;
      --red: #ff6b6b;
      --yellow: #e9bf4b;
      --blue: #6aa8ff;
      --cyan: #53d3c4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      background: #15191e;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 650;
      letter-spacing: 0;
    }
    main {
      padding: 18px 24px 28px;
      display: grid;
      gap: 16px;
      max-width: 1520px;
      margin: 0 auto;
    }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(7, minmax(150px, 1fr));
      gap: 10px;
    }
    .stat, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .stat {
      padding: 12px 14px;
      min-height: 76px;
    }
    .stat .label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }
    .stat .value {
      font-size: 17px;
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .ok { color: var(--green); }
    .bad { color: var(--red); }
    .warn { color: var(--yellow); }
    .info { color: var(--blue); }
    .toolbar {
      display: grid;
      gap: 10px;
      grid-template-columns: 1.4fr repeat(14, minmax(116px, auto));
      align-items: end;
    }
    label {
      color: var(--muted);
      font-size: 12px;
      display: grid;
      gap: 6px;
    }
    input {
      width: 100%;
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #101317;
      color: var(--text);
      padding: 0 10px;
      font: inherit;
    }
    button {
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-2);
      color: var(--text);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      padding: 0 12px;
      white-space: nowrap;
    }
    button.primary { background: #1f6f4a; border-color: #2b8b60; }
    button.secondary { background: #1f4b75; border-color: #2d6598; }
    button.danger { background: #6b2b2b; border-color: #8c3f3f; }
    button:disabled { opacity: .55; cursor: wait; }
    .content-grid {
      display: grid;
      grid-template-columns: minmax(360px, .95fr) minmax(520px, 1.4fr);
      gap: 16px;
    }
    .panel h2 {
      margin: 0;
      padding: 12px 14px;
      font-size: 15px;
      border-bottom: 1px solid var(--line);
    }
    .panel-body {
      padding: 12px 14px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      padding: 8px 6px;
      border-bottom: 1px solid #2e3740;
      vertical-align: top;
      text-align: left;
      overflow-wrap: anywhere;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }
    .mono {
      font-family: Consolas, "Cascadia Mono", monospace;
      font-size: 12px;
    }
    .log {
      height: 300px;
      overflow: auto;
      background: #0d1014;
      border: 1px solid #2a323b;
      border-radius: 6px;
      padding: 10px;
      white-space: pre-wrap;
    }
    .split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .hint {
      color: var(--muted);
      font-size: 12px;
      margin-top: 8px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      height: 22px;
      padding: 0 8px;
      border-radius: 999px;
      background: #2a333c;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }
    @media (max-width: 1180px) {
      .status-grid { grid-template-columns: repeat(2, minmax(150px, 1fr)); }
      .toolbar { grid-template-columns: 1fr 1fr; }
      .content-grid, .split { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Discord 期权信号控制台</h1>
    <div class="mono" id="clock"></div>
  </header>
  <main>
    <section class="status-grid">
      <div class="stat"><div class="label">抓包监听</div><div class="value" id="statCapture">-</div></div>
      <div class="stat"><div class="label">Moomoo 监听</div><div class="value" id="statWatch">-</div></div>
      <div class="stat"><div class="label">OpenD</div><div class="value" id="statOpenD">-</div></div>
      <div class="stat"><div class="label">最新信号</div><div class="value" id="statSignal">-</div></div>
      <div class="stat"><div class="label">最新计划</div><div class="value" id="statPlan">-</div></div>
      <div class="stat"><div class="label">股票调仓</div><div class="value" id="statStock">-</div></div>
      <div class="stat"><div class="label">ATR 止损</div><div class="value" id="statAtr">-</div></div>
    </section>

    <section class="toolbar">
      <label>OpenD 配置文件
        <input id="envFile" value="${DEFAULT_ENV_FILE.replace(/"/g, '&quot;')}" />
      </label>
      <button class="primary" data-action="start-all-sim">启动全套模拟</button>
      <button class="secondary" data-action="start-all-plan">启动全套干跑</button>
      <button data-action="start-browser">Discord 浏览器</button>
      <button data-action="start-capture">抓包</button>
      <button data-action="start-watch-sim">模拟监听</button>
      <button data-action="start-exit-monitor">卖出监控</button>
      <button data-action="start-watch-plan">干跑监听</button>
      <button data-action="moomoo-check">OpenD 检查</button>
      <button data-action="stock-rebalance-plan">股票计划</button>
      <button class="primary" data-action="start-stock-rebalance">启动股票调仓</button>
      <button data-action="start-atr-stop">启动 ATR</button>
      <button class="danger" data-action="stop-stock-rebalance">停股票</button>
      <button class="danger" data-action="stop-atr-stop">停 ATR</button>
      <button class="danger" data-action="stop-all">停止</button>
    </section>
    <div class="hint">启动或重启抓包后，等抓包进程日志出现 Attached，再刷新 Discord 页面一次。</div>

    <section class="content-grid">
      <div class="panel">
        <h2>进程</h2>
        <div class="panel-body">
          <table>
            <thead><tr><th style="width:28%">名称</th><th style="width:18%">状态</th><th style="width:20%">PID</th><th>最近日志</th></tr></thead>
            <tbody id="processRows"></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h2>最新交易计划</h2>
        <div class="panel-body" id="latestPlan"></div>
      </div>
    </section>

    <section class="split">
      <div class="panel">
        <h2>最近信号</h2>
        <div class="panel-body">
          <table>
            <thead><tr><th>时间</th><th>合约</th><th>方向</th><th>门槛</th></tr></thead>
            <tbody id="signalRows"></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h2>OpenD 账户</h2>
        <div class="panel-body">
          <table>
            <thead><tr><th>账户</th><th>环境</th><th>市场</th><th>模拟类型</th></tr></thead>
            <tbody id="accountRows"></tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>进程日志</h2>
      <div class="panel-body">
        <div class="split">
          <div>
            <div class="badge">抓包</div>
            <div class="log mono" id="captureLog"></div>
          </div>
          <div>
            <div class="badge">Moomoo</div>
            <div class="log mono" id="watchLog"></div>
          </div>
        </div>
      </div>
    </section>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    let busy = false;
    function cls(ok) { return ok ? 'ok' : 'bad'; }
    function text(value) { return value === null || value === undefined || value === '' ? '-' : String(value); }
    function fmtTime(value) {
      if (!value) return '-';
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
    }
    function shortContract(s) {
      if (!s) return '-';
      return [s.ticker, s.expiration, String(s.strike || '') + (s.option_type || '')].filter(Boolean).join(' ');
    }
    async function post(action) {
      if (busy) return;
      busy = true;
      document.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        await fetch('/api/' + action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ envFile: $('envFile').value })
        });
        await refresh();
      } finally {
        busy = false;
        document.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      }
    }
    function renderProcesses(processes) {
      const names = ['browser', 'capture', 'watchSim', 'exitMonitor', 'watchPlan', 'stockPlan', 'stockRebalance', 'atrStop', 'moomooCheck'];
      $('processRows').innerHTML = names.map((name) => {
        const p = processes[name] || { label: name, running: false, lastLog: [] };
        let state = '<span class="warn">未启动</span>';
        if (p.running) {
          state = '<span class="ok">运行中</span>';
        } else if (p.oneShot && p.exitCode === 0) {
          state = '<span class="ok">已完成</span>';
        } else if (p.exitCode !== null && p.exitCode !== undefined) {
          state = '<span class="bad">已退出</span>';
        }
        const last = (p.lastLog || []).slice(-3).join('\\n');
        return '<tr><td>' + text(p.label) + '</td><td>' + state + '</td><td class="mono">' + text(p.pid) + '</td><td class="mono">' + text(last) + '</td></tr>';
      }).join('');
    }
    function renderLatestPlan(plan) {
      if (!plan) {
        $('latestPlan').innerHTML = '<div class="hint">暂无交易计划</div>';
        return;
      }
      const signal = plan.signal || {};
      const order = plan.order || {};
      const quote = plan.quote?.basic || {};
      const gate = plan.gate || {};
      $('latestPlan').innerHTML =
        '<table><tbody>' +
        '<tr><th>状态</th><td><span class="' + (plan.order_status === 'submitted' || plan.order_status === 'dry_run_planned' ? 'ok' : 'warn') + '">' + text(plan.order_status) + '</span> <span class="badge">' + text(plan.mode) + '</span></td></tr>' +
        '<tr><th>信号</th><td>' + shortContract(signal) + ' ' + text(signal.direction) + ' win=' + text(signal.win_rate_pct) + ' conf=' + text(signal.confidence) + ' risk=' + text(signal.risk_score) + '</td></tr>' +
        '<tr><th>合约</th><td class="mono">' + text(order.code || plan.contract?.security?.code) + '</td></tr>' +
        '<tr><th>报价</th><td>bid=' + text(quote.bidPrice) + ' ask=' + text(quote.askPrice) + ' cur=' + text(quote.curPrice) + ' update=' + text(quote.updateTime) + '</td></tr>' +
        '<tr><th>订单</th><td>' + text(order.side) + ' ' + text(order.qty) + ' @ ' + text(order.price) + '</td></tr>' +
        '<tr><th>账户</th><td>' + text(plan.simulated_account?.accID || order.request?.c2s?.header?.accID) + ' env=' + text(order.request?.c2s?.header?.trdEnv) + '</td></tr>' +
        '<tr><th>拦截</th><td>' + text((gate.reasons || []).join(', ')) + '</td></tr>' +
        '</tbody></table>';
    }
    function renderSignals(signals) {
      $('signalRows').innerHTML = (signals || []).map((s) =>
        '<tr><td class="mono">' + fmtTime(s.received_at || s.captured_at || s.observed_at) + '</td><td>' + shortContract(s) + '</td><td>' + text(s.direction) + '</td><td>win=' + text(s.win_rate_pct) + ' conf=' + text(s.confidence) + ' risk=' + text(s.risk_score) + '</td></tr>'
      ).join('');
    }
    function renderAccounts(check) {
      const rows = check?.account_summary || [];
      $('accountRows').innerHTML = rows.map((a) =>
        '<tr><td class="mono">' + text(a.accID) + '</td><td>' + (Number(a.trdEnv) === 0 ? '<span class="ok">模拟</span>' : '<span class="warn">真实</span>') + '</td><td>' + text((a.trdMarketAuthList || []).join(',')) + '</td><td>' + text(a.simAccType) + '</td></tr>'
      ).join('');
    }
    function renderLogs(processes) {
      $('captureLog').textContent = (processes.capture?.lastLog || []).join('\\n');
      const parts = [];
      if (processes.watchSim?.lastLog?.length) {
        parts.push('[Moomoo 模拟监听]\\n' + processes.watchSim.lastLog.join('\\n'));
      }
      if (processes.exitMonitor?.lastLog?.length) {
        parts.push('[卖出监控]\\n' + processes.exitMonitor.lastLog.join('\\n'));
      }
      if (!parts.length && processes.watchPlan?.lastLog?.length) {
        parts.push('[干跑监听]\\n' + processes.watchPlan.lastLog.join('\\n'));
      }
      if (processes.stockPlan?.lastLog?.length) {
        parts.push('[Stock rebalance plan]\\n' + processes.stockPlan.lastLog.join('\\n'));
      }
      if (processes.stockRebalance?.lastLog?.length) {
        parts.push('[Stock rebalance live]\\n' + processes.stockRebalance.lastLog.join('\\n'));
      }
      if (processes.atrStop?.lastLog?.length) {
        parts.push('[ATR trailing stop]\\n' + processes.atrStop.lastLog.join('\\n'));
      }
      $('watchLog').textContent = parts.join('\\n\\n');
    }
    async function refresh() {
      $('clock').textContent = new Date().toLocaleString();
      const res = await fetch('/api/status');
      const data = await res.json();
      const capture = data.processes.capture;
      const watchSim = data.processes.watchSim;
      const watchPlan = data.processes.watchPlan;
      const exitMonitor = data.processes.exitMonitor;
      const stockRebalance = data.processes.stockRebalance;
      const stockPlan = data.processes.stockPlan;
      const atrStop = data.processes.atrStop;
      $('statCapture').innerHTML = capture?.running ? '<span class="ok">运行中</span>' : '<span class="warn">未运行</span>';
      $('statWatch').innerHTML = watchSim?.running && exitMonitor?.running
        ? '<span class="ok">模拟+卖出监控</span>'
        : (watchSim?.running ? '<span class="ok">模拟监听</span>' : (watchPlan?.running ? '<span class="info">干跑监听</span>' : '<span class="warn">未运行</span>'));
      const gs = data.moomooCheck?.global_state;
      $('statOpenD').innerHTML = gs?.qotLogined && gs?.trdLogined ? '<span class="ok">已连接</span>' : '<span class="warn">待检查</span>';
      $('statSignal').textContent = shortContract((data.latestSignals || [])[0]);
      $('statPlan').textContent = data.latestPlan ? text(data.latestPlan.order_status) : '-';
      $('statStock').innerHTML = stockRebalance?.running
        ? '<span class="ok">live</span>'
        : (stockPlan?.running ? '<span class="info">planning</span>' : '<span class="warn">' + text(data.stockRebalanceStatus?.phase || 'stopped') + '</span>');
      $('statAtr').innerHTML = atrStop?.running
        ? '<span class="ok">watching</span>'
        : '<span class="warn">' + text(data.atrStopStatus?.phase || 'stopped') + '</span>';
      renderProcesses(data.processes || {});
      renderLatestPlan(data.latestPlan);
      renderSignals(data.latestSignals || []);
      renderAccounts(data.moomooCheck);
      renderLogs(data.processes || {});
    }
    document.querySelectorAll('button[data-action]').forEach((button) => {
      button.addEventListener('click', () => post(button.dataset.action));
    });
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}

await fsp.mkdir(logsDir, { recursive: true });
http.createServer((req, res) => {
  handler(req, res).catch((error) => sendJson(res, { error: error.message }, 500));
}).listen(PORT, HOST, () => {
  console.log(`Control console: http://${HOST}:${PORT}`);
});
