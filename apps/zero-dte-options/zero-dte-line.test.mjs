import assert from 'node:assert/strict';
import test from 'node:test';
import {
  apply_broker_order_identity,
  apply_exit_cumulative_fill,
  apply_exit_management_update,
  apply_experiment_filled_management,
  apply_junk_gex_freshness_gate,
  advance_junk_experiment_exit_latch,
  arm_junk_experiment_unpriced_force_close,
  block_unresolved_submission,
  broker_order_identity,
  broker_order_keys,
  build_exit_attempt_remark,
  create_moomoo_runtime,
  classify_nightwatch_fixed_sample_error,
  directional_chain_retry_delay_ms,
  directional_chain_retry_key,
  expired_entry_without_broker_evidence,
  expired_settlement_missing,
  exit_owned_position,
  experiment_unpriced_incident_blocks_new_entry,
  fresh_last_gex_spot,
  has_broker_order_identity,
  heatmap_summary,
  is_simulated_fill_history_unsupported,
  junk_experiment_entry_risk_state,
  junk_oi_background_refresh_due,
  junk_experiment_ownership_rows,
  junk_experiment_ownership_invariant,
  junk_experiment_unpriced_emergency_window,
  finalize_junk_experiment_entry_if_terminal,
  junk_experiment_manifest_conflicts,
  build_junk_experiment_entry_cohort,
  resolve_junk_experiment_entry_fill,
  is_terminal_broker_order,
  is_terminal_unfilled_broker_order,
  live_entry_remainder_pending,
  market_schedule,
  observed_exit_attempt_no,
  provider_backoff_cycle_delay,
  provider_account_backoff_ms,
  prove_junk_experiment_unpriced_force_close_ownership,
  recovery_source_on_load,
  recompute_session_risk,
  seed_recovered_active_exit_accounting,
  untrusted_state_requires_recovery_block,
  unresolved_exit_recovery_required,
} from './zero-dte-line.mjs';
import { apply_junk_v3_evidence } from './junk-trading-model-v2.mjs';
import {
  apply_junk_experiment_exit_cumulative_fill,
  begin_junk_experiment_exit_batch,
  create_junk_experiment_ledger,
} from './junk-exit-experiment.mjs';

const policy = {
  strategy: {
    entry_start_time_et: '09:45',
    entry_cutoff_time_et: '15:15',
  },
  exit_rules: {
    close_exit_start_time_et: '15:30',
    force_close_exit_start_time_et: '15:45',
  },
  market_calendar: {
    valid_through_et: '2026-12-31',
    closed_dates_et: ['2026-09-07'],
    early_close_dates_et: ['2026-11-27'],
    early_close_exit_start_time_et: '12:30',
    early_force_close_exit_start_time_et: '12:45',
    early_session_close_time_et: '13:00',
  },
};

function ny(date_key, minutes, weekday = 'Mon') {
  return {
    date_key,
    weekday,
    minutes,
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    second: 0,
  };
}

test('runtime GEX freshness assessment is a hard entry gate', () => {
  const candidate = {
    decision: 'trade',
    action: 'buy_call',
    reason_codes: ['valid_structure'],
  };

  assert.equal(
    apply_junk_gex_freshness_gate(candidate, { readiness: 'ready', reason_codes: [] }),
    candidate,
  );

  const missing_meta = apply_junk_gex_freshness_gate(candidate, {
    readiness: 'not_ready',
    reason_codes: ['missing_or_invalid_meta_freshness'],
  });
  assert.equal(missing_meta.decision, 'no_trade');
  assert.equal(missing_meta.action, 'hold');
  assert.ok(missing_meta.reason_codes.includes(
    'gex_freshness_not_ready:missing_or_invalid_meta_freshness',
  ));

  const missing_assessment = apply_junk_gex_freshness_gate(candidate, null);
  assert.equal(missing_assessment.decision, 'no_trade');
  assert.ok(missing_assessment.reason_codes.includes(
    'gex_freshness_not_ready:missing_assessment',
  ));
});

test('JUNKMAN startup passes an explicit OpenD login timeout and closes cleanly', async () => {
  let connect_options = null;
  let connection_close_count = 0;
  let quote_close_count = 0;
  const account = { accID: 'sim-options', trdEnv: 0, simAccType: 4 };
  const runtime = await create_moomoo_runtime({}, {
    load_config: () => ({ trdEnv: 0 }),
    connect: async (_config, options) => {
      connect_options = options;
      return {
        client: {},
        close: () => { connection_close_count += 1; },
      };
    },
    fetch_accounts: async () => ({ s2c: { accList: [account] } }),
    select_account: () => account,
    create_quote_feed: () => ({
      close: async () => { quote_close_count += 1; },
    }),
  });

  assert.equal(connect_options.timeoutMs, 25_000);
  await runtime.close();
  assert.equal(quote_close_count, 1);
  assert.equal(connection_close_count, 1);
});

test('JUNKMAN startup bounds GetAccList and releases OpenD on timeout', async () => {
  let connection_close_count = 0;
  await assert.rejects(
    create_moomoo_runtime({}, {
      load_config: () => ({ trdEnv: 0 }),
      connect: async () => ({
        client: {},
        close: () => { connection_close_count += 1; },
      }),
      fetch_accounts: async () => new Promise(() => {}),
      accounts_timeout_ms: 5,
    }),
    /JUNKMAN OpenD GetAccList startup timed out after 5ms/,
  );
  assert.equal(connection_close_count, 1);
});

function experimentRow({ filled_qty = 10 } = {}) {
  const lines = Array.from({ length: 7 }, (_, index) => ({
    line_id: `line_${index + 1}`,
    label: `Line ${index + 1}`,
    control: index === 0,
    exit_profile: {
      catastrophic_stop_loss_pct: 15,
      option_stop_loss_pct: 15,
      option_take_profit_enabled: false,
      option_take_profit_pct: 25,
    },
    exit_profile_hash: `hash_${index + 1}`,
  }));
  return {
    plan_id: 'zero_dte_experiment_test',
    filled_qty,
    exited_qty: 0,
    entry_fill_price: 2,
    exit_fill_value: 0,
    exit_order_accounted_fill_value: 0,
    experiment_ledger: create_junk_experiment_ledger({
      experiment_id: 'junk_exit_grid_test',
      version: 1,
      manifest_hash: 'manifest_test',
      cohort_id: 'junk_cohort_test',
      control_line_id: 'line_1',
      per_line_entry_qty: 2,
      aggregate_entry_qty: 14,
      lines,
    }, new Date('2026-08-10T14:30:00.000Z')),
  };
}

