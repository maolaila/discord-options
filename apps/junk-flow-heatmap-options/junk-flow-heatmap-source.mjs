import { createHash } from 'node:crypto';
import { read_bounded_ndjson_tail } from '../zero-dte-options/junk-flow-context.mjs';

const DEFAULT_MAX_EVENT_AGE_MS = 300_000;
const ALLOWED_EXECUTION_TYPES = new Set(['sweep', 'floor', 'unspecified']);

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) ? ticker : '';
}

function eventTimestampMs(event) {
  const timestamp = event?.message_timestamp || event?.captured_at;
  const parsed = Date.parse(String(timestamp || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function eventDirection(event) {
  const right = String(event?.right_code || '').toUpperCase();
  if (right === 'C') return 'bull';
  if (right === 'P') return 'bear';
  return null;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

export function selectRecentUnusualFlowEvents(events, {
  session_date_et,
  now_ms = Date.now(),
  max_event_age_ms = DEFAULT_MAX_EVENT_AGE_MS,
} = {}) {
  const accepted = [];
  const rejected = [];
  for (const event of Array.isArray(events) ? events : []) {
    const reasons = [];
    const ticker = normalizedTicker(event?.ticker);
    const timestampMs = eventTimestampMs(event);
    const ageMs = timestampMs === null ? null : Number(now_ms) - timestampMs;
    const executionType = String(event?.execution_type || 'unspecified').toLowerCase();
    const direction = eventDirection(event);
    if (event?.schema_version !== 'nightwatch_zero_dte_flow_event.v1') reasons.push('unsupported_schema');
    if (event?.live_eligible !== true || event?.archive_only === true) reasons.push('not_live_eligible');
    if (event?.parse_valid !== true || event?.premium_consistent === false) reasons.push('invalid_alert_payload');
    if (event?.is_zero_dte !== true || Number(event?.dte) !== 0) reasons.push('not_zero_dte');
    if (String(event?.aggressor_side || '').toLowerCase() !== 'ask') reasons.push('not_ask_side');
    if (!ALLOWED_EXECUTION_TYPES.has(executionType)) reasons.push(`unsupported_execution_type:${executionType}`);
    if (!ticker) reasons.push('ticker_invalid');
    if (!direction) reasons.push('option_direction_invalid');
    if (String(event?.trading_date_et || '') !== String(session_date_et || '')) reasons.push('cross_session');
    if (timestampMs === null) reasons.push('timestamp_invalid');
    else if (ageMs < -5_000) reasons.push('event_from_future');
    else if (ageMs > Number(max_event_age_ms)) reasons.push('event_stale');
    if (reasons.length > 0) {
      rejected.push({ event_id: event?.sub_event_id || null, ticker: ticker || null, reasons });
      continue;
    }
    accepted.push({
      ...event,
      ticker,
      direction,
      event_age_ms: ageMs,
      event_timestamp_ms: timestampMs,
    });
  }
  accepted.sort((left, right) => right.event_timestamp_ms - left.event_timestamp_ms);
  return { accepted, rejected };
}

export function buildRecentUnusualFlowSeeds(events, options = {}) {
  const selected = selectRecentUnusualFlowEvents(events, options);
  const eventsByTicker = new Map();
  for (const event of selected.accepted) {
    const rows = eventsByTicker.get(event.ticker) || [];
    rows.push(event);
    eventsByTicker.set(event.ticker, rows);
  }
  const seeds = [...eventsByTicker.values()].map((tickerEvents) => {
    const event = tickerEvents[0];
    const contemporaneous = tickerEvents.filter((row) => (
      event.event_timestamp_ms - row.event_timestamp_ms <= 30_000
    ));
    return {
      ticker: event.ticker,
      rank: 1,
      flow_event: event,
      flow_event_id: event.sub_event_id,
      flow_message_id: event.message_id,
      flow_direction: event.direction,
      flow_strike_usd: finiteNumber(event.strike),
      flow_premium_usd: finiteNumber(event.premium_usd),
      flow_contract_count: finiteNumber(event.contract_count),
      flow_execution_type: event.execution_type,
      flow_conflict: contemporaneous.some((row) => row.direction !== event.direction),
      contemporaneous_event_ids: contemporaneous.map((row) => row.sub_event_id),
      source: 'discord_nightwatch_0dte_flow_alert',
    };
  });
  const signaturePayload = seeds
    .map((seed) => `${seed.ticker}:${seed.flow_event_id}`)
    .sort()
    .join('|');
  return {
    ...selected,
    seeds,
    source_signature: `sha256:${createHash('sha256').update(signaturePayload).digest('hex')}`,
  };
}

export async function readRecentUnusualFlowSeeds(filePath, options = {}) {
  const tail = read_bounded_ndjson_tail({
    file_path: filePath,
    max_tail_bytes: 1_048_576,
    max_tail_rows: 5_000,
  });
  if (!tail.diagnostics.file_exists) {
    return {
      accepted: [], rejected: [], seeds: [], source_signature: 'missing',
      source_status: 'missing', source_error: null, tail_diagnostics: tail.diagnostics,
    };
  }
  if (tail.diagnostics.read_error) {
    return {
      accepted: [], rejected: [], seeds: [], source_signature: 'unreadable',
      source_status: 'unreadable', source_error: tail.diagnostics.read_error,
      tail_diagnostics: tail.diagnostics,
    };
  }
  return {
    ...buildRecentUnusualFlowSeeds(tail.events, options),
    source_status: 'ready',
    source_error: null,
    observed_event_count: tail.events.length,
    tail_diagnostics: tail.diagnostics,
  };
}

export function applyUnusualFlowHeatmapGate(decision, finalist, {
  now_ms = Date.now(),
  max_event_age_ms = DEFAULT_MAX_EVENT_AGE_MS,
} = {}) {
  const event = finalist?.flow_event || null;
  const reasons = [];
  if (decision?.decision === 'trade') {
    const eventAt = eventTimestampMs(event);
    const ageMs = eventAt === null ? null : Number(now_ms) - eventAt;
    const testedStrike = finiteNumber(decision?.tested_node?.strike_usd);
    const flowStrike = finiteNumber(event?.strike);
    if (!event || event?.live_eligible !== true) reasons.push('unusual_flow_missing_or_ineligible');
    if (finalist?.flow_conflict === true) reasons.push('unusual_flow_contemporaneous_direction_conflict');
    if (event && normalizedTicker(event.ticker) !== normalizedTicker(decision?.ticker)) reasons.push('unusual_flow_ticker_mismatch');
    if (eventDirection(event) !== String(decision?.direction || '').toLowerCase()) reasons.push('unusual_flow_direction_mismatch');
    if (ageMs === null || ageMs < -5_000 || ageMs > Number(max_event_age_ms)) reasons.push('unusual_flow_not_fresh');
    if (testedStrike === null || flowStrike === null || Math.abs(testedStrike - flowStrike) > 1e-6) {
      reasons.push('unusual_flow_strike_not_same_as_tested_node');
    }
    if (decision?.evidence_model?.heatmap?.assessment !== 'confirm') reasons.push('heatmap_tested_node_not_confirmed');
  }
  const blocked = decision?.decision === 'trade' && reasons.length > 0;
  return {
    ...decision,
    flow_dependency: 'required_for_this_business_line',
    automated_flow_usage: 'entry_gate_for_flow_heatmap_business_line',
    decision: blocked ? 'no_trade' : decision?.decision,
    action: blocked ? 'hold' : decision?.action,
    reason_codes: unique([...(decision?.reason_codes || []), ...reasons]),
    flow_heatmap_evidence: {
      source: 'discord_nightwatch_0dte_flow_alert',
      event_id: event?.sub_event_id || null,
      message_id: event?.message_id || null,
      ticker: event?.ticker || null,
      direction: eventDirection(event),
      strike_usd: finiteNumber(event?.strike),
      premium_usd: finiteNumber(event?.premium_usd),
      contract_count: finiteNumber(event?.contract_count),
      execution_type: event?.execution_type || null,
      contemporaneous_direction_conflict: finalist?.flow_conflict === true,
      contemporaneous_event_ids: finalist?.contemporaneous_event_ids || [],
      heatmap_assessment: decision?.evidence_model?.heatmap?.assessment || null,
      gate_passed: !blocked && decision?.decision === 'trade',
      gate_reasons: reasons,
    },
  };
}
