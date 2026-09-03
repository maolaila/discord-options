import assert from 'node:assert/strict';
import test from 'node:test';
import policy from '../config/zero-dte-options-policy.json' with { type: 'json' };
import {
  apply_junk_experiment_exit_cumulative_fill,
  begin_junk_experiment_exit_batch,
  build_junk_experiment_cohort,
  create_junk_experiment_ledger,
  exit_config_for_variant,
  experiment_all_variants_flat,
  experiment_total_remaining_qty,
  finalize_junk_experiment_entry_allocation,
  load_junk_exit_experiment,
  settle_junk_experiment_expiration_unpriced,
  summarize_junk_exit_experiment,
} from '../apps/zero-dte-options/junk-exit-experiment.mjs';

function basePlan(qty = 1) {
  return {
    schema_version: 1,
    plan_id: 'zero_dte_base',
    planned_at: '2026-08-12T14:00:00.000Z',
    business_line: 'zero-dte-options',
    strategy: 'junk_gex_nodes_v3',
    mode: 'simulate',
    order_status: 'ready_for_simulation',
    gate: { passed: true, reasons: [] },
    signal: {
      signal_id: 'junk_signal_1',
      generated_at: '2026-08-12T14:00:00.000Z',
      ticker: 'SPX',
    },
    contract: { code: 'SPXW260812C07750000' },
    quote: { buy_limit_price: 5, ask_size_contracts: 14 },
    position_sizing: {
      qty,
      estimated_position_usd: qty * 500,
      max_qty_to_ask_volume_ratio: 1,
    },
    order: {
      side: 'buy_to_open',
      order_type: 'limit',
      code: 'SPXW260812C07750000',
      qty,
      price: 5,
      remark: 'junk_gex:junk_signal_1',
    },
  };
}

test('manifest has seven exit-grid lines plus one observation-only latest line sharing base entry', () => {
  const manifest = load_junk_exit_experiment(policy);
  assert.equal(manifest.enabled, true);
  assert.equal(manifest.line_count, 8);
  assert.equal(manifest.total_paper_equity_usd, 80_000);
  assert.equal(manifest.control_line_id, 'control_sl15_tp_off');
  assert.equal(new Set(manifest.lines.map((line) => line.exit_profile_hash)).size, 7);
  assert.equal(new Set(manifest.lines.map((line) => line.line_profile_hash)).size, 8);
  assert.ok(manifest.lines.every((line) => line.paper_equity_usd === 10_000));
  const control = manifest.lines.find((line) => line.control);
  const latest = manifest.lines.find((line) => line.line_id === 'latest_regime_lifecycle');
  assert.equal(latest.entry_profile, 'latest_regime_lifecycle_v1');
  assert.equal(policy.exit_experiment.latest_entry_profile.participation, 'base_v3_entry_always');
  for (const removedGate of [
    'minimum_node_samples',
    'minimum_node_strength_ratio',
    'minimum_structure_overlap_ratio',
    'maximum_node_touches',
    'minimum_relative_confirmation_volume',
    'require_heatmap_confirmation',
    'require_vwap_context',
  ]) assert.equal(removedGate in policy.exit_experiment.latest_entry_profile, false);
  assert.equal(latest.exit_profile_hash, control.exit_profile_hash);
  assert.notEqual(latest.line_profile_hash, control.line_profile_hash);
});

test('cohort multiplies only broker quantity and retains one common signal, contract, price and entry', () => {
  const manifest = load_junk_exit_experiment(policy);
  const cohort = build_junk_experiment_cohort(basePlan(2), manifest);
  assert.equal(cohort.gate.passed, true);
  assert.equal(cohort.position_sizing.per_line_qty, 2);
  assert.equal(cohort.position_sizing.qty, 14);
  assert.equal(cohort.order.qty, 14);
  assert.equal(cohort.order.price, 5);
  assert.equal(cohort.contract.code, 'SPXW260812C07750000');
  assert.match(cohort.plan_id, /^zero_dte_[0-9a-f]{20}$/);
  assert.match(cohort.order.remark, /^junk_gex:exp:/);
  assert.ok(cohort.order.remark.length <= 60);
});