test('daily OI background refresh runs once per session and retries only on cadence', () => {
  const schedule = market_schedule(policy, ny('2026-08-13', 10 * 60, 'Thu'));
  const common = {
    session_date_et: '2026-08-13',
    ny: ny('2026-08-13', 10 * 60, 'Thu'),
    schedule,
    policy: {
      enabled: true,
      refresh_start_time_et: '08:30',
      refresh_cutoff_time_et: '15:00',
      refresh_retry_minutes: 15,
    },
    now_ms: Date.parse('2026-08-13T14:00:00.000Z'),
  };
  assert.deepEqual(junk_oi_background_refresh_due({
    ...common,
    background: null,
    refresh_state: null,
  }), { due: true, reason: 'current_session_context_missing' });
  assert.deepEqual(junk_oi_background_refresh_due({
    ...common,
    background: { usable: true, oi_effective_date: '2026-08-13' },
    refresh_state: null,
  }), { due: false, reason: 'current_session_already_loaded' });
  assert.deepEqual(junk_oi_background_refresh_due({
    ...common,
    background: null,
    refresh_state: { attempted_at: '2026-08-13T13:50:00.000Z' },
  }), { due: false, reason: 'retry_interval_not_elapsed' });
  assert.deepEqual(junk_oi_background_refresh_due({
    ...common,
    ny: ny('2026-08-13', 15 * 60 + 1, 'Thu'),
    background: null,
    refresh_state: null,
  }), { due: false, reason: 'outside_refresh_window' });
});

test('real heatmap cells aggregate across expirations by strike and rank by gross absolute GEX', () => {
  const now_ms = Date.parse('2026-08-13T14:30:30.000Z');
  const summary = heatmap_summary({
    data: {
      ticker: 'SPX',
      generated_at: '2026-08-13T14:30:00.000Z',
      session_date_et: '2026-08-13',
      spot_usd: 7_800,
      expirations: ['2026-08-13', '2026-08-14'],
      cells: [
        { expiration: '2026-08-13', strike_usd: 7_815, net_dealer_gex_usd: 100 },
        { expiration: '2026-08-14', strike_usd: 7_815, net_dealer_gex_usd: -40 },
        { expiration: '2026-08-13', strike_usd: 7_800, net_dealer_gex_usd: 90 },
        { expiration: 'not-a-date', strike_usd: 7_790, net_dealer_gex_usd: 10_000 },
        { expiration: '2026-08-13', strike_usd: 0, net_dealer_gex_usd: 10_000 },
        { expiration: '2026-08-13', strike_usd: 7_790, net_dealer_gex_usd: null },
      ],
    },
    _meta: { data_freshness_seconds: 30 },
  }, { now_ms, max_age_ms: 600_000 });

  assert.equal(summary.state, 'fresh');
  assert.equal(summary.state_reason, 'heatmap_fresh');
  assert.equal(summary.source_schema, 'cells');
  assert.equal(summary.spot_usd, 7_800);
  assert.deepEqual(summary.top_rows, [
    {
      strike_usd: 7_815,
      row_net_wall_gex_usd: 60,
      row_abs_wall_gex_usd: 140,
      rank: 1,
      expiration_count: 2,
      cell_count: 2,
      source_schema: 'cells',
    },
    {
      strike_usd: 7_800,
      row_net_wall_gex_usd: 90,
      row_abs_wall_gex_usd: 90,
      rank: 2,
      expiration_count: 1,
      cell_count: 1,
      source_schema: 'cells',
    },
  ]);

  const still_no_trade = apply_junk_v3_evidence({
    core_decision: {
      decision: 'no_trade',
      action: 'hold',
      reason_codes: ['snapshot_stale'],
    },
    heatmap_context: summary,
    flow_evaluation: { decision: 'neutral' },
    evidence_policy: { heatmap: { enabled: true, max_age_ms: 600_000 } },
    now_ms,
  });
  assert.equal(still_no_trade.decision, 'no_trade');
  assert.equal(still_no_trade.action, 'hold');
  assert.ok(still_no_trade.reason_codes.includes('snapshot_stale'));
  assert.deepEqual(still_no_trade.evidence_model.confirmations, []);
});

test('heatmap accepts the latest fixed sample through ten minutes and fails closed after it', () => {
  const now_ms = Date.parse('2026-08-13T14:40:00.000Z');
  const base = {
    data: {
      generated_at: '2026-08-13T14:30:00.000Z',
      session_date_et: '2026-08-13',
      spot_usd: 7_800,
      cells: [{ expiration: '2026-08-13', strike_usd: 7_800, net_dealer_gex_usd: 100 }],
    },
  };
  const boundary = heatmap_summary({
    ...base,
    _meta: { data_freshness_seconds: 600 },
  }, { now_ms, max_age_ms: 600_000 });
  assert.equal(boundary.state, 'fresh');

  const stale_meta = heatmap_summary({
    ...base,
    _meta: { data_freshness_seconds: 600.001 },
  }, { now_ms, max_age_ms: 600_000 });
  assert.equal(stale_meta.state, 'stale');
  assert.equal(stale_meta.state_reason, 'heatmap_age_exceeded');

  const missing_meta = heatmap_summary(base, { now_ms, max_age_ms: 600_000 });
  assert.equal(missing_meta.state, 'invalid');
  assert.equal(missing_meta.state_reason, 'heatmap_meta_freshness_invalid');

  const stale_timestamp = heatmap_summary({
    data: { ...base.data, generated_at: '2026-08-13T14:29:59.999Z' },
    _meta: { data_freshness_seconds: 1 },
  }, { now_ms, max_age_ms: 600_000 });
  assert.equal(stale_timestamp.state, 'stale');
  assert.equal(stale_timestamp.state_reason, 'heatmap_age_exceeded');

  const cross_session = heatmap_summary({
    data: {
      ...base.data,
      generated_at: '2026-08-12T19:59:30.000Z',
      session_date_et: '2026-08-12',
      cells: [{ expiration: '2026-08-13', strike_usd: 7_800, net_dealer_gex_usd: 100 }],
    },
  }, { now_ms, max_age_ms: 24 * 60 * 60 * 1_000 });
  assert.equal(cross_session.state, 'stale');
  assert.equal(cross_session.state_reason, 'heatmap_cross_session');
});

