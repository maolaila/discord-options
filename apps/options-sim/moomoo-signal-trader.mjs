import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  PROJECT_ROOT,
  QOT_MARKET_US_SECURITY,
  TRD_ENV_REAL,
  TRD_ENV_SIMULATE,
  buildOptionExecutionQuote,
  buildLimitBuyOrderRequest,
  connectMoomoo,
  createMoomooQuoteFeed,
  ensureDir,
  fetchMoomooAccounts,
  fetchOrderList,
  fetchPositionList,
  findOptionContract,
  loadMoomooConfig,
  maskId,
  moomooUnderlyingCode,
  normalizeForJson,
  parseCliArgs,
  placeLimitBuyOrder,
  selectConfiguredUsRealAccount,
  selectSimulatedUsOptionAccount,
} from '../../packages/moomoo-opend/moomoo-opend.mjs';
import {
  appendTradeJournalEvent,
  buildPlanJournalPayload,
} from '../../packages/trade-journal/trade-journal.mjs';
import {
  assertBusinessLineKind,
  businessLineLogPath,
  moomooConfigOptionsForBusinessLine,
  resolveBusinessLine,
} from '../../packages/business-lines/business-lines.mjs';
import {
  buildPaEntryRemark,
  hasPaEntryAttempt,
  materializeAcceptedEntry,
  materializeTerminalUnfilledEntry,
  parseStrictNdjson,
  completeNdjsonChunk,
  reconcilePaEntryLedger,
  brokerOrderIds,
  brokerOrderKey,
  brokerOrderRemark,
  buildPaRiskOrderView,
  evaluatePaAggregateExposure,
  getSharedPaOrderSnapshot,
} from './pa-broker-recovery.mjs';

const args = parseCliArgs();
const businessLine = assertBusinessLineKind(resolveBusinessLine(args['business-line'] || args.line || 'pa-options'), 'options');
if (businessLine.key !== 'pa-options') {
  throw new Error(`${businessLine.key} is isolated from the PA options trader. Use its dedicated business-line entrypoint.`);
}
const logsDir = path.join(PROJECT_ROOT, 'logs');
const signalsPath = path.join(logsDir, 'option-signals.ndjson');
const intentsPath = path.join(logsDir, 'order-intents.ndjson');
const plansPath = businessLineLogPath(businessLine, 'order-plans.ndjson');
const latestPlanPath = businessLineLogPath(businessLine, 'order-plans-latest.json');
const executionsPath = businessLineLogPath(businessLine, 'executions.ndjson');
const cursorPath = businessLineLogPath(businessLine, 'intent-cursor.json');
const entryStatusPath = businessLineLogPath(businessLine, 'entry-status.json');
const sharedOrderSnapshotPath = businessLineLogPath(businessLine, 'broker-orders-snapshot.json');
const sharedOrderSnapshotLockPath = `${sharedOrderSnapshotPath}.lock`;

function parseJsonLine(line, sourcePath, lineNumber) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`${sourcePath}:${lineNumber} is not valid JSON: ${error.message}`);
  }
}

function readNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parseStrictNdjson(fs.readFileSync(filePath, 'utf8'), filePath);
}

function brokerRows(response, listName) {
  const normalized = normalizeForJson(response);
  return Array.isArray(normalized?.s2c?.[listName]) ? normalized.s2c[listName] : [];
}

function signalExecutionKey(intent) {
  return [
    businessLine.key,
    intent.source_signal_key || intent.message_id || '',
    intent.ticker || '', intent.expiration || '', intent.strike || '', intent.option_type || '',
  ].join('|');
}

function hasRecordedExecution(executionKey) {
  return hasPaEntryAttempt(readNdjson(executionsPath), executionKey);
}