test('latest line independently adds one aggregate unit only when its entry profile passes', () => {
  const manifest = load_junk_exit_experiment(policy);
  const assessment = {
    entry_profile: 'latest_regime_lifecycle_v1',
    participate: true,
    decision: 'trade',
    reason_codes: ['latest_line_quality_filter_passed'],
  };
  const cohort = build_junk_experiment_cohort(basePlan(1), manifest, {
    line_participation: { latest_regime_lifecycle: assessment },
  });
  assert.equal(cohort.position_sizing.aggregate_qty, 8);
  assert.equal(cohort.position_sizing.experiment_participating_line_count, 8);
  assert.equal(cohort.experiment.lines.find(
    (line) => line.line_id === 'latest_regime_lifecycle',
  ).entry_eligible, true);
  const ledger = finalize_junk_experiment_entry_allocation(
    create_junk_experiment_ledger(cohort.experiment),
    { filled_qty: 8, fill_avg_price: 5 },
  );
  assert.ok(Object.values(ledger.variants).every((line) => line.allocated_entry_qty === 1));
});

test('unpriced expiration settlement clears virtual ownership but preserves actual fill accounting', () => {
  const manifest = load_junk_exit_experiment(policy);
  const cohort = build_junk_experiment_cohort(basePlan(1), manifest, {
    line_participation: {
      latest_regime_lifecycle: {
        entry_profile: 'latest_regime_lifecycle_v1',
        participate: true,
        decision: 'trade',
        reason_codes: ['latest_line_quality_filter_passed'],
      },
    },
  });
  let ledger = finalize_junk_experiment_entry_allocation(
    create_junk_experiment_ledger(cohort.experiment),
    { filled_qty: 8, fill_avg_price: 3.8 },
  );
  ledger = begin_junk_experiment_exit_batch(ledger, {
    allocations: { sl10_tp20: 1, sl15_tp20: 1 },
    reason_by_line: { sl10_tp20: 'option_take_profit', sl15_tp20: 'option_take_profit' },
    attempt_no: 1,
    remark: 'junk_gex_exit:test:1',
  });
  const settled = settle_junk_experiment_expiration_unpriced(ledger, {
    now: new Date('2026-09-02T13:00:00.000Z'),
  });
  assert.equal(experiment_total_remaining_qty(settled), 0);
  assert.equal(experiment_all_variants_flat(settled), true);
  assert.equal(settled.pending_exit_batch, null);
  assert.equal(settled.expiration_settlement.settled_qty, 8);
  assert.equal(settled.expiration_settlement.prior_pending_exit_batch.requested_qty, 2);
  assert.ok(Object.values(settled.variants).every((variant) => variant.expired_settled_qty === 1));
  assert.ok(Object.values(settled.variants).every((variant) => variant.allocated_exit_qty === 0));
  assert.ok(Object.values(settled.variants).every((variant) => variant.realized_pnl_usd === null));
});

test('optional latest line yields to visible depth without blocking the seven base lines', () => {
  const manifest = load_junk_exit_experiment(policy);
  const source = basePlan(1);
  source.quote.ask_size_contracts = 7;
  const cohort = build_junk_experiment_cohort(source, manifest, {
    line_participation: {
      latest_regime_lifecycle: {
        entry_profile: 'latest_regime_lifecycle_v1',
        participate: true,
        decision: 'trade',
        reason_codes: ['latest_line_quality_filter_passed'],
      },
    },
  });
  assert.equal(cohort.gate.passed, true);
  assert.equal(cohort.order.qty, 7);
  const latest = cohort.experiment.lines.find(
    (line) => line.line_id === 'latest_regime_lifecycle',
  );
  assert.equal(latest.entry_eligible, false);
  assert.ok(latest.entry_participation.reason_codes.includes(
    'entry_profile_skipped_visible_ask_capacity',
  ));
});

