import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { create_nightwatch_rest_client } from '../packages/nightwatch-api/nightwatch-rest-client.mjs';
import { create_research_context_service } from '../apps/zero-dte-options/junk-research-context.mjs';
import { build_exit_replay_report } from '../apps/zero-dte-options/junk-exit-replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (name) => path.join(root, 'logs', `zero-dte-options-${name}`);
const escape = (text) => String(text ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function render_replay_report(report) {
  const fmt = (n) => n === null ? '—' : Number(n).toFixed(2);
  const rows = report.groups.map((g) => `<tr><td>${escape(g.date_et)}</td><td>${escape(g.line_id)}</td>
    <td>${g.trades}</td><td>${g.wins}/${g.losses}/${g.flat}</td><td>${fmt(g.purchase_cost_usd)}</td>
    <td>${fmt(g.sale_proceeds_usd)}</td><td>${fmt(g.gross_pnl_usd)}</td><td>${fmt(g.invested_return_pct)}%</td>
    <td>${g.remaining_qty}</td><td>${g.replay_complete}/${g.replay_incomplete}</td>
    <td>${g.replay_complete ? fmt(g.modeled_gross_pnl_usd) : '—'}</td></tr>`).join('');
  const cohorts = report.cohorts.map((c) => `<details><summary>${escape(c.date_et)} · ${escape(c.code)} · ${escape(c.plan_id)}</summary>
    <p><a href="${escape(c.replay_lab_url)}">打开 Nightwatch SPX 回放</a></p>
    <pre>${escape(JSON.stringify(c, null, 2))}</pre></details>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <title>JUNK 三线退出复核</title><style>body{font:15px system-ui;background:#101725;color:#dce8f7;margin:32px}
    h1{font-size:24px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
    td,th{padding:10px;border-bottom:1px solid #34425a;text-align:right}td:first-child,td:nth-child(2){text-align:left}
    a{color:#74baff}p{line-height:1.7}details{margin:16px 0}pre{white-space:pre-wrap}.table{overflow:auto}</style>
    <h1>JUNK 三线退出复核</h1><p>生成时间：${escape(report.generated_at)}。按美国交易日、每条退出线分别统计，禁止合并为策略总收益。</p>
    <p>实际结果取已完整成交且可比较的模拟账本，收益率 = 毛盈亏 ÷ 买入成本；未扣手续费。作废日和不完整成交不计入收益。
    回放沿用各历史仓位冻结的退出规则，假设按记录的买一价减缓冲立即成交，不能复现排队、成交延迟和部分成交。
    报价缺失、过期、间隔超过 45 秒或路径提前结束时，回放标为不完整，不填造收益。旧交易没有完整报价路径时仍可核对实际成交并打开官方回放。</p>
    <div class="table"><table><thead><tr><th>交易日</th><th>退出线</th><th>完整交易</th><th>赢/亏/平</th><th>买入成本 $</th>
    <th>卖出收入 $</th><th>实际毛盈亏 $</th><th>投入收益率</th><th>余仓</th><th>回放完整/缺失</th><th>完整回放毛盈亏 $</th></tr></thead>
    <tbody>${rows}</tbody></table></div>${cohorts}</html>`;
}

async function read_observations(file) {
  const records = [];
  try {
    const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { /* incomplete writes become coverage gaps */ }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return records;
}

export async function run_research_cli(args = process.argv.slice(2)) {
  if (args[0] === 'snapshot' && args.length === 1) {
    const client = create_nightwatch_rest_client({ max_429_retries: 0, request_timeout_ms: 8_000 });
    const service = create_research_context_service({ client,
      latest_path: log('research-context.json'), history_path: log('research-context.ndjson') });
    for (let i = 0; i < 3; i++) {
      service.kick(); await service.idle();
      if (i < 2) await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
    const result = service.snapshot(); service.stop();
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (args[0] !== 'replay' || (args.length > 1 &&
    (args.length !== 3 || args[1] !== '--date' || !/^\d{4}-\d{2}-\d{2}$/.test(args[2])))) {
    throw new Error('Usage: junk-research.mjs snapshot | replay [--date YYYY-MM-DD]');
  }
  const state = JSON.parse(await readFile(log('runtime-state.json'), 'utf8'));
  const policy = JSON.parse(await readFile(path.join(root, 'config/zero-dte-options-policy.json'), 'utf8'));
  const observations = await read_observations(log('replay-observations.ndjson'));
  const report = build_exit_replay_report({ state, policy, observations, date_et: args[2] || null });
  const output = path.join(root, 'logs', 'research-reports', `junk-exit-review-${args[2] || 'all'}`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(`${output}.json`, JSON.stringify(report, null, 2) + '\n');
  await writeFile(`${output}.html`, render_replay_report(report));
  console.log(JSON.stringify({ json: `${output}.json`, html: `${output}.html`, groups: report.groups }, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run_research_cli().catch((error) => {
    console.error(error?.name === 'NightwatchRestError' ? 'Nightwatch research request unavailable.' : error.message);
    process.exitCode = 1;
  });
}
