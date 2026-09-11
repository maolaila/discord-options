import assert from 'node:assert/strict';
import test from 'node:test';
import policy from './fixtures/junk-eight-line-policy.mjs';
import activePolicy from '../config/zero-dte-options-policy.json' with { type: 'json' };
import { reconcile_junk_experiment_row, broker_order_keys } from '../apps/zero-dte-options/zero-dte-line.mjs';
import {
  load_junk_exit_experiment, build_junk_experiment_cohort, create_junk_experiment_ledger,
  finalize_junk_experiment_entry_allocation, begin_junk_experiment_exit_batch,
} from '../apps/zero-dte-options/junk-exit-experiment.mjs';

function fixture({ active = false } = {}) {
  const selectedPolicy = active ? activePolicy : policy;
  const totalQty = active ? 3 : 8;
  const pendingQty = active ? 1 : 2;
  const oldPrice = active ? 16.1 : 14.8;
  const now = new Date('2026-09-11T14:47:48Z');
  const manifest = load_junk_exit_experiment(selectedPolicy);
  const cohort = build_junk_experiment_cohort({
    plan_id: 'zero_dte_test', business_line: 'zero-dte-options', strategy: 'junk_gex_nodes_v3',
    planned_at: now.toISOString(), gate: { passed: true, reasons: [] },
    signal: { signal_id: 'test', generated_at: now.toISOString(), ticker: 'SPX' },
    contract: { code: 'SPXW260911P7655000' },
    quote: { buy_limit_price: 12.3, ask_size_contracts: 100 },
    position_sizing: { qty: 1, estimated_position_usd: 1230, max_qty_to_ask_volume_ratio: 1 },
    order: { qty: 1, price: 12.3 },
  }, manifest, { line_participation: { latest_regime_lifecycle: { participate: true } } });
  const ledger = finalize_junk_experiment_entry_allocation(create_junk_experiment_ledger(cohort.experiment), {
    filled_qty: totalQty, fill_avg_price: 12.3, now,
  });
  const allocations = active ? { sl15_tp30: 1 } : { sl10_tp20: 1, sl15_tp20: 1 };
  const reason_by_line = active ? { sl15_tp30: 'option_30pct_take_profit' }
    : { sl10_tp20: 'option_20pct_take_profit', sl15_tp20: 'option_20pct_take_profit' };
  const row = {
    plan_id: cohort.plan_id, code: 'SPXW260911P7655000', expiration: '2026-09-11',
    business_line: 'zero-dte-options', strategy: 'junk_gex_nodes_v3', status: 'exit_submitted',
    filled_qty: totalQty, exited_qty: 0, exit_fill_value: 0, entry_fill_price: 12.3,
    entry_filled_at: '2026-09-11T14:46:01Z', direction: 'bear', setup_type: 'breakout_retest',
    invalidation_price: 7661.4781, target_price: 7650, contract_multiplier: 100,
    exit_order_id: 'old-order', exit_order_id_ex: 'old-ex', exit_order_type: 'limit',
    exit_submitted_price: oldPrice, exit_attempt_no: 1, pending_exit_qty: pendingQty,
    exit_base_exited_qty: 0, exit_order_accounted_fill_qty: 0, exit_order_accounted_fill_value: 0,
    experiment_exit_latches: Object.fromEntries(Object.entries(reason_by_line).map(([id, reason]) => [id, {
      kind: 'full', remaining_qty: 1, reason, management_update: {},
    }])),
    experiment_ledger: begin_junk_experiment_exit_batch(ledger, { allocations, reason_by_line, attempt_no: 1, now }),
  };
  const calls = { cancels: [], executions: [], events: [], plans: [] };
  const config = { businessLine: 'zero-dte-options', trdEnv: 0, trdMarket: 2,
    policyExecutionEnvironment: 'simulate_only', policyRealTradingAllowed: false, policy: selectedPolicy };
  const args = {
    runtime: { client: {}, config }, state: { session_date_et: '2026-09-11', orders: { [row.plan_id]: row } },
    row, now, underlying_price_usd: 7650.2571, allow_execution: true,
    persist_state: async () => {}, exit_config: config, force_close: false,
    emergency_submission_allowed: true, session_date_et: '2026-09-11',
    position: { qty: totalQty, canSellQty: totalQty - pendingQty }, orders: new Map(), order_rows: [], fills_by_order: new Map(),
    effects: {
      experimentEvent: async (...event) => calls.events.push(event), tradeEvent: async () => {},
      appendPlan: async plan => calls.plans.push(plan),
      cancel: async (...request) => { calls.cancels.push(request); },
      execute: async ({ plan }) => {
        calls.executions.push(plan);
        return { ...plan, order_status: 'submitted_simulation_exit', execution: {
          submitted: true, submitted_qty: plan.order.qty, broker_order_id: 'replacement',
          broker_order_id_ex: 'replacement-ex', submitted_at: args.now.toISOString(),
        } };
      },
    },
  };
  function order(status = 5, filled = 0) {
    const o = { orderID: 'old-order', orderIDEx: 'old-ex', orderStatus: status,
      qty: pendingQty, fillQty: filled, fillAvgPrice: filled ? oldPrice : 0, price: oldPrice };
    args.orders = new Map(broker_order_keys(o).map(k => [k, o])); args.order_rows = [o];
    args.position = { qty: totalQty - filled, canSellQty: status === 15 || status === 11 ? totalQty - filled : totalQty - pendingQty };
  }
  function quote(bid = active ? 16.2 : 14.9) {
    args.option_snapshot = bid === null ? null : {
      basic: { security: { market: 11, code: row.code }, bidPrice: bid, askPrice: bid + .1,
        priceSpread: .1, bidVol: 20, askVol: 20, curPrice: bid, volume: 100 },
      optionExData: { contractMultiplier: 100 }, quote_received_at: args.now.toISOString(),
    };
  }
  order(); quote();
  return { args, row, calls, order, quote, run: () => reconcile_junk_experiment_row(args) };
}