test('soft 10% sizing fallback remains one contract per line and seven in the aggregate cohort', () => {
  const manifest = load_junk_exit_experiment(policy);
  for (const optionPrice of [10.30, 10.50]) {
    const source = basePlan(1);
    source.quote.buy_limit_price = optionPrice;
    source.quote.ask_size_contracts = 7;
    source.position_sizing = {
      ...source.position_sizing,
      qty: 1,
      contract_cost_usd: optionPrice * 100,
      estimated_position_usd: optionPrice * 100,
      estimated_position_pct: optionPrice,
      max_position_pct: 10,
      max_position_is_soft_target: true,
      reasons: ['minimum_contract_above_max_position_target'],
    };
    source.order.price = optionPrice;
    source.order.qty = 1;

    const cohort = build_junk_experiment_cohort(source, manifest);
    assert.equal(cohort.gate.passed, true);
    assert.equal(cohort.position_sizing.per_line_qty, 1);
    assert.equal(cohort.position_sizing.aggregate_qty, 7);
    assert.equal(cohort.order.qty, 7);
  }

  const insufficientDepth = basePlan(1);
  insufficientDepth.quote.buy_limit_price = 10.50;
  insufficientDepth.quote.ask_size_contracts = 2;
  insufficientDepth.position_sizing.estimated_position_usd = 1_050;
  insufficientDepth.order.price = 10.50;
  const blocked = build_junk_experiment_cohort(insufficientDepth, manifest);
  assert.equal(blocked.gate.passed, false);
  assert.ok(blocked.gate.reasons.includes('experiment_aggregate_qty_exceeds_visible_ask_cap:7'));
});

test('aggregate visible ask cap fails closed instead of silently changing paired sizing', () => {
  const manifest = load_junk_exit_experiment(policy);
  const source = basePlan(3);
  source.quote.ask_size_contracts = 2;
  const cohort = build_junk_experiment_cohort(source, manifest);
  assert.equal(cohort.gate.passed, false);
  assert.ok(cohort.gate.reasons.some((reason) => reason.startsWith('experiment_aggregate_qty_exceeds_visible_ask_cap')));
});

test('aggregate ask cap uses the manifest policy ratio instead of a hard-coded fallback', () => {
  const strictPolicy = structuredClone(policy);
  strictPolicy.execution_quality.max_qty_to_ask_volume_ratio = 1;
  const manifest = load_junk_exit_experiment(strictPolicy);
  const source = basePlan(1);
  source.quote.ask_size_contracts = 3;
  delete source.position_sizing.max_qty_to_ask_volume_ratio;
  const cohort = build_junk_experiment_cohort(source, manifest);
  assert.equal(cohort.gate.passed, false);
  assert.ok(cohort.gate.reasons.includes('experiment_aggregate_qty_exceeds_visible_ask_cap:7'));
});

test('aggregate entry fails closed when visible ask depth is missing', () => {
  const manifest = load_junk_exit_experiment(policy);
  const source = basePlan(1);
  source.quote.ask_size_contracts = null;
  const cohort = build_junk_experiment_cohort(source, manifest);
  assert.equal(cohort.gate.passed, false);
  assert.ok(cohort.gate.reasons.includes('experiment_visible_ask_size_missing'));
});

test('partial entry fill allocates only complete equal rounds and isolates the remainder', () => {
  const manifest = load_junk_exit_experiment(policy);
  const cohort = build_junk_experiment_cohort(basePlan(2), manifest);
  const ledger = create_junk_experiment_ledger(cohort.experiment, new Date('2026-08-12T14:00:00Z'));
  const allocated = finalize_junk_experiment_entry_allocation(ledger, {
    filled_qty: 10,
    fill_avg_price: 5,
    now: new Date('2026-08-12T14:01:00Z'),
  });
  assert.ok(Object.values(allocated.variants)
    .filter((line) => line.entry_eligible)
    .every((line) => line.allocated_entry_qty === 1));
  assert.equal(allocated.variants.latest_regime_lifecycle.allocated_entry_qty, 0);
  assert.equal(allocated.variants.latest_regime_lifecycle.status, 'not_participating');
  assert.equal(allocated.allocated_entry_qty, 7);
  assert.equal(allocated.unallocated_entry_qty, 3);
  assert.equal(experiment_total_remaining_qty(allocated), 10);
  assert.equal(allocated.allocation_quality, 'paired_with_unallocated_remainder');
});

