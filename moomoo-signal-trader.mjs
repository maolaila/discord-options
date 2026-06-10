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
  findOptionContract,
  loadMoomooConfig,
  maskId,
  moomooUnderlyingCode,
  normalizeForJson,
  parseCliArgs,
  placeLimitBuyOrder,
  selectConfiguredUsRealAccount,
  selectSimulatedUsOptionAccount,
} from './moomoo-opend.mjs';
import {
  appendTradeJournalEvent,
  buildPlanJournalPayload,
} from './trade-journal.mjs';

const args = parseCliArgs();
const logsDir = path.join(PROJECT_ROOT, 'logs');
const signalsPath = path.join(logsDir, 'option-signals.ndjson');
const intentsPath = path.join(logsDir, 'order-intents.ndjson');
const plansPath = path.join(logsDir, 'moomoo-order-plans.ndjson');
const latestPlanPath = path.join(logsDir, 'moomoo-order-plans-latest.json');
const executionsPath = path.join(logsDir, 'moomoo-executions.ndjson');

function parseJsonLine(line, sourcePath, lineNumber) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`${sourcePath}:${lineNumber} is not valid JSON: ${error.message}`);
  }
}

function readNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parseJsonLine(line, filePath, index + 1));
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

function evaluateGate(intent, signal, config) {
  const reasons = [];
  const flowSignal = isFlowSignal(signal);
  if (!signal) reasons.push('missing_matching_option_signal');
  if (intent.status !== 'paper_intent_only') reasons.push(`unsupported_intent_status:${intent.status || ''}`);
  if (intent.action !== 'BUY_TO_OPEN') reasons.push(`unsupported_intent_action:${intent.action || ''}`);
  if (intent.instrument_type !== 'option') reasons.push(`unsupported_instrument_type:${intent.instrument_type || ''}`);

  const action = signal?.action || (intent.action === 'BUY_TO_OPEN' ? 'trade' : '');
  if (action !== 'trade') reasons.push(`signal_action_not_trade:${action || ''}`);
  if (signal && !flowSignal && !formatMatches(signal, config)) reasons.push(`advice_format_not_allowed:${signal.advice_format || 'missing'}`);
  if (signal && signal.signal_actionable !== true) reasons.push('signal_not_actionable');
  if (signal && !flowSignal && signal.full_plan_ready !== true) reasons.push('signal_missing_full_stock_plan');
  if (!flowSignal && !hasStockPlan(intent, signal)) reasons.push('missing_stock_entry_target_stop');
  if (!directionMatchesContract(intent, signal)) reasons.push('direction_option_type_mismatch');

  const winRate = numeric(signal?.win_rate_pct ?? intent.win_rate_pct);
  if (!flowSignal && (winRate === null || winRate < config.minWinRate)) reasons.push(`win_rate_below_gate:${winRate ?? 'missing'}`);

  const confidence = numeric(signal?.confidence ?? intent.confidence);
  if (!flowSignal && (confidence === null || confidence < config.minConfidence)) reasons.push(`confidence_below_gate:${confidence ?? 'missing'}`);

  const risk = numeric(signal?.risk_score ?? intent.risk_score);
  if (!flowSignal && risk === null) reasons.push('missing_risk_score');
  if (!flowSignal && risk !== null && risk > config.maxRiskScore) reasons.push(`risk_score_above_gate:${risk}`);

  if (!intent.ticker || !intent.expiration || !intent.strike || !intent.option_type) reasons.push('missing_option_contract_fields');

  return {
    passed: reasons.length === 0,
    reasons,
    values: {
      gate_profile: flowSignal ? 'nightwatch_flow' : 'pa_full_plan',
      win_rate_pct: winRate,
      confidence,
      risk_score: risk,
      required_advice_format: config.requiredAdviceFormat || null,
      min_win_rate: config.minWinRate,
      min_confidence: config.minConfidence,
      max_risk_score: config.maxRiskScore,
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
    if (!config.allowRealTrading) {
      throw new Error('Real trading is blocked. Set MOOMOO_ALLOW_REAL_TRADING=true and pass --execute-real only after confirming the account and risk controls.');
    }
    if (String(process.env.MOOMOO_REAL_TRADING_CONFIRM || '') !== 'I_UNDERSTAND') {
      throw new Error('Real trading is blocked. Set MOOMOO_REAL_TRADING_CONFIRM=I_UNDERSTAND to remove the last real-trading guard.');
    }
    config.trdEnv = TRD_ENV_REAL;
    return 'execute_real';
  }
  if (isTruthyFlag(args['execute-simulate'])) {
    config.trdEnv = TRD_ENV_SIMULATE;
    return 'execute_simulate';
  }
  return 'dry_run';
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
  await fsp.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
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

async function processIntent(intent, signalMaps, config, mode, connectionHolder) {
  const signal = resolveSignal(intent, signalMaps);
  const gate = evaluateGate(intent, signal, config);
  const summary = signalSummary(intent, signal);
  const plan = {
    planned_at: new Date().toISOString(),
    mode,
    order_status: gate.passed ? 'gate_passed' : 'gate_failed',
    gate,
    signal: summary,
    contract: null,
    quote: null,
    order: null,
    execution: null,
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
  const remark = `discord:${String(summary.message_id || '').slice(-12)}`;
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
      stop_loss_return_pct: config.optionStopLossPct,
      take_profit_return_pct: config.optionTakeProfitPct,
      exit_before_regular_session_close: true,
      no_overnight_holding: true,
    },
    underlying_exit_rules: {
      price_basis: 'stock_lines_reference_only',
      entry_price: underlyingEntryPrice,
      signal_stock_target: summary.stock_target,
      signal_stock_stop: summary.stock_stop,
    },
  } : null;

  if (plan.gate.passed === false) {
    await recordPlan(plan, config);
    return plan;
  }

  if (mode === 'dry_run') {
    plan.order_status = 'dry_run_planned';
  } else {
    try {
      const response = await placeLimitBuyOrder(client, config, {
        code: contract.security.code,
        qty,
        price: limitPrice,
        remark,
      });
      plan.order_status = 'submitted';
      plan.execution = {
        submitted_at: new Date().toISOString(),
        response: normalizeForJson(response),
      };
      await appendJsonLine(executionsPath, plan);
    } catch (error) {
      plan.order_status = 'submit_failed';
      plan.execution = {
        submitted_at: new Date().toISOString(),
        error: error.message,
      };
    }
  }

  await recordPlan(plan, config);
  return plan;
}

async function processBatch(intents, signalMaps, config, mode) {
  const connectionHolder = { connection: null };
  const plans = [];
  try {
    for (const intent of intents) {
      plans.push(await processIntent(intent, signalMaps, config, mode, connectionHolder));
    }
  } finally {
    await connectionHolder.quoteFeed?.close?.();
    connectionHolder.connection?.close();
  }
  return plans;
}

async function runOnce() {
  const config = loadMoomooConfig({ envFile: args.env });
  const mode = getMode(config);
  const signalMaps = buildSignalMaps(readNdjson(signalsPath));
  const selected = selectIntents(readNdjson(intentsPath));
  if (selected.length === 0) {
    console.log('No matching order intents found.');
    return;
  }
  const plans = await processBatch(selected, signalMaps, config, mode);
  for (const plan of plans) {
    console.log(`${plan.order_status}: ${plan.signal.ticker} ${plan.signal.expiration} ${plan.signal.strike}${plan.signal.option_type} msg=${plan.signal.message_id}`);
    if (plan.gate.reasons.length) console.log(`  gate: ${plan.gate.reasons.join(', ')}`);
    if (plan.order) console.log(`  order: ${plan.order.side} ${plan.order.qty} ${plan.order.code} limit=${plan.order.price}`);
  }
  console.log(`Wrote: ${plansPath}`);
  console.log(`Latest: ${latestPlanPath}`);
}

async function readNewIntentLines(offset) {
  if (!fs.existsSync(intentsPath)) return { offset, rows: [] };
  const stat = fs.statSync(intentsPath);
  if (stat.size < offset) offset = 0;
  if (stat.size === offset) return { offset, rows: [] };
  const handle = await fsp.open(intentsPath, 'r');
  try {
    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const text = buffer.toString('utf8');
    const rows = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => parseJsonLine(line, intentsPath, index + 1));
    return { offset: stat.size, rows };
  } finally {
    await handle.close();
  }
}

async function runWatch() {
  const config = loadMoomooConfig({ envFile: args.env });
  const mode = getMode(config);
  let offset = fs.existsSync(intentsPath) && !isTruthyFlag(args['from-start']) ? fs.statSync(intentsPath).size : 0;
  const processed = new Set();
  console.log(`Watching ${intentsPath}`);
  console.log(`Mode: ${mode}; from_start=${offset === 0}`);
  while (true) {
    const result = await readNewIntentLines(offset);
    offset = result.offset;
    if (result.rows.length > 0) {
      const signalMaps = buildSignalMaps(readNdjson(signalsPath));
      const rows = result.rows.filter((intent) => {
        const key = intent.source_signal_key || intent.message_id || JSON.stringify(intent);
        if (processed.has(key)) return false;
        processed.add(key);
        return true;
      });
      if (rows.length > 0) {
        const plans = await processBatch(rows, signalMaps, config, mode);
        for (const plan of plans) {
          console.log(`[${plan.planned_at}] ${plan.order_status} ${plan.signal.ticker} ${plan.signal.expiration} ${plan.signal.strike}${plan.signal.option_type} msg=${plan.signal.message_id}`);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

if (isTruthyFlag(args.watch)) {
  await runWatch();
} else {
  await runOnce();
}