test('9/11 regression: live TP order does not skip breakeven and other variants; replace only after broker terminal', async () => {
  const f = fixture(); await f.run();
  assert.ok(Object.values(f.row.experiment_ledger.variants).every(v => v.breakeven_armed));
  assert.equal(f.calls.cancels.length, 0);
  f.quote(11.5); await f.run();
  assert.equal(f.calls.cancels.length, 1);
  assert.equal(f.calls.executions.length, 0);
  assert.equal(Object.keys(f.row.experiment_exit_latches).length, 8);
  assert.equal(f.row.experiment_exit_latches.sl10_tp20.reason, 'option_breakeven_protect');
  await f.run(); // CANCEL acknowledgement is not terminal proof.
  assert.equal(f.calls.executions.length, 0);
  f.order(15); await f.run();
  assert.equal(f.calls.executions.length, 0);
  assert.equal(f.row.experiment_ledger.pending_exit_batch, null);
  await f.run();
  assert.equal(f.calls.executions.length, 1);
  assert.equal(f.calls.executions[0].order.qty, 8);
  assert.equal(f.calls.executions[0].order.price, 11.4);
  assert.ok(Object.values(f.calls.executions[0].experiment_reason_by_line).every(r => r === 'option_breakeven_protect'));
});

test('unfilled TP is repriced when market moves away even before breakeven triggers', async () => {
  const f = fixture(); f.quote(14.5); await f.run();
  assert.equal(f.row.exit_cancel_reason, 'limit_no_longer_marketable');
  assert.equal(f.calls.executions.length, 0);
});

test('partial fill during cancellation is counted once and only remaining seven are replaced', async () => {
  const f = fixture(); await f.run(); f.quote(11.5); f.order(10, 1);
  await f.run(); await f.run();
  assert.equal(f.row.exited_qty, 1);
  assert.equal(f.calls.executions.length, 0);
  f.order(15, 1); await f.run(); await f.run();
  assert.equal(f.calls.executions[0].order.qty, 7);
  assert.equal(f.row.exited_qty, 1);
  assert.equal(f.row.exit_fill_value, 14.8);
});

test('fill wins cancellation race: both TP fills retained and remaining six alone exit', async () => {
  const f = fixture(); await f.run(); f.quote(11.5); await f.run();
  f.order(11, 2); await f.run(); await f.run();
  assert.equal(f.row.exited_qty, 2);
  assert.equal(f.calls.executions[0].order.qty, 6);
  assert.equal(f.row.experiment_ledger.variants.sl10_tp20.realized_pnl_usd, 250);
  assert.equal(f.row.experiment_ledger.variants.sl15_tp20.realized_pnl_usd, 250);
});

test('failed cancel remains monitored, retries same identity, and never submits a second live exit', async () => {
  const f = fixture(); f.quote(11.5);
  f.args.effects.cancel = async () => { throw new Error('cancel timeout'); };
  await f.run(); assert.match(f.row.last_error, /cancel timeout/);
  assert.equal(f.row.exit_order_id, 'old-order');
  assert.equal(f.calls.executions.length, 0);
  f.args.effects.cancel = async (...a) => f.calls.cancels.push(a);
  await f.run(); assert.equal(f.calls.cancels.length, 1);
  assert.equal(f.calls.executions.length, 0);
});

