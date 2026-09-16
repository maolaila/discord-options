import test from 'node:test';
import assert from 'node:assert/strict';
import policy from '../../config/zero-dte-options-policy.json' with { type: 'json' };
import { build_exit_replay_report, create_replay_recorder, replay_exit_variant } from './junk-exit-replay.mjs';
import { render_replay_report } from '../../ops/junk-research.mjs';
import { load_junk_exit_experiment } from './junk-exit-experiment.mjs';

const row = { plan_id: 'zero_dte_test', code: 'SPXW260917C7500000', expiration: '2026-09-17',
  entry_filled_at: '2026-09-17T14:00:00Z', entry_fill_price: 10, contract_multiplier: 100,
  direction: 'bull', invalidation_price: 7400, target_price: 7600, setup_type: 'breakout_retest' };
const config = { businessLine: 'zero-dte-options', policyExecutionEnvironment: 'simulate_only',
  policyRealTradingAllowed: false, trdEnv: 0, trdMarket: 2, policy };
const variant = (id) => ({ ...load_junk_exit_experiment(policy).lines.find((l) => l.line_id === id),
  allocated_entry_qty: 1, allocated_exit_qty: 1, allocated_entry_value: 10, allocated_exit_value: 9,
  comparison_eligible: true });
function sample(seconds, bid, underlying = 7500) {
  const at = new Date(Date.parse(row.entry_filled_at) + seconds * 1000).toISOString();
  return { plan_id: row.plan_id, code: row.code, evaluated_at: at, underlying_price_usd: underlying,
    option_snapshot: { basic: { security: { market: 11, code: row.code }, bidPrice: bid, askPrice: bid + 0.1,
      priceSpread: 0.05, bidVol: 100, askVol: 100, volume: 500 },
    optionExData: { openInterest: 500 }, bid_ask_received_at: at, quote_received_at: at } };
}

test('same observed path distinguishes SL10 from SL15 using the production exit planner', () => {
  const samples = [sample(15, 8.95), sample(30, 8.2)];
  const sl10 = replay_exit_variant({ row, variant: variant('sl10_tp_off'), samples, config });
  const sl15 = replay_exit_variant({ row, variant: variant('control_sl15_tp_off'), samples, config });
  assert.equal(sl10.status, 'complete'); assert.equal(sl15.status, 'complete');
  assert.equal(sl10.fills[0].at, samples[0].evaluated_at);
  assert.equal(sl15.fills[0].at, samples[1].evaluated_at);
  assert.ok(sl10.gross_pnl_usd > sl15.gross_pnl_usd);
});

test('TP30 and breakeven share frozen management rules without mutating the ledger', () => {
  const samples = [sample(15, 13.2), sample(30, 9.9)];
  const before = JSON.stringify(row);
  const tp = replay_exit_variant({ row, variant: variant('sl15_tp30'), samples, config });
  const control = replay_exit_variant({ row, variant: variant('control_sl15_tp_off'), samples, config });
  assert.equal(tp.status, 'complete'); assert.ok(tp.gross_pnl_usd > 0);
  assert.equal(control.status, 'complete'); assert.match(control.fills[0].reason, /breakeven/);
  assert.equal(JSON.stringify(row), before);
});

test('missing, gapped, stale, mismatched and unfinished paths are never assigned modeled profit', () => {
  for (const samples of [[], [sample(60, 8)], [sample(15, 10)],
    [{ ...sample(15, 8), code: 'OTHER' }],
    [{ ...sample(15, 8), option_snapshot: { ...sample(15, 8).option_snapshot, bid_ask_received_at: '2026-09-16T14:00:00Z' } }]]) {
    const result = replay_exit_variant({ row, variant: variant('sl10_tp_off'), samples, config });
    assert.equal(result.status, 'incomplete'); assert.equal(result.gross_pnl_usd, undefined);
  }
});

test('reports keep each line/day separate, exclude void days and preserve visible exposure', () => {
  const variants = Object.fromEntries(policy.exit_experiment.lines.map((l) => [l.line_id, variant(l.line_id)]));
  const current = { ...row, experiment_ledger: { variants } };
  const voided = { ...current, plan_id: 'zero_dte_void', entry_filled_at: '2026-09-11T14:00:00Z' };
  const report = build_exit_replay_report({ state: { orders: { current, voided } }, policy });
  assert.equal(report.groups.length, 6);
  for (const group of report.groups.filter((g) => g.date_et === '2026-09-17')) {
    assert.equal(group.gross_pnl_usd, -100); assert.equal(group.invested_return_pct, -10);
    assert.equal(group.replay_complete, 0); assert.equal(group.modeled_return_pct, null);
  }
  for (const group of report.groups.filter((g) => g.date_et === '2026-09-11')) {
    assert.equal(group.trades, 0); assert.equal(group.gross_pnl_usd, 0);
  }
  assert.equal(report.total_pnl, undefined);
  assert.match(render_replay_report(report), /未扣手续费/);
});

test('bounded recorder survives disk errors and does not block the trading caller', async () => {
  let reject;
  const recorder = create_replay_recorder('unused', { write: () => new Promise((_, r) => { reject = r; }) });
  recorder.record([{ observation_only: true }]); await Promise.resolve();
  assert.equal(recorder.status().pending, 1);
  reject(new Error('disk full')); await recorder.idle();
  assert.equal(recorder.status().error, 'replay_write_failed');
  assert.equal(recorder.status().dropped, 1);
});
