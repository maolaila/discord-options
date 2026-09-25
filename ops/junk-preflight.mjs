import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { create_nightwatch_rest_client } from '../packages/nightwatch-api/nightwatch-rest-client.mjs';
import { assess_directional_chain_provenance } from '../apps/zero-dte-options/junk-gex-strategy.mjs';
import { assess_junk_gex_freshness, JUNK_GEX_MAX_AGE_MS } from '../apps/zero-dte-options/junk-gex-freshness.mjs';
import { market_schedule, ny_context } from '../apps/zero-dte-options/zero-dte-line.mjs';
import { connectMoomoo, loadMoomooConfig, fetchGlobalState, fetchMoomooAccounts,
  selectSimulatedUsOptionAccount, fetchPositionList, fetchOrderList, maskId } from '../packages/moomoo-opend/moomoo-opend.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const businessLine = process.argv.includes('--strategy=junkman_new_20260925') ? 'junkman_new_20260925' : 'zero-dte-options';
const policyFile = path.join(root, 'config', `${businessLine}-policy.json`);
const policy = JSON.parse(await fsp.readFile(policyFile, 'utf8'));
const config = loadMoomooConfig({ businessLine, envFile: path.join(root, '.env'), policyFile });
if (config.trdEnv !== 0 || config.allowRealTrading || policy.execution?.real_trading_allowed !== false) {
  throw new Error('Preflight requires the simulation-only configuration');
}
const current = ny_context(new Date());
const dateArg = process.argv.find(arg => arg.startsWith('--date='))?.slice(7);
if (dateArg && (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)
  || !Number.isFinite(Date.parse(`${dateArg}T12:00:00Z`))
  || new Date(`${dateArg}T12:00:00Z`).toISOString().slice(0, 10) !== dateArg)) throw new Error('Invalid --date=YYYY-MM-DD');
let target = dateArg || current.date_key;
if (!dateArg) {
  for (let day = 0; day < 8; day++) {
    const candidate = ny_context(new Date(`${target}T16:00:00Z`));
    if (!market_schedule(policy, candidate).closed
      && (target !== current.date_key || current.minutes < 16 * 60)) break;
    target = new Date(Date.parse(`${target}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
}
if (market_schedule(policy, ny_context(new Date(`${target}T16:00:00Z`))).closed) {
  throw new Error('Requested date is closed or outside the configured calendar');
}
const api = create_nightwatch_rest_client({ request_timeout_ms: 10_000 });
function api_error(error) {
  return { status: 'request_failed', http_status: error?.status ?? null,
    error_code: error?.error_code || 'REQUEST_FAILED', retry_after_ms: error?.retry_after_ms ?? null };
}
async function probe_chain() {
  try {
    const response = await api.get_options_chain_snapshot_complete('SPX', { query: { expiration: target } });
    const options = { option_chain_snapshot: response, ticker: 'SPX', expiration: target,
      now_ms: Date.now(), max_age_ms: JUNK_GEX_MAX_AGE_MS };
    const call = assess_directional_chain_provenance({ ...options, direction: 'bullish' });
    const put = assess_directional_chain_provenance({ ...options, direction: 'bearish' });
    return { status: call.ready && put.ready ? 'ready' : 'not_ready', call, put };
  } catch (error) { return api_error(error); }
}
async function probe_broker() {
  let connection;
  async function bounded(operation) {
    let timer;
    try {
      return await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Broker read timed out')), 15_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  try {
    connection = await connectMoomoo(config, { timeoutMs: 15_000 });
    const [global, accounts] = await bounded(() => Promise.all([fetchGlobalState(connection.client), fetchMoomooAccounts(connection.client)]));
    const account = selectSimulatedUsOptionAccount(accounts);
    const ready = global.s2c?.qotLogined === true && global.s2c?.trdLogined === true && Boolean(account);
    if (!ready) return { status: 'not_authenticated', checked_at: new Date().toISOString() };
    const scoped = { ...config, accId: String(account.accID), trdEnv: 0 };
    const [positions, orders] = await bounded(() => Promise.all([
      fetchPositionList(connection.client, scoped), fetchOrderList(connection.client, scoped),
    ]));
    return { status: 'authenticated', checked_at: new Date().toISOString(),
      qot_logined: true, trd_logined: true, trd_env: 0, sim_acc_type: account.simAccType,
      account_id: maskId(account.accID),
      positions: (positions.s2c?.positionList || []).filter(p => Number(p.qty) !== 0)
        .map(p => ({ code: p.code, qty: p.qty, can_sell_qty: p.canSellQty })),
      order_count: (orders.s2c?.orderList || []).length };
  } catch { return { status: 'connection_or_account_probe_failed', checked_at: new Date().toISOString() }; }
  finally { connection?.close(); }
}
const [chain, broker, gex, discovery] = await Promise.all([
  probe_chain(), probe_broker(),
  api.get_dealer_gex_snapshot('SPX').then(response => assess_junk_gex_freshness({ response })).catch(api_error),
  api.discover_datasets().then(response => ({ quota: response.data?.quota,
    capabilities: response.data?.capabilities?.filter(id => /chain_greeks|volume_rank|vex/i.test(id)) })).catch(api_error),
]);
const report = { business_line: businessLine, option_selection_mode: policy.strategy.option_selection_mode || 'directional_gex', checked_at: new Date().toISOString(), session_date_et: target,
  simulation_only: true, market_open: market_schedule(policy, ny_context(new Date())).market_open,
  scope: 'read_only_dependencies_not_a_trade_or_fill_test', chain, broker, gex, discovery };
await fsp.mkdir(path.join(root, 'logs'), { recursive: true });
await fsp.writeFile(path.join(root, 'logs', businessLine === 'zero-dte-options' ? 'junk-preflight.json' : 'junkman_new_20260925-preflight.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
const requiresChain = policy.strategy.option_selection_mode !== 'atm';
if (broker.status !== 'authenticated' || (requiresChain && chain.status === 'request_failed')
  || (report.market_open && ((requiresChain && chain.status !== 'ready') || gex.readiness !== 'ready'))) process.exitCode = 2;