test('undocumented legacy rows and malformed or missing official cells remain neutral', () => {
  const now_ms = Date.parse('2026-08-13T14:30:30.000Z');
  const legacy = heatmap_summary({
    data: {
      generated_at: '2026-08-13T14:30:00.000Z',
      session_date_et: '2026-08-13',
      state: 'fresh',
      spot_usd: 7_800,
      row_stacks: [
        { strike_usd: 7_810, row_net_wall_gex_usd: -25, row_abs_wall_gex_usd: 25, rank: 2 },
        { strike_usd: 7_800, row_net_wall_gex_usd: 50, row_abs_wall_gex_usd: 50, rank: 1 },
      ],
    },
  }, { now_ms, max_age_ms: 600_000 });
  assert.equal(legacy.state, 'missing');
  assert.equal(legacy.source_schema, 'missing');
  assert.equal(legacy.top_rows, null);

  const invalid = heatmap_summary({
    data: {
      generated_at: '2026-08-13T14:30:00.000Z',
      session_date_et: '2026-08-13',
      cells: [
        { expiration: 'invalid', strike_usd: 7_800, net_dealer_gex_usd: 100 },
        { expiration: '2026-08-13', strike_usd: 'bad', net_dealer_gex_usd: 100 },
        { expiration: '2026-08-13', strike_usd: 7_800, net_dealer_gex_usd: null },
      ],
    },
  }, { now_ms, max_age_ms: 600_000 });
  assert.equal(invalid.state, 'invalid');
  assert.equal(invalid.state_reason, 'heatmap_rows_invalid');
  assert.deepEqual(invalid.top_rows, []);

  const missing = heatmap_summary({
    data: {
      generated_at: '2026-08-13T14:30:00.000Z',
      session_date_et: '2026-08-13',
    },
  }, { now_ms, max_age_ms: 600_000 });
  assert.equal(missing.state, 'missing');
  assert.equal(missing.state_reason, 'heatmap_rows_missing');
  assert.equal(missing.top_rows, null);

  const neutral = apply_junk_v3_evidence({
    core_decision: {
      decision: 'trade',
      action: 'open_long_option',
      reason_codes: ['gex_node_confirmed'],
      tested_node: { strike_usd: 7_800 },
    },
    heatmap_context: invalid,
    flow_evaluation: { decision: 'neutral' },
    evidence_policy: {
      heatmap: { enabled: true, max_age_ms: 600_000, require_ranked_node_when_fresh: true },
    },
    now_ms,
  });
  assert.equal(neutral.decision, 'trade');
  assert.equal(neutral.evidence_model.heatmap.assessment, 'neutral');
  assert.deepEqual(neutral.evidence_model.vetoes, []);
});

test('exit management state persists into the next round and arms only once', () => {
  const row = {
    plan_id: 'zero_dte_management_state',
    code: 'SPXW260810C07750000',
    expiration: '2026-08-10',
    filled_qty: 1,
    exited_qty: 0,
    entry_fill_price: 5,
  };

  assert.deepEqual(
    {
      peak_option_return_pct: exit_owned_position(row).peak_option_return_pct,
      breakeven_armed: exit_owned_position(row).breakeven_armed,
    },
    { peak_option_return_pct: null, breakeven_armed: false },
  );

  const first = apply_exit_management_update(row, {
    option_return_pct: 22,
    peak_option_return_pct: 22,
    breakeven_armed: true,
  });
  assert.equal(first.newly_armed, true);
  assert.equal(exit_owned_position(row).peak_option_return_pct, 22);
  assert.equal(exit_owned_position(row).breakeven_armed, true);

  const next = apply_exit_management_update(row, {
    option_return_pct: 10,
    peak_option_return_pct: 18,
    breakeven_armed: false,
  });
  assert.deepEqual(next, {
    option_return_pct: 10,
    peak_option_return_pct: 22,
    breakeven_armed: true,
    newly_armed: false,
  });
  assert.equal(exit_owned_position(row).peak_option_return_pct, 22);
  assert.equal(exit_owned_position(row).breakeven_armed, true);
});

test('legacy rows without management fields remain safe when no update is available', () => {
  const row = {};
  assert.deepEqual(apply_exit_management_update(row, undefined), {
    option_return_pct: null,
    peak_option_return_pct: null,
    breakeven_armed: false,
    newly_armed: false,
  });
  assert.equal(exit_owned_position(row).peak_option_return_pct, null);
  assert.equal(exit_owned_position(row).breakeven_armed, false);
});

test('submit-failed status is terminal for both entry and exit reconciliation', () => {
  assert.equal(is_terminal_broker_order(3), true);
  assert.equal(is_terminal_unfilled_broker_order(3), true);
  assert.equal(is_terminal_broker_order(4), false, 'unknown submission status must remain recovery-blocked');
});

test('market schedule fails closed on holidays and after calendar expiry', () => {
  assert.equal(market_schedule(policy, ny('2026-09-07', 10 * 60)).closed, true);
  assert.equal(market_schedule(policy, ny('2027-01-04', 10 * 60)).calendar_valid, false);
  assert.equal(market_schedule(policy, ny('2027-01-04', 10 * 60)).entry_open, false);
});

test('market schedule consumes the JUNK strategy entry window and stops before exit management', () => {
  assert.equal(market_schedule(policy, ny('2026-08-10', 9 * 60 + 44)).entry_open, false);
  assert.equal(market_schedule(policy, ny('2026-08-10', 9 * 60 + 45)).entry_open, true);
  assert.equal(market_schedule(policy, ny('2026-08-10', 15 * 60 + 14)).entry_open, true);
  assert.equal(market_schedule(policy, ny('2026-08-10', 15 * 60 + 15)).entry_open, false);
});

test('early-close calendar advances normal and force exits before the session close', () => {
  const schedule = market_schedule(policy, ny('2026-11-27', 12 * 60 + 46, 'Fri'));
  assert.equal(schedule.early_close, true);
  assert.equal(schedule.close_exit_start_minutes, 12 * 60 + 30);
  assert.equal(schedule.force_close_start_minutes, 12 * 60 + 45);
  assert.equal(schedule.session_close_minutes, 13 * 60);
  assert.equal(schedule.market_open, true);
});