async function brokerEntryRiskGate(client, config, code, requestedNotionalUsd, brokerOrders) {
  const positionsResponse = await fetchPositionList(client, config);
  const positions = brokerRows(positionsResponse, 'positionList');
  if (!Array.isArray(brokerOrders)) {
    return {
      passed: false,
      reasons: ['shared_broker_order_snapshot_unavailable'],
      existing_exposure_usd: null,
      requested_notional_usd: requestedNotionalUsd,
      projected_exposure_usd: null,
      paper_equity_usd: config.paperEquityUsd,
    };
  }
  return evaluatePaAggregateExposure({
    positions,
    orders: brokerOrders,
    code,
    requestedNotionalUsd,
    paperEquityUsd: config.paperEquityUsd,
  });
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTruthyFlag(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function buildSignalMaps(signals) {
  const byKey = new Map();
  const byMessageId = new Map();
  for (const signal of signals) {
    if (signal.signal_key) byKey.set(signal.signal_key, signal);
    if (signal.message_id) byMessageId.set(signal.message_id, signal);
  }
  return { byKey, byMessageId };
}

function resolveSignal(intent, signalMaps) {
  return signalMaps.byKey.get(intent.source_signal_key)
    || signalMaps.byMessageId.get(intent.message_id)
    || null;
}

function hasStockPlan(intent, signal) {
  return [intent.stock_entry, intent.stock_target, intent.stock_stop, signal?.entry_stock_price, signal?.target_stock_price, signal?.stop_stock_price]
    .some((value) => numeric(value) !== null)
    && numeric(intent.stock_entry ?? signal?.entry_stock_price) !== null
    && numeric(intent.stock_target ?? signal?.target_stock_price) !== null
    && numeric(intent.stock_stop ?? signal?.stop_stock_price) !== null;
}

function directionMatchesContract(intent, signal) {
  const direction = String(signal?.direction || intent.direction || '').toLowerCase();
  const optionType = String(signal?.option_type || intent.option_type || '').toUpperCase();
  if (!direction || !optionType) return false;
  return (direction === 'bull' && optionType === 'C') || (direction === 'bear' && optionType === 'P');
}

function formatMatches(signal, config) {
  if (!config.requiredAdviceFormat) return true;
  return String(signal?.advice_format || '').toLowerCase() === String(config.requiredAdviceFormat).toLowerCase();
}

function isFlowSignal(signal) {
  return String(signal?.advice_format || '').toLowerCase() === 'flow';
}

function liveSignalGate(intent, signal, config, now = new Date()) {
  const policy = config.policy?.signal_filter || {};
  const reasons = [];
  const observedVia = String(intent.observed_via || signal?.observed_via || '');
  const source = String(intent.source || signal?.source || '');
  const eventType = String(intent.event_type || signal?.event_type || '');
  const guildId = String(intent.guild_id || signal?.guild_id || '');
  const channelId = String(intent.channel_id || signal?.channel_id || '');
  const authorId = String(intent.author_id || signal?.author_id || '');
  const authorBot = intent.author_bot === true || signal?.author_bot === true;
  if (intent.live_eligible !== true) reasons.push('intent_not_live_eligible');
  if (observedVia !== 'LIVE_SIGNAL') reasons.push('intent_not_live_gateway');
  if (source !== 'discord_gateway_websocket') reasons.push('intent_source_not_gateway');
  if (eventType !== 'MESSAGE_CREATE') reasons.push('intent_event_not_message_create');
  if (guildId !== String(policy.allowed_guild_id || '')) reasons.push('intent_guild_not_allowed');
  if (!Array.isArray(policy.allowed_channel_ids) || !policy.allowed_channel_ids.map(String).includes(channelId)) {
    reasons.push('intent_channel_not_allowed');
  }
  if (authorId !== String(policy.allowed_author_id || '')) reasons.push('intent_author_not_allowed');
  if (policy.require_bot_author !== false && !authorBot) reasons.push('intent_author_not_bot');
  const messageMs = Date.parse(intent.message_timestamp || signal?.message_timestamp || '');
  const ageMs = now.getTime() - messageMs;
  const maxAgeMs = Number(policy.max_signal_age_seconds || 120) * 1000;
  const skewMs = Number(policy.clock_skew_tolerance_seconds || 5) * 1000;
  if (!Number.isFinite(messageMs)) reasons.push('intent_message_timestamp_invalid');
  else if (ageMs < -skewMs) reasons.push('intent_message_timestamp_in_future');
  else if (ageMs > maxAgeMs) reasons.push('intent_stale');
  const ticker = String(intent.ticker || signal?.ticker || '').toUpperCase();
  if ((policy.blocked_underlyings || []).map((value) => String(value).toUpperCase()).includes(ticker)) {
    reasons.push('underlying_reserved_for_junkman');
  }
  return { passed: reasons.length === 0, reasons, age_ms: Number.isFinite(ageMs) ? ageMs : null };
}

function evaluateGate(intent, signal, config) {
  const reasons = [];
  const liveGate = liveSignalGate(intent, signal, config);
  reasons.push(...liveGate.reasons);
  if (!signal) reasons.push('missing_matching_option_signal');
  if (signal) {
    const signalLiveGate = liveSignalGate(signal, null, config);
    reasons.push(...signalLiveGate.reasons.map((reason) => `matched_signal_${reason}`));
    const exactStringFields = [
      ['message_id', intent.message_id, signal.message_id],
      ['channel_id', intent.channel_id, signal.channel_id],
      ['guild_id', intent.guild_id, signal.guild_id],
      ['author_id', intent.author_id, signal.author_id],
      ['observed_via', intent.observed_via, signal.observed_via],
      ['source', intent.source, signal.source],
      ['event_type', intent.event_type, signal.event_type],
      ['message_timestamp', intent.message_timestamp, signal.message_timestamp],
      ['ticker', String(intent.ticker || '').toUpperCase(), String(signal.ticker || '').toUpperCase()],
      ['expiration', intent.expiration, signal.expiration],
      ['option_type', String(intent.option_type || '').toUpperCase(), String(signal.option_type || '').toUpperCase()],
      ['direction', String(intent.direction || '').toLowerCase(), String(signal.direction || '').toLowerCase()],
    ];
    for (const [field, left, right] of exactStringFields) {
      if (String(left ?? '') !== String(right ?? '')) reasons.push(`intent_signal_${field}_mismatch`);
    }
    if (String(intent.source_signal_key || '') !== String(signal.signal_key || '')) reasons.push('intent_signal_key_mismatch');
    if (numeric(intent.strike) !== numeric(signal.strike)) reasons.push('intent_signal_strike_mismatch');
    if (numeric(intent.stock_entry) !== numeric(signal.entry_stock_price)) reasons.push('intent_signal_stock_entry_mismatch');
    if (numeric(intent.stock_target) !== numeric(signal.target_stock_price)) reasons.push('intent_signal_stock_target_mismatch');
    if (numeric(intent.stock_stop) !== numeric(signal.stop_stock_price)) reasons.push('intent_signal_stock_stop_mismatch');
    if (intent.author_bot !== true || signal.author_bot !== true) reasons.push('intent_signal_bot_identity_mismatch');
  }
  if (intent.status !== 'paper_intent_only') reasons.push(`unsupported_intent_status:${intent.status || ''}`);
  if (intent.action !== 'BUY_TO_OPEN') reasons.push(`unsupported_intent_action:${intent.action || ''}`);
  if (intent.instrument_type !== 'option') reasons.push(`unsupported_instrument_type:${intent.instrument_type || ''}`);

  const action = signal?.action || (intent.action === 'BUY_TO_OPEN' ? 'trade' : '');
  if (action !== 'trade') reasons.push(`signal_action_not_trade:${action || ''}`);
  if (signal && !formatMatches(signal, config)) reasons.push(`advice_format_not_allowed:${signal.advice_format || 'missing'}`);
  if (numeric(intent.stock_stop ?? signal?.stop_stock_price) === null) reasons.push('missing_stock_stop');
  if (!directionMatchesContract(intent, signal)) reasons.push('direction_option_type_mismatch');

  const winRate = numeric(signal?.win_rate_pct ?? intent.win_rate_pct);
  if (winRate === null || winRate < config.minWinRate) reasons.push(`win_rate_below_gate:${winRate ?? 'missing'}`);

  if (!intent.ticker || !intent.expiration || !intent.strike || !intent.option_type) reasons.push('missing_option_contract_fields');

  return {
    passed: reasons.length === 0,
    reasons,
    values: {
      gate_profile: 'option_sim_winrate_stop_gate',
      win_rate_pct: winRate,
      required_advice_format: config.requiredAdviceFormat || null,
      min_win_rate: config.minWinRate,
      confidence_ignored: true,
      risk_score_ignored: true,
      signal_age_ms: liveGate.age_ms,
    },
  };
}

function selectIntents(intents) {
  let selected = intents;
  if (args['message-id']) {
    selected = selected.filter((intent) => String(intent.message_id || '') === String(args['message-id']));
  }
  if (args['signal-key']) {
    selected = selected.filter((intent) => String(intent.source_signal_key || '') === String(args['signal-key']));
  }
  if (args.ticker) {
    selected = selected.filter((intent) => String(intent.ticker || '').toUpperCase() === String(args.ticker).toUpperCase());
  }

  selected = selected.slice().sort((a, b) => {
    const left = Date.parse(a.created_at || a.message_timestamp || '') || 0;
    const right = Date.parse(b.created_at || b.message_timestamp || '') || 0;
    return right - left;
  });

  const limit = Number(args.limit || 1);
  return selected.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 1);
}

function getMode(config) {
  if (isTruthyFlag(args['execute-real'])) {
    assertOptionsRealTradingAllowed(config);
    config.trdEnv = TRD_ENV_REAL;
    return 'execute_real';
  }
  if (isTruthyFlag(args['execute-simulate'])) {
    config.trdEnv = TRD_ENV_SIMULATE;
    return 'execute_simulate';
  }
  return 'dry_run';
}

function assertOptionsRealTradingAllowed(config) {
  if (config.policyRealTradingAllowed !== true) {
    throw new Error(`Real ${businessLine.key} trading is blocked by policy. Set execution.real_trading_allowed=true in ${config.policyPath}.`);
  }
  if (!config.allowRealTrading) {
    throw new Error(`Real ${businessLine.key} trading is blocked. Set MOOMOO_ALLOW_REAL_TRADING=true in .env first.`);
  }
  if (String(process.env.MOOMOO_REAL_TRADING_CONFIRM || '') !== 'I_UNDERSTAND') {
    throw new Error(`Real ${businessLine.key} trading is blocked. Set MOOMOO_REAL_TRADING_CONFIRM=I_UNDERSTAND for the started process.`);
  }
  if (String(process.env.MOOMOO_OPTIONS_REAL_TRADING_CONFIRM || '') !== 'I_UNDERSTAND') {
    throw new Error(`Real ${businessLine.key} trading is blocked. Set MOOMOO_OPTIONS_REAL_TRADING_CONFIRM=I_UNDERSTAND for the started process.`);
  }
}

function assertPaSimulationInvariants(config, mode) {
  if (mode !== 'execute_simulate') return;
  const policy = config.policy || {};
  const blocked = new Set((policy.signal_filter?.blocked_underlyings || []).map((value) => String(value).toUpperCase()));
  if (policy.business_line?.id !== businessLine.key
    || policy.execution?.environment !== 'simulate_only'
    || policy.execution?.real_trading_allowed !== false) {
    throw new Error('PA execution is fail-closed because its policy is not explicitly simulation-only.');
  }
  if (Number(policy.position_sizing?.paper_equity_usd) !== 10_000 || Number(config.paperEquityUsd) !== 10_000) {
    throw new Error('PA execution is fail-closed unless the effective and policy paper equity are both exactly $10,000.');
  }
  if (String(config.requiredAdviceFormat || '').toLowerCase() !== 'pa') {
    throw new Error('PA execution is fail-closed unless requiredAdviceFormat=pa.');
  }
  if (!blocked.has('SPX') || !blocked.has('SPXW')) {
    throw new Error('PA execution is fail-closed unless SPX and SPXW are reserved for JUNKMAN.');
  }
}

function calculatePositionSizing(optionPrice, contractMultiplier, config) {
  const price = Number(optionPrice);
  const multiplier = Number(contractMultiplier || config.contractMultiplierDefault || 100);
  const equity = Number(config.paperEquityUsd || 10000);
  const targetPct = Number(config.targetPositionPct || 25);
  const minPct = Number(config.minPositionPct || 20);
  const maxPct = Number(config.maxPositionPct || 30);
  if (!Number.isFinite(price) || price <= 0) {
    return { qty: 0, status: 'invalid_option_price', reasons: ['invalid_option_price'] };
  }
  const contractCost = price * multiplier;
  const targetBudget = equity * targetPct / 100;
  const maxBudget = equity * maxPct / 100;
  const maxQtyByBudget = Math.floor(maxBudget / contractCost);
  const reasons = [];
  if (maxQtyByBudget < 1) {
    return {
      qty: 0,
      status: 'contract_cost_above_max_position',
      reasons: ['contract_cost_above_max_position'],
      option_price: price,
      contract_multiplier: multiplier,
      contract_cost: contractCost,
      paper_equity_usd: equity,
      max_position_usd: maxBudget,
      max_position_pct: maxPct,
    };
  }

  let qty = Math.max(1, Math.round(targetBudget / contractCost));
  qty = Math.min(qty, maxQtyByBudget);
  if (config.optionQty !== undefined && config.optionQty !== null) {
    qty = Math.max(1, Math.floor(Number(config.optionQty)));
    reasons.push('qty_overridden_by_MOOMOO_OPTION_QTY');
  }
  if (config.maxOptionQty !== undefined && config.maxOptionQty !== null) {
    const capped = Math.min(qty, Math.max(1, Math.floor(Number(config.maxOptionQty))));
    if (capped !== qty) reasons.push('qty_capped_by_MOOMOO_MAX_OPTION_QTY');
    qty = capped;
  }

  const notional = qty * contractCost;
  const actualPct = equity > 0 ? notional / equity * 100 : null;
  if (actualPct !== null && actualPct < minPct) reasons.push('position_below_min_due_to_contract_price_or_qty_cap');
  if (actualPct !== null && actualPct > maxPct) reasons.push('position_above_max');
  return {
    qty,
    status: reasons.includes('position_above_max') ? 'position_above_max' : 'ok',
    reasons,
    option_price: price,
    contract_multiplier: multiplier,
    contract_cost: Number(contractCost.toFixed(2)),
    paper_equity_usd: equity,
    target_position_pct: targetPct,
    min_position_pct: minPct,
    max_position_pct: maxPct,
    target_position_usd: Number(targetBudget.toFixed(2)),
    max_position_usd: Number(maxBudget.toFixed(2)),
    estimated_position_usd: Number(notional.toFixed(2)),
    estimated_position_pct: actualPct === null ? null : Number(actualPct.toFixed(2)),
  };
}

function applyVisibleAskLiquidityCap(positionSizing, quoteModel, config) {
  const out = {
    ...positionSizing,
    reasons: [...(positionSizing.reasons || [])],
  };
  if (!out.qty || out.qty < 1) return out;
  if (!config.optionCapQtyByVisibleAsk) return out;

  const askSize = numeric(quoteModel?.ask_size_contracts);
  const ratio = Number(config.optionMaxQtyToAskVolumeRatio || 0);
  if (askSize === null) {
    out.reasons.push('visible_ask_size_missing');
    return out;
  }
  if (askSize < 1) {
    out.qty = 0;
    out.status = 'visible_ask_size_below_1';
    out.reasons.push('visible_ask_size_below_1');
    out.visible_ask_size_contracts = askSize;
    return out;
  }
  if (!Number.isFinite(ratio) || ratio <= 0) return out;

  const capQty = Math.max(1, Math.floor(askSize * ratio));
  out.visible_ask_size_contracts = askSize;
  out.max_qty_from_visible_ask = capQty;
  out.max_qty_to_ask_volume_ratio = ratio;

  if (out.qty <= capQty) return out;

  out.reasons.push(`qty_capped_by_visible_ask_liquidity:${out.qty}->${capQty}`);
  out.qty = capQty;
  const price = Number(out.option_price);
  const multiplier = Number(out.contract_multiplier || config.contractMultiplierDefault || 100);
  const equity = Number(out.paper_equity_usd || config.paperEquityUsd || 10000);
  const notional = out.qty * price * multiplier;
  const actualPct = equity > 0 ? notional / equity * 100 : null;
  out.estimated_position_usd = Number(notional.toFixed(2));
  out.estimated_position_pct = actualPct === null ? null : Number(actualPct.toFixed(2));
  out.contract_cost = Number((price * multiplier).toFixed(2));
  if (actualPct !== null && actualPct < Number(config.minPositionPct || 0)) {
    out.reasons.push('position_below_min_due_to_visible_ask_liquidity');
  }
  return out;
}

function redactOrderRequest(request) {
  const clone = normalizeForJson(request);
  if (clone?.c2s?.header?.accID) clone.c2s.header.accID = maskId(clone.c2s.header.accID);
  return clone;
}

async function ensureSimulatedOptionAccount(client, config, connectionHolder) {
  if (connectionHolder.simAccountResolved) return connectionHolder.simAccount;
  const accounts = await fetchMoomooAccounts(client);
  const account = selectSimulatedUsOptionAccount(accounts);
  if (!account) {
    throw new Error('No simulated US options account found in OpenD account list.');
  }
  config.trdEnv = TRD_ENV_SIMULATE;
  config.accId = String(account.accID || '');
  connectionHolder.simAccountResolved = true;
  connectionHolder.simAccount = {
    accID: maskId(account.accID),
    trdEnv: account.trdEnv,
    trdMarketAuthList: account.trdMarketAuthList || [],
    simAccType: account.simAccType,
  };
  return connectionHolder.simAccount;
}

async function ensureRealTradingAccount(client, config, connectionHolder) {
  if (connectionHolder.realAccountResolved) return connectionHolder.realAccount;
  const accounts = await fetchMoomooAccounts(client);
  const account = selectConfiguredUsRealAccount(accounts, config);
  if (!account) {
    throw new Error('Configured real US trading account was not found or is not authorized for the US market. Check MOOMOO_ACC_ID with npm run moomoo:check.');
  }
  connectionHolder.realAccountResolved = true;
  connectionHolder.realAccount = {
    accID: maskId(account.accID),
    trdEnv: account.trdEnv,
    markets: account.trdMarketAuthList || [],
    accType: account.accType,
    jpAccType: account.jpAccType || [],
  };
  return connectionHolder.realAccount;
}

function brokerOrderStatusSummary(order) {
  const ids = brokerOrderIds(order);
  return {
    order_id: ids.order_id || null,
    order_id_ex: ids.order_id_ex || null,
    remark: brokerOrderRemark(order) || null,
    code: order?.code || null,
    qty: numeric(order?.qty),
    fill_qty: numeric(order?.fillQty),
    trd_side: numeric(order?.trdSide),
    order_status: numeric(order?.orderStatus),
  };
}

async function writeEntryStatus(payload) {
  const tmp = `${entryStatusPath}.${process.pid}.tmp`;
  await ensureDir(path.dirname(entryStatusPath));
  await fsp.writeFile(tmp, `${JSON.stringify({
    updated_at: new Date().toISOString(),
    business_line: businessLine.key,
    ...payload,
  }, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, entryStatusPath);
}

async function paEntryIsDisabled(config) {
  const policyStatus = String(config.policy?.business_line?.status || '').trim().toLowerCase();
  if (businessLine.enabled !== false && policyStatus !== 'disabled') return false;
  await writeEntryStatus({
    phase: 'disabled',
    mode: 'disabled',
    entry_allowed: false,
    blocked_reasons: ['business_line_permanently_disabled'],
    disabled_reason: config.policy?.business_line?.disabled_reason || null,
  });
  console.log('PA options entry is permanently disabled; no broker connection or order submission was attempted.');
  return true;
}

function latestEntryAttemptAtMs(executionRows = []) {
  let latest = Number.NEGATIVE_INFINITY;
  for (const row of executionRows || []) {
    if (!['submission_intent', 'submission_unknown', 'submitted'].includes(String(row?.order_status || ''))) continue;
    for (const value of [row.execution?.intent_persisted_at, row.execution?.submitted_at]) {
      const parsed = Date.parse(value || '');
      if (Number.isFinite(parsed)) latest = Math.max(latest, parsed);
    }
  }
  return latest;
}

function degradedEntryRecovery(snapshot, reason, error = null) {
  return {
    materializations: [],
    terminalizations: [],
    unresolved: [],
    orphan_broker_orders: [],
    blocked_reasons: [reason],
    entry_allowed: false,
    degraded: true,
    error,
    broker_orders: null,
    order_snapshot: snapshot || null,
  };
}

async function reconcileEntryBrokerState(config, connectionHolder, { urgent = false } = {}) {
  try {
    const executionRowsBeforeSnapshot = readNdjson(executionsPath);
    if (!connectionHolder.connection) connectionHolder.connection = await connectMoomoo(config);
    const client = connectionHolder.connection.client;
    await ensureSimulatedOptionAccount(client, config, connectionHolder);
    const orderSnapshot = await getSharedPaOrderSnapshot({
      snapshotPath: sharedOrderSnapshotPath,
      lockPath: sharedOrderSnapshotLockPath,
      maxAgeMs: urgent ? 11_000 : 30_000,
      notBeforeMs: latestEntryAttemptAtMs(executionRowsBeforeSnapshot),
      waitForPermit: urgent,
      maxWaitMs: 15_000,
      fetchOrders: async () => brokerRows(await fetchOrderList(client, config), 'orderList'),
    });
    if (!orderSnapshot.ok) {
      const degraded = degradedEntryRecovery(orderSnapshot, `broker_order_snapshot_degraded:${orderSnapshot.reason}`, orderSnapshot.error);
      await writeEntryStatus({
        phase: 'broker_orders_degraded',
        mode: 'execute_simulate',
        entry_allowed: false,
        blocked_reasons: degraded.blocked_reasons,
        order_snapshot: orderSnapshot,
        error: orderSnapshot.error || null,
      });
      return degraded;
    }
    const brokerOrders = orderSnapshot.orders;
    let executionRows = executionRowsBeforeSnapshot;
    let reconciliation = reconcilePaEntryLedger({ executionRows, brokerOrders });
    const recoveredAt = new Date();
    for (const item of reconciliation.materializations) {
      await appendJsonLine(executionsPath, materializeAcceptedEntry(item.plan, item.broker_order, recoveredAt));
    }
    for (const item of reconciliation.terminalizations) {
      await appendJsonLine(executionsPath, materializeTerminalUnfilledEntry(item.plan, item.broker_order, recoveredAt));
    }
    if (reconciliation.materializations.length > 0 || reconciliation.terminalizations.length > 0) {
      executionRows = readNdjson(executionsPath);
      reconciliation = reconcilePaEntryLedger({ executionRows, brokerOrders });
    }
    const riskBrokerOrders = buildPaRiskOrderView({
      brokerOrders,
      executionRows,
    });
    await writeEntryStatus({
      phase: reconciliation.entry_allowed ? 'broker_reconciled' : 'entry_fail_closed',
      mode: 'execute_simulate',
      entry_allowed: reconciliation.entry_allowed,
      blocked_reasons: reconciliation.blocked_reasons,
      unresolved_submissions: reconciliation.unresolved.map((item) => ({
        execution_key: item.execution_key,
        reason: item.reason,
        match_count: item.match_count ?? null,
        remark: item.plan?.order?.remark || null,
        code: item.plan?.order?.code || null,
        qty: numeric(item.plan?.order?.qty),
      })),
      orphan_broker_orders: reconciliation.orphan_broker_orders.map(brokerOrderStatusSummary),
      broker_order_count: brokerOrders.length,
      local_pending_reservation_count: riskBrokerOrders.filter((order) => order._pa_local_reservation).length,
      order_snapshot: orderSnapshot,
    });
    return {
      ...reconciliation,
      degraded: false,
      broker_orders: riskBrokerOrders,
      order_snapshot: orderSnapshot,
    };
  } catch (error) {
    const degraded = degradedEntryRecovery(null, 'entry_reconciliation_transient_error', error.message);
    await writeEntryStatus({
      phase: 'broker_orders_degraded',
      mode: 'execute_simulate',
      entry_allowed: false,
      blocked_reasons: degraded.blocked_reasons,
      error: error.message,
    });
    return degraded;
  }
}

function signalSummary(intent, signal) {
  return {
    source_signal_key: intent.source_signal_key || signal?.signal_key || '',
    message_id: intent.message_id || signal?.message_id || '',
    channel_id: intent.channel_id || signal?.channel_id || '',
    observed_via: intent.observed_via || signal?.observed_via || '',
    message_timestamp: intent.message_timestamp || signal?.message_timestamp || '',
    received_at: signal?.captured_at || intent.created_at || '',
    intent_created_at: intent.created_at || '',
    ticker: intent.ticker || signal?.ticker || '',
    expiration: intent.expiration || signal?.expiration || '',
    strike: numeric(intent.strike ?? signal?.strike),
    option_type: intent.option_type || signal?.option_type || '',
    direction: intent.direction || signal?.direction || '',
    stock_entry: numeric(intent.stock_entry ?? signal?.entry_stock_price),
    stock_target: numeric(intent.stock_target ?? signal?.target_stock_price),
    stock_stop: numeric(intent.stock_stop ?? signal?.stop_stock_price),
    win_rate_pct: numeric(signal?.win_rate_pct ?? intent.win_rate_pct),
    confidence: numeric(signal?.confidence ?? intent.confidence),
    risk_score: numeric(signal?.risk_score ?? intent.risk_score),
    advice_format: signal?.advice_format || '',
    source_type: signal?.source_type || '',
    flow_aggressor_side: signal?.flow_aggressor_side || null,
    flow_execution_type: signal?.flow_execution_type || null,
    flow_contract_count: numeric(signal?.flow_contract_count),
    flow_avg_option_price: numeric(signal?.flow_avg_option_price),
    title: signal?.title || '',
  };
}

async function appendJsonLine(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  const handle = await fsp.open(filePath, 'a');
  try {
    await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeLatestPlan(payload) {
  await ensureDir(path.dirname(latestPlanPath));
  await fsp.writeFile(latestPlanPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function journalEventTypeForPlan(plan) {
  if (plan.order_status === 'submitted') return 'buy_order_submitted';
  if (plan.order_status === 'submit_failed') return 'buy_order_submit_failed';
  if (plan.order_status === 'dry_run_planned') return 'trade_candidate_planned';
  if (plan.gate?.passed === false) return 'trade_candidate_rejected';
  return 'trade_candidate_evaluated';
}

async function recordPlan(plan, config) {
  await appendJsonLine(plansPath, plan);
  await writeLatestPlan(plan);
  await appendTradeJournalEvent(
    journalEventTypeForPlan(plan),
    buildPlanJournalPayload(plan, config),
  );
}

function pctToken(value) {
  const parsed = numeric(value);
  if (parsed === null) return 'unknown';
  return String(parsed).replace('.', 'p');
}

function stockLineContext(summary, underlyingEntryPrice, config) {
  const direction = String(summary.direction || '').toLowerCase();
  const signalEntry = numeric(summary.stock_entry);
  const signalTarget = numeric(summary.stock_target);
  const signalStop = numeric(summary.stock_stop);
  const current = numeric(underlyingEntryPrice);
  const staleReasons = [];
  const optionStopPct = config?.optionExitStopLossPct ?? config?.optionStopLossPct ?? 20;
  const optionTakePct = config?.optionExitTakeProfitPct ?? config?.optionTakeProfitPct ?? 50;
  const optionExitLabel = `option_${pctToken(optionStopPct)}_${pctToken(optionTakePct)}`;

  if (!['bull', 'bear'].includes(direction)) staleReasons.push('unsupported_direction');
  if (signalEntry === null || signalTarget === null || signalStop === null) staleReasons.push('missing_signal_stock_lines');
  if (current === null) staleReasons.push('missing_current_underlying_price');

  if (staleReasons.length === 0 && direction === 'bull') {
    if (!(signalStop < signalEntry && signalEntry < signalTarget)) staleReasons.push('invalid_bull_stock_line_order');
    if (current <= signalStop || current >= signalTarget) staleReasons.push('current_outside_signal_stock_range');
  } else if (staleReasons.length === 0 && direction === 'bear') {
    if (!(signalTarget < signalEntry && signalEntry < signalStop)) staleReasons.push('invalid_bear_stock_line_order');
    if (current <= signalTarget || current >= signalStop) staleReasons.push('current_outside_signal_stock_range');
  }

  return {
    status: staleReasons.length === 0 ? 'active' : 'stale',
    use_signal_stock_lines: staleReasons.length === 0,
    stale_reasons: staleReasons,
    direction,
    current_underlying_price: current,
    signal_stock_entry: signalEntry,
    signal_stock_target: signalTarget,
    signal_stock_stop: signalStop,
    stale_behavior: staleReasons.length === 0 ? `use_signal_stock_lines_plus_${optionExitLabel}` : `ignore_signal_stock_lines_use_${optionExitLabel}_and_close_exit`,
  };
}

async function processIntent(intent, signalMaps, config, mode, connectionHolder, entryBlockReasons = [], entryRecoveryControls = {}) {
  const signal = resolveSignal(intent, signalMaps);
  const gate = evaluateGate(intent, signal, config);
  const summary = signalSummary(intent, signal);
  const executionKey = signalExecutionKey(intent);
  if (hasRecordedExecution(executionKey)) {
    gate.passed = false;
    gate.reasons.push('duplicate_or_unknown_prior_submission');
  }
  if (mode === 'execute_simulate' && entryBlockReasons.length > 0) {
    gate.passed = false;
    gate.reasons.push(...entryBlockReasons.map((reason) => `entry_recovery_blocked:${reason}`));
  }
  const plan = {
    planned_at: new Date().toISOString(),
    business_line: businessLine.key,
    policy_path: config.policyPath || null,
    mode,
    order_status: gate.passed ? 'gate_passed' : 'gate_failed',
    gate,
    signal: summary,
    contract: null,
    quote: null,
    order: null,
    execution: null,
    execution_key: executionKey,
  };

  if (!gate.passed) {
    await recordPlan(plan, config);
    return plan;
  }

  if (!connectionHolder.connection) {
    connectionHolder.connection = await connectMoomoo(config);
  }
  const client = connectionHolder.connection.client;
  if (mode === 'execute_simulate') {
    plan.simulated_account = await ensureSimulatedOptionAccount(client, config, connectionHolder);
  } else if (mode === 'execute_real') {
    plan.real_account = await ensureRealTradingAccount(client, config, connectionHolder);
  }
  if (!connectionHolder.quoteFeed) {
    connectionHolder.quoteFeed = createMoomooQuoteFeed(client, config);
  }

  const resolved = await findOptionContract(client, summary);
  if (!resolved.found) {
    plan.order_status = 'contract_not_found';
    plan.gate.passed = false;
    plan.gate.reasons.push(`moomoo_contract_not_found:candidates=${resolved.candidateCount}`);
    plan.contract = { found: false, candidate_count: resolved.candidateCount };
    await recordPlan(plan, config);
    return plan;
  }

  const contract = resolved.contract;
  const underlyingSecurity = {
    market: QOT_MARKET_US_SECURITY,
    code: moomooUnderlyingCode(summary.ticker),
  };
  const quoteResult = await connectionHolder.quoteFeed.getSnapshots([contract.security], {
    orderBookSecurities: [contract.security],
  });
  let underlyingQuoteResult = null;
  let underlyingQuoteError = null;
  if (underlyingSecurity.code && underlyingSecurity.code !== '.SPX') {
    try {
      underlyingQuoteResult = await connectionHolder.quoteFeed.getSnapshots([underlyingSecurity], {
        orderBookSecurities: [],
      });
    } catch (error) {
      underlyingQuoteError = error.message;
    }
  }
  const snapshots = quoteResult.snapshots || [];
  const snapshot = snapshots.find((item) => item?.basic?.security?.code === contract.security.code) || snapshots[0] || null;
  const underlyingSnapshots = underlyingQuoteResult?.snapshots || [];
  const underlyingSnapshot = underlyingSnapshots.find((item) => item?.basic?.security?.code === underlyingSecurity.code) || null;
  const optionExecutionQuote = buildOptionExecutionQuote(snapshot, config);
  const limitPrice = optionExecutionQuote.buy_limit_price;
  const underlyingEntryPrice = numeric(underlyingSnapshot?.basic?.curPrice);
  const signalStopPrice = numeric(summary.stock_stop);
  if (signalStopPrice === null) {
    plan.order_status = 'gate_failed';
    plan.gate.passed = false;
    plan.gate.reasons.push('missing_stock_stop');
  } else if (underlyingEntryPrice === null) {
    plan.order_status = 'underlying_quote_required';
    plan.gate.passed = false;
    plan.gate.reasons.push('missing_current_underlying_price_for_stop_gate');
  } else if (String(summary.direction || '').toLowerCase() === 'bull' && underlyingEntryPrice < signalStopPrice) {
    plan.order_status = 'underlying_stop_gate_rejected';
    plan.gate.passed = false;
    plan.gate.reasons.push(`current_underlying_price_below_signal_stop:${underlyingEntryPrice}<${signalStopPrice}`);
  } else if (String(summary.direction || '').toLowerCase() === 'bear' && underlyingEntryPrice > signalStopPrice) {
    plan.order_status = 'underlying_stop_gate_rejected';
    plan.gate.passed = false;
    plan.gate.reasons.push(`current_underlying_price_above_signal_stop:${underlyingEntryPrice}>${signalStopPrice}`);
  }
  if (limitPrice === null) {
    plan.order_status = 'quote_not_tradeable';
    plan.gate.passed = false;
    plan.gate.reasons.push('missing_option_ask_or_current_price');
  }
  if (!optionExecutionQuote.tradeable) {
    plan.order_status = 'quote_quality_rejected';
    plan.gate.passed = false;
    plan.gate.reasons.push(...optionExecutionQuote.reasons.map((reason) => `option_quote_quality:${reason}`));
  }

  const contractMultiplier = numeric(snapshot?.optionExData?.contractMultiplier)
    || numeric(snapshot?.optionExData?.contractSizeFloat)
    || numeric(snapshot?.optionExData?.contractSize)
    || numeric(contract.lotSize)
    || config.contractMultiplierDefault;
  const positionSizing = limitPrice === null
    ? { qty: 0, status: 'missing_option_price', reasons: ['missing_option_price'] }
    : applyVisibleAskLiquidityCap(calculatePositionSizing(limitPrice, contractMultiplier, config), optionExecutionQuote, config);
  if (positionSizing.qty < 1) {
    plan.order_status = positionSizing.status || 'position_sizing_failed';
    plan.gate.passed = false;
    plan.gate.reasons.push(...(positionSizing.reasons || ['position_sizing_failed']));
  }

  const qty = positionSizing.qty;
  const remark = buildPaEntryRemark(executionKey);
  const requestConfig = mode === 'dry_run'
    ? { ...config, trdEnv: TRD_ENV_SIMULATE, accId: '' }
    : config;
  const orderRequest = limitPrice === null ? null : buildLimitBuyOrderRequest(requestConfig, {
    code: contract.security.code,
    qty,
    price: limitPrice,
    remark,
  }, {
    allowMissingAccId: mode === 'dry_run',
  });

  plan.contract = {
    found: true,
    security: normalizeForJson(contract.security),
    name: contract.name,
    strike_time: contract.strikeTime,
    strike_price: contract.strikePrice,
    lot_size: contract.lotSize,
    owner: normalizeForJson(contract.owner || underlyingSecurity),
    candidate_count: resolved.candidateCount,
  };
  plan.quote = {
    snapshot_at: new Date().toISOString(),
    basic: normalizeForJson(snapshot?.basic || null),
    option_ex_data: normalizeForJson(snapshot?.optionExData || null),
    order_book: normalizeForJson(snapshot?.order_book || null),
    quote_source: snapshot?.quote_source || 'snapshot',
    quote_received_at: snapshot?.quote_received_at || null,
    feed_status: normalizeForJson(quoteResult.feed_status || null),
    subscription: normalizeForJson(quoteResult.subscription || null),
    selected_limit_buy_price: limitPrice,
    execution_quality: optionExecutionQuote,
  };
  plan.underlying_quote = {
    snapshot_at: new Date().toISOString(),
    security: underlyingSecurity,
    basic: normalizeForJson(underlyingSnapshot?.basic || null),
    quote_source: underlyingSnapshot?.quote_source || 'snapshot',
    quote_received_at: underlyingSnapshot?.quote_received_at || null,
    selected_entry_price: underlyingEntryPrice,
    optional: true,
    error: underlyingQuoteError,
  };
  plan.position_sizing = positionSizing;
  const stockContext = stockLineContext(summary, underlyingEntryPrice, config);
  const controlledOvernight = config.policy?.exit_rules?.controlled_overnight || null;
  plan.order = orderRequest ? {
    side: 'BUY_TO_OPEN',
    order_type: 'LIMIT',
    code: contract.security.code,
    qty,
    price: limitPrice,
    price_basis: optionExecutionQuote.buy_limit_basis,
    execution_quality: {
      bid: optionExecutionQuote.bid,
      ask: optionExecutionQuote.ask,
      mid: optionExecutionQuote.mid,
      quote_source: optionExecutionQuote.quote_source,
      quote_received_at: optionExecutionQuote.quote_received_at,
      bid_ask_source: optionExecutionQuote.bid_ask_source,
      bid_ask_received_at: optionExecutionQuote.bid_ask_received_at,
      spread_abs: optionExecutionQuote.spread_abs,
      spread_pct_of_mid: optionExecutionQuote.spread_pct_of_mid,
      slippage_buffer: optionExecutionQuote.slippage_buffer,
      buy_limit_price: optionExecutionQuote.buy_limit_price,
      sell_estimate_price: optionExecutionQuote.sell_estimate_price,
      immediate_round_trip_loss_pct: optionExecutionQuote.immediate_round_trip_loss_pct,
      ask_size_contracts: optionExecutionQuote.ask_size_contracts,
      bid_size_contracts: optionExecutionQuote.bid_size_contracts,
      day_volume_contracts: optionExecutionQuote.day_volume_contracts,
      open_interest: optionExecutionQuote.open_interest,
    },
    remark,
    request: redactOrderRequest(orderRequest),
    stock_lines: {
      entry: summary.stock_entry,
      target: summary.stock_target,
      stop: summary.stock_stop,
    },
    option_exit_rules: {
      price_basis: 'option_entry_fill_price',
      stop_loss_return_pct: config.optionExitStopLossPct ?? config.optionStopLossPct,
      take_profit_return_pct: config.optionExitTakeProfitPct ?? config.optionTakeProfitPct,
      exit_before_regular_session_close: true,
      close_exit_start_time_et: config.closeExitStartTimeEt,
      force_close_exit_start_time_et: config.forceCloseExitStartTimeEt,
      no_overnight_holding: true,
      controlled_overnight: controlledOvernight,
    },
    underlying_exit_rules: {
      price_basis: 'underlying_stock_price_at_option_entry',
      entry_price: underlyingEntryPrice,
      stop_loss_move_pct: config.underlyingStopLossPct,
      take_profit_move_pct: config.underlyingTakeProfitPct,
      option_price_exit_enabled: true,
      option_stop_loss_pct: config.optionExitStopLossPct,
      option_take_profit_pct: config.optionExitTakeProfitPct,
      use_signal_stock_lines: stockContext.use_signal_stock_lines,
      stock_line_context: stockContext,
      signal_stock_target: summary.stock_target,
      signal_stock_stop: summary.stock_stop,
      exit_before_regular_session_close: true,
      close_exit_start_time_et: config.closeExitStartTimeEt,
      force_close_exit_start_time_et: config.forceCloseExitStartTimeEt,
      no_overnight_holding: true,
      controlled_overnight: controlledOvernight,
    },
  } : null;

  if (plan.gate.passed === false) {
    await recordPlan(plan, config);
    return plan;
  }

  const requestedNotionalUsd = qty * limitPrice * contractMultiplier;
  let latestEntryRecovery = null;
  if (mode === 'execute_simulate' && entryRecoveryControls.refreshRecovery) {
    latestEntryRecovery = await entryRecoveryControls.refreshRecovery(true);
    plan.entry_recovery = {
      entry_allowed: latestEntryRecovery.entry_allowed,
      degraded: latestEntryRecovery.degraded === true,
      blocked_reasons: latestEntryRecovery.blocked_reasons || [],
      order_snapshot: latestEntryRecovery.order_snapshot || null,
    };
    if (!latestEntryRecovery.entry_allowed) {
      plan.order_status = 'entry_recovery_blocked';
      plan.gate.passed = false;
      plan.gate.reasons.push(...(latestEntryRecovery.blocked_reasons || ['entry_recovery_unavailable'])
        .map((reason) => `entry_recovery_blocked:${reason}`));
      await recordPlan(plan, config);
      return plan;
    }
  }
  const brokerRisk = mode === 'execute_simulate'
    ? await brokerEntryRiskGate(
      client,
      config,
      contract.security.code,
      requestedNotionalUsd,
      latestEntryRecovery?.broker_orders || entryRecoveryControls.getBrokerOrders?.(),
    )
    : { passed: true, reasons: [], dry_run_not_queried: true };
  plan.broker_risk = brokerRisk;
  if (!brokerRisk.passed) {
    plan.order_status = 'broker_risk_rejected';
    plan.gate.passed = false;
    plan.gate.reasons.push(...brokerRisk.reasons);
    await recordPlan(plan, config);
    return plan;
  }

  if (mode === 'dry_run') {
    plan.order_status = 'dry_run_planned';
  } else {
    const durableIntent = {
      ...plan,
      order_status: 'submission_intent',
      execution: { intent_persisted_at: new Date().toISOString() },
    };
    await appendJsonLine(executionsPath, durableIntent);
    let response = null;
    try {
      response = await placeLimitBuyOrder(client, config, {
        code: contract.security.code,
        qty,
        price: limitPrice,
        remark,
      });
      const normalizedResponse = normalizeForJson(response);
      if (!brokerOrderKey(normalizedResponse?.s2c || {})) {
        throw new Error('PlaceOrder returned success without orderID or orderIDEx; submission outcome is unknown.');
      }
      plan.order_status = 'submitted';
      plan.execution = {
        submitted_at: new Date().toISOString(),
        response: normalizedResponse,
      };
      await appendJsonLine(executionsPath, plan);
    } catch (error) {
      plan.order_status = 'submission_unknown';
      plan.execution = {
        submitted_at: new Date().toISOString(),
        error: error.message,
        response: response ? normalizeForJson(response) : null,
      };
      await appendJsonLine(executionsPath, plan);
    }
  }

  await recordPlan(plan, config);
  return plan;
}

async function processBatch(intents, signalMaps, config, mode, options = {}) {
  const connectionHolder = options.connectionHolder || { connection: null };
  const ownsConnection = !options.connectionHolder;
  const plans = [];
  try {
    for (const intent of intents) {
      const entryBlockReasons = options.getEntryBlockReasons?.() || [];
      const plan = await processIntent(intent, signalMaps, config, mode, connectionHolder, entryBlockReasons, {
        refreshRecovery: options.refreshRecovery,
        getBrokerOrders: options.getBrokerOrders,
      });
      plans.push(plan);
      if (mode === 'execute_simulate'
        && ['submitted', 'submission_unknown'].includes(String(plan.order_status || ''))
        && options.refreshRecovery) {
        await options.refreshRecovery(true);
      }
    }
  } finally {
    if (ownsConnection) {
      await connectionHolder.quoteFeed?.close?.();
      connectionHolder.connection?.close();
    }
  }
  return plans;
}

async function runOnce() {
  const config = loadMoomooConfig(moomooConfigOptionsForBusinessLine(businessLine, args));
  if (await paEntryIsDisabled(config)) return;
  const mode = getMode(config);
  assertPaSimulationInvariants(config, mode);
  const connectionHolder = { connection: null };
  let recovery = { blocked_reasons: [] };
  const refreshRecovery = async (urgent = false) => {
    recovery = await reconcileEntryBrokerState(config, connectionHolder, { urgent });
    return recovery;
  };
  try {
    if (mode === 'execute_simulate') await refreshRecovery(true);
    const signalMaps = buildSignalMaps(readNdjson(signalsPath));
    const selected = selectIntents(readNdjson(intentsPath));
    if (selected.length === 0) {
      console.log('No matching order intents found.');
      return;
    }
    const plans = await processBatch(selected, signalMaps, config, mode, {
      connectionHolder,
      getEntryBlockReasons: () => recovery.blocked_reasons || [],
      getBrokerOrders: () => recovery.broker_orders,
      refreshRecovery,
    });
    for (const plan of plans) {
      console.log(`${plan.order_status}: ${plan.signal.ticker} ${plan.signal.expiration} ${plan.signal.strike}${plan.signal.option_type} msg=${plan.signal.message_id}`);
      if (plan.gate.reasons.length) console.log(`  gate: ${plan.gate.reasons.join(', ')}`);
      if (plan.order) console.log(`  order: ${plan.order.side} ${plan.order.qty} ${plan.order.code} limit=${plan.order.price}`);
    }
    console.log(`Wrote: ${plansPath}`);
    console.log(`Latest: ${latestPlanPath}`);
  } finally {
    await connectionHolder.quoteFeed?.close?.();
    connectionHolder.connection?.close();
  }
}

async function readNewIntentLines(offset) {
  if (!fs.existsSync(intentsPath)) return { offset, rows: [] };
  const stat = fs.statSync(intentsPath);
  // Rotation/truncation must never replay historical order intents.
  if (stat.size < offset) return { offset: stat.size, rows: [], reset_to_eof: true };
  if (stat.size === offset) return { offset, rows: [] };
  const handle = await fsp.open(intentsPath, 'r');
  try {
    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const complete = completeNdjsonChunk(buffer.subarray(0, bytesRead));
    if (complete.consumed_bytes === 0) {
      return { offset, rows: [], partial_tail_bytes: complete.partial_tail_bytes };
    }
    const rows = complete.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => parseJsonLine(line, intentsPath, index + 1));
    return {
      offset: offset + complete.consumed_bytes,
      rows,
      partial_tail_bytes: complete.partial_tail_bytes,
    };
  } finally {
    await handle.close();
  }
}

async function writeCursor(offset) {
  const tmp = `${cursorPath}.${process.pid}.tmp`;
  await ensureDir(path.dirname(cursorPath));
  await fsp.writeFile(tmp, `${JSON.stringify({
    business_line: businessLine.key,
    offset,
    updated_at: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, cursorPath);
}

function initialWatchOffset() {
  const eof = fs.existsSync(intentsPath) ? fs.statSync(intentsPath).size : 0;
  if (!fs.existsSync(cursorPath)) return eof;
  try {
    const saved = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
    const offset = Number(saved.offset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset is not a non-negative safe integer');
    // Rotation/truncation is not corruption and must not replay an old file.
    return offset <= eof ? offset : eof;
  } catch (error) {
    throw new Error(`PA intent cursor is corrupt and execution is fail-closed: ${cursorPath}: ${error.message}`);
  }
}

async function runWatch() {
  const config = loadMoomooConfig(moomooConfigOptionsForBusinessLine(businessLine, args));
  if (await paEntryIsDisabled(config)) return;
  const mode = getMode(config);
  assertPaSimulationInvariants(config, mode);
  if (isTruthyFlag(args['from-start'])) throw new Error('--from-start is forbidden for the PA execution watcher.');
  let offset = initialWatchOffset();
  if (!fs.existsSync(cursorPath)) await writeCursor(offset);
  const processed = new Set();
  const connectionHolder = { connection: null };
  const reconcileIntervalMs = 30_000;
  let lastReconciledAt = 0;
  let recovery = { blocked_reasons: [] };
  const refreshRecovery = async (force = false) => {
    if (mode !== 'execute_simulate') return recovery;
    if (!force && Date.now() - lastReconciledAt < reconcileIntervalMs) return recovery;
    recovery = await reconcileEntryBrokerState(config, connectionHolder, { urgent: force });
    lastReconciledAt = Date.now();
    return recovery;
  };
  console.log(`Watching ${intentsPath}`);
  console.log(`Business line: ${businessLine.key}; mode=${mode}; from_start=${offset === 0}`);
  if (mode === 'execute_simulate') await refreshRecovery(true);
  while (true) {
    const previousOffset = offset;
    const result = await readNewIntentLines(offset);
    await refreshRecovery(result.rows.length > 0);
    if (result.rows.length > 0) {
      const signalMaps = buildSignalMaps(readNdjson(signalsPath));
      const rows = result.rows.filter((intent) => {
        const key = intent.source_signal_key || intent.message_id || JSON.stringify(intent);
        if (processed.has(key)) return false;
        processed.add(key);
        return true;
      });
      if (rows.length > 0) {
        const plans = await processBatch(rows, signalMaps, config, mode, {
          connectionHolder,
          getEntryBlockReasons: () => recovery.blocked_reasons || [],
          getBrokerOrders: () => recovery.broker_orders,
          refreshRecovery,
        });
        for (const plan of plans) {
          console.log(`[${plan.planned_at}] ${plan.order_status} ${plan.signal.ticker} ${plan.signal.expiration} ${plan.signal.strike}${plan.signal.option_type} msg=${plan.signal.message_id}`);
        }
      }
    }
    offset = result.offset;
    if (offset !== previousOffset || result.reset_to_eof) await writeCursor(offset);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

if (isTruthyFlag(args.watch)) {
  await runWatch();
} else {
  await runOnce();
}
