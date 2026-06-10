import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import WebSocketModule from 'ws';
import MoomooWebsocket from 'moomoo-api';

export const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const RET_SUCCEED = 0;
export const QOT_MARKET_US_SECURITY = 11;
export const OPTION_TYPE_CALL = 1;
export const OPTION_TYPE_PUT = 2;
export const TRD_ENV_SIMULATE = 0;
export const TRD_ENV_REAL = 1;
export const TRD_MARKET_US = 2;
export const TRD_SEC_MARKET_US = 2;
export const TRD_SIDE_BUY = 1;
export const TRD_SIDE_SELL = 2;
export const ORDER_TYPE_LIMIT = 1;
export const TIME_IN_FORCE_DAY = 0;
export const SESSION_RTH = 1;
export const QOT_SUBTYPE_BASIC = 1;
export const QOT_SUBTYPE_ORDER_BOOK = 2;
const CMD_QOT_UPDATE_BASIC_QOT = 3005;
const CMD_QOT_UPDATE_ORDER_BOOK = 3013;
export const DEFAULT_POLICY_PATH = path.join(PROJECT_ROOT, 'sim-trading-policy.json');

let tradeSerialNo = 1;

const originalConsoleDebug = console.debug;
console.debug = (...args) => {
  const first = String(args[0] || '');
  if (first === '登录成功' || first === '断开连接') return;
  originalConsoleDebug(...args);
};

const trdEnvMap = {
  simulate: TRD_ENV_SIMULATE,
  sim: TRD_ENV_SIMULATE,
  paper: TRD_ENV_SIMULATE,
  real: TRD_ENV_REAL,
  live: TRD_ENV_REAL,
};

const trdMarketMap = {
  US: TRD_MARKET_US,
};

function boolValue(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function intValue(value, name, defaultValue = undefined) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer.`);
  return parsed;
}

function numberValue(value, name, defaultValue = undefined) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`);
  return parsed;
}

function mappedInt(value, map, name, defaultValue = undefined) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const raw = String(value).trim();
  const numeric = Number(raw);
  if (Number.isInteger(numeric)) return numeric;
  const mapped = map[raw] ?? map[raw.toUpperCase()] ?? map[raw.toLowerCase()];
  if (mapped === undefined) throw new Error(`${name} must be one of ${Object.keys(map).join(', ')} or an integer.`);
  return mapped;
}

function resolveMaybeRelative(filePath, baseDir) {
  if (!filePath) return '';
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir || PROJECT_ROOT, filePath);
}