test('positive experiment fills require a broker-confirmed average instead of guessing the limit', () => {
  const manifest = load_junk_exit_experiment(policy);
  const ledger = create_junk_experiment_ledger(build_junk_experiment_cohort(basePlan(1), manifest).experiment);
  assert.throws(() => finalize_junk_experiment_entry_allocation(ledger, {
    filled_qty: 7,
    fill_avg_price: null,
  }), /broker-confirmed positive fill average/);
});

test('cumulative batch fills are idempotent, deterministic and remain assigned to line IDs', () => {
  const manifest = load_junk_exit_experiment(policy);
  let ledger = finalize_junk_experiment_entry_allocation(
    create_junk_experiment_ledger(build_junk_experiment_cohort(basePlan(1), manifest).experiment),
    { filled_qty: 7, fill_avg_price: 5 },
  );
  ledger = begin_junk_experiment_exit_batch(ledger, {
    allocations: { sl10_tp20: 1, sl15_tp20: 1, sl15_tp30: 1 },
    reason_by_line: { sl10_tp20: 'tp20', sl15_tp20: 'tp20', sl15_tp30: 'tp30' },
    attempt_no: 1,
    remark: 'junk_gex_exit:batch1',
  });
  let applied = apply_junk_experiment_exit_cumulative_fill(ledger, {
    cumulative_fill_qty: 2,
    cumulative_fill_avg_price: 6,
  });
  ledger = applied.ledger;
  assert.equal(applied.deltas.reduce((sum, row) => sum + row.qty, 0), 2);
  const repeated = apply_junk_experiment_exit_cumulative_fill(ledger, {
    cumulative_fill_qty: 2,
    cumulative_fill_avg_price: 6,
  });
  assert.equal(repeated.deltas.reduce((sum, row) => sum + row.qty, 0), 0);
  const completed = apply_junk_experiment_exit_cumulative_fill(repeated.ledger, {
    cumulative_fill_qty: 3,
    cumulative_fill_avg_price: 6,
    terminal: true,
  });
  assert.equal(completed.ledger.pending_exit_batch, null);
  assert.equal(['sl10_tp20', 'sl15_tp20', 'sl15_tp30']
    .reduce((sum, line) => sum + completed.ledger.variants[line].allocated_exit_qty, 0), 3);
  assert.ok(['sl10_tp20', 'sl15_tp20', 'sl15_tp30']
    .every((line) => completed.ledger.variants[line].realized_pnl_usd === 100));
});

test('positive exit fills require a broker-confirmed cumulative average', () => {
  const manifest = load_junk_exit_experiment(policy);
  let ledger = finalize_junk_experiment_entry_allocation(
    create_junk_experiment_ledger(build_junk_experiment_cohort(basePlan(1), manifest).experiment),
    { filled_qty: 7, fill_avg_price: 5 },
  );
  ledger = begin_junk_experiment_exit_batch(ledger, {
    allocations: { sl10_tp20: 1 },
    attempt_no: 1,
    remark: 'missing-exit-average',
  });
  assert.throws(() => apply_junk_experiment_exit_cumulative_fill(ledger, {
    cumulative_fill_qty: 1,
    cumulative_fill_avg_price: null,
  }), /broker-confirmed positive cumulative fill average/);
});

test('unequal exit allocations remain monotonic and conserve every cumulative broker fill prefix', () => {
  const manifest = load_junk_exit_experiment(policy);
  let ledger = finalize_junk_experiment_entry_allocation(
    create_junk_experiment_ledger(build_junk_experiment_cohort(basePlan(3), manifest).experiment),
    { filled_qty: 21, fill_avg_price: 5 },
  );
  ledger = begin_junk_experiment_exit_batch(ledger, {
    allocations: { sl10_tp20: 1, sl15_tp20: 3, sl15_tp30: 3 },
    attempt_no: 1,
    remark: 'unequal',
  });
  const previous = { sl10_tp20: 0, sl15_tp20: 0, sl15_tp30: 0 };
  for (let cumulative = 1; cumulative <= 7; cumulative += 1) {
    const applied = apply_junk_experiment_exit_cumulative_fill(ledger, {
      cumulative_fill_qty: cumulative,
      cumulative_fill_avg_price: 6,
      terminal: cumulative === 7,
    });
    ledger = applied.ledger;
    const current = Object.fromEntries(Object.keys(previous).map((line) => [
      line,
      ledger.variants[line].allocated_exit_qty,
    ]));
    assert.equal(Object.values(current).reduce((sum, qty) => sum + qty, 0), cumulative);
    for (const line of Object.keys(previous)) assert.ok(current[line] >= previous[line]);
    Object.assign(previous, current);
  }
  assert.deepEqual(previous, { sl10_tp20: 1, sl15_tp20: 3, sl15_tp30: 3 });
});

