'use strict';

const crypto = require('node:crypto');

const NIGHTWATCH_GUILD_ID = '1434960637561409689';
const NIGHTWATCH_ZERO_DTE_FLOW_CHANNEL_ID = '1513450634148577350';
const NIGHTWATCH_ZERO_DTE_FLOW_BOT_AUTHOR_ID = '1513450701777276999';
const MAX_LIVE_CAPTURE_LAG_MS = 15_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5_000;
const MAX_PREMIUM_RELATIVE_ERROR = 0.10;

const FLOW_ALERT_RE = /(?<color_emoji>\u{1F7E2}|\u{1F534})[^\S\r\n]*(?<flow_time_et>\d{1,2}:\d{2})(?::\d{2})?\s+(?<ticker>[A-Z][A-Z0-9.-]*)\s+(?:(?<explicit_dte>\d+)\s*DTE\s+)?(?<strike>\d+(?:\.\d+)?)(?<right_code>[CP])[^\S\r\n]*(?<side_text>\u4e70|\u5356|\u4e2d)[^\S\r\n]*(?<execution_icon>\u26A1|\u25A3|\u21C6)?[^\S\r\n]*\$(?<premium_value>\d[\d,]*(?:\.\d+)?)(?<premium_unit>[KMB]?)\s+(?<contract_value>\d[\d,]*(?:\.\d+)?)(?<contract_unit>[KMB]?)\s*\u5f20\s+avg\s+\$?(?<avg_option_price>\d[\d,]*(?:\.\d+)?)/gimu;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function scaledNumber(value, unit) {
  const parsed = Number(String(value || '').replace(/,/g, ''));
  if (!Number.isFinite(parsed)) return null;
  const multiplier = {
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000,
  }[String(unit || '').toUpperCase()] || 1;
  return parsed * multiplier;
}

