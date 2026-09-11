import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import policy from '../config/zero-dte-options-policy.json' with { type: 'json' };
import historicalPolicy from './fixtures/junk-eight-line-policy.mjs';
import { build_junk_experiment_entry_cohort, junk_experiment_manifest_conflicts } from '../apps/zero-dte-options/zero-dte-line.mjs';
import {
  load_junk_exit_experiment, create_junk_experiment_ledger, finalize_junk_experiment_entry_allocation,
  settle_junk_experiment_expiration_unpriced,
} from '../apps/zero-dte-options/junk-exit-experiment.mjs';
import { build_junk_performance_report } from '../apps/control-console/junk-performance-report.mjs';

const ids = ['control_sl15_tp_off', 'sl10_tp_off', 'sl15_tp30'];
const manifest = load_junk_exit_experiment(policy);
function basePlan(depth = 3) {
  return { plan_id: 'three-lines', planned_at: '2026-09-14T14:00:00Z',
    business_line: 'zero-dte-options', strategy: 'junk_gex_nodes_v3',
    gate: { passed: true, reasons: [] }, signal: { signal_id: 'fixture', ticker: 'SPX' },
    contract: { code: 'SPXW260914C7700000' },
    quote: { buy_limit_price: 5, ask_size_contracts: depth },
    position_sizing: { qty: 1, estimated_position_usd: 500, max_qty_to_ask_volume_ratio: 1 },
    order: { qty: 1, price: 5 },
  };
}

test('production version 4 retains exactly the three approved unchanged exit profiles', () => {
  assert.equal(manifest.version, 4);
  assert.deepEqual(manifest.lines.map(line => line.line_id), ids);
  assert.deepEqual(manifest.lines.map(line => [line.exit_profile.catastrophic_stop_loss_pct,
    line.exit_profile.option_take_profit_enabled, line.exit_profile.option_take_profit_pct]),
  [[15, false, 25], [10, false, 25], [15, true, 30]]);
  const historical = load_junk_exit_experiment(historicalPolicy);
  for (const line of manifest.lines) {
    assert.equal(line.entry_profile, 'base_v3');
    assert.equal(line.line_profile_hash, historical.lines.find(old => old.line_id === line.line_id).line_profile_hash);
  }
  assert.equal(policy.exit_experiment.latest_entry_profile, undefined);
  assert.equal(policy.exit_rules.breakeven_activation_pct, 20);
  assert.equal(policy.exit_rules.setup_time_stop_enabled, true);
  assert.deepEqual(policy.exit_rules.setup_time_stop_setup_types, ['range_mean_reversion']);
  assert.equal(policy.exit_rules.use_underlying_confirmation_bar_wick_invalidation, true);
  assert.equal(policy.exit_rules.use_next_gex_node_target, true);
});

test('new entries allocate three equal units and retired participation cannot add contracts', () => {
  const plan = build_junk_experiment_entry_cohort(basePlan(), manifest, policy, {
    line_participation: { latest_regime_lifecycle: { participate: true }, sl10_tp20: { participate: true } },
  });
  assert.equal(plan.gate.passed, true);
  assert.equal(plan.order.qty, 3);
  const ledger = finalize_junk_experiment_entry_allocation(create_junk_experiment_ledger(plan.experiment), {
    filled_qty: 3, fill_avg_price: 5,
  });
  assert.deepEqual(Object.keys(ledger.variants), ids);
  assert.ok(Object.values(ledger.variants).every(line => line.allocated_entry_qty === 1));
  const shallow = build_junk_experiment_entry_cohort(basePlan(2), manifest, policy);
  assert.equal(shallow.gate.passed, false);
});

test('manifest migration preserves old ownership and allows new entries only once old cohorts settle', () => {
  const previous = load_junk_exit_experiment(historicalPolicy);
  const plan = build_junk_experiment_entry_cohort(basePlan(100), previous, historicalPolicy);
  const ledger = finalize_junk_experiment_entry_allocation(create_junk_experiment_ledger(plan.experiment), {
    filled_qty: 7, fill_avg_price: 5,
  });
  const row = { status: 'filled', filled_qty: 7, exited_qty: 0, experiment_ledger: ledger };
  const state = { orders: { old: row } };
  const before = JSON.stringify(state);
  assert.equal(junk_experiment_manifest_conflicts(state, manifest).length, 1);
  assert.equal(JSON.stringify(state), before);
  row.experiment_ledger = settle_junk_experiment_expiration_unpriced(ledger).ledger;
  row.status = 'expired_unpriced'; row.expired_qty = 7;
  assert.deepEqual(junk_experiment_manifest_conflicts(state, manifest), []);
});

test('performance and HTML use three active lines, retain void-day audit, and invalidate old cache', () => {
  const report = build_junk_performance_report({ policy });
  assert.deepEqual(report.active_line_ids, ids);
  assert.equal(report.active_experiment_version, 4);
  assert.deepEqual(report.cumulative.lines.map(line => line.line_id), ids);
  assert.ok(report.voided_trading_days.some(day => day.date_et === '2026-09-11'));
  const html = readFileSync(new URL('../reports/junkman-performance.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /dailyObserver|cumulativeObserver|七条止盈/);
  assert.match(html, /main-v5-three-lines/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Script(script));
  for (const [, id] of script.matchAll(/\$\('([^']+)'\)/g)) assert.ok(html.includes(`id="${id}"`), id);
});