test('dry run keeps monitoring but does not cancel or place orders', async () => {
  const f = fixture(); f.args.allow_execution = false; f.quote(11.5); await f.run();
  assert.equal(f.calls.cancels.length, 0); assert.equal(f.calls.executions.length, 0);
});

test('force close cancels a limit without quote; missing quote alone never fabricates a reprice', async () => {
  const f = fixture(); f.quote(null); await f.run(); assert.equal(f.calls.cancels.length, 0);
  f.args.force_close = true; await f.run();
  assert.equal(f.calls.cancels.length, 1); assert.equal(f.calls.executions.length, 0);
});

test('broker cumulative-fill regression blocks replacement instead of duplicating previously sold quantity', async () => {
  const f = fixture(); f.order(10, 1); await f.run(); f.order(5, 0); await f.run();
  assert.equal(f.row.status, 'recovery_blocked');
  assert.match(f.row.last_error, /cumulative_fill_regressed/);
  assert.equal(f.calls.executions.length, 0);
});

test('restart after CANCEL request still waits for broker terminal and fresh reconciliation', async () => {
  const f = fixture(); await f.run(); f.quote(11.5); await f.run();
  const recovered = JSON.parse(JSON.stringify(f.row));
  f.args.row = recovered; f.args.state.orders[recovered.plan_id] = recovered;
  await f.run(); assert.equal(f.calls.executions.length, 0);
  f.order(15); await f.run(); assert.equal(f.calls.executions.length, 0);
  await f.run(); assert.equal(f.calls.executions[0].order.qty, 8);
});

test('replacement full fill closes all variants with real fills and no further cancellation', async () => {
  const f = fixture(); await f.run(); f.quote(11.5); await f.run(); f.order(15);
  await f.run(); await f.run();
  const replacement = { orderID: 'replacement', orderIDEx: 'replacement-ex', orderStatus: 11,
    qty: 8, fillQty: 8, fillAvgPrice: 11.4, price: 11.4 };
  f.args.orders = new Map(broker_order_keys(replacement).map(k => [k, replacement]));
  f.args.order_rows = [replacement]; f.args.position = { qty: 0, canSellQty: 0 };
  const result = await f.run();
  assert.equal(result.closed, true); assert.equal(f.row.exited_qty, 8);
  assert.equal(f.row.status, 'closed'); assert.equal(f.calls.executions.length, 1);
  assert.ok(Object.values(f.row.experiment_ledger.variants).every(v => v.realized_pnl_usd === -90));
});

test('live market order is not canceled or duplicated while awaiting fills', async () => {
  const f = fixture(); f.row.exit_order_type = 'market'; f.quote(11.5); f.args.force_close = true;
  await f.run(); assert.equal(f.calls.cancels.length, 0); assert.equal(f.calls.executions.length, 0);
});

test('production three-line TP30 hang still monitors every line and replaces exactly three after terminal', async () => {
  const f = fixture({ active: true }); await f.run();
  assert.ok(Object.values(f.row.experiment_ledger.variants).every(v => v.breakeven_armed));
  assert.equal(f.calls.cancels.length, 0);
  f.quote(11.5); await f.run();
  assert.equal(f.calls.cancels.length, 1); assert.equal(f.calls.executions.length, 0);
  assert.deepEqual(Object.keys(f.row.experiment_exit_latches).sort(), ['control_sl15_tp_off', 'sl10_tp_off', 'sl15_tp30']);
  assert.equal(f.row.experiment_exit_latches.sl15_tp30.reason, 'option_breakeven_protect');
  f.order(15); await f.run(); assert.equal(f.calls.executions.length, 0);
  await f.run();
  assert.equal(f.calls.executions[0].order.qty, 3);
  assert.deepEqual(Object.keys(f.calls.executions[0].experiment_reason_by_line).sort(), ['control_sl15_tp_off', 'sl10_tp_off', 'sl15_tp30']);
});

test('production TP30 fill during cancel is retained and only remaining two contracts are replaced', async () => {
  const f = fixture({ active: true }); await f.run(); f.quote(11.5); await f.run();
  f.order(11, 1); await f.run(); await f.run();
  assert.equal(f.row.exited_qty, 1);
  assert.equal(f.row.experiment_ledger.variants.sl15_tp30.realized_pnl_usd, 380);
  assert.equal(f.calls.executions[0].order.qty, 2);
  assert.deepEqual(Object.keys(f.calls.executions[0].experiment_reason_by_line).sort(), ['control_sl15_tp_off', 'sl10_tp_off']);
});
