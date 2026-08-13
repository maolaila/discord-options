import assert from 'node:assert/strict';
import test from 'node:test';
import {
  apply_junk_contract_audit,
  audit_junk_contract_candidate,
  junk_contract_audit_cache_key,
  evaluate_junk_api_evidence,
  evaluate_junk_contract_evidence,
  evaluate_junk_structure_evidence,
  read_junk_contract_audit_cache,
  write_junk_contract_audit_cache,
} from '../apps/zero-dte-options/junk-api-evidence.mjs';

const evaluated_at = '2026-08-11T14:31:00.000Z';
const available_at = '2026-08-11T14:30:31.000Z';

function contract_response(overrides = {}, meta = {}) {
  return {
    data: {
      contract: 'SPX260811C07750000',
      state: 'fresh',
      as_of: '2026-08-11T14:30:30.000Z',
      delta: 0.52,
      gamma: 0.03,
      theta: -0.18,
      vega: 0.06,
      implied_volatility: 0.24,
      open_interest: 1200,
      volume: 850,
      bid: 4,
      ask: 4.1,
      bid_size: 25,
      ask_size: 30,
      ...overrides,
    },
    _meta: meta,
  };
}

test('fresh candidate contract evidence exposes summaries but never invents direction', () => {
  const result = evaluate_junk_contract_evidence({
    response: contract_response(),
    source_path: '/v1/options/contract-intraday/SPX260811C07750000',
    candidate_contract: 'spx260811c07750000',
    available_at,
    evaluated_at,
    max_age_ms: 60_000,
  });

  assert.equal(result.usable, true);
  assert.equal(result.evidence_kind, 'contract');
  assert.equal(result.source_path, '/v1/options/contract-intraday/SPX260811C07750000');
  assert.equal(result.available_at, available_at);
  assert.equal(result.as_of, '2026-08-11T14:30:30.000Z');
  assert.equal(result.state, 'fresh');
  assert.deepEqual(result.reason_codes, []);
  assert.deepEqual(result.greeks_summary, {
    delta: 0.52,
    gamma: 0.03,
    theta: -0.18,
    vega: 0.06,
    implied_volatility: 0.24,
  });
  assert.deepEqual(result.oi_summary, {
    open_interest: 1200,
    settlement_lagged: true,
    intraday_directional_signal: false,
  });
  assert.deepEqual(result.volume_summary, { volume: 850 });
  assert.deepEqual(result.liquidity_summary, {
    bid: 4,
    ask: 4.1,
    bid_size: 25,
    ask_size: 30,
    mid_usd: 4.05,
    spread_usd: 0.1,
    relative_spread: 0.024691,
  });
  assert.equal(Object.hasOwn(result, 'direction'), false);
  assert.equal(Object.hasOwn(result, 'action'), false);
});

test('stale, disallowed-state, future, and mismatched candidate evidence fails closed', () => {
  const result = evaluate_junk_api_evidence({
    response: contract_response({
      contract: 'SPX260811P07750000',
      state: 'stale',
      as_of: '2026-08-11T14:20:00.000Z',
    }),
    source_path: '/v1/options/chain-snapshot/SPX?expiration=2026-08-11',
    candidate_contract: 'SPX260811C07750000',
    available_at: '2026-08-11T14:19:50.000Z',
    evaluated_at,
    max_age_ms: 60_000,
  });

  assert.equal(result.usable, false);
  assert.equal(result.source_path, '/v1/options/chain-snapshot/SPX');
  assert.ok(result.reason_codes.includes('state_not_allowed:stale'));
  assert.ok(result.reason_codes.includes('as_of_after_available_at'));
  assert.ok(result.reason_codes.includes('evidence_stale'));
  assert.ok(result.reason_codes.includes('candidate_contract_mismatch'));
});

test('available_at is mandatory and cannot be reconstructed from evaluation time', () => {
  const result = evaluate_junk_contract_evidence({
    response: contract_response(),
    source_path: '/v1/options/contract-greeks-series/SPX260811C07750000',
    candidate_contract: 'SPX260811C07750000',
    evaluated_at,
  });

  assert.equal(result.available_at, null);
  assert.equal(result.usable, false);
  assert.ok(result.reason_codes.includes('missing_or_invalid_available_at'));
});