function readPolicy() {
  try {
    return JSON.parse(fs.readFileSync(DEFAULT_POLICY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export function loadEnvFile(envFile) {
  const candidate = envFile ? path.resolve(envFile) : path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(candidate)) {
    return {
      envFile: fs.existsSync(path.join(PROJECT_ROOT, '.env')) ? path.join(PROJECT_ROOT, '.env') : '',
      envBaseDir: PROJECT_ROOT,
      loaded: false,
    };
  }
  loadDotenv({ path: candidate, override: false, quiet: true });
  return {
    envFile: candidate,
    envBaseDir: path.dirname(candidate),
    loaded: true,
  };
}

function readOpenDWebSocketKey(envBaseDir) {
  const direct = String(process.env.MOOMOO_OPEND_WS_KEY || '').trim();
  if (direct) return direct;

  const keyFile = String(process.env.MOOMOO_OPEND_WS_KEY_FILE || '').trim();
  if (!keyFile) return undefined;
  const resolved = resolveMaybeRelative(keyFile, envBaseDir);
  if (!fs.existsSync(resolved)) return undefined;
  return fs.readFileSync(resolved, 'utf8').trim() || undefined;
}

export function loadMoomooConfig(opts = {}) {
  const envInfo = loadEnvFile(opts.envFile);
  const policy = readPolicy();
  const signalFilter = policy.signal_filter || {};
  const sizing = policy.position_sizing || {};
  const executionQuality = policy.execution_quality || {};
  const exits = policy.exit_rules || {};
  return {
    envFile: envInfo.envFile,
    envLoaded: envInfo.loaded,
    host: String(opts.host || process.env.MOOMOO_OPEND_HOST || '127.0.0.1'),
    websocketPort: intValue(opts.websocketPort || process.env.MOOMOO_OPEND_WS_PORT || process.env.MOOMOO_OPEND_PORT || 33333, 'MOOMOO_OPEND_WS_PORT'),
    websocketSsl: boolValue(opts.websocketSsl ?? process.env.MOOMOO_OPEND_WS_SSL, false),
    websocketKey: String(opts.websocketKey || readOpenDWebSocketKey(envInfo.envBaseDir) || '').trim() || undefined,
    accId: String(opts.accId || process.env.MOOMOO_ACC_ID || '').trim() || undefined,
    trdEnv: mappedInt(opts.trdEnv || process.env.MOOMOO_TRD_ENV || 'simulate', trdEnvMap, 'MOOMOO_TRD_ENV', TRD_ENV_SIMULATE),
    trdMarket: mappedInt(opts.trdMarket || process.env.MOOMOO_TRD_MARKET || 'US', trdMarketMap, 'MOOMOO_TRD_MARKET', TRD_MARKET_US),
    jpAccType: intValue(opts.jpAccType || process.env.MOOMOO_JP_ACC_TYPE, 'MOOMOO_JP_ACC_TYPE'),
    requiredAdviceFormat: String(opts.requiredAdviceFormat || process.env.MOOMOO_REQUIRED_ADVICE_FORMAT || signalFilter.advice_format || 'pa').trim().toLowerCase(),
    minWinRate: numberValue(opts.minWinRate || process.env.MOOMOO_MIN_WIN_RATE, 'MOOMOO_MIN_WIN_RATE', signalFilter.min_win_rate_pct ?? 80),
    minConfidence: numberValue(opts.minConfidence || process.env.MOOMOO_MIN_CONFIDENCE, 'MOOMOO_MIN_CONFIDENCE', signalFilter.min_confidence ?? 5),
    maxRiskScore: numberValue(opts.maxRiskScore || process.env.MOOMOO_MAX_RISK_SCORE, 'MOOMOO_MAX_RISK_SCORE', signalFilter.max_risk_score ?? 2),
    optionQty: intValue(opts.optionQty || process.env.MOOMOO_OPTION_QTY, 'MOOMOO_OPTION_QTY'),
    maxOptionQty: intValue(opts.maxOptionQty || process.env.MOOMOO_MAX_OPTION_QTY, 'MOOMOO_MAX_OPTION_QTY'),
    paperEquityUsd: numberValue(opts.paperEquityUsd || process.env.MOOMOO_PAPER_EQUITY_USD, 'MOOMOO_PAPER_EQUITY_USD', sizing.paper_equity_usd ?? 10000),
    targetPositionPct: numberValue(opts.targetPositionPct || process.env.MOOMOO_POSITION_TARGET_PCT, 'MOOMOO_POSITION_TARGET_PCT', sizing.target_position_pct ?? 25),
    minPositionPct: numberValue(opts.minPositionPct || process.env.MOOMOO_POSITION_MIN_PCT, 'MOOMOO_POSITION_MIN_PCT', sizing.min_position_pct ?? 20),
    maxPositionPct: numberValue(opts.maxPositionPct || process.env.MOOMOO_POSITION_MAX_PCT, 'MOOMOO_POSITION_MAX_PCT', sizing.max_position_pct ?? 30),
    contractMultiplierDefault: numberValue(opts.contractMultiplierDefault || process.env.MOOMOO_CONTRACT_MULTIPLIER_DEFAULT, 'MOOMOO_CONTRACT_MULTIPLIER_DEFAULT', sizing.contract_multiplier_default ?? 100),
    optionRequireBidAsk: boolValue(opts.optionRequireBidAsk ?? process.env.MOOMOO_OPTION_REQUIRE_BID_ASK, executionQuality.require_bid_ask ?? true),
    optionMinBidPrice: numberValue(opts.optionMinBidPrice || process.env.MOOMOO_OPTION_MIN_BID_PRICE, 'MOOMOO_OPTION_MIN_BID_PRICE', executionQuality.min_bid_price ?? 0.01),
    optionMaxSpreadPctOfMid: numberValue(opts.optionMaxSpreadPctOfMid || process.env.MOOMOO_OPTION_MAX_SPREAD_PCT_OF_MID, 'MOOMOO_OPTION_MAX_SPREAD_PCT_OF_MID', executionQuality.max_spread_pct_of_mid ?? 25),
    optionMaxSpreadAbs: numberValue(opts.optionMaxSpreadAbs || process.env.MOOMOO_OPTION_MAX_SPREAD_ABS, 'MOOMOO_OPTION_MAX_SPREAD_ABS', executionQuality.max_spread_abs ?? 1),
    optionMaxRoundTripLossPct: numberValue(opts.optionMaxRoundTripLossPct || process.env.MOOMOO_OPTION_MAX_ROUND_TRIP_LOSS_PCT, 'MOOMOO_OPTION_MAX_ROUND_TRIP_LOSS_PCT', executionQuality.max_round_trip_loss_pct ?? 40),
    optionSlippageTicks: numberValue(opts.optionSlippageTicks || process.env.MOOMOO_OPTION_SLIPPAGE_TICKS, 'MOOMOO_OPTION_SLIPPAGE_TICKS', executionQuality.slippage_ticks ?? 1),
    optionSlippagePctOfSpread: numberValue(opts.optionSlippagePctOfSpread || process.env.MOOMOO_OPTION_SLIPPAGE_PCT_OF_SPREAD, 'MOOMOO_OPTION_SLIPPAGE_PCT_OF_SPREAD', executionQuality.slippage_pct_of_spread ?? 10),
    optionCapQtyByVisibleAsk: boolValue(opts.optionCapQtyByVisibleAsk ?? process.env.MOOMOO_OPTION_CAP_QTY_BY_VISIBLE_ASK, executionQuality.cap_qty_by_visible_ask ?? true),
    optionMaxQtyToAskVolumeRatio: numberValue(opts.optionMaxQtyToAskVolumeRatio || process.env.MOOMOO_OPTION_MAX_QTY_TO_ASK_VOLUME_RATIO, 'MOOMOO_OPTION_MAX_QTY_TO_ASK_VOLUME_RATIO', executionQuality.max_qty_to_ask_volume_ratio ?? 10),
    optionMinOpenInterest: numberValue(opts.optionMinOpenInterest || process.env.MOOMOO_OPTION_MIN_OPEN_INTEREST, 'MOOMOO_OPTION_MIN_OPEN_INTEREST', executionQuality.min_open_interest ?? 50),
    optionMinDayVolume: numberValue(opts.optionMinDayVolume || process.env.MOOMOO_OPTION_MIN_DAY_VOLUME, 'MOOMOO_OPTION_MIN_DAY_VOLUME', executionQuality.min_option_day_volume ?? 1),
    quotePushWarmupMs: numberValue(opts.quotePushWarmupMs || process.env.MOOMOO_QUOTE_PUSH_WARMUP_MS, 'MOOMOO_QUOTE_PUSH_WARMUP_MS', 350),
    quoteFallbackSnapshotMaxAgeMs: numberValue(opts.quoteFallbackSnapshotMaxAgeMs || process.env.MOOMOO_QUOTE_FALLBACK_SNAPSHOT_MAX_AGE_MS, 'MOOMOO_QUOTE_FALLBACK_SNAPSHOT_MAX_AGE_MS', 2000),
    optionTakeProfitPct: numberValue(
      opts.optionTakeProfitPct || process.env.MOOMOO_OPTION_TAKE_PROFIT_PCT || process.env.MOOMOO_UNDERLYING_TAKE_PROFIT_PCT,
      'MOOMOO_OPTION_TAKE_PROFIT_PCT',
      exits.take_profit_option_return_pct ?? exits.take_profit_underlying_move_pct ?? 50,
    ),
    optionStopLossPct: numberValue(
      opts.optionStopLossPct || process.env.MOOMOO_OPTION_STOP_LOSS_PCT || process.env.MOOMOO_UNDERLYING_STOP_LOSS_PCT,
      'MOOMOO_OPTION_STOP_LOSS_PCT',
      exits.stop_loss_option_return_pct ?? exits.stop_loss_underlying_move_pct ?? 20,
    ),
    underlyingTakeProfitPct: numberValue(opts.underlyingTakeProfitPct || process.env.MOOMOO_UNDERLYING_TAKE_PROFIT_PCT, 'MOOMOO_UNDERLYING_TAKE_PROFIT_PCT', exits.take_profit_underlying_move_pct ?? 50),
    underlyingStopLossPct: numberValue(opts.underlyingStopLossPct || process.env.MOOMOO_UNDERLYING_STOP_LOSS_PCT, 'MOOMOO_UNDERLYING_STOP_LOSS_PCT', exits.stop_loss_underlying_move_pct ?? 20),
    allowRealTrading: boolValue(opts.allowRealTrading ?? process.env.MOOMOO_ALLOW_REAL_TRADING, false),
    policy,
  };
}

export function normalizeForJson(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => normalizeForJson(item));

  if (
    typeof value.low === 'number'
    && typeof value.high === 'number'
    && typeof value.unsigned === 'boolean'
    && typeof value.toString === 'function'
  ) {
    return value.toString();
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, normalizeForJson(item)]),
  );
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export function maskId(value) {
  const raw = String(value || '');
  if (raw === 'DRY_RUN_NO_ACCOUNT' || raw === 'MISSING_MOOMOO_ACC_ID') return raw;
  if (raw.length <= 4) return raw ? '***' : '';
  return `${'*'.repeat(Math.max(3, raw.length - 4))}${raw.slice(-4)}`;
}

export function assertMoomooSuccess(response, label) {
  if (!response || response.retType !== RET_SUCCEED) {
    const retType = response && response.retType !== undefined ? response.retType : 'unknown';
    const retMsg = response && response.retMsg ? response.retMsg : '';
    const errCode = response && response.errCode !== undefined ? response.errCode : '';
    throw new Error(`${label} failed: retType=${retType} errCode=${errCode} retMsg=${retMsg}`);
  }
}

export async function connectMoomoo(config) {
  if (typeof globalThis.WebSocket !== 'function') {
    globalThis.WebSocket = WebSocketModule.WebSocket || WebSocketModule.default || WebSocketModule;
  }

  const client = new MoomooWebsocket();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting to Moomoo OpenD WebSocket.')), 25000);
    client.onlogin = (ok, message) => {
      clearTimeout(timer);
      if (ok) {
        resolve();
      } else {
        reject(new Error(`Moomoo OpenD WebSocket login failed: ${JSON.stringify(normalizeForJson(message))}`));
      }
    };
    client.start(config.host, config.websocketPort, config.websocketSsl, config.websocketKey);
  });

  return {
    client,
    close: () => {
      try {
        client.stop?.();
        client.websock?.close?.();
      } catch {
        // Best-effort close only.
      }
    },
  };
}