test('allocation order rotates deterministically by cohort and attempt while residual inventory stays first', () => {
  const manifest = load_junk_exit_experiment(policy);
  let ledger = finalize_junk_experiment_entry_allocation(
    create_junk_experiment_ledger(build_junk_experiment_cohort(basePlan(2), manifest).experiment),
    { filled_qty: 15, fill_avg_price: 5 },
  );
  ledger = begin_junk_experiment_exit_batch(ledger, {
    allocations: { __unallocated__: 1, sl10_tp20: 2, sl15_tp20: 2, sl15_tp30: 2 },
    attempt_no: 7,
    remark: 'rotated',
  });
  assert.equal(ledger.pending_exit_batch.allocation_order[0], '__unallocated__');
  assert.equal(new Set(ledger.pending_exit_batch.allocation_order).size, 4);
  const first = apply_junk_experiment_exit_cumulative_fill(ledger, {
    cumulative_fill_qty: 1,
    cumulative_fill_avg_price: 6,
  });
  assert.equal(first.ledger.unallocated_exited_qty, 1);
});

test('terminal partial multi-line fills are retained but excluded from paired optimization metrics', () => {
  const manifest = load_junk_exit_experiment(policy);
  let ledger = finalize_junk_experiment_entry_allocation(
    create_junk_experiment_ledger(build_junk_experiment_cohort(basePlan(1), manifest).experiment),
    { filled_qty: 7, fill_avg_price: 5 },
  );
  ledger = begin_junk_experiment_exit_batch(ledger, {
    allocations: { sl10_tp20: 1, sl15_tp20: 1 },
    attempt_no: 1,
    remark: 'terminal-partial',
  });
  ledger = apply_junk_experiment_exit_cumulative_fill(ledger, {
    cumulative_fill_qty: 1,
    cumulative_fill_avg_price: 6,
    terminal: true,
  }).ledger;
  assert.equal(ledger.comparison_pairing_issue_count, 1);
  assert.equal(ledger.variants.sl10_tp20.comparison_eligible, false);
  assert.equal(ledger.variants.sl15_tp20.comparison_eligible, false);
  assert.ok(Object.values(ledger.variants).every((variant) => variant.comparison_eligible === false));
});

test('a zero-fill rejected multi-line attempt remains comparable and can be retried', () => {
  const manifest = load_junk_exit_experiment(policy);
  let ledger = finalize_junk_experiment_entry_allocation(
    create_junk_experiment_ledger(build_junk_experiment_cohort(basePlan(1), manifest).experiment),
    { filled_qty: 7, fill_avg_price: 5 },
  );
  ledger = begin_junk_experiment_exit_batch(ledger, {
    allocations: { sl10_tp20: 1, sl15_tp20: 1 },
    attempt_no: 1,
    remark: 'rejected-no-fill',
  });
  ledger = apply_junk_experiment_exit_cumulative_fill(ledger, {
    cumulative_fill_qty: 0,
    cumulative_fill_avg_price: null,
    terminal: true,
  }).ledger;
  assert.equal(ledger.comparison_pairing_issue_count, 0);
  assert.ok(Object.values(ledger.variants)
    .filter((variant) => variant.entry_eligible)
    .every((variant) => variant.comparison_eligible === true));
  assert.equal(ledger.variants.latest_regime_lifecycle.comparison_eligible, false);
});

