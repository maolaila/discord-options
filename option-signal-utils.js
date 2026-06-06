'use strict';

const FIELD = {
  executionView: '\u6267\u884c\u89c2\u70b9',
  priceStructure: '\u4ef7\u683c\u7ed3\u6784',
  optionStructure: '\u671f\u6743\u7ed3\u6784',
  executionPlan: '\u6267\u884c\u8ba1\u5212',
  invalidation: '\u5931\u6548\u6761\u4ef6',
  riskNote: '\u98ce\u9669\u63d0\u793a',
  conclusion: '\u7ed3\u8bba',
  executionPoints: '\u6267\u884c\u8981\u70b9',
};

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseTitle(title) {
  const match = String(title || '').match(/^([A-Z][A-Z0-9.-]*)\s+(\d{4}-\d{2}-\d{2})\s+([0-9]+(?:\.[0-9]+)?)([CP])\s+\|\s*(.*)$/);
  if (!match) return null;
  return {
    ticker: match[1],
    expiration: match[2],
    strike: Number(match[3]),
    option_type: match[4],
    title_suffix: match[5] || '',
  };
}

function yyyymmdd(value) {
  return String(value || '').replace(/-/g, '');
}

function polygonOptionTicker(ticker, expiration, optionType, strike) {
  const yyMMdd = yyyymmdd(expiration).slice(2);
  const strikeInt = Math.round(Number(strike) * 1000);
  return `O:${ticker}${yyMMdd}${optionType}${String(strikeInt).padStart(8, '0')}`;
}

function occSymbol(ticker, expiration, optionType, strike) {
  const yyMMdd = yyyymmdd(expiration).slice(2);
  const strikeInt = Math.round(Number(strike) * 1000);
  return `${ticker.padEnd(6, ' ')}${yyMMdd}${optionType}${String(strikeInt).padStart(8, '0')}`;
}

function firstEmbed(record) {
  return record && Array.isArray(record.embeds) && record.embeds.length ? record.embeds[0] : null;
}

function fieldMap(embed) {
  const out = {};
  for (const field of embed && Array.isArray(embed.fields) ? embed.fields : []) {
    out[String(field.name || '')] = String(field.value || '');
  }
  return out;
}

function getField(fields, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  }

  const lowerNames = new Set(names.map((name) => String(name).toLowerCase()));
  for (const [name, value] of Object.entries(fields)) {
    if (lowerNames.has(String(name).toLowerCase())) return value;
  }

  return '';
}

function parsePremium(description) {
  const match = String(description || '').match(/Premium\s+\$([0-9,]+(?:\.\d+)?)/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function parseNumberAfter(label, text) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`${escaped}\\s*([0-9]+(?:\\.[0-9]+)?)`));
  return match ? Number(match[1]) : null;
}

function parseWinRate(text) {
  const match = String(text || '').match(/\u80dc\u7387\s*([0-9]+(?:\.[0-9]+)?)%/);
  return match ? Number(match[1]) : null;
}