export async function fetchMoomooAccounts(client) {
  const response = await client.GetAccList({
    c2s: {
      userID: 0,
      trdCategory: 1,
      needGeneralSecAccount: true,
    },
  });
  assertMoomooSuccess(response, 'GetAccList');
  return response;
}

export async function fetchGlobalState(client) {
  const response = await client.GetGlobalState({
    c2s: {
      userID: 0,
    },
  });
  assertMoomooSuccess(response, 'GetGlobalState');
  return response;
}

export function summarizeAccounts(response) {
  const accounts = response?.s2c?.accList || [];
  return accounts.map((account, index) => ({
    index: index + 1,
    accID: maskId(account.accID),
    rawAccID: String(account.accID || ''),
    trdEnv: account.trdEnv,
    accType: account.accType,
    cardNum: maskId(account.cardNum),
    securityFirm: account.securityFirm,
    trdMarketAuthList: account.trdMarketAuthList || [],
    simAccType: account.simAccType,
    jpAccType: account.jpAccType || [],
  }));
}

export function selectSimulatedUsOptionAccount(response) {
  const accounts = response?.s2c?.accList || [];
  return accounts.find((account) => {
    const markets = account.trdMarketAuthList || [];
    const simAccType = Number(account.simAccType ?? 0);
    return Number(account.trdEnv) === TRD_ENV_SIMULATE
      && markets.includes(TRD_MARKET_US)
      && (simAccType === 2 || simAccType === 4);
  }) || null;
}

