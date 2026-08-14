const DEFAULT_MAX_AGE_MS = 60_000;
const DEFAULT_ALLOWED_STATES = Object.freeze(['fresh']);

const SOURCE_PATTERNS = Object.freeze([
  Object.freeze({
    evidence_kind: 'contract',
    pattern: /^\/v1\/options\/(?:chain-snapshot|atm-chains)\/[A-Z0-9._^-]{1,24}$/,
  }),
  Object.freeze({
    evidence_kind: 'contract',
    pattern: /^\/v1\/options\/(?:contract-intraday|contract-greeks-series|contract-volume-profile)\/[A-Z0-9._-]{1,64}$/,
  }),
  Object.freeze({
    evidence_kind: 'structure',
    pattern: /^\/v1\/derived\/(?:dealer-gex|heatmap)\/[A-Z]{1,5}\/(?:snapshot|history)$/,
  }),
  Object.freeze({
    evidence_kind: 'structure',
    pattern: /^\/v1\/stocks\/(?:stock-state|index-ohlc)\/[A-Z0-9._^-]{1,24}$/,
  }),
]);

function finite_number(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonnegative_number(value) {
  const parsed = finite_number(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function timestamp_ms(value) {
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso_timestamp(value) {
  const parsed = timestamp_ms(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function rounded(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function normalized_contract(contract) {
  const value = String(contract || '').trim().toUpperCase();
  return /^[A-Z0-9._-]{1,64}$/.test(value) ? value : null;
}

function normalized_source_path(source_path) {
  const text = String(source_path || '').trim();
  if (!text) return null;
  try {
    const parsed = new URL(text, 'https://api.yehangshe.com');
    if (parsed.origin !== 'https://api.yehangshe.com') return null;
    return parsed.pathname.replace(/\/$/, '') || '/';
  } catch {
    return null;
  }
}

function source_descriptor(source_path) {
  const path = normalized_source_path(source_path);
  const descriptor = path
    ? SOURCE_PATTERNS.find(({ pattern }) => pattern.test(path)) || null
    : null;
  return {
    source_path: descriptor ? path : null,
    evidence_kind: descriptor?.evidence_kind || 'unknown',
  };
}

function payload_from_response(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  if (!Object.hasOwn(response, 'data')) return null;
  return response.data;
}

function meta_from_response(response) {
  return response?._meta && typeof response._meta === 'object' && !Array.isArray(response._meta)
    ? response._meta
    : {};
}

function selected_record(payload, record) {
  if (record !== undefined) {
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  }
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
}

function resolved_state(payload, meta, record) {
  const candidates = [record?.state, payload?.state, meta?.state]
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
    .map((value) => String(value).trim().toLowerCase());
  const unique = [...new Set(candidates)];
  return {
    state: unique.length === 1 ? unique[0] : 'unknown',
    conflicting: unique.length > 1,
  };
}

function resolved_as_of({ as_of, payload, meta, record }) {
  const candidates = [
    as_of,
    meta?.as_of,
    payload?.as_of,
    payload?.snapshot_at,
    payload?.generated_at,
    record?.as_of,
  ];
  const present = candidates.find(
    (value) => value !== undefined && value !== null && String(value).trim() !== '',
  );
  return iso_timestamp(present);
}

function resolved_available_at(available_at, meta) {
  const present = available_at ?? meta?.available_at;
  return iso_timestamp(present);
}

function summary_number(record, key, { nonnegative = false } = {}) {
  if (!record || !Object.hasOwn(record, key)) return { present: false, value: null, invalid: false };
  const value = nonnegative ? nonnegative_number(record[key]) : finite_number(record[key]);
  return { present: true, value, invalid: value === null };
}

function greeks_summary(record, reason_codes) {
  const keys = ['delta', 'gamma', 'theta', 'vega', 'rho', 'implied_volatility'];
  const summary = {};
  let present = false;
  let invalid = false;
  for (const key of keys) {
    const value = summary_number(record, key, { nonnegative: key === 'implied_volatility' });
    if (!value.present) continue;
    present = true;
    invalid ||= value.invalid;
    if (!value.invalid) summary[key] = value.value;
  }
  if (invalid) reason_codes.push('invalid_greeks_fields');
  return present && !invalid ? summary : null;
}

function oi_summary(record, reason_codes) {
  const value = summary_number(record, 'open_interest', { nonnegative: true });
  if (!value.present) return null;
  if (value.invalid) {
    reason_codes.push('invalid_open_interest');
    return null;
  }
  return {
    open_interest: value.value,
    settlement_lagged: true,
    intraday_directional_signal: false,
  };
}

function volume_summary(record, reason_codes) {
  const volume = summary_number(record, 'volume', { nonnegative: true });
  if (!volume.present) return null;
  if (volume.invalid) {
    reason_codes.push('invalid_volume');
    return null;
  }
  return { volume: volume.value };
}

function liquidity_summary(record, reason_codes) {
  const bid = summary_number(record, 'bid', { nonnegative: true });
  const ask = summary_number(record, 'ask', { nonnegative: true });
  const bid_size = summary_number(record, 'bid_size', { nonnegative: true });
  const ask_size = summary_number(record, 'ask_size', { nonnegative: true });
  const any_present = [bid, ask, bid_size, ask_size].some((value) => value.present);
  if (!any_present) return null;
  if (
    !bid.present
    || !ask.present
    || bid.invalid
    || ask.invalid
    || bid.value <= 0
    || ask.value <= 0
    || bid.value > ask.value
    || bid_size.invalid
    || ask_size.invalid
  ) {
    reason_codes.push('invalid_liquidity_fields');
    return null;
  }
  const spread_usd = ask.value - bid.value;
  const mid_usd = (ask.value + bid.value) / 2;
  return {
    bid: bid.value,
    ask: ask.value,
    bid_size: bid_size.present ? bid_size.value : null,
    ask_size: ask_size.present ? ask_size.value : null,
    mid_usd: rounded(mid_usd),
    spread_usd: rounded(spread_usd),
    relative_spread: mid_usd > 0 ? rounded(spread_usd / mid_usd) : null,
  };
}

/**
 * Validate one already-observed Nightwatch response without creating a trade
 * direction. `available_at` is deliberately supplied by the caller: response
 * receipt time must not be reconstructed from a later polling/evaluation time.
 *
 * When a provider response contains a nested/array schema, callers must pass
 * the exact candidate `record` after an endpoint-specific parser has verified
 * it. This module never heuristically picks the "latest" row.
 */
export function evaluate_junk_api_evidence({
  response,
  source_path,
  available_at,
  as_of,
  record,
  candidate_contract,
  evaluated_at = Date.now(),
  max_age_ms = DEFAULT_MAX_AGE_MS,
  allowed_states = DEFAULT_ALLOWED_STATES,
} = {}) {
  const reason_codes = [];
  const source = source_descriptor(source_path);
  if (!source.source_path) reason_codes.push('unknown_source_path');

  const payload = payload_from_response(response);
  const meta = meta_from_response(response);
  if (payload === null) reason_codes.push('missing_response_data');
  const selected = selected_record(payload, record);
  if (!selected) reason_codes.push('unsupported_response_schema');

  const allowed = Array.isArray(allowed_states)
    ? [...new Set(allowed_states.map((value) => String(value).trim().toLowerCase()).filter(Boolean))]
    : [];
  if (allowed.length === 0) throw new TypeError('allowed_states must contain at least one state');
  const resolved_max_age_ms = Number(max_age_ms);
  if (!Number.isFinite(resolved_max_age_ms) || resolved_max_age_ms < 0) {
    throw new TypeError('max_age_ms must be a non-negative number');
  }
  const evaluated_at_ms = timestamp_ms(evaluated_at);
  if (evaluated_at_ms === null) throw new TypeError('evaluated_at must be a valid timestamp');

  const state_result = resolved_state(payload, meta, selected);
  if (state_result.conflicting) reason_codes.push('conflicting_state_fields');
  if (state_result.state === 'unknown') reason_codes.push('missing_or_unknown_state');
  else if (!allowed.includes(state_result.state)) {
    reason_codes.push(`state_not_allowed:${state_result.state}`);
  }

  const normalized_available_at = resolved_available_at(available_at, meta);
  const normalized_as_of = resolved_as_of({ as_of, payload, meta, record: selected });
  const available_at_ms = timestamp_ms(normalized_available_at);
  const as_of_ms = timestamp_ms(normalized_as_of);
  if (!normalized_available_at) reason_codes.push('missing_or_invalid_available_at');
  if (!normalized_as_of) reason_codes.push('missing_or_invalid_as_of');
  if (available_at_ms !== null && available_at_ms > evaluated_at_ms + 5_000) {
    reason_codes.push('available_at_from_future');
  }
  if (as_of_ms !== null && available_at_ms !== null && as_of_ms > available_at_ms + 5_000) {
    reason_codes.push('as_of_after_available_at');
  }
  if (as_of_ms !== null && evaluated_at_ms - as_of_ms > resolved_max_age_ms) {
    reason_codes.push('evidence_stale');
  }

  const normalized_candidate_contract = candidate_contract === undefined
    ? null
    : normalized_contract(candidate_contract);
  if (candidate_contract !== undefined && !normalized_candidate_contract) {
    reason_codes.push('invalid_candidate_contract');
  }
  if (source.evidence_kind === 'contract' && normalized_candidate_contract) {
    const record_contract = normalized_contract(selected?.contract);
    const candidate_identity = parse_osi_contract(normalized_candidate_contract)?.contract
      || normalized_candidate_contract;
    const record_identity = parse_osi_contract(record_contract)?.contract || record_contract;
    if (!record_contract) reason_codes.push('candidate_contract_not_verified');
    else if (record_identity !== candidate_identity) reason_codes.push('candidate_contract_mismatch');
  }

  const summaries = selected
    ? {
      greeks_summary: greeks_summary(selected, reason_codes),
      oi_summary: oi_summary(selected, reason_codes),
      volume_summary: volume_summary(selected, reason_codes),
      liquidity_summary: liquidity_summary(selected, reason_codes),
    }
    : {
      greeks_summary: null,
      oi_summary: null,
      volume_summary: null,
      liquidity_summary: null,
    };

  return {
    evidence_kind: source.evidence_kind,
    source_path: source.source_path,
    available_at: normalized_available_at,
    as_of: normalized_as_of,
    evaluated_at: new Date(evaluated_at_ms).toISOString(),
    age_ms: as_of_ms === null ? null : Math.max(0, evaluated_at_ms - as_of_ms),
    state: state_result.state,
    usable: reason_codes.length === 0,
    reason_codes: [...new Set(reason_codes)],
    candidate_contract: parse_osi_contract(normalized_candidate_contract)?.contract
      || normalized_candidate_contract,
    ...summaries,
  };
}

export function evaluate_junk_contract_evidence(input = {}) {
  return evaluate_junk_api_evidence(input);
}

export function evaluate_junk_structure_evidence(input = {}) {
  return evaluate_junk_api_evidence(input);
}

function unique_strings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))];
}

function parse_osi_contract(contract) {
  const normalized = normalized_contract(contract);
  if (!normalized) return null;
  const match = normalized.match(/^([A-Z][A-Z0-9.]{0,9})(\d{2})(\d{2})(\d{2})([CP])(\d{7,8})$/);
  if (!match) return null;
  const year = Number(match[2]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const expiration = `20${match[2]}-${match[3]}-${match[4]}`;
  const parsed_date = new Date(`${expiration}T00:00:00.000Z`);
  if (
    parsed_date.getUTCFullYear() !== 2000 + year
    || parsed_date.getUTCMonth() + 1 !== month
    || parsed_date.getUTCDate() !== day
  ) return null;
  const strike_digits = match[6].padStart(8, '0');
  return {
    contract: `${match[1]}${match[2]}${match[3]}${match[4]}${match[5]}${strike_digits}`,
    root: match[1],
    expiration,
    right: match[5],
    strike_usd: Number(strike_digits) / 1_000,
  };
}

function canonical_right(value) {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'CALL') return 'C';
  if (token === 'PUT') return 'P';
  return token === 'C' || token === 'P' ? token : null;
}

function contract_audit_base({
  candidate_contract = null,
  source_path = null,
  available_at = null,
  provider_call_count = 0,
} = {}) {
  const normalized_candidate = normalized_contract(candidate_contract);
  return {
    schema_version: 1,
    source: 'nightwatch_options_chain_snapshot',
    usage: 'candidate_contract_audit_only',
    can_trigger_trade: false,
    generates_direction: false,
    assessment: 'degraded_neutral',
    advisory_only: true,
    can_veto_candidate: false,
    provider_call_count,
    source_path,
    available_at,
    state: 'unknown',
    candidate_contract: parse_osi_contract(normalized_candidate)?.contract || normalized_candidate,
    record_schema: 'unknown',
    evidence: null,
    reason_codes: [],
  };
}

export function degraded_junk_contract_audit({
  candidate_contract,
  source_path,
  available_at,
  reason_code = 'nightwatch_contract_audit_unavailable_neutral',
  provider_call_count = 1,
} = {}) {
  return {
    ...contract_audit_base({
      candidate_contract,
      source_path,
      available_at: iso_timestamp(available_at),
      provider_call_count,
    }),
    reason_codes: [String(reason_code)],
  };
}

function safe_candidate_record(response, candidate_contract) {
  const payload = payload_from_response(response);
  const candidate = normalized_contract(candidate_contract);
  const candidate_identity = parse_osi_contract(candidate)?.contract;
  if (!candidate_identity) return { record: null, record_schema: 'unknown', explicit_mismatch: null };
  if (Array.isArray(payload)) {
    const matches = payload.filter((row) => (
      row && typeof row === 'object' && !Array.isArray(row)
      && parse_osi_contract(row.contract)?.contract === candidate_identity
    ));
    return matches.length === 1
      ? { record: matches[0], record_schema: 'data_array_exact_contract', explicit_mismatch: null }
      : { record: null, record_schema: matches.length > 1 ? 'ambiguous_exact_records' : 'unknown', explicit_mismatch: null };
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const direct_contract = normalized_contract(payload.contract);
    if (direct_contract) {
      const direct_identity = parse_osi_contract(direct_contract)?.contract;
      return {
        record: payload,
        record_schema: 'direct_data_object',
        explicit_mismatch: direct_identity === candidate_identity ? null : direct_contract,
      };
    }
  }
  return { record: null, record_schema: 'unknown', explicit_mismatch: null };
}

function mismatch_reason_codes({ expected, observed }) {
  const reasons = [];
  if (!expected || !observed) return reasons;
  if (expected.contract !== observed.contract) reasons.push('nightwatch_contract_identity_mismatch');
  if (expected.expiration !== observed.expiration) reasons.push('nightwatch_contract_expiration_mismatch');
  if (expected.right !== observed.right) reasons.push('nightwatch_contract_right_mismatch');
  if (Math.abs(expected.strike_usd - observed.strike_usd) > 0.0001) {
    reasons.push('nightwatch_contract_strike_mismatch');
  }
  return reasons;
}

/**
 * Make at most one paid call for an already-approved, already-quoted moomoo
 * candidate. The official OpenAPI currently describes the chain response only
 * as an object payload, so this accepts no undocumented nested field aliases.
 * Unknown response shapes remain degraded-neutral and cannot block an order.
 */
export async function audit_junk_contract_candidate({
  nightwatch,
  decision,
  entry_plan,
  policy = {},
  now_ms = () => Date.now(),
} = {}) {
  if (typeof now_ms !== 'function') throw new TypeError('now_ms must be a function');
  const candidate_contract = normalized_contract(entry_plan?.contract?.code || entry_plan?.order?.code);
  const ticker = String(entry_plan?.signal?.ticker || decision?.ticker || '').trim().toUpperCase();
  const expiration = String(entry_plan?.contract?.expiration || entry_plan?.signal?.expiration || '').slice(0, 10);
  const source_path = ticker ? `/v1/options/chain-snapshot/${ticker}` : null;
  const base = contract_audit_base({ candidate_contract, source_path });
  if (decision?.decision !== 'trade') {
    return { ...base, assessment: 'skipped', reason_codes: ['no_trade_candidate_for_contract_audit'] };
  }
  if (entry_plan?.gate?.passed !== true) {
    return { ...base, assessment: 'skipped', reason_codes: ['entry_gate_failed_before_contract_audit'] };
  }
  if (policy.enabled === false) {
    return { ...base, assessment: 'skipped', reason_codes: ['nightwatch_contract_audit_disabled'] };
  }
  if (!nightwatch || typeof nightwatch.get_options_chain_snapshot !== 'function') {
    return { ...base, reason_codes: ['nightwatch_contract_audit_client_missing_neutral'] };
  }

  const expected = parse_osi_contract(candidate_contract);
  const expected_right = canonical_right(entry_plan?.signal?.option_type || decision?.option_selection?.option_right);
  const local_mismatches = [];
  if (!expected) local_mismatches.push('candidate_contract_not_valid_osi');
  if (expected && expiration && expected.expiration !== expiration) {
    local_mismatches.push('candidate_contract_expiration_mismatch');
  }
  if (expected && expected_right && expected.right !== expected_right) {
    local_mismatches.push('candidate_contract_right_mismatch');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) local_mismatches.push('candidate_expiration_invalid');
  if (local_mismatches.length > 0) {
    return {
      ...base,
      assessment: 'veto',
      advisory_only: false,
      can_veto_candidate: true,
      reason_codes: local_mismatches,
    };
  }

  const response = await nightwatch.get_options_chain_snapshot(ticker, {
    query: { expiration },
  });
  const observed_at_ms = Number(now_ms());
  if (!Number.isFinite(observed_at_ms)) throw new TypeError('now_ms returned a non-finite value');
  const observed_at = new Date(observed_at_ms).toISOString();
  const selected = safe_candidate_record(response, candidate_contract);
  const severe_stale_after_ms = Math.max(
    1_000,
    finite_number(policy.severe_stale_after_ms) ?? 300_000,
  );
  const evidence = evaluate_junk_contract_evidence({
    response,
    record: selected.record || undefined,
    source_path,
    candidate_contract,
    available_at: observed_at,
    evaluated_at: observed_at_ms,
    max_age_ms: severe_stale_after_ms,
    allowed_states: Array.isArray(policy.allowed_states) && policy.allowed_states.length > 0
      ? policy.allowed_states
      : DEFAULT_ALLOWED_STATES,
  });
  const explicit_record = selected.explicit_mismatch
    ? parse_osi_contract(selected.explicit_mismatch)
    : parse_osi_contract(selected.record?.contract);
  const explicit_mismatches = selected.explicit_mismatch
    ? mismatch_reason_codes({ expected, observed: explicit_record })
    : [];
  const veto_reasons = unique_strings([
    ...explicit_mismatches,
    ...(evidence.reason_codes.includes('candidate_contract_mismatch')
      ? ['nightwatch_contract_identity_mismatch']
      : []),
    ...(evidence.reason_codes.includes('evidence_stale')
      ? ['nightwatch_contract_evidence_severely_stale']
      : []),
  ]);
  if (veto_reasons.length > 0) {
    return {
      ...base,
      assessment: 'veto',
      advisory_only: false,
      can_veto_candidate: true,
      provider_call_count: 1,
      available_at: observed_at,
      state: evidence.state,
      record_schema: selected.record_schema,
      evidence,
      reason_codes: veto_reasons,
    };
  }
  if (evidence.usable) {
    return {
      ...base,
      assessment: 'confirm',
      advisory_only: false,
      provider_call_count: 1,
      available_at: observed_at,
      state: evidence.state,
      record_schema: selected.record_schema,
      evidence,
      reason_codes: ['nightwatch_contract_evidence_confirmed'],
    };
  }
  return {
    ...base,
    provider_call_count: 1,
    available_at: observed_at,
    state: evidence.state,
    record_schema: selected.record_schema,
    evidence,
    reason_codes: unique_strings([
      'nightwatch_contract_schema_or_freshness_unknown_neutral',
      ...evidence.reason_codes,
    ]),
  };
}

export function apply_junk_contract_audit({ decision, entry_plan, audit } = {}) {
  if (!decision || typeof decision !== 'object') throw new TypeError('decision is required');
  if (!entry_plan || typeof entry_plan !== 'object') throw new TypeError('entry_plan is required');
  const resolved_audit = audit && typeof audit === 'object'
    ? audit
    : degraded_junk_contract_audit({ reason_code: 'nightwatch_contract_audit_missing_neutral' });
  const veto = resolved_audit.assessment === 'veto';
  const confirm = resolved_audit.assessment === 'confirm';
  const neutral = resolved_audit.assessment === 'degraded_neutral';
  const evidence_model = decision.evidence_model && typeof decision.evidence_model === 'object'
    ? decision.evidence_model
    : {};
  const confirmations = unique_strings([
    ...(evidence_model.confirmations || []),
    ...(confirm ? ['nightwatch_contract_evidence_confirmed'] : []),
  ]);
  const vetoes = unique_strings([
    ...(evidence_model.vetoes || []),
    ...(veto ? ['nightwatch_contract_evidence_veto'] : []),
  ]);
  const audit_status_reason = veto
    ? 'nightwatch_contract_evidence_veto'
    : (confirm
      ? 'nightwatch_contract_evidence_confirmed'
      : (neutral ? 'nightwatch_contract_evidence_degraded_neutral' : null));
  const decision_result = {
    ...decision,
    decision: veto ? 'no_trade' : decision.decision,
    action: veto ? 'hold' : decision.action,
    reason_codes: unique_strings([
      ...(decision.reason_codes || []),
      audit_status_reason,
      ...(veto ? resolved_audit.reason_codes : []),
    ]),
    evidence_model: {
      ...evidence_model,
      contract_confirmation: resolved_audit,
      confirmations,
      vetoes,
    },
  };
  const gate_reasons = veto
    ? unique_strings([
      ...(entry_plan.gate?.reasons || []),
      'nightwatch_contract_evidence_veto',
      ...resolved_audit.reason_codes,
    ])
    : unique_strings(entry_plan.gate?.reasons || []);
  const entry_plan_result = {
    ...entry_plan,
    order_status: veto ? 'gate_failed' : entry_plan.order_status,
    gate: {
      ...(entry_plan.gate || {}),
      passed: veto ? false : entry_plan.gate?.passed === true,
      reasons: gate_reasons,
    },
    provenance: {
      ...(entry_plan.provenance || {}),
      nightwatch_contract_audit_used: !['skipped'].includes(resolved_audit.assessment),
      nightwatch_contract_audit_provider_called_this_cycle: resolved_audit.provider_call_count > 0,
      nightwatch_contract_audit_assessment: resolved_audit.assessment,
      nightwatch_contract_audit: resolved_audit,
    },
  };
  return { decision: decision_result, entry_plan: entry_plan_result };
}

export function junk_contract_audit_cache_key({ signal_id, contract, expiration } = {}) {
  const signal = String(signal_id || '').trim();
  const normalized = normalized_contract(contract);
  const contract_identity = parse_osi_contract(normalized)?.contract || normalized;
  const date = String(expiration || '').trim();
  if (!signal || !contract_identity || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return JSON.stringify([signal, contract_identity, date]);
}

export function read_junk_contract_audit_cache({
  cache,
  cache_key,
  now_ms = Date.now(),
} = {}) {
  const at_ms = timestamp_ms(now_ms);
  if (at_ms === null || !cache_key || !cache || typeof cache !== 'object') return null;
  const entry = cache[cache_key];
  if (!entry || typeof entry !== 'object' || !entry.audit || typeof entry.audit !== 'object') return null;
  const expires_at_ms = timestamp_ms(entry.expires_at);
  if (expires_at_ms === null || expires_at_ms <= at_ms) return null;
  return {
    ...entry.audit,
    cache_hit: true,
    provider_call_count: 0,
    cached_at: iso_timestamp(entry.cached_at),
    cache_expires_at: new Date(expires_at_ms).toISOString(),
    reason_codes: unique_strings([
      ...(entry.audit.reason_codes || []),
      'nightwatch_contract_audit_cache_hit',
    ]),
  };
}

export function write_junk_contract_audit_cache({
  cache,
  cache_key,
  audit,
  now_ms = Date.now(),
  ttl_ms = 60_000,
  max_entries = 100,
} = {}) {
  const at_ms = timestamp_ms(now_ms);
  const resolved_ttl_ms = Math.max(60_000, finite_number(ttl_ms) ?? 60_000);
  const resolved_max_entries = Math.max(1, Math.trunc(finite_number(max_entries) ?? 100));
  if (at_ms === null) throw new TypeError('now_ms must be a valid timestamp');
  if (!cache_key) throw new TypeError('cache_key is required');
  if (!audit || typeof audit !== 'object') throw new TypeError('audit is required');
  const next = {};
  for (const [key, entry] of Object.entries(cache && typeof cache === 'object' ? cache : {})) {
    if (timestamp_ms(entry?.expires_at) > at_ms && entry?.audit && typeof entry.audit === 'object') {
      next[key] = entry;
    }
  }
  next[cache_key] = {
    cached_at: new Date(at_ms).toISOString(),
    expires_at: new Date(at_ms + resolved_ttl_ms).toISOString(),
    audit,
  };
  const ordered = Object.entries(next)
    .sort((left, right) => timestamp_ms(right[1]?.cached_at) - timestamp_ms(left[1]?.cached_at))
    .slice(0, resolved_max_entries);
  return Object.fromEntries(ordered);
}