function parseRisk(text) {
  const match = String(text || '').match(/\u98ce\u9669\s*([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : null;
}

function parseConfidence(text) {
  const numeric = String(text || '').match(/(?:\u7f6e\u4fe1|confidence_score)\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (numeric) return Number(numeric[1]);

  if (/(\u4fe1\u5fc3|\u7f6e\u4fe1)\s*[:：]?\s*(\u9ad8|high)/i.test(String(text || ''))) return 5;
  if (/(\u4fe1\u5fc3|\u7f6e\u4fe1)\s*[:：]?\s*(\u4e2d|medium)/i.test(String(text || ''))) return 3;
  if (/(\u4fe1\u5fc3|\u7f6e\u4fe1)\s*[:：]?\s*(\u4f4e|low)/i.test(String(text || ''))) return 2;

  return null;
}

function parseDirection(text) {
  const value = String(text || '');
  const english = value.match(/\b(bull|bear|neutral)\b/i);
  if (english) return english[1].toLowerCase();
  if (value.includes('\u504f\u7a7a') || value.includes('\u65b9\u5411\uff1a\u504f\u7a7a') || value.includes('\u65b9\u5411:\u504f\u7a7a')) return 'bear';
  if (value.includes('\u504f\u591a') || value.includes('\u65b9\u5411\uff1a\u504f\u591a') || value.includes('\u65b9\u5411:\u504f\u591a')) return 'bull';
  return null;
}

function parseAction(...texts) {
  const joined = texts.map((text) => String(text || '')).join(' ');
  if (/\bno_trade\b/i.test(joined) || joined.includes('\u4e0d\u4ea4\u6613')) return 'no_trade';
  if (/\btrade\b/i.test(joined) || joined.includes('\u4ea4\u6613')) return 'trade';
  return 'unknown';
}

function inferFormat(fields, titleSuffix) {
  if (getField(fields, ['decision', 'confidence_score'])) return 'mr';
  if (getField(fields, [FIELD.conclusion, FIELD.executionPoints])) return 'qmr';
  if (getField(fields, [FIELD.executionView, FIELD.executionPlan])) return 'pa';
  if (/\bQMR\b/i.test(titleSuffix)) return 'qmr';
  if (/\bMR\b/i.test(titleSuffix)) return 'mr';
  return 'unknown';
}

function getSignalTexts(fields) {
  return {
    execution_view: getField(fields, [FIELD.executionView, 'decision', FIELD.conclusion]),
    price_structure: getField(fields, [FIELD.priceStructure]),
    option_structure: getField(fields, [FIELD.optionStructure]),
    execution_plan: getField(fields, [FIELD.executionPlan, FIELD.executionPoints]),
    invalidation: getField(fields, [FIELD.invalidation, 'confidence_score']),
    risk_note: getField(fields, [FIELD.riskNote]),
  };
}

function buildSignalKey(signal) {
  return [
    signal.message_id || '',
    signal.event_type || '',
    signal.contract_key || '',
    signal.action || '',
    signal.direction || '',
    signal.entry_stock_price ?? '',
    signal.target_stock_price ?? '',
    signal.stop_stock_price ?? '',
  ].join('|');
}

function evaluateSignal(signal) {
  const notes = [];
  const isTrade = signal.action === 'trade';
  const hasContract = Boolean(signal.ticker && signal.expiration && signal.strike && signal.option_type);
  const hasPlan = signal.entry_stock_price !== null && signal.target_stock_price !== null && signal.stop_stock_price !== null;
  const confidenceOk = signal.confidence !== null && signal.confidence >= 4;
  const winRateOk = signal.win_rate_pct !== null && signal.win_rate_pct >= 75;
  const directionOk = signal.direction === 'bull' || signal.direction === 'bear';

  if (!isTrade) notes.push('not_trade_decision');
  if (!hasContract) notes.push('missing_option_contract');
  if (!directionOk) notes.push('missing_or_neutral_direction');
  if (!hasPlan) notes.push('missing_stock_entry_target_stop');
  if (!confidenceOk && !winRateOk) notes.push('confidence_or_winrate_below_gate');

  const signalActionable = isTrade && hasContract && directionOk && (confidenceOk || winRateOk);
  const fullPlanReady = signalActionable && hasPlan;

  return {
    signal_actionable: signalActionable,
    full_plan_ready: fullPlanReady,
    order_intent: signalActionable ? 'buy_to_open' : 'none',
    order_side: signalActionable ? 'BUY' : 'NONE',
    order_type: signalActionable ? 'OPTION_LONG' : 'NONE',
    management_mode: hasPlan ? 'option_stop_take_profit_plus_stock_lines' : 'option_stop_take_profit_only',
    gate_notes: notes,
  };
}

function parseOptionSignal(record, observedVia) {
  const embed = firstEmbed(record);
  if (!embed) return null;

  const titleParts = parseTitle(embed.title);
  if (!titleParts) return null;

  const fields = fieldMap(embed);
  const format = inferFormat(fields, titleParts.title_suffix);
  const texts = getSignalTexts(fields);
  const allText = Object.values(texts).join(' ');
  const action = parseAction(texts.execution_view, texts.execution_plan, texts.invalidation);

  let direction = parseDirection(texts.execution_view)
    || parseDirection(texts.option_structure)
    || parseDirection(texts.execution_plan)
    || parseDirection(texts.risk_note)
    || parseDirection(allText);
  let directionInferred = false;
  if (!direction && action === 'trade') {
    direction = titleParts.option_type === 'P' ? 'bear' : 'bull';
    directionInferred = true;
  }

  const planText = texts.execution_plan || texts.execution_view;
  const signal = {
    observed_at: new Date().toISOString(),
    observed_via: observedVia,
    source: record.source || '',
    event_type: record.event_type || '',
    message_id: record.id || '',
    channel_id: record.channel_id || '',
    guild_id: record.guild_id || null,
    message_timestamp: record.timestamp || '',
    captured_at: record.captured_at || '',
    capture_lag_ms: record.capture_lag_ms ?? null,
    author_id: record.author && record.author.id ? record.author.id : '',
    author_username: record.author && record.author.username ? record.author.username : '',
    advice_format: format,
    title: embed.title || '',
    description: embed.description || '',
    ticker: titleParts.ticker,
    expiration: titleParts.expiration,
    strike: titleParts.strike,
    option_type: titleParts.option_type,
    title_suffix: titleParts.title_suffix,
    contract_key: `${titleParts.ticker}_${titleParts.expiration}_${titleParts.strike}${titleParts.option_type}`,
    polygon_option_ticker: polygonOptionTicker(titleParts.ticker, titleParts.expiration, titleParts.option_type, titleParts.strike),
    occ_symbol: occSymbol(titleParts.ticker, titleParts.expiration, titleParts.option_type, titleParts.strike),
    action,
    direction,
    direction_inferred: directionInferred,
    entry_stock_price: parseNumberAfter('\u5165\u573a', planText) ?? parseNumberAfter('\u5165\u573a', texts.execution_view),
    target_stock_price: parseNumberAfter('\u76ee\u6807', planText) ?? parseNumberAfter('\u76ee\u6807', texts.execution_view),
    stop_stock_price: parseNumberAfter('\u6b62\u635f', planText) ?? parseNumberAfter('\u6b62\u635f', texts.execution_view),
    win_rate_pct: parseWinRate(texts.invalidation),
    risk_score: parseRisk(texts.risk_note),
    confidence: parseConfidence(texts.invalidation) ?? parseConfidence(texts.risk_note) ?? parseConfidence(texts.option_structure) ?? parseConfidence(texts.execution_view),
    premium_usd: parsePremium(embed.description),
    execution_view: texts.execution_view,
    price_structure: texts.price_structure,
    option_structure: texts.option_structure,
    execution_plan: texts.execution_plan,
    invalidation: texts.invalidation,
    risk_note: texts.risk_note,
  };

  Object.assign(signal, evaluateSignal(signal));
  signal.signal_key = buildSignalKey(signal);
  return signal;
}

function formatSignalLine(signal) {
  const lag = signal.capture_lag_ms === null || signal.capture_lag_ms === undefined ? '' : ` lag=${signal.capture_lag_ms}ms`;
  const plan = signal.entry_stock_price !== null
    ? ` entry=${signal.entry_stock_price} target=${signal.target_stock_price} stop=${signal.stop_stock_price}`
    : '';
  const score = [
    signal.win_rate_pct !== null ? `win=${signal.win_rate_pct}%` : '',
    signal.confidence !== null ? `conf=${signal.confidence}` : '',
    signal.risk_score !== null ? `risk=${signal.risk_score}` : '',
  ].filter(Boolean).join(' ');
  return `[${signal.captured_at || signal.observed_at}] ${signal.observed_via} ${signal.action.toUpperCase()} ${signal.ticker} ${signal.expiration} ${signal.strike}${signal.option_type} ${signal.direction || 'unknown'}${plan}${score ? ` ${score}` : ''}${lag} channel=${signal.channel_id} id=${signal.message_id} ready=${signal.signal_actionable}`;
}

function buildOrderIntent(signal) {
  if (!signal.signal_actionable) return null;

  return {
    created_at: new Date().toISOString(),
    status: 'paper_intent_only',
    source_signal_key: signal.signal_key,
    message_id: signal.message_id,
    channel_id: signal.channel_id,
    message_timestamp: signal.message_timestamp,
    observed_via: signal.observed_via,
    action: 'BUY_TO_OPEN',
    instrument_type: 'option',
    ticker: signal.ticker,
    expiration: signal.expiration,
    strike: signal.strike,
    option_type: signal.option_type,
    polygon_option_ticker: signal.polygon_option_ticker,
    occ_symbol: signal.occ_symbol,
    direction: signal.direction,
    confidence: signal.confidence,
    win_rate_pct: signal.win_rate_pct,
    risk_score: signal.risk_score,
    management_mode: signal.management_mode,
    stock_entry: signal.entry_stock_price,
    stock_target: signal.target_stock_price,
    stock_stop: signal.stop_stock_price,
    option_stop_loss_pct: 20,
    option_take_profit_pct: 50,
    requires_live_option_quote: true,
    requires_user_enabled_broker_execution: true,
    notes: signal.gate_notes,
  };
}

module.exports = {
  FIELD,
  buildOrderIntent,
  firstEmbed,
  formatSignalLine,
  parseOptionSignal,
  parseTitle,
  polygonOptionTicker,
  occSymbol,
};