export function selectConfiguredUsRealAccount(response, config) {
  const expected = String(config?.accId || '');
  if (!expected) return null;
  const accounts = response?.s2c?.accList || [];
  return accounts.find((account) => {
    const markets = account.trdMarketAuthList || [];
    return String(account.accID || '') === expected
      && Number(account.trdEnv) === TRD_ENV_REAL
      && markets.includes(TRD_MARKET_US);
  }) || null;
}

export function optionTypeCode(optionType) {
  const type = String(optionType || '').toUpperCase();
  if (type === 'C' || type === 'CALL') return OPTION_TYPE_CALL;
  if (type === 'P' || type === 'PUT') return OPTION_TYPE_PUT;
  throw new Error(`Unknown option type: ${optionType}`);
}

export function optionLegName(optionType) {
  return optionTypeCode(optionType) === OPTION_TYPE_CALL ? 'call' : 'put';
}

export function moomooUnderlyingCode(ticker) {
  const code = String(ticker || '').trim().toUpperCase();
  if (code === 'SPX') return '.SPX';
  return code;
}

export async function findOptionContract(client, signal) {
  const ticker = String(signal.ticker || '').trim().toUpperCase();
  const ownerCode = moomooUnderlyingCode(ticker);
  const expiration = String(signal.expiration || '').trim();
  const strike = Number(signal.strike);
  if (!ticker || !expiration || !Number.isFinite(strike)) {
    throw new Error('Signal is missing ticker, expiration, or strike.');
  }

  const legName = optionLegName(signal.option_type);
  const response = await client.GetOptionChain({
    c2s: {
      owner: {
        market: QOT_MARKET_US_SECURITY,
        code: ownerCode,
      },
      type: optionTypeCode(signal.option_type),
      beginTime: expiration,
      endTime: expiration,
    },
  });
  assertMoomooSuccess(response, 'GetOptionChain');

  const candidates = [];
  for (const chain of response?.s2c?.optionChain || []) {
    for (const item of chain.option || []) {
      const info = item[legName];
      if (!info?.basic?.security) continue;
      const optionExData = info.optionExData || {};
      candidates.push({
        security: info.basic.security,
        name: info.basic.name || '',
        lotSize: info.basic.lotSize,
        strikeTime: optionExData.strikeTime || chain.strikeTime || '',
        strikePrice: Number(optionExData.strikePrice),
        optionType: optionExData.type,
        owner: optionExData.owner,
        suspend: optionExData.suspend,
        raw: info,
      });
    }
  }

  const match = candidates.find((candidate) => (
    Math.abs(Number(candidate.strikePrice) - strike) < 0.0001
    && String(candidate.strikeTime || '').slice(0, 10) === expiration
  )) || null;

  return {
    found: Boolean(match),
    contract: match,
    candidateCount: candidates.length,
    response: normalizeForJson(response),
  };
}

export async function getSecuritySnapshots(client, securities) {
  const response = await client.GetSecuritySnapshot({
    c2s: {
      securityList: securities,
    },
  });
  assertMoomooSuccess(response, 'GetSecuritySnapshot');
  return response;
}

function securityKey(security) {
  if (!security) return '';
  return `${Number(security.market)}:${String(security.code || '').toUpperCase()}`;
}

function cloneSecurity(security) {
  return {
    market: Number(security.market),
    code: String(security.code || '').trim().toUpperCase(),
  };
}