test('variant config changes only fixed option SL/TP fields', () => {
  const manifest = load_junk_exit_experiment(policy);
  const line = manifest.lines.find((item) => item.line_id === 'sl10_tp30');
  const base = { policy: { ...policy, exit_rules: { ...policy.exit_rules } } };
  const configured = exit_config_for_variant(base, line);
  assert.equal(configured.policy.exit_rules.catastrophic_stop_loss_pct, 10);
  assert.equal(configured.policy.exit_rules.option_take_profit_enabled, true);
  assert.equal(configured.policy.exit_rules.option_take_profit_pct, 30);
  assert.equal(configured.policy.exit_rules.breakeven_activation_pct, policy.exit_rules.breakeven_activation_pct);
  assert.equal(configured.policy.exit_rules.use_next_gex_node_target, policy.exit_rules.use_next_gex_node_target);
});

test('shared exits are frozen into the cohort manifest and survive later base-policy drift', () => {
  const manifest = load_junk_exit_experiment(policy);
  const ledger = create_junk_experiment_ledger(build_junk_experiment_cohort(basePlan(1), manifest).experiment);
  const variant = ledger.variants.sl10_tp30;
  const drifted = structuredClone(policy);
  drifted.exit_rules.breakeven_activation_pct = 99;
  drifted.exit_rules.setup_time_stop_minutes = 99;
  const configured = exit_config_for_variant({ policy: drifted }, variant);
  assert.equal(configured.policy.exit_rules.breakeven_activation_pct, policy.exit_rules.breakeven_activation_pct);
  assert.equal(configured.policy.exit_rules.setup_time_stop_minutes, policy.exit_rules.setup_time_stop_minutes);
  assert.equal(configured.policy.exit_rules.catastrophic_stop_loss_pct, 10);
  assert.equal(configured.policy.exit_rules.option_take_profit_pct, 30);

  const changed = structuredClone(policy);
  changed.exit_rules.breakeven_activation_pct = 10;
  assert.notEqual(load_junk_exit_experiment(changed).manifest_hash, manifest.manifest_hash);
});

test('exchange-calendar early-close overrides win over the frozen normal-session schedule', () => {
  const manifest = load_junk_exit_experiment(policy);
  const ledger = create_junk_experiment_ledger(build_junk_experiment_cohort(basePlan(1), manifest).experiment);
  const variant = ledger.variants.sl10_tp30;
  const configured = exit_config_for_variant({
    policy,
    schedule_exit_rule_overrides: {
      close_exit_start_time_et: '12:30',
      force_close_exit_start_time_et: '12:45',
    },
  }, variant);
  assert.equal(configured.policy.exit_rules.close_exit_start_time_et, '12:30');
  assert.equal(configured.policy.exit_rules.force_close_exit_start_time_et, '12:45');
});

test('partially exited lines expose realized PnL to date before the virtual position is flat', () => {
  const manifest = load_junk_exit_experiment(policy);
  let ledger = finalize_junk_experiment_entry_allocation(
    create_junk_experiment_ledger(build_junk_experiment_cohort(basePlan(2), manifest).experiment),
    { filled_qty: 14, fill_avg_price: 5 },
  );
  ledger = begin_junk_experiment_exit_batch(ledger, {
    allocations: { sl10_tp20: 1 },
    attempt_no: 1,
    remark: 'partial-loss',
  });
  ledger = apply_junk_experiment_exit_cumulative_fill(ledger, {
    cumulative_fill_qty: 1,
    cumulative_fill_avg_price: 4,
    terminal: true,
  }).ledger;
  const summary = summarize_junk_exit_experiment({
    session_date_et: '2026-08-12',
    orders: { one: { expiration: '2026-08-12', experiment_ledger: ledger } },
  });
  const line = summary.lines.find((item) => item.experiment_line_id === 'sl10_tp20');
  assert.equal(line.closed_trade_count, 0);
  assert.equal(line.realized_pnl_usd, 0);
  assert.equal(line.realized_pnl_to_date_usd, -100);
  assert.equal(summary.session_aggregate_realized_pnl_to_date_usd, -100);
});

