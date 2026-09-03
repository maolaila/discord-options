import assert from 'node:assert/strict';
import test from 'node:test';
import {
  build_merkle_root,
  canonical_hash,
  canonical_stringify,
  extract_notarizable_trades,
  notarizable_trade,
  prepare_trade_batch,
} from '../apps/trade-notary/trade-notary.mjs';

function closed(overrides = {}) {
  return {
    event_at: '2026-09-02T18:13:51.068Z',
    event: 'experiment_line_position_closed',
    business_line: 'zero-dte-options',
    strategy: 'junk_gex_nodes_v3',
    execution_environment: 'simulate_only',
    experiment_id: 'junk_exit_grid_v1',
    cohort_id: 'junk_cohort_test',
    plan_id: 'zero_dte_test',
    signal_id: 'junk_gex_test',
    code: 'SPXW260902P7655000',
    line_id: 'control_sl15_tp_off',
    entry_qty: 4,
    entry_value: 4.6,
    exit_qty: 4,
    exit_value: 4,
    realized_pnl_usd: -60,
    trigger_reason: 'option_15pct_catastrophic_stop_loss',
    ...overrides,
  };
}

test('canonical JSON and hashes do not depend on object key insertion order', () => {
  assert.equal(canonical_stringify({ z: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"z":1}');
  assert.equal(canonical_hash({ b: 2, a: 1 }), canonical_hash({ a: 1, b: 2 }));
});

test('only complete JUNKMAN simulation closes become public proof leaves', () => {
  assert.ok(notarizable_trade(closed()));
  assert.equal(notarizable_trade(closed({ execution_environment: 'real' })), null);
  assert.equal(notarizable_trade(closed({ event: 'entry_order_submitted' })), null);
  assert.equal(notarizable_trade(closed({ exit_value: null })), null);
  assert.equal(notarizable_trade(closed({ business_line: 'junk-multi-options' })), null);
});

test('batch is deterministic, deduplicated, merkle-rooted, and excludes committed leaves', () => {
  const second = closed({
    event_at: '2026-09-02T18:13:52.000Z',
    line_id: 'sl10_tp20',
    exit_value: 5.5,
    realized_pnl_usd: 90,
  });
  const events = [second, closed(), closed()];
  const extracted = extract_notarizable_trades(events);
  assert.equal(extracted.length, 2);
  const first = prepare_trade_batch({ events, strategyId: 'junkman-test' });
  const reordered = prepare_trade_batch({ events: [...events].reverse(), strategyId: 'junkman-test' });
  assert.equal(first.recordId, reordered.recordId);
  assert.equal(first.dataHash, reordered.dataHash);
  assert.equal(first.batch.merkle.root, build_merkle_root(first.leafHashes));
  assert.equal(first.batch.source.execution_environment, 'simulate_only');
  assert.equal(first.batch.source.fees_included, false);

  const index = { schema_version: 1, batches: [{ leaf_hashes: [first.leafHashes[0]] }] };
  const incremental = prepare_trade_batch({ events, index, strategyId: 'junkman-test' });
  assert.equal(incremental.leafHashes.length, 1);
  assert.equal(incremental.leafHashes[0], first.leafHashes[1]);
  assert.equal(prepare_trade_batch({
    events,
    index: { schema_version: 1, batches: [{ leaf_hashes: first.leafHashes }] },
    strategyId: 'junkman-test',
  }), null);
});