function dedupeSecurities(securities) {
  const out = [];
  const seen = new Set();
  for (const security of securities || []) {
    const normalized = cloneSecurity(security || {});
    if (!Number.isFinite(normalized.market) || !normalized.code) continue;
    const key = securityKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function errorText(error) {
  if (error?.message) return error.message;
  try {
    return JSON.stringify(normalizeForJson(error));
  } catch {
    return String(error);
  }
}

function mergeBasicIntoSnapshot(snapshot, basic, receivedAt) {
  if (!basic?.security) return snapshot;
  const existing = snapshot || { basic: { security: cloneSecurity(basic.security) } };
  const normalizedBasic = normalizeForJson(basic);
  const mergedBasic = {
    ...(existing.basic || {}),
    ...normalizedBasic,
    security: cloneSecurity(normalizedBasic.security || existing.basic?.security || basic.security),
  };
  if (mergedBasic.isSuspend === undefined && mergedBasic.isSuspended !== undefined) {
    mergedBasic.isSuspend = mergedBasic.isSuspended;
  }
  const next = {
    ...existing,
    basic: mergedBasic,
    quote_source: 'push_basic',
    quote_received_at: receivedAt,
    bid_ask_source: existing.bid_ask_source || null,
    bid_ask_received_at: existing.bid_ask_received_at || null,
  };
  if (normalizedBasic.optionExData) {
    next.optionExData = {
      ...(existing.optionExData || {}),
      ...normalizeForJson(normalizedBasic.optionExData),
    };
  }
  return next;
}

function bestOrderBookLevel(levels) {
  const first = Array.isArray(levels) && levels.length > 0 ? levels[0] : null;
  if (!first) return null;
  const price = Number(first.price);
  const volume = Number(first.hpVolume ?? first.volume);
  return {
    price: Number.isFinite(price) ? price : null,
    volume: Number.isFinite(volume) ? volume : null,
    raw: normalizeForJson(first),
  };
}

function mergeOrderBookIntoSnapshot(snapshot, orderBook, receivedAt) {
  if (!orderBook?.security) return snapshot;
  const existing = snapshot || { basic: { security: cloneSecurity(orderBook.security) } };
  const bid = bestOrderBookLevel(orderBook.orderBookBidList);
  const ask = bestOrderBookLevel(orderBook.orderBookAskList);
  const basic = {
    ...(existing.basic || {}),
    security: cloneSecurity(existing.basic?.security || orderBook.security),
  };
  if (bid?.price !== null) basic.bidPrice = bid.price;
  if (ask?.price !== null) basic.askPrice = ask.price;
  if (bid?.volume !== null) {
    basic.bidVol = bid.volume;
    basic.hpBidVol = bid.volume;
  }
  if (ask?.volume !== null) {
    basic.askVol = ask.volume;
    basic.hpAskVol = ask.volume;
  }
  return {
    ...existing,
    basic,
    order_book: {
      security: cloneSecurity(orderBook.security),
      best_bid: bid,
      best_ask: ask,
      svrRecvTimeBid: orderBook.svrRecvTimeBid,
      svrRecvTimeBidTimestamp: orderBook.svrRecvTimeBidTimestamp,
      svrRecvTimeAsk: orderBook.svrRecvTimeAsk,
      svrRecvTimeAskTimestamp: orderBook.svrRecvTimeAskTimestamp,
      received_at: receivedAt,
    },
    quote_source: 'push_order_book',
    quote_received_at: receivedAt,
    bid_ask_source: 'push_order_book',
    bid_ask_received_at: receivedAt,
  };
}

export function createMoomooQuoteFeed(client, config = {}) {
  const snapshots = new Map();
  const subscribedByType = new Map();
  const errors = [];
  let pushCount = 0;
  const previousOnPush = client.onPush;

  function rememberSnapshot(snapshot, source = 'snapshot') {
    if (!snapshot?.basic?.security) return null;
    const key = securityKey(snapshot.basic.security);
    const normalized = normalizeForJson(snapshot);
    const now = new Date().toISOString();
    const existing = snapshots.get(key) || null;
    const mergedBasic = {
      ...(normalized.basic || {}),
    };
    if (existing?.bid_ask_source === 'push_order_book') {
      if (existing.basic?.bidPrice !== undefined) mergedBasic.bidPrice = existing.basic.bidPrice;
      if (existing.basic?.askPrice !== undefined) mergedBasic.askPrice = existing.basic.askPrice;
      if (existing.basic?.bidVol !== undefined) mergedBasic.bidVol = existing.basic.bidVol;
      if (existing.basic?.askVol !== undefined) mergedBasic.askVol = existing.basic.askVol;
      if (existing.basic?.hpBidVol !== undefined) mergedBasic.hpBidVol = existing.basic.hpBidVol;
      if (existing.basic?.hpAskVol !== undefined) mergedBasic.hpAskVol = existing.basic.hpAskVol;
    }
    snapshots.set(key, {
      ...normalized,
      basic: mergedBasic,
      order_book: existing?.order_book || normalized.order_book || null,
      quote_source: existing?.quote_source && String(existing.quote_source).startsWith('push_')
        ? existing.quote_source
        : (normalized.quote_source || source),
      quote_received_at: existing?.quote_received_at && String(existing.quote_source || '').startsWith('push_')
        ? existing.quote_received_at
        : (normalized.quote_received_at || now),
      bid_ask_source: existing?.bid_ask_source || normalized.bid_ask_source || 'snapshot',
      bid_ask_received_at: existing?.bid_ask_received_at || normalized.bid_ask_received_at || now,
      snapshot_received_at: now,
    });
    return snapshots.get(key);
  }

  client.onPush = (cmd, payload) => {
    const receivedAt = new Date().toISOString();
    pushCount += 1;
    try {
      if (cmd === CMD_QOT_UPDATE_BASIC_QOT) {
        for (const basic of payload?.s2c?.basicQotList || []) {
          const key = securityKey(basic.security);
          snapshots.set(key, mergeBasicIntoSnapshot(snapshots.get(key), basic, receivedAt));
        }
      } else if (cmd === CMD_QOT_UPDATE_ORDER_BOOK) {
        const orderBook = payload?.s2c;
        const key = securityKey(orderBook?.security);
        if (key) snapshots.set(key, mergeOrderBookIntoSnapshot(snapshots.get(key), orderBook, receivedAt));
      }
    } catch (error) {
      errors.push({ at: receivedAt, error: errorText(error), cmd });
    }
    if (previousOnPush && typeof previousOnPush === 'function') previousOnPush(cmd, payload);
  };

  async function subscribeByType(securities, subType) {
    const targets = dedupeSecurities(securities)
      .filter((security) => {
        const key = securityKey(security);
        const set = subscribedByType.get(key);
        return !set || !set.has(subType);
      });
    if (targets.length === 0) return { subscribed: 0, skipped: true };
    const response = await client.Sub({
      c2s: {
        securityList: targets,
        subTypeList: [subType],
        isSubOrUnSub: true,
        isRegOrUnRegPush: true,
        isFirstPush: true,
      },
    });
    assertMoomooSuccess(response, `Sub:${subType}`);
    for (const security of targets) {
      const key = securityKey(security);
      if (!subscribedByType.has(key)) subscribedByType.set(key, new Set());
      subscribedByType.get(key).add(subType);
    }
    return { subscribed: targets.length, response: normalizeForJson(response) };
  }

  async function ensureSubscribed(securities, opts = {}) {
    const all = dedupeSecurities(securities);
    const orderBookSecurities = dedupeSecurities(opts.orderBookSecurities || securities);
    const result = {
      basic: null,
      order_book: null,
      errors: [],
    };
    try {
      result.basic = await subscribeByType(all, QOT_SUBTYPE_BASIC);
    } catch (error) {
      result.errors.push({ type: 'basic', error: errorText(error) });
      errors.push({ at: new Date().toISOString(), type: 'basic', error: errorText(error) });
    }
    try {
      result.order_book = await subscribeByType(orderBookSecurities, QOT_SUBTYPE_ORDER_BOOK);
    } catch (error) {
      result.errors.push({ type: 'order_book', error: errorText(error) });
      errors.push({ at: new Date().toISOString(), type: 'order_book', error: errorText(error) });
    }
    return result;
  }

  async function primeSnapshots(securities) {
    const all = dedupeSecurities(securities);
    if (all.length === 0) return [];
    const response = await getSecuritySnapshots(client, all);
    const rows = response.s2c?.snapshotList || [];
    for (const snapshot of rows) rememberSnapshot(snapshot, 'snapshot');
    return rows.map((snapshot) => snapshots.get(securityKey(snapshot.basic?.security)) || normalizeForJson(snapshot));
  }

  function cachedSnapshots(securities) {
    return dedupeSecurities(securities).map((security) => snapshots.get(securityKey(security)) || null);
  }

  function staleOrMissingSecurities(securities, maxAgeMs) {
    const now = Date.now();
    return dedupeSecurities(securities).filter((security) => {
      const cached = snapshots.get(securityKey(security));
      if (!cached) return true;
      const snapshotMs = Date.parse(cached.snapshot_received_at || cached.quote_received_at || '');
      if (!Number.isFinite(snapshotMs)) return true;
      return now - snapshotMs > maxAgeMs;
    });
  }

  async function getSnapshots(securities, opts = {}) {
    const all = dedupeSecurities(securities);
    const subscribe = opts.subscribe !== false;
    const warmupMs = Math.max(0, Number(opts.warmupMs ?? config.quotePushWarmupMs ?? 350));
    const fallbackMaxAgeMs = Math.max(0, Number(opts.fallbackSnapshotMaxAgeMs ?? config.quoteFallbackSnapshotMaxAgeMs ?? 2000));
    let subscription = null;
    if (subscribe) {
      subscription = await ensureSubscribed(all, {
        orderBookSecurities: opts.orderBookSecurities || all,
      });
    }
    const needPrime = staleOrMissingSecurities(all, fallbackMaxAgeMs);
    if (needPrime.length > 0) await primeSnapshots(needPrime);
    if (warmupMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, warmupMs));
    }
    return {
      snapshots: cachedSnapshots(all),
      subscription,
      feed_status: status(),
    };
  }

  async function close() {
    const all = [...subscribedByType.keys()].map((key) => {
      const [market, code] = key.split(':');
      return { market: Number(market), code };
    });
    if (all.length > 0) {
      try {
        await client.Sub({
          c2s: {
            securityList: all,
            subTypeList: [QOT_SUBTYPE_BASIC, QOT_SUBTYPE_ORDER_BOOK],
            isSubOrUnSub: false,
            isRegOrUnRegPush: false,
          },
        });
      } catch {
        // Best-effort unsubscribe only.
      }
    }
    client.onPush = previousOnPush;
  }

  function status() {
    return {
      mode: 'push_plus_snapshot_fallback',
      subscribed_security_count: subscribedByType.size,
      push_count: pushCount,
      cached_snapshot_count: snapshots.size,
      recent_errors: errors.slice(-5),
    };
  }

  return {
    ensureSubscribed,
    getSnapshots,
    primeSnapshots,
    cachedSnapshots,
    status,
    close,
  };
}