test('unpriced emergency submission is same-session force-close only', () => {
  const regularBeforeForce = market_schedule(policy, ny('2026-08-10', 15 * 60 + 44));
  assert.equal(junk_experiment_unpriced_emergency_window({
    schedule: regularBeforeForce,
    force_close: false,
    expiration: '2026-08-10',
    session_date_et: '2026-08-10',
  }), false);

  const regularForce = market_schedule(policy, ny('2026-08-10', 15 * 60 + 45));
  assert.equal(junk_experiment_unpriced_emergency_window({
    schedule: regularForce,
    force_close: true,
    expiration: '2026-08-10',
    session_date_et: '2026-08-10',
  }), true);

  const earlyForce = market_schedule(policy, ny('2026-11-27', 12 * 60 + 45, 'Fri'));
  assert.equal(junk_experiment_unpriced_emergency_window({
    schedule: earlyForce,
    force_close: true,
    expiration: '2026-11-27',
    session_date_et: '2026-11-27',
  }), true);

  assert.equal(junk_experiment_unpriced_emergency_window({
    schedule: regularForce,
    force_close: true,
    expiration: '2026-08-09',
    session_date_et: '2026-08-10',
  }), false, 'an expired cross-session incident requires manual reconciliation');
  assert.equal(junk_experiment_unpriced_emergency_window({
    schedule: { ...regularForce, market_open: false },
    force_close: true,
    expiration: '2026-08-10',
    session_date_et: '2026-08-10',
  }), false, 'market-open state is independently required');
});

test('partial exit cumulative average changes do not double count proceeds', () => {
  const row = {
    filled_qty: 2,
    exited_qty: 0,
    exit_base_exited_qty: 0,
    exit_fill_value: 0,
    exit_order_accounted_fill_value: 0,
  };
  apply_exit_cumulative_fill(row, { qty: 1, avg_price: 10, value: 10 });
  assert.equal(row.exited_qty, 1);
  assert.equal(row.exit_fill_value, 10);

  apply_exit_cumulative_fill(row, { qty: 2, avg_price: 8, value: 16 });
  assert.equal(row.exited_qty, 2);
  assert.equal(row.exit_fill_value, 16);
  assert.equal(row.exit_fill_value / row.exited_qty, 8);
});

test('broker-first structure checks reject stale or cross-session GEX spot', () => {
  const state = {
    last_gex: {
      state: 'fresh',
      snapshot_at: '2026-08-10T14:30:00.000Z',
      session_date_et: '2026-08-10',
      spot_usd: 5000,
    },
  };
  assert.equal(fresh_last_gex_spot(state, new Date('2026-08-10T14:30:20.000Z')), 5000);
  assert.equal(fresh_last_gex_spot({
    ...state,
    last_gex: { ...state.last_gex, state: 'degraded' },
  }, new Date('2026-08-10T14:30:20.000Z')), null);
  assert.equal(fresh_last_gex_spot(state, new Date('2026-08-10T14:40:00.000Z')), 5000);
  assert.equal(fresh_last_gex_spot(state, new Date('2026-08-10T14:40:00.001Z')), null);
  assert.equal(fresh_last_gex_spot(state, new Date('2026-08-11T14:30:10.000Z')), null);
});

test('risk is rebuilt idempotently from accepted broker order ownership', () => {
  const state = {
    session_date_et: '2026-08-10',
    orders: {
      first: {
        expiration: '2026-08-10',
        entry_order_id_ex: 'A',
        entry_submitted_at: '2026-08-10T14:00:00.000Z',
        signal_id: 'signal-a',
        status: 'closed',
        realized_pnl_usd: 25,
      },
      second: {
        expiration: '2026-08-10',
        entry_order_id_ex: 'B',
        entry_submitted_at: '2026-08-10T14:15:00.000Z',
        signal_id: 'signal-b',
        status: 'open',
      },
    },
    executed_signal_ids: [],
  };
  const risk = recompute_session_risk(state);
  assert.equal(risk.daily_trade_count, 2);
  assert.equal(risk.last_entry_at, '2026-08-10T14:15:00.000Z');
  assert.equal(risk.daily_realized_pnl_usd, 25);
  recompute_session_risk(state);
  assert.equal(state.daily_trade_count, 2);
});

test('an unknown broker submission never auto-unlocks into a retry', () => {
  const entry = { status: 'entry_submission_unknown', entry_order_missing_cycles: 0 };
  const exit = { status: 'exit_submission_unknown', exit_order_missing_cycles: 0 };
  for (let index = 0; index < 100; index += 1) {
    block_unresolved_submission(entry, 'entry', new Date('2026-08-10T14:31:00.000Z'));
    block_unresolved_submission(exit, 'exit', new Date('2026-08-10T14:31:00.000Z'));
  }
  assert.equal(entry.status, 'entry_submission_unknown');
  assert.equal(exit.status, 'exit_submission_unknown');
  assert.equal(entry.last_error, 'entry_submission_outcome_unknown_recovery_blocked');
  assert.equal(exit.last_error, 'exit_submission_outcome_unknown_recovery_blocked');
});

test('broker submission identity accepts orderID or orderIDEx but never invents one', () => {
  assert.deepEqual(broker_order_identity({ orderID: 123 }), { order_id: '123', order_id_ex: null });
  assert.deepEqual(broker_order_identity({ orderIDEx: 'ABC' }), { order_id: null, order_id_ex: 'ABC' });
  assert.deepEqual(broker_order_keys({ orderID: 123, orderIDEx: 'ABC' }), ['ex:ABC', 'id:123']);
  assert.equal(has_broker_order_identity({ broker_order_id: '123' }), true);
  assert.equal(has_broker_order_identity({ broker_order_id_ex: 'ABC' }), true);
  assert.equal(has_broker_order_identity({}), false);
  const row = {};
  apply_broker_order_identity(row, 'entry', { broker_order_id: '123' });
  apply_broker_order_identity(row, 'entry', { broker_order_id_ex: 'ABC' });
  assert.equal(row.entry_order_id, '123');
  assert.equal(row.entry_order_id_ex, 'ABC');
});

test('each exit retry gets a distinct recoverable remark', () => {
  const first = build_exit_attempt_remark('zero_dte_0123456789abcdef0123', 1);
  const second = build_exit_attempt_remark('zero_dte_0123456789abcdef0123', 2);
  assert.notEqual(first, second);
  assert.match(first, /^junk_gex_exit:.*:1$/);
  assert.match(second, /^junk_gex_exit:.*:2$/);
  assert.ok(first.length <= 60);
  assert.equal(observed_exit_attempt_no('zero_dte_0123456789abcdef0123', [
    { remark: first },
    { remark: second },
    { remark: 'junk_gex_exit:someone_else:99' },
  ]), 2);
});

test('startup recovery never unlocks an unresolved current exit without broker evidence', () => {
  const unknown = {
    status: 'exit_submission_unknown',
    exit_remark: build_exit_attempt_remark('zero_dte_0123456789abcdef0123', 2),
  };
  assert.equal(unresolved_exit_recovery_required(unknown, []), true);
  assert.equal(unresolved_exit_recovery_required(unknown, [{ orderStatus: 3 }]), false);
  assert.equal(unresolved_exit_recovery_required({
    status: 'recovery_blocked',
    exit_order_id: '123',
  }, []), true);
  assert.equal(unresolved_exit_recovery_required({ status: 'open' }, []), false);
});