test('array and unknown nested schemas are not heuristically reduced to a latest row', () => {
  const result = evaluate_junk_contract_evidence({
    response: {
      data: {
        state: 'fresh',
        as_of: '2026-08-11T14:30:30.000Z',
        rows: [contract_response().data],
      },
    },
    source_path: '/v1/options/contract-volume-profile/SPX260811C07750000',
    candidate_contract: 'SPX260811C07750000',
    available_at,
    evaluated_at,
  });

  assert.equal(result.usable, false);
  assert.ok(result.reason_codes.includes('candidate_contract_not_verified'));
  assert.equal(result.greeks_summary, null);
});

test('a caller may pass one endpoint-specific verified record without losing envelope as-of checks', () => {
  const verified_record = contract_response({ as_of: undefined }).data;
  const result = evaluate_junk_contract_evidence({
    response: {
      data: { state: 'fresh' },
      _meta: { as_of: '2026-08-11T14:30:30.000Z' },
    },
    record: verified_record,
    source_path: '/v1/options/atm-chains/SPX',
    candidate_contract: 'SPX260811C07750000',
    available_at,
    evaluated_at,
  });

  assert.equal(result.usable, true);
  assert.equal(result.as_of, '2026-08-11T14:30:30.000Z');
});

test('structure evidence accepts documented heatmap generated_at and has no contract requirement', () => {
  const result = evaluate_junk_structure_evidence({
    response: {
      data: {
        ticker: 'SPX',
        generated_at: '2026-08-11T14:30:30.000Z',
        state: 'fresh',
        cells: [],
      },
      _meta: { data_freshness_seconds: 1 },
    },
    source_path: '/v1/derived/heatmap/SPX/snapshot',
    available_at,
    evaluated_at,
  });

  assert.equal(result.usable, true);
  assert.equal(result.evidence_kind, 'structure');
  assert.equal(result.candidate_contract, null);
  assert.deepEqual(result.reason_codes, []);
});

test('unknown source, missing state, malformed liquidity, and unrecognized aliases stay unknown', () => {
  const result = evaluate_junk_api_evidence({
    response: {
      data: {
        contract: 'SPX260811C07750000',
        as_of: '2026-08-11T14:30:30.000Z',
        bid_price: 4,
        ask_price: 4.1,
        bid: 4.2,
        ask: 4.1,
        oi: 999,
      },
    },
    source_path: 'https://attacker.invalid/v1/options/contract-intraday/SPX260811C07750000',
    candidate_contract: 'SPX260811C07750000',
    available_at,
    evaluated_at,
  });

  assert.equal(result.source_path, null);
  assert.equal(result.state, 'unknown');
  assert.equal(result.oi_summary, null, 'the undocumented oi alias must not be guessed');
  assert.equal(result.liquidity_summary, null);
  assert.ok(result.reason_codes.includes('unknown_source_path'));
  assert.ok(result.reason_codes.includes('missing_or_unknown_state'));
  assert.ok(result.reason_codes.includes('invalid_liquidity_fields'));
});

test('invalid module policy inputs throw instead of silently weakening validation', () => {
  assert.throws(
    () => evaluate_junk_api_evidence({ allowed_states: [] }),
    /allowed_states must contain/,
  );
  assert.throws(
    () => evaluate_junk_api_evidence({ max_age_ms: -1 }),
    /max_age_ms must be a non-negative/,
  );
});

function candidate_decision(overrides = {}) {
  return {
    decision: 'trade',
    action: 'open_long_option',
    ticker: 'SPX',
    reason_codes: ['gex_node_confirmed'],
    evidence_model: { confirmations: [], vetoes: [] },
    ...overrides,
  };
}

function entry_plan(overrides = {}) {
  return {
    order_status: 'ready_for_simulation',
    gate: { passed: true, reasons: [] },
    signal: {
      signal_id: 'junk_gex_signal_a',
      ticker: 'SPX',
      expiration: '2026-08-11',
      option_type: 'C',
    },
    contract: {
      code: 'SPXW260811C07750000',
      expiration: '2026-08-11',
    },
    provenance: {},
    ...overrides,
  };
}