export function getBestLimitBuyPrice(snapshot) {
  const basic = snapshot?.basic || {};
  const ask = Number(basic.askPrice);
  const cur = Number(basic.curPrice);
  const bid = Number(basic.bidPrice);
  const raw = Number.isFinite(ask) && ask > 0
    ? ask
    : (Number.isFinite(cur) && cur > 0 ? cur : bid);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Number(raw.toFixed(2));
}

function numericOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function decimalPlaces(value) {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot >= 0 ? Math.min(6, text.length - dot - 1) : 0;
}

function roundUpToTick(value, tick) {
  const normalizedTick = Number.isFinite(tick) && tick > 0 ? tick : 0.01;
  const decimals = Math.max(2, decimalPlaces(normalizedTick));
  return Number((Math.ceil((value / normalizedTick) - 1e-9) * normalizedTick).toFixed(decimals));
}

function roundDownToTick(value, tick) {
  const normalizedTick = Number.isFinite(tick) && tick > 0 ? tick : 0.01;
  const decimals = Math.max(2, decimalPlaces(normalizedTick));
  return Number((Math.floor((value / normalizedTick) + 1e-9) * normalizedTick).toFixed(decimals));
}

export function buildOptionExecutionQuote(snapshot, config) {
  const basic = snapshot?.basic || {};
  const optionExData = snapshot?.optionExData || {};
  const bid = numericOrNull(basic.bidPrice);
  const ask = numericOrNull(basic.askPrice);
  const last = numericOrNull(basic.curPrice);
  const tick = numericOrNull(basic.priceSpread) || 0.01;
  const askSize = numericOrNull(basic.askVol ?? basic.hpAskVol);
  const bidSize = numericOrNull(basic.bidVol ?? basic.hpBidVol);
  const dayVolume = numericOrNull(basic.volume ?? basic.hpVolume);
  const openInterest = numericOrNull(optionExData.openInterest);
  const reasons = [];

  if (config.optionRequireBidAsk && (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0)) {
    reasons.push('missing_or_zero_bid_ask');
  }
  if (Number.isFinite(bid) && bid < Number(config.optionMinBidPrice || 0)) {
    reasons.push(`bid_below_min:${bid}`);
  }
  if (Number.isFinite(ask) && Number.isFinite(bid) && ask < bid) {
    reasons.push('ask_below_bid');
  }
  if (Number.isFinite(dayVolume) && dayVolume < Number(config.optionMinDayVolume || 0)) {
    reasons.push(`option_day_volume_below_min:${dayVolume}`);
  }
  if (Number.isFinite(openInterest) && openInterest < Number(config.optionMinOpenInterest || 0)) {
    reasons.push(`open_interest_below_min:${openInterest}`);
  }

  const hasBidAsk = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask >= bid;
  const mid = hasBidAsk ? Number(((bid + ask) / 2).toFixed(4)) : null;
  const spreadAbs = hasBidAsk ? Number((ask - bid).toFixed(4)) : null;
  const spreadPctOfMid = hasBidAsk && mid > 0 ? Number((spreadAbs / mid * 100).toFixed(2)) : null;

  if (spreadPctOfMid !== null && spreadPctOfMid > Number(config.optionMaxSpreadPctOfMid ?? 25)) {
    reasons.push(`spread_pct_above_gate:${spreadPctOfMid}`);
  }
  if (spreadAbs !== null && spreadAbs > Number(config.optionMaxSpreadAbs ?? 1)) {
    reasons.push(`spread_abs_above_gate:${spreadAbs}`);
  }

  const fallbackBase = Number.isFinite(ask) && ask > 0
    ? ask
    : (Number.isFinite(last) && last > 0 ? last : bid);
  const slippageByTicks = Math.max(0, Number(config.optionSlippageTicks ?? 1)) * tick;
  const slippageBySpread = spreadAbs !== null ? Math.max(0, Number(config.optionSlippagePctOfSpread ?? 10)) * spreadAbs / 100 : 0;
  const slippageBuffer = Number(Math.max(slippageByTicks, slippageBySpread, 0).toFixed(4));
  const buyLimitPrice = Number.isFinite(fallbackBase) && fallbackBase > 0
    ? roundUpToTick(fallbackBase + slippageBuffer, tick)
    : null;
  const sellEstimatePrice = hasBidAsk
    ? Math.max(0, roundDownToTick(bid - slippageBuffer, tick))
    : null;
  const roundTripLossPct = buyLimitPrice && sellEstimatePrice !== null
    ? Number(((buyLimitPrice - sellEstimatePrice) / buyLimitPrice * 100).toFixed(2))
    : null;

  if (roundTripLossPct !== null && roundTripLossPct > Number(config.optionMaxRoundTripLossPct ?? 40)) {
    reasons.push(`round_trip_loss_pct_above_gate:${roundTripLossPct}`);
  }

  return {
    tradeable: buyLimitPrice !== null && reasons.length === 0,
    reasons,
    bid,
    ask,
    mid,
    last,
    quote_source: snapshot?.quote_source || null,
    quote_received_at: snapshot?.quote_received_at || null,
    bid_ask_source: snapshot?.bid_ask_source || (snapshot?.basic ? 'snapshot' : null),
    bid_ask_received_at: snapshot?.bid_ask_received_at || snapshot?.quote_received_at || null,
    tick,
    ask_size_contracts: askSize,
    bid_size_contracts: bidSize,
    day_volume_contracts: dayVolume,
    open_interest: openInterest,
    spread_abs: spreadAbs,
    spread_pct_of_mid: spreadPctOfMid,
    slippage_buffer: slippageBuffer,
    buy_limit_price: buyLimitPrice,
    buy_limit_basis: 'ask_plus_slippage_buffer',
    sell_estimate_price: sellEstimatePrice,
    sell_estimate_basis: 'bid_minus_slippage_buffer',
    immediate_round_trip_loss_pct: roundTripLossPct,
  };
}