test('simulation fill-history unsupported response accepts live plain-object shape only in simulation', () => {
  const response = { retType: -1, errCode: 0, retMsg: '模拟交易不支持成交数据', s2c: {} };
  assert.equal(is_simulated_fill_history_unsupported(response, 0), true);
  assert.equal(is_simulated_fill_history_unsupported(response, 1), false);
  assert.equal(is_simulated_fill_history_unsupported({ retType: -1, retMsg: 'permission denied' }, 0), false);
});

test('recovered active partial exit does not count the same cumulative fill twice', () => {
  const row = { filled_qty: 2, exited_qty: 0, exit_fill_value: 0 };
  seed_recovered_active_exit_accounting(row, 1, 10, { qty: 1, avg_price: 10, value: 10 });
  assert.equal(row.exited_qty, 1);
  assert.equal(row.exit_base_exited_qty, 0);
  assert.equal(row.exit_order_accounted_fill_value, 10);
  apply_exit_cumulative_fill(row, { qty: 1, avg_price: 10, value: 10 });
  assert.equal(row.exited_qty, 1);
  assert.equal(row.exit_fill_value, 10);
});

test('partial entry remainder must become terminal before an exit can be submitted', () => {
  const row = { submitted_qty: 2, filled_qty: 1 };
  assert.equal(live_entry_remainder_pending(row, { orderStatus: 10 }), true);
  assert.equal(live_entry_remainder_pending(row, { orderStatus: 14 }), false);
  assert.equal(live_entry_remainder_pending({ submitted_qty: 2, filled_qty: 2 }, { orderStatus: 10 }), false);
});

test('expired active rows treat a zero-quantity broker position as settled and non-blocking', () => {
  const row = { expiration: '2026-08-10', filled_qty: 1, exited_qty: 0 };
  assert.equal(expired_settlement_missing(row, null, '2026-08-11'), true);
  assert.equal(expired_settlement_missing(row, { qty: 0, canSellQty: 0 }, '2026-08-11'), true);
  assert.equal(expired_settlement_missing(row, { qty: 1, canSellQty: 1 }, '2026-08-11'), false);
  assert.equal(expired_settlement_missing(row, null, '2026-08-10'), false);
});

test('an expired entry intent with no order, fill, or position evidence stops occupying risk', () => {
  const row = { expiration: '2026-08-10', filled_qty: 0, exited_qty: 0 };
  assert.equal(expired_entry_without_broker_evidence(row, null, '2026-08-11'), true);
  assert.equal(expired_entry_without_broker_evidence(row, { qty: 0 }, '2026-08-11'), true);
  assert.equal(expired_entry_without_broker_evidence(row, { qty: 1 }, '2026-08-11'), false);
  assert.equal(expired_entry_without_broker_evidence(row, null, '2026-08-10'), false);
  assert.equal(expired_entry_without_broker_evidence({ ...row, filled_qty: 1 }, null, '2026-08-11'), false);
});

test('new or corrupt local state fails closed when simulated option positions are unowned', () => {
  assert.equal(untrusted_state_requires_recovery_block('new', 1), true);
  assert.equal(untrusted_state_requires_recovery_block('backup', 1), true);
  assert.equal(untrusted_state_requires_recovery_block('corrupt_fail_closed', 1), true);
  assert.equal(untrusted_state_requires_recovery_block('primary', 1), false);
  assert.equal(untrusted_state_requires_recovery_block('corrupt_fail_closed', 0), false);
  const blocked = {
    status: 'blocked',
    source_state: 'corrupt_fail_closed',
    error_code: 'unowned_simulated_option_positions_with_untrusted_local_state',
  };
  assert.equal(recovery_source_on_load(blocked, 'primary'), 'corrupt_fail_closed');
  assert.equal(recovery_source_on_load({ ...blocked, source_state: 'backup' }, 'primary'), 'backup');
  assert.equal(recovery_source_on_load({ ...blocked, status: 'complete', error_code: null }, 'primary'), 'primary');
});

test('provider Retry-After never slows broker-first exit cadence below the configured poll', () => {
  assert.equal(provider_backoff_cycle_delay(15_000, 120_000), 15_000);
  assert.equal(provider_backoff_cycle_delay(15_000, 5_000), 5_000);
  assert.equal(provider_backoff_cycle_delay(15_000, 0), 15_000);
});

test('materializing option chains honor official Retry-After without blocking broker polling', () => {
  assert.equal(directional_chain_retry_delay_ms({ retry_after_seconds: 7 }), 7_000);
  assert.equal(directional_chain_retry_delay_ms({ _meta: { retry_after_seconds: 12 } }), 12_000);
  assert.equal(directional_chain_retry_delay_ms({}), 300_000);
  assert.equal(directional_chain_retry_delay_ms({}, 15_000), 15_000);
  assert.equal(directional_chain_retry_delay_ms({}, 300_000), 300_000);
  assert.equal(directional_chain_retry_delay_ms({ retry_after_seconds: 900 }), 900_000);
  assert.equal(
    directional_chain_retry_key({
      ticker: 'spx',
      expiration: '2026-08-14',
      gex_snapshot_at: '2026-08-14T14:30:00.000Z',
    }),
    directional_chain_retry_key({
      ticker: 'SPX',
      expiration: '2026-08-14',
      gex_snapshot_at: '2026-08-14T14:35:00.000Z',
    }),
    'a new GEX bucket must not change the option-chain Retry-After identity',
  );
});

test('fixed-sample errors branch on the official stable machine code', () => {
  assert.equal(classify_nightwatch_fixed_sample_error({
    status: 503,
    error_code: 'READ_MODEL_UNAVAILABLE',
  }), 'read_model_unavailable');
  assert.equal(classify_nightwatch_fixed_sample_error({
    status: 503,
    error_code: 'SERVICE_DISABLED',
  }), 'service_disabled');
  assert.equal(classify_nightwatch_fixed_sample_error({
    status: 429,
    error_code: 'RATE_LIMITED',
  }), 'account_backoff');
  assert.equal(classify_nightwatch_fixed_sample_error({ status: 503 }), 'error');
});

test('account-level 429 never falls into a hot retry when Retry-After is absent', () => {
  assert.equal(provider_account_backoff_ms({ status: 429, retry_after_ms: 30_000 }), 30_000);
  assert.equal(provider_account_backoff_ms({ status: 429, retry_after_ms: null }), 300_000);
  assert.equal(provider_account_backoff_ms({ status: 503, retry_after_ms: null }), 0);
});