test('production audit makes exactly one chain call only for an orderable trade candidate', async () => {
  const calls = [];
  const nightwatch = {
    async get_options_chain_snapshot(ticker, options) {
      calls.push({ ticker, options });
      return contract_response({
        contract: 'SPXW260811C07750000',
        as_of: '2026-08-11T14:30:30.000Z',
      });
    },
  };
  const audit = await audit_junk_contract_candidate({
    nightwatch,
    decision: candidate_decision(),
    entry_plan: entry_plan(),
    now_ms: () => Date.parse(available_at),
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    ticker: 'SPX',
    options: { query: { expiration: '2026-08-11' } },
  });
  assert.equal(audit.assessment, 'confirm');
  assert.equal(audit.generates_direction, false);
  assert.equal(audit.provider_call_count, 1);
  assert.equal(Object.hasOwn(audit, 'direction'), false);

  const skipped_no_trade = await audit_junk_contract_candidate({
    nightwatch,
    decision: candidate_decision({ decision: 'no_trade' }),
    entry_plan: entry_plan(),
  });
  const skipped_gate = await audit_junk_contract_candidate({
    nightwatch,
    decision: candidate_decision(),
    entry_plan: entry_plan({ gate: { passed: false, reasons: ['quote_failed'] } }),
  });
  assert.equal(skipped_no_trade.assessment, 'skipped');
  assert.equal(skipped_gate.assessment, 'skipped');
  assert.equal(calls.length, 1, 'skipped candidates must not consume another API unit');
});

test('moomoo seven-digit strike code is normalized to the same strict OSI identity', async () => {
  const calls = [];
  const audit = await audit_junk_contract_candidate({
    nightwatch: {
      async get_options_chain_snapshot(ticker, options) {
        calls.push({ ticker, options });
        return contract_response({
          contract: 'SPXW260812P07745000',
          as_of: '2026-08-12T16:00:10.000Z',
        });
      },
    },
    decision: candidate_decision(),
    entry_plan: entry_plan({
      signal: {
        signal_id: 'junk_gex_signal_real_20260812_120010_et',
        ticker: 'SPX',
        expiration: '2026-08-12',
        option_type: 'P',
      },
      contract: {
        code: 'SPXW260812P7745000',
        expiration: '2026-08-12',
      },
    }),
    now_ms: () => Date.parse('2026-08-12T16:00:11.000Z'),
  });

  assert.equal(audit.assessment, 'confirm');
  assert.equal(audit.candidate_contract, 'SPXW260812P07745000');
  assert.equal(audit.evidence.candidate_contract, 'SPXW260812P07745000');
  assert.deepEqual(audit.reason_codes, ['nightwatch_contract_evidence_confirmed']);
  assert.deepEqual(calls, [{
    ticker: 'SPX',
    options: { query: { expiration: '2026-08-12' } },
  }]);

  const moomoo_key = junk_contract_audit_cache_key({
    signal_id: 'junk_gex_signal_real_20260812_120010_et',
    contract: 'SPXW260812P7745000',
    expiration: '2026-08-12',
  });
  const standard_osi_key = junk_contract_audit_cache_key({
    signal_id: 'junk_gex_signal_real_20260812_120010_et',
    contract: 'SPXW260812P07745000',
    expiration: '2026-08-12',
  });
  assert.equal(moomoo_key, standard_osi_key);
});

test('seven-digit normalization still rejects every wrong contract identity dimension', async () => {
  const mismatches = [
    ['root', 'SPX260812P07745000', 'nightwatch_contract_identity_mismatch'],
    ['expiration', 'SPXW260813P07745000', 'nightwatch_contract_expiration_mismatch'],
    ['right', 'SPXW260812C07745000', 'nightwatch_contract_right_mismatch'],
    ['strike', 'SPXW260812P07750000', 'nightwatch_contract_strike_mismatch'],
  ];

  for (const [dimension, observed_contract, expected_reason] of mismatches) {
    let call_count = 0;
    const audit = await audit_junk_contract_candidate({
      nightwatch: {
        async get_options_chain_snapshot() {
          call_count += 1;
          return contract_response({
            contract: observed_contract,
            as_of: '2026-08-12T16:00:10.000Z',
          });
        },
      },
      decision: candidate_decision(),
      entry_plan: entry_plan({
        signal: {
          signal_id: `junk_gex_wrong_${dimension}`,
          ticker: 'SPX',
          expiration: '2026-08-12',
          option_type: 'P',
        },
        contract: {
          code: 'SPXW260812P7745000',
          expiration: '2026-08-12',
        },
      }),
      now_ms: () => Date.parse('2026-08-12T16:00:11.000Z'),
    });

    assert.equal(call_count, 1, `${dimension} mismatch must use exactly one audited response`);
    assert.equal(audit.assessment, 'veto', `${dimension} mismatch must veto`);
    assert.equal(audit.can_veto_candidate, true);
    assert.ok(audit.reason_codes.includes('nightwatch_contract_identity_mismatch'));
    assert.ok(audit.reason_codes.includes(expected_reason));
  }
});