test('summary reports independent line PnL and flat state', () => {
  const manifest = load_junk_exit_experiment(policy);
  let ledger = finalize_junk_experiment_entry_allocation(
    create_junk_experiment_ledger(build_junk_experiment_cohort(basePlan(1), manifest).experiment),
    { filled_qty: 7, fill_avg_price: 5 },
  );
  const allocations = Object.fromEntries(Object.keys(ledger.variants).map((line) => [line, 1]));
  ledger = begin_junk_experiment_exit_batch(ledger, { allocations, attempt_no: 1, remark: 'batch' });
  ledger = apply_junk_experiment_exit_cumulative_fill(ledger, {
    cumulative_fill_qty: 7,
    cumulative_fill_avg_price: 5.5,
    terminal: true,
  }).ledger;
  assert.equal(experiment_all_variants_flat(ledger), true);
  const summary = summarize_junk_exit_experiment({ orders: { one: { experiment_ledger: ledger } } });
  assert.equal(summary.lines.length, 8);
  assert.ok(summary.lines
    .filter((line) => line.experiment_line_id !== 'latest_regime_lifecycle')
    .every((line) => line.realized_pnl_usd === 50));
  assert.equal(summary.lines.find(
    (line) => line.experiment_line_id === 'latest_regime_lifecycle',
  ).cohort_count, 0);
  assert.equal(summary.lines.find(
    (line) => line.experiment_line_id === 'latest_regime_lifecycle',
  ).entry_skipped_cohort_count, 1);
  assert.equal(summary.aggregate_realized_pnl_usd, 350);
  assert.equal(summary.physical_realized_pnl_usd, 350);
  assert.equal(summary.pnl_basis, 'gross_option_price_change');
  assert.equal(summary.fees_included, false);
});

test('summary separates manifest versions and accounts for residual liquidation PnL', () => {
  const manifest = load_junk_exit_experiment(policy);
  let first = finalize_junk_experiment_entry_allocation(
    create_junk_experiment_ledger(build_junk_experiment_cohort(basePlan(1), manifest).experiment),
    { filled_qty: 8, fill_avg_price: 5 },
  );
  first = begin_junk_experiment_exit_batch(first, {
    allocations: { __unallocated__: 1 },
    attempt_no: 1,
    remark: 'residual',
  });
  first = apply_junk_experiment_exit_cumulative_fill(first, {
    cumulative_fill_qty: 1,
    cumulative_fill_avg_price: 4.5,
    terminal: true,
  }).ledger;
  const second = structuredClone(first);
  second.cohort_id = 'second-cohort';
  second.manifest_hash = 'different-manifest';
  second.version = first.version + 1;
  const summary = summarize_junk_exit_experiment({
    session_date_et: '2026-08-12',
    orders: {
      first: { expiration: '2026-08-12', experiment_ledger: first },
      second: { expiration: '2026-08-11', experiment_ledger: second },
    },
  });
  assert.equal(summary.lines.length, 16);
  assert.equal(summary.unallocated_realized_pnl_usd, -100);
  assert.equal(summary.unallocated_closed_cohort_count, 2);
  assert.equal(summary.physical_realized_pnl_usd, summary.aggregate_realized_pnl_usd - 100);
  assert.equal(summary.session_unallocated_realized_pnl_usd, -50);
  assert.equal(summary.session_cohort_count, 1);
  assert.equal(summary.session_lines.length, 8);
});

test('manifest rejects per-line capital drift and a control that no longer matches base v3', () => {
  const badEquity = structuredClone(policy);
  badEquity.exit_experiment.lines[0].paper_equity_usd = 20_000;
  assert.throws(() => load_junk_exit_experiment(badEquity), /paper_equity_usd=10000/);
  const badControl = structuredClone(policy);
  badControl.exit_experiment.lines[0].catastrophic_stop_loss_pct = 20;
  assert.throws(() => load_junk_exit_experiment(badControl), /control line must match/);
  const duplicateProfile = structuredClone(policy);
  duplicateProfile.exit_experiment.lines[1].catastrophic_stop_loss_pct = 15;
  assert.throws(() => load_junk_exit_experiment(duplicateProfile), /unique entry plus exit profiles/);
});