function requireAccId(config) {
  if (!config.accId) throw new Error('Missing MOOMOO_ACC_ID. Run npm run moomoo:check, then set MOOMOO_ACC_ID in .env.');
  return config.accId;
}

export function buildTradeHeader(config, opts = {}) {
  const header = {
    trdEnv: config.trdEnv,
    accID: config.accId || (opts.allowMissingAccId ? 'DRY_RUN_NO_ACCOUNT' : requireAccId(config)),
    trdMarket: config.trdMarket,
  };
  if (config.jpAccType !== undefined) header.jpAccType = config.jpAccType;
  return header;
}

export function buildLimitBuyOrderRequest(config, { code, qty, price, remark }, opts = {}) {
  const c2s = {
    header: buildTradeHeader(config, opts),
    trdSide: TRD_SIDE_BUY,
    orderType: ORDER_TYPE_LIMIT,
    code,
    qty,
    price,
    secMarket: TRD_SEC_MARKET_US,
    remark: String(remark || '').slice(0, 60),
    timeInForce: TIME_IN_FORCE_DAY,
    session: SESSION_RTH,
  };
  if (opts.packetID) {
    c2s.packetID = opts.packetID;
  }
  return {
    c2s,
  };
}

export function buildLimitSellOrderRequest(config, { code, qty, price, remark, positionID }, opts = {}) {
  const c2s = {
    header: buildTradeHeader(config, opts),
    trdSide: TRD_SIDE_SELL,
    orderType: ORDER_TYPE_LIMIT,
    code,
    qty,
    price,
    secMarket: TRD_SEC_MARKET_US,
    remark: String(remark || '').slice(0, 60),
    timeInForce: TIME_IN_FORCE_DAY,
    session: SESSION_RTH,
  };
  if (positionID !== undefined && positionID !== null && positionID !== '') {
    c2s.positionID = positionID;
  }
  if (opts.packetID) {
    c2s.packetID = opts.packetID;
  }
  return {
    c2s,
  };
}