test('experiment entry allocation waits for terminal buy state and finalizes equal complete rounds once', () => {
  const row = experimentRow({ filled_qty: 10 });
  const pending = finalize_junk_experiment_entry_if_terminal(
    row,
    { orderStatus: 10 },
    new Date('2026-08-10T14:31:00.000Z'),
  );
  assert.equal(pending.finalized, false);
  assert.equal(row.experiment_ledger.entry_allocation_finalized, false);

  const terminal = finalize_junk_experiment_entry_if_terminal(
    row,
    { orderStatus: 14 },
    new Date('2026-08-10T14:32:00.000Z'),
  );
  assert.equal(terminal.finalized, true);
  assert.deepEqual(
    Object.values(row.experiment_ledger.variants).map((variant) => variant.allocated_entry_qty),
    [1, 1, 1, 1, 1, 1, 1],
  );
  assert.equal(row.experiment_ledger.allocated_entry_qty, 7);
  assert.equal(row.experiment_ledger.unallocated_entry_qty, 3);
  const finalized_snapshot = structuredClone(row.experiment_ledger);
  assert.equal(finalize_junk_experiment_entry_if_terminal(row, { orderStatus: 14 }).finalized, false);
  assert.deepEqual(row.experiment_ledger, finalized_snapshot);

  const empty = experimentRow({ filled_qty: 0 });
  assert.equal(finalize_junk_experiment_entry_if_terminal(empty, { orderStatus: 14 }).finalized, false);
  assert.equal(empty.experiment_ledger.entry_allocation_finalized, false);
});

test('experiment ownership invariant includes paired variants and unallocated remainder', () => {
  const row = experimentRow({ filled_qty: 10 });
  finalize_junk_experiment_entry_if_terminal(row, { orderStatus: 14 });
  assert.equal(junk_experiment_ownership_invariant(row, { qty: 10 }).passed, true);

  row.exited_qty = 1;
  const mismatch = junk_experiment_ownership_invariant(row, { qty: 9 });
  assert.equal(mismatch.passed, false);
  assert.match(mismatch.reasons.join(','), /experiment_ledger_physical_qty_mismatch/);
  assert.match(mismatch.reasons.join(','), /experiment_broker_ledger_qty_mismatch/);

  row.exited_qty = 0;
  row.experiment_ledger = begin_junk_experiment_exit_batch(row.experiment_ledger, {
    allocations: { line_1: 1 },
    attempt_no: 1,
    remark: 'junk_gex_exit:exp:test:1',
  });
  row.experiment_ledger = apply_junk_experiment_exit_cumulative_fill(row.experiment_ledger, {
    cumulative_fill_qty: 1,
    cumulative_fill_avg_price: 2.5,
    terminal: true,
  }).ledger;
  apply_exit_cumulative_fill(row, { qty: 1, avg_price: 2.5, value: 2.5 });
  assert.equal(junk_experiment_ownership_invariant(row, { qty: 9 }).passed, true);
});

test('experiment daily loss gate uses the worst $10k line, not aggregate PnL or an average', () => {
  const risk = junk_experiment_entry_risk_state(
    { daily_trade_count: 1, daily_realized_pnl_usd: 400 },
    { enabled: true, line_count: 7 },
    {
      lines: [
        { experiment_line_id: 'control', realized_pnl_usd: -300 },
        { experiment_line_id: 'winner', realized_pnl_usd: 700 },
      ],
    },
  );
  assert.equal(risk.daily_realized_pnl_usd, -300);
  assert.equal(risk.worst_line_realized_pnl_usd, -300);
  assert.equal(risk.aggregate_daily_realized_pnl_usd, 400);

  const no_rows = junk_experiment_entry_risk_state(
    { daily_realized_pnl_usd: -700 },
    { enabled: true, line_count: 7 },
    { lines: [] },
  );
  assert.equal(no_rows.daily_realized_pnl_usd, -700, 'an aggregate loss must remain a conservative entry block');
});

test('experiment entry fill price uses broker evidence and never falls back to the entry limit', () => {
  const row = {
    plan_id: 'entry_price_test',
    status: 'open',
    code: 'SPXW260810C07750000',
    filled_qty: 2,
    exited_qty: 0,
    entry_limit_price: 9,
  };
  assert.deepEqual(resolve_junk_experiment_entry_fill({
    row,
    broker_order: { fillQty: 2, fillAvgPrice: 3 },
    ownership_rows: [row],
  }), {
    qty: 2,
    avg_price: 3,
    source: 'broker_order_fill_average',
    trusted: true,
  });
  assert.equal(resolve_junk_experiment_entry_fill({
    row,
    broker_order: { fillQty: 2 },
    fills: [{ qty: 2, price: 4 }],
    ownership_rows: [row],
  }).source, 'broker_fill_list_vwap');
  assert.deepEqual(resolve_junk_experiment_entry_fill({
    row,
    broker_order: { fillQty: 2 },
    positions: [{ code: row.code, qty: 2, averageCostPrice: 5 }],
    ownership_rows: [row],
  }), {
    qty: 2,
    avg_price: 5,
    source: 'single_owned_position_cost',
    trusted: true,
  });
  const missing = resolve_junk_experiment_entry_fill({
    row,
    broker_order: { fillQty: 2 },
    ownership_rows: [row],
  });
  assert.equal(missing.trusted, false);
  assert.equal(missing.avg_price, null);
  assert.equal(missing.reason, 'experiment_entry_fill_average_missing');

  const experiment = experimentRow({ filled_qty: 10 });
  experiment.entry_fill_price = null;
  experiment.entry_limit_price = 9;
  const refused = finalize_junk_experiment_entry_if_terminal(experiment, { orderStatus: 14 });
  assert.equal(refused.finalized, false);
  assert.equal(refused.reason, 'experiment_entry_fill_average_missing');
  assert.equal(experiment.experiment_ledger.entry_allocation_finalized, false);
});