function dateKeyInTimeZone(iso, timeZone) {
  const date = new Date(iso || '');
  if (Number.isNaN(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function discordMessageText(record) {
  const pieces = [record && record.content ? record.content : ''];
  for (const embed of Array.isArray(record && record.embeds) ? record.embeds : []) {
    pieces.push(embed.title || '', embed.description || '');
    for (const field of Array.isArray(embed.fields) ? embed.fields : []) {
      pieces.push(field.name || '', field.value || '');
    }
  }
  return pieces.filter(Boolean).join('\n');
}

function hasStrictProvenance(record) {
  return Boolean(
    record &&
    String(record.guild_id || '') === NIGHTWATCH_GUILD_ID &&
    String(record.channel_id || '') === NIGHTWATCH_ZERO_DTE_FLOW_CHANNEL_ID &&
    record.author &&
    String(record.author.id || '') === NIGHTWATCH_ZERO_DTE_FLOW_BOT_AUTHOR_ID &&
    record.author.bot === true
  );
}

function executionTypeFromIcon(icon) {
  if (icon === '\u26A1') return 'sweep';
  if (icon === '\u25A3') return 'floor';
  if (icon === '\u21C6') return 'multileg';
  return 'unspecified';
}

function aggressorFromSide(sideText) {
  if (sideText === '\u4e70') return 'ask';
  if (sideText === '\u5356') return 'bid';
  return 'mid';
}

function payloadFingerprint(fields) {
  const stablePayload = [
    fields.trading_date_et || '',
    fields.flow_time_et,
    fields.ticker,
    fields.dte,
    fields.strike,
    fields.right_code,
    fields.aggressor_side,
    fields.execution_type,
    fields.premium_usd,
    fields.contract_count,
    fields.avg_option_price,
  ].join('|');
  return `sha256:${sha256(stablePayload)}`;
}

function premiumConsistency(fields) {
  const premiumUsd = Number(fields && fields.premium_usd);
  const contractCount = Number(fields && fields.contract_count);
  const avgOptionPrice = Number(fields && fields.avg_option_price);
  if (
    !Number.isFinite(premiumUsd)
    || premiumUsd <= 0
    || !Number.isFinite(contractCount)
    || contractCount <= 0
    || !Number.isFinite(avgOptionPrice)
    || avgOptionPrice <= 0
  ) {
    return {
      expected_premium_usd: null,
      premium_relative_error: null,
      premium_consistent: null,
    };
  }
  const expectedPremiumUsd = contractCount * avgOptionPrice * 100;
  const relativeError = Math.abs(premiumUsd - expectedPremiumUsd) / expectedPremiumUsd;
  return {
    expected_premium_usd: Number(expectedPremiumUsd.toFixed(4)),
    premium_relative_error: Number(relativeError.toFixed(6)),
    premium_consistent: relativeError <= MAX_PREMIUM_RELATIVE_ERROR,
  };
}

function validationResult(fields, record, observedVia) {
  const reasonCodes = [];
  const expectedRight = fields.color_indicator === 'green' ? 'C' : 'P';
  if (fields.right_code !== expectedRight) reasonCodes.push('color_right_mismatch');
  if (fields.premium_consistent === false) reasonCodes.push('premium_contract_notional_mismatch');
  if (fields.dte !== 0) reasonCodes.push('not_zero_dte');
  if (observedVia !== 'live_gateway') reasonCodes.push('archive_observation_only');
  if (record.source !== 'discord_gateway_websocket') reasonCodes.push('not_gateway_source');
  if (record.event_type !== 'MESSAGE_CREATE') reasonCodes.push('not_message_create');

  const captureLagMs = record.capture_lag_ms;
  if (!Number.isFinite(captureLagMs)) reasonCodes.push('missing_capture_lag');
  else if (captureLagMs < -MAX_FUTURE_CLOCK_SKEW_MS) reasonCodes.push('negative_capture_lag');
  else if (captureLagMs > MAX_LIVE_CAPTURE_LAG_MS) reasonCodes.push('capture_lag_exceeded');

  const parseValid = !reasonCodes.includes('color_right_mismatch')
    && !reasonCodes.includes('premium_contract_notional_mismatch');
  const liveEligible = parseValid && reasonCodes.length === 0;
  return {
    parse_valid: parseValid,
    live_eligible: liveEligible,
    archive_only: !liveEligible,
    reason_codes: reasonCodes,
  };
}

function parseNightwatchZeroDteFlowAlerts(record, observedVia) {
  if (!hasStrictProvenance(record)) return [];

  const text = discordMessageText(record);
  const matches = Array.from(text.matchAll(FLOW_ALERT_RE));
  const fingerprintOccurrences = new Map();

  return matches.map((match, matchIndex) => {
    const groups = match.groups || {};
    const explicitDte = groups.explicit_dte === undefined ? null : Number(groups.explicit_dte);
    const dte = explicitDte === null ? 0 : explicitDte;
    const rightCode = String(groups.right_code || '').toUpperCase();
    const colorIndicator = groups.color_emoji === '\u{1F7E2}' ? 'green' : 'red';
    const tradingDateEt = dateKeyInTimeZone(record.timestamp || record.captured_at, 'America/New_York');
    const fields = {
      trading_date_et: tradingDateEt,
      flow_time_et: groups.flow_time_et,
      ticker: String(groups.ticker || '').toUpperCase(),
      dte,
      strike: Number(groups.strike),
      right_code: rightCode,
      aggressor_side: aggressorFromSide(groups.side_text),
      execution_type: executionTypeFromIcon(groups.execution_icon || ''),
      premium_usd: scaledNumber(groups.premium_value, groups.premium_unit),
      contract_count: scaledNumber(groups.contract_value, groups.contract_unit),
      avg_option_price: Number(String(groups.avg_option_price || '').replace(/,/g, '')),
    };
    const fingerprint = payloadFingerprint(fields);
    const occurrence = fingerprintOccurrences.get(fingerprint) || 0;
    fingerprintOccurrences.set(fingerprint, occurrence + 1);
    const childKey = `${record.id}|${fingerprint}|${occurrence}`;
    const premiumConsistencyResult = premiumConsistency(fields);
    const validation = validationResult({
      ...fields,
      ...premiumConsistencyResult,
      color_indicator: colorIndicator,
    }, record, observedVia);

    return {
      schema_version: 'nightwatch_zero_dte_flow_event.v1',
      source_type: 'nightwatch_0dte_flow_alert',
      observed_via: observedVia,
      source: record.source || '',
      event_type: record.event_type || '',
      guild_id: String(record.guild_id),
      channel_id: String(record.channel_id),
      author_id: String(record.author.id),
      author_bot: true,
      message_id: String(record.id || ''),
      sub_event_id: `nw0dte:${sha256(childKey).slice(0, 32)}`,
      match_index: matchIndex,
      payload_occurrence: occurrence,
      payload_fingerprint: fingerprint,
      message_timestamp: record.timestamp || null,
      captured_at: record.captured_at || null,
      capture_lag_ms: Number.isFinite(record.capture_lag_ms) ? record.capture_lag_ms : null,
      trading_date_et: tradingDateEt,
      flow_time_et: fields.flow_time_et,
      dte,
      dte_source: explicitDte === null ? 'channel_default' : 'explicit',
      is_zero_dte: dte === 0,
      color_indicator: colorIndicator,
      color_emoji: groups.color_emoji,
      ticker: fields.ticker,
      strike: fields.strike,
      option_right: rightCode === 'C' ? 'call' : 'put',
      right_code: rightCode,
      side_text: groups.side_text,
      aggressor_side: fields.aggressor_side,
      execution_icon: groups.execution_icon || '',
      execution_type: fields.execution_type,
      premium_usd: fields.premium_usd,
      contract_count: fields.contract_count,
      avg_option_price: fields.avg_option_price,
      ...premiumConsistencyResult,
      raw_alert_line: oneLine(match[0]),
      ...validation,
    };
  });
}

module.exports = {
  MAX_LIVE_CAPTURE_LAG_MS,
  MAX_PREMIUM_RELATIVE_ERROR,
  NIGHTWATCH_GUILD_ID,
  NIGHTWATCH_ZERO_DTE_FLOW_BOT_AUTHOR_ID,
  NIGHTWATCH_ZERO_DTE_FLOW_CHANNEL_ID,
  discordMessageText,
  hasStrictProvenance,
  premiumConsistency,
  parseNightwatchZeroDteFlowAlerts,
};