export async function placeLimitBuyOrder(client, config, order) {
  const packetID = {
    connID: client.getConnID(),
    serialNo: tradeSerialNo,
  };
  tradeSerialNo += 1;
  const response = await client.PlaceOrder(buildLimitBuyOrderRequest(config, order, { packetID }));
  assertMoomooSuccess(response, 'PlaceOrder');
  return response;
}

export async function placeLimitSellOrder(client, config, order) {
  const packetID = {
    connID: client.getConnID(),
    serialNo: tradeSerialNo,
  };
  tradeSerialNo += 1;
  const response = await client.PlaceOrder(buildLimitSellOrderRequest(config, order, { packetID }));
  assertMoomooSuccess(response, 'PlaceOrder');
  return response;
}

export async function fetchPositionList(client, config, opts = {}) {
  const response = await client.GetPositionList({
    c2s: {
      header: buildTradeHeader(config),
      refreshCache: opts.refreshCache ?? true,
    },
  });
  assertMoomooSuccess(response, 'GetPositionList');
  return response;
}

export async function fetchOrderList(client, config, opts = {}) {
  const response = await client.GetOrderList({
    c2s: {
      header: buildTradeHeader(config),
      filterConditions: opts.filterConditions || undefined,
      filterStatusList: opts.filterStatusList || [],
      refreshCache: opts.refreshCache ?? true,
    },
  });
  assertMoomooSuccess(response, 'GetOrderList');
  return response;
}

export async function fetchOrderFillList(client, config, opts = {}) {
  const response = await client.GetOrderFillList({
    c2s: {
      header: buildTradeHeader(config),
      filterConditions: opts.filterConditions || undefined,
      refreshCache: opts.refreshCache ?? true,
    },
  });
  assertMoomooSuccess(response, 'GetOrderFillList');
  return response;
}