test('experiment manifest remains locked by pending entry or physical ownership but not terminal zero-fill rows', () => {
  const manifest = { enabled: true, manifest_hash: 'new_manifest' };
  const open = experimentRow();
  open.status = 'open';
  open.experiment_ledger.manifest_hash = 'old_manifest';
  const terminal_unfinalized = experimentRow({ filled_qty: 0 });
  terminal_unfinalized.status = 'entry_unfilled_terminal';
  terminal_unfinalized.experiment_ledger.manifest_hash = 'old_manifest';
  const terminal_finalized = experimentRow();
  terminal_finalized.status = 'closed';
  terminal_finalized.experiment_ledger.entry_allocation_finalized = true;
  for (const variant of Object.values(terminal_finalized.experiment_ledger.variants)) {
    variant.allocated_entry_qty = 1;
    variant.allocated_exit_qty = 1;
    variant.status = 'closed';
  }
  terminal_finalized.experiment_ledger.allocated_entry_qty = 7;
  terminal_finalized.filled_qty = 7;
  terminal_finalized.exited_qty = 7;
  terminal_finalized.broker_position_qty = 7; // stale close-time cache must not lock a new manifest
  terminal_finalized.experiment_ledger.manifest_hash = 'old_manifest';
  assert.deepEqual(
    junk_experiment_manifest_conflicts({ orders: { open, terminal_unfinalized, terminal_finalized } }, manifest),
    [open],
  );
  terminal_unfinalized.status = 'entry_submission_unknown';
  assert.deepEqual(
    junk_experiment_manifest_conflicts({ orders: { terminal_unfinalized } }, manifest),
    [terminal_unfinalized],
  );
  terminal_unfinalized.status = 'submit_failed';
  terminal_unfinalized.filled_qty = 1;
  assert.deepEqual(
    junk_experiment_manifest_conflicts({ orders: { terminal_unfinalized } }, manifest),
    [terminal_unfinalized],
  );
});

test('experiment risk charges unallocated loss to the worst line and prefers session lines', () => {
  const risk = junk_experiment_entry_risk_state(
    { daily_realized_pnl_usd: 999 },
    { enabled: true, line_count: 7 },
    {
      lines: [{ realized_pnl_usd: -900, realized_pnl_to_date_usd: -950 }],
      session_lines: [
        { realized_pnl_usd: 0, realized_pnl_to_date_usd: -250 },
        { realized_pnl_usd: 40, realized_pnl_to_date_usd: 40 },
      ],
      unallocated_realized_pnl_usd: -800,
      session_unallocated_realized_pnl_usd: -50,
    },
  );
  assert.equal(risk.worst_line_realized_pnl_usd, -250);
  assert.equal(risk.unallocated_realized_pnl_usd, -50);
  assert.equal(risk.daily_realized_pnl_usd, -300);

  const legacy_loss = junk_experiment_entry_risk_state(
    { daily_realized_pnl_usd: -400 },
    { enabled: true, line_count: 7 },
    { session_lines: [], session_unallocated_realized_pnl_usd: 0 },
  );
  assert.equal(legacy_loss.daily_realized_pnl_usd, -400);
});

test('experiment cohort fails closed when visible ask capping is enabled but depth is absent', () => {
  const manifest = {
    enabled: true,
    experiment_id: 'test',
    manifest_hash: 'manifest',
    version: 1,
    line_count: 7,
    total_paper_equity_usd: 70000,
    control_line_id: 'line_1',
    broker_execution_mode: 'aggregate_single_position',
    lines: [],
  };
  const base = {
    plan_id: 'base',
    gate: { passed: true, reasons: [] },
    signal: { signal_id: 'signal', generated_at: '2026-08-10T14:30:00.000Z' },
    contract: { code: 'SPXW260810C07750000' },
    quote: { ask_size_contracts: null },
    position_sizing: { qty: 1, estimated_position_usd: 500, max_qty_to_ask_volume_ratio: 3 },
    order: { code: 'SPXW260810C07750000', qty: 1 },
  };
  const plan = build_junk_experiment_entry_cohort(base, manifest, {
    execution_quality: { cap_qty_by_visible_ask: true },
  });
  assert.equal(plan.gate.passed, false);
  assert.match(plan.gate.reasons.join(','), /experiment_visible_ask_size_missing/);
});

test('experiment exit latches survive terminal partial fills and arm structural partial only when complete', () => {
  const row = experimentRow({ filled_qty: 14 });
  finalize_junk_experiment_entry_if_terminal(row, { orderStatus: 14 });
  row.experiment_exit_latches = {
    line_1: {
      kind: 'structural_partial',
      reason: 'structural_target_reached',
      remaining_qty: 2,
      management_update: { partial_target_taken: true, management_floor_pct: 5 },
    },
    line_2: {
      kind: 'full',
      reason: 'catastrophic_option_stop',
      remaining_qty: 2,
      management_update: {},
    },
  };
  row.experiment_ledger = begin_junk_experiment_exit_batch(row.experiment_ledger, {
    allocations: { line_1: 2, line_2: 2 },
    attempt_no: 1,
    remark: 'junk_gex_exit:exp:test:1',
  });
  let allocation = apply_junk_experiment_exit_cumulative_fill(row.experiment_ledger, {
    cumulative_fill_qty: 2,
    cumulative_fill_avg_price: 2.5,
    terminal: true,
  });
  row.experiment_ledger = allocation.ledger;
  apply_experiment_filled_management(row, allocation.deltas, true);
  assert.equal(row.experiment_ledger.variants.line_1.partial_target_taken, false);
  assert.equal(row.experiment_exit_latches.line_1.remaining_qty, 1);
  assert.equal(row.experiment_exit_latches.line_2.remaining_qty, 1);

  row.experiment_ledger = begin_junk_experiment_exit_batch(row.experiment_ledger, {
    allocations: { line_1: 1, line_2: 1 },
    attempt_no: 2,
    remark: 'junk_gex_exit:exp:test:2',
  });
  allocation = apply_junk_experiment_exit_cumulative_fill(row.experiment_ledger, {
    cumulative_fill_qty: 2,
    cumulative_fill_avg_price: 2.6,
    terminal: true,
  });
  row.experiment_ledger = allocation.ledger;
  apply_experiment_filled_management(row, allocation.deltas, true);
  assert.equal(row.experiment_ledger.variants.line_1.partial_target_taken, true);
  assert.equal(row.experiment_ledger.variants.line_1.management_floor_pct, 5);
  assert.equal(row.experiment_ledger.variants.line_2.status, 'closed');
  assert.equal(row.experiment_exit_latches, null);
});