test('unknown chain schema is degraded-neutral while explicit identity mismatch and severe staleness veto', async () => {
  const unknown = await audit_junk_contract_candidate({
    nightwatch: {
      async get_options_chain_snapshot() {
        return {
          data: {
            state: 'fresh',
            as_of: '2026-08-11T14:30:30.000Z',
            contracts: [contract_response({ contract: 'SPXW260811C07750000' }).data],
          },
        };
      },
    },
    decision: candidate_decision(),
    entry_plan: entry_plan(),
    now_ms: () => Date.parse(available_at),
  });
  assert.equal(unknown.assessment, 'degraded_neutral');
  assert.equal(unknown.can_veto_candidate, false);
  assert.ok(unknown.reason_codes.includes('candidate_contract_not_verified'));

  const mismatch = await audit_junk_contract_candidate({
    nightwatch: {
      async get_options_chain_snapshot() {
        return contract_response({ contract: 'SPXW260811P07750000' });
      },
    },
    decision: candidate_decision(),
    entry_plan: entry_plan(),
    now_ms: () => Date.parse(available_at),
  });
  assert.equal(mismatch.assessment, 'veto');
  assert.ok(mismatch.reason_codes.includes('nightwatch_contract_right_mismatch'));

  const stale = await audit_junk_contract_candidate({
    nightwatch: {
      async get_options_chain_snapshot() {
        return contract_response({
          contract: 'SPXW260811C07750000',
          as_of: '2026-08-11T14:20:00.000Z',
        });
      },
    },
    decision: candidate_decision(),
    entry_plan: entry_plan(),
    policy: { severe_stale_after_ms: 300_000 },
    now_ms: () => Date.parse(available_at),
  });
  assert.equal(stale.assessment, 'veto');
  assert.ok(stale.reason_codes.includes('nightwatch_contract_evidence_severely_stale'));
});

test('contract audit application records decision and entry provenance without neutral outages blocking', () => {
  const neutral_audit = {
    assessment: 'degraded_neutral',
    provider_call_count: 1,
    reason_codes: ['nightwatch_contract_audit_service_unavailable_neutral'],
  };
  const neutral = apply_junk_contract_audit({
    decision: candidate_decision(),
    entry_plan: entry_plan(),
    audit: neutral_audit,
  });
  assert.equal(neutral.decision.decision, 'trade');
  assert.equal(neutral.entry_plan.gate.passed, true);
  assert.equal(neutral.decision.evidence_model.contract_confirmation.assessment, 'degraded_neutral');
  assert.equal(neutral.entry_plan.provenance.nightwatch_contract_audit_assessment, 'degraded_neutral');

  const veto = apply_junk_contract_audit({
    decision: candidate_decision(),
    entry_plan: entry_plan(),
    audit: {
      assessment: 'veto',
      provider_call_count: 1,
      reason_codes: ['nightwatch_contract_right_mismatch'],
    },
  });
  assert.equal(veto.decision.decision, 'no_trade');
  assert.equal(veto.entry_plan.gate.passed, false);
  assert.equal(veto.entry_plan.order_status, 'gate_failed');
  assert.ok(veto.entry_plan.gate.reasons.includes('nightwatch_contract_right_mismatch'));
});

test('persistable contract audit cache suppresses repeat calls for the same setup for at least 60 seconds', () => {
  const key = junk_contract_audit_cache_key({
    signal_id: 'junk_gex_signal_a',
    contract: 'SPXW260811C07750000',
    expiration: '2026-08-11',
  });
  const at_ms = Date.parse('2026-08-11T14:31:00.000Z');
  const cache = write_junk_contract_audit_cache({
    cache: {},
    cache_key: key,
    audit: { assessment: 'confirm', provider_call_count: 1, reason_codes: [] },
    now_ms: at_ms,
    ttl_ms: 1,
  });
  const hit = read_junk_contract_audit_cache({ cache, cache_key: key, now_ms: at_ms + 59_999 });
  const expired = read_junk_contract_audit_cache({ cache, cache_key: key, now_ms: at_ms + 60_000 });
  assert.equal(hit.assessment, 'confirm');
  assert.equal(hit.cache_hit, true);
  assert.equal(hit.provider_call_count, 0);
  assert.equal(expired, null);
});
