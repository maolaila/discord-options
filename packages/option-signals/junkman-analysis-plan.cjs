'use strict';

const fs = require('fs');
const { createHash } = require('crypto');

const JUNKMAN_ANALYSIS_CHANNEL_ID = '1515786763417813094';
const JUNKMAN_ANALYSIS_AUTHOR_ID = '414165384648720405';
const JUNKMAN_DAILY_PLAN_STRATEGY = 'junkman_discord_daily_plan_v1';

function finiteNumber(value) {
  const parsed = Number(String(value ?? '').replaceAll(',', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function numbers(text) {
  return [...String(text || '').matchAll(/(?<![\p{L}\p{N}])\d[\d,]*(?:\.\d+)?/gu)]
    .map((match) => finiteNumber(match[0]))
    .filter((value) => value !== null);
}

function firstLineMatch(text, pattern) {
  return String(text || '').match(pattern)?.[1]?.trim() || '';
}

function cleanMarkdown(text) {
  return String(text || '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dateInNewYork(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizedTicker(header) {
  const token = cleanMarkdown(header).split(/[｜|\s]/)[0].toUpperCase().replace(/[^A-Z.]/g, '');
  if (token === 'SPXW') return 'SPX';
  return token;
}

function sourceSignature(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

function parseKeyLevels(content) {
  const result = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    const label = line.match(/`(CALL WALL|PUT WALL|FLIP|PIVOT|MAGNET)`/i)?.[1]?.toUpperCase();
    if (!label) continue;
    const bold = line.match(/\*\*([\d,.]+(?:\s*[–—-]\s*[\d,.]+)?)\*\*/)?.[1] || '';
    const values = numbers(bold);
    if (!values.length) continue;
    const key = label.toLowerCase().replaceAll(' ', '_');
    result[key] = {
      label,
      lower_usd: Math.min(...values),
      upper_usd: Math.max(...values),
    };
  }
  return result;
}

function parseScenarios(content) {
  const rows = [];
  const pattern = /^-\s*[📈↔️📉]+\s*\*\*(多头接受|区间钉住|空头扩张)\s+(\d+(?:\.\d+)?)%\*\*｜(.+)$/gmu;
  for (const match of String(content || '').matchAll(pattern)) {
    const kind = match[1] === '多头接受' ? 'bull' : match[1] === '空头扩张' ? 'bear' : 'range';
    rows.push({
      kind,
      weight_pct: finiteNumber(match[2]),
      path_usd: numbers(match[3]).slice(0, 3),
    });
  }
  return rows;
}

function strategyKind(title) {
  if (title.includes('磁吸区均值回归')) return 'magnet_mean_reversion';
  if (title.includes('方向确认')) return 'flip_direction_confirmation';
  if (title.includes('回踩多') || title.includes('上方接受')) return 'bullish_retest';
  if (title.includes('反抽空') || title.includes('下方接受')) return 'bearish_retest';
  return 'unsupported';
}

function parseExecution(title, triggerText, targetText, invalidationText) {
  const kind = strategyKind(title);
  const triggerParts = String(triggerText || '').split('｜').map((part) => part.trim()).filter(Boolean);
  const triggerClause = triggerParts[0] || '';
  const targetClause = [targetText, ...triggerParts.slice(1)].filter(Boolean).join('｜');
  const triggerValues = numbers(triggerClause);
  const targetValues = numbers(targetClause);
  const invalidationValues = numbers(String(invalidationText || '').split('｜')[0]);
  const dashRange = /\d[\d,.]*\s*[–—-]\s*\d/.test(triggerClause);

  if (kind === 'magnet_mean_reversion') {
    const combinedTargets = targetValues.length ? targetValues : triggerValues.slice(2);
    if (triggerValues.length < 2 || combinedTargets.length < 1) return null;
    const lower = Math.min(triggerValues[0], triggerValues[1]);
    const upper = Math.max(triggerValues[0], triggerValues[1]);
    const center = combinedTargets[0];
    if (!(lower < center && center < upper)) return null;
    return {
      kind,
      trigger_zone: { lower_usd: lower, upper_usd: upper },
      long: { trigger_usd: lower, invalidation_usd: lower, target_usd: center },
      bear: { trigger_usd: upper, invalidation_usd: upper, target_usd: center },
    };
  }

  if (kind === 'flip_direction_confirmation') {
    if (triggerValues.length < 2 || targetValues.length < 2) return null;
    const upper = Math.max(triggerValues[0], triggerValues[1]);
    const lower = Math.min(triggerValues[0], triggerValues[1]);
    return {
      kind,
      trigger_zone: { lower_usd: lower, upper_usd: upper },
      long: { trigger_usd: upper, invalidation_usd: upper, target_usd: targetValues[0] },
      bear: { trigger_usd: lower, invalidation_usd: lower, target_usd: targetValues[1] },
    };
  }

  if (kind === 'bullish_retest' || kind === 'bearish_retest') {
    if (!triggerValues.length || !targetValues.length || !invalidationValues.length) return null;
    const lower = triggerValues[0];
    const upper = dashRange && triggerValues.length > 1 ? triggerValues[1] : triggerValues[0];
    const leg = {
      trigger_usd: kind === 'bullish_retest' ? Math.max(lower, upper) : Math.min(lower, upper),
      invalidation_usd: invalidationValues[0],
      target_usd: targetValues[0],
    };
    if (kind === 'bullish_retest' && !(leg.invalidation_usd < leg.trigger_usd && leg.target_usd > leg.trigger_usd)) return null;
    if (kind === 'bearish_retest' && !(leg.invalidation_usd > leg.trigger_usd && leg.target_usd < leg.trigger_usd)) return null;
    return {
      kind,
      trigger_zone: { lower_usd: Math.min(lower, upper), upper_usd: Math.max(lower, upper) },
      [kind === 'bullish_retest' ? 'long' : 'bear']: leg,
    };
  }
  return null;
}

function parseJunkmanAnalysisPlan(record, observedVia = 'unknown') {
  if (!record || String(record.channel_id || '') !== JUNKMAN_ANALYSIS_CHANNEL_ID) return null;
  if (String(record.author?.id || '') !== JUNKMAN_ANALYSIS_AUTHOR_ID) return null;
  const content = String(record.content || '');
  const header = firstLineMatch(content, /^##\s*⚡\s*(.+)$/mu);
  if (!header || !content.includes('开盘策略')) return null;
  const ticker = normalizedTicker(header);
  if (!ticker) return null;
  const strategyTitle = cleanMarkdown(firstLineMatch(content, /^\*\*🎯\s*开盘策略｜(.+?)\*\*$/mu));
  const triggerText = cleanMarkdown(firstLineMatch(content, /^-?\s*触发(?:｜目标)?：(.+)$/mu));
  const targetText = cleanMarkdown(firstLineMatch(content, /^-?\s*目标：(.+)$/mu));
  const invalidationText = cleanMarkdown(firstLineMatch(content, /^-?\s*失效(?:｜避免)?：(.+)$/mu));
  const execution = parseExecution(strategyTitle, triggerText, targetText, invalidationText);
  const messageTimestamp = new Date(record.edited_timestamp || record.timestamp || record.captured_at);
  if (!Number.isFinite(messageTimestamp.getTime())) return null;
  const sessionDateEt = dateInNewYork(record.timestamp || record.captured_at);
  const referenceMatch = content.match(/(?:当前参考价|SPY\s*推算开盘约)\s*\*\*([\d,.]+)\*\*/u);
  const regime = cleanMarkdown(content.match(/｜[🟢🟡🔴]\s*\*\*([^*]+GEX[^*]*)\*\*/u)?.[1] || '');
  const scenarios = parseScenarios(content);
  const messageId = String(record.id || '');
  const contentSignature = sourceSignature(content);
  const eventId = `junkman_analysis_${sourceSignature([messageId, contentSignature])}`;
  const reasons = [];
  if (!strategyTitle) reasons.push('strategy_title_missing');
  if (!triggerText) reasons.push('trigger_text_missing');
  if (!invalidationText) reasons.push('invalidation_text_missing');
  if (!execution) reasons.push('strategy_execution_unparseable');
  return {
    event_id: eventId,
    plan_id: `junkman_plan_${sourceSignature([messageId, contentSignature])}`,
    content_signature: contentSignature,
    source: 'discord_junkman_analysis',
    observed_via: String(observedVia || 'unknown'),
    channel_id: JUNKMAN_ANALYSIS_CHANNEL_ID,
    author_id: JUNKMAN_ANALYSIS_AUTHOR_ID,
    message_id: messageId,
    message_timestamp: messageTimestamp.toISOString(),
    session_date_et: sessionDateEt,
    ticker,
    header: cleanMarkdown(header),
    reference_price_usd: finiteNumber(referenceMatch?.[1]),
    regime: regime || null,
    key_levels: parseKeyLevels(content),
    strategy_title: strategyTitle || null,
    trigger_text: triggerText || null,
    target_text: targetText || null,
    invalidation_text: invalidationText || null,
    scenarios,
    execution,
    actionable: reasons.length === 0,
    rejection_reasons: reasons,
  };
}

function readJunkmanAnalysisPlanSource(file, {
  session_date_et,
  reserved_underlyings = ['SPX'],
} = {}) {
  const reserved = new Set((reserved_underlyings || []).map((value) => String(value).trim().toUpperCase()));
  if (!file || !fs.existsSync(file)) {
    return { source_status: 'plan_log_missing', source_signature: 'missing', seeds: [], rejected: [] };
  }
  const latest = new Map();
  const rejected = [];
  const text = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.channel_id !== JUNKMAN_ANALYSIS_CHANNEL_ID || row.author_id !== JUNKMAN_ANALYSIS_AUTHOR_ID) continue;
    if (row.session_date_et !== session_date_et) continue;
    if (reserved.has(String(row.ticker || '').toUpperCase())) continue;
    const previous = latest.get(row.ticker);
    if (!previous || Date.parse(row.message_timestamp) >= Date.parse(previous.message_timestamp)) latest.set(row.ticker, row);
  }
  const newest = [...latest.values()];
  for (const row of newest.filter((value) => !value.actionable || !value.execution)) {
    rejected.push({ message_id: row.message_id || null, ticker: row.ticker || null, reasons: row.rejection_reasons || ['not_actionable'] });
  }
  const seeds = newest.filter((row) => row.actionable && row.execution).sort((left, right) => (
    Date.parse(left.message_timestamp) - Date.parse(right.message_timestamp)
    || left.ticker.localeCompare(right.ticker)
  ));
  return {
    source_status: seeds.length ? 'current_session_plans_ready' : 'waiting_for_current_session_plans',
    source_signature: seeds.length ? sourceSignature(seeds.map((row) => [row.ticker, row.event_id])) : 'missing',
    seeds,
    rejected,
  };
}

module.exports = {
  JUNKMAN_ANALYSIS_AUTHOR_ID,
  JUNKMAN_ANALYSIS_CHANNEL_ID,
  JUNKMAN_DAILY_PLAN_STRATEGY,
  dateInNewYork,
  parseJunkmanAnalysisPlan,
  readJunkmanAnalysisPlanSource,
};