test('zero-fill attempts release a new structural partial latch but retain a full-exit safety latch', () => {
  const row = experimentRow({ filled_qty: 14 });
  finalize_junk_experiment_entry_if_terminal(row, { orderStatus: 14 });
  row.experiment_exit_latches = {
    line_1: { kind: 'structural_partial', reason: 'target', remaining_qty: 1 },
    line_2: { kind: 'full', reason: 'catastrophic_stop', remaining_qty: 2 },
  };
  row.experiment_ledger = begin_junk_experiment_exit_batch(row.experiment_ledger, {
    allocations: { line_1: 1, line_2: 2 },
    attempt_no: 1,
    remark: 'junk_gex_exit:exp:test:1',
  });
  const allocation = apply_junk_experiment_exit_cumulative_fill(row.experiment_ledger, {
    cumulative_fill_qty: 0,
    terminal: true,
  });
  row.experiment_ledger = allocation.ledger;
  apply_experiment_filled_management(row, allocation.deltas, true);
  assert.equal(row.experiment_exit_latches.line_1, undefined);
  assert.equal(row.experiment_exit_latches.line_2.remaining_qty, 2);
});

test('an unfinished structural partial latch upgrades to full stop or force-close and never downgrades', () => {
  const partial = {
    kind: 'structural_partial',
    reason: 'structural_target_reached',
    remaining_qty: 4,
    management_update: { partial_target_taken: true },
  };
  const catastrophic = advance_junk_experiment_exit_latch(partial, {
    gate: { passed: true },
    order: { qty: 10 },
    trigger: { reason: 'catastrophic_option_stop' },
    management_update: { option_return_pct: -16 },
  }, 9);
  assert.equal(catastrophic.kind, 'full');
  assert.equal(catastrophic.reason, 'catastrophic_option_stop');
  assert.equal(catastrophic.remaining_qty, 9);

  const force = advance_junk_experiment_exit_latch(partial, {
    gate: { passed: true },
    order: { qty: 9, order_type: 'market' },
    trigger: { reason: 'force_close_time_et' },
    management_update: {},
  }, 9);
  assert.equal(force.kind, 'full');
  assert.equal(force.reason, 'force_close_time_et');
  assert.equal(force.remaining_qty, 9);

  const retained = advance_junk_experiment_exit_latch(catastrophic, {
    gate: { passed: true },
    order: { qty: 4 },
    trigger: { reason: 'structural_target_reached', structural_target_exit: 'partial' },
  }, 8);
  assert.equal(retained.kind, 'full');
  assert.equal(retained.reason, 'catastrophic_option_stop');
  assert.equal(retained.remaining_qty, 8);
});

test('unpriced force close arms only from one terminal entry and one exact uniquely owned broker position', () => {
  const row = experimentRow({ filled_qty: 0 });
  Object.assign(row, {
    code: 'SPXW260810C07750000',
    submitted_qty: 14,
    entry_order_id_ex: 'ENTRY-UNPRICED-1',
    entry_fill_price: null,
    entry_fill_price_source: null,
    status: 'recovery_blocked',
  });
  const brokerOrder = {
    orderIDEx: 'ENTRY-UNPRICED-1',
    orderStatus: 11,
    code: row.code,
    fillQty: 14,
    fillAvgPrice: 0,
  };
  const position = { code: row.code, qty: 14, canSellQty: 14, positionID: 'POSITION-UNPRICED-1' };
  const proof = prove_junk_experiment_unpriced_force_close_ownership({
    row,
    broker_order: brokerOrder,
    positions: [position],
    ownership_rows: [row],
  });
  assert.equal(proof.passed, true);
  assert.equal(proof.physical_remaining_qty, 14);

  const armed = arm_junk_experiment_unpriced_force_close({
    row,
    broker_order: brokerOrder,
    positions: [position],
    ownership_rows: [row],
    now: new Date('2026-08-10T19:45:00.000Z'),
  });
  assert.equal(armed.armed, true);
  assert.equal(row.experiment_unpriced_force_close, true);
  assert.equal(row.entry_fill_unpriced, true);
  assert.equal(row.entry_fill_price, null);
  assert.equal(row.experiment_ledger.entry_allocation_finalized, true);
  assert.equal(row.experiment_ledger.entry_fill_avg_price, null);
  assert.equal(row.experiment_ledger.allocated_entry_qty, 14);
  assert.ok(Object.values(row.experiment_ledger.variants).every((variant) => (
    variant.allocated_entry_qty === 2
      && variant.comparison_eligible === false
      && variant.realized_pnl_usd === null
  )));
  assert.equal(experiment_unpriced_incident_blocks_new_entry({ orders: { emergency: row } }), true);
  row.experiment_ledger = begin_junk_experiment_exit_batch(row.experiment_ledger, {
    allocations: Object.fromEntries(Object.keys(row.experiment_ledger.variants).map((lineId) => [lineId, 2])),
    attempt_no: 1,
    remark: 'junk_gex_exit:exp:unpriced:1',
  });
  row.experiment_ledger = apply_junk_experiment_exit_cumulative_fill(row.experiment_ledger, {
    cumulative_fill_qty: 14,
    cumulative_fill_avg_price: 1.25,
    terminal: true,
  }).ledger;
  assert.ok(Object.values(row.experiment_ledger.variants).every((variant) => (
    variant.status === 'closed' && variant.realized_pnl_usd === null
  )));

  const ambiguous = experimentRow({ filled_qty: 0 });
  Object.assign(ambiguous, {
    code: row.code,
    submitted_qty: 14,
    entry_order_id_ex: 'ENTRY-UNPRICED-1',
    entry_fill_price: null,
  });
  const refused = prove_junk_experiment_unpriced_force_close_ownership({
    row: ambiguous,
    broker_order: brokerOrder,
    positions: [position, { ...position, positionID: 'POSITION-UNRELATED-LOT' }],
    ownership_rows: [ambiguous],
  });
  assert.equal(refused.passed, false);
  assert.ok(refused.reasons.includes('experiment_unique_broker_position_not_proven'));

  const terminalLocalOwner = {
    plan_id: 'stale-terminal-owner',
    code: row.code,
    status: 'closed',
    filled_qty: 14,
    exited_qty: 0,
  };
  const productionOwnershipRows = junk_experiment_ownership_rows({
    orders: {
      active_target: ambiguous,
      terminal_positive_owner: terminalLocalOwner,
    },
  });
  assert.deepEqual(
    productionOwnershipRows.map((candidate) => candidate.plan_id),
    [ambiguous.plan_id, terminalLocalOwner.plan_id],
    'the production ownership adapter must retain terminal rows excluded from active_rows',
  );
  const terminalOwnerRefused = prove_junk_experiment_unpriced_force_close_ownership({
    row: ambiguous,
    broker_order: brokerOrder,
    positions: [position],
    ownership_rows: productionOwnershipRows,
  });
  assert.equal(terminalOwnerRefused.passed, false);
  assert.ok(terminalOwnerRefused.reasons.includes(
    'experiment_contract_has_terminal_local_owner_with_remaining_qty',
  ));
});
