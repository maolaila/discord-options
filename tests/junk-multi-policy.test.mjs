import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { load_junk_exit_experiment } from '../apps/zero-dte-options/junk-exit-experiment.mjs';
import { buildZeroDteSimulatedEntryPlan } from '../apps/zero-dte-options/zero-dte-moomoo-executor.mjs';
import { buildZeroDteSimulatedExplicitExitPlan } from '../apps/zero-dte-options/zero-dte-moomoo-exit.mjs';
import { resolveBusinessLine } from '../packages/business-lines/business-lines.mjs';
import { acquireSimulatedOptionsEntryLock } from '../packages/business-lines/simulated-options-entry-lock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(await fsp.readFile(path.join(root, 'config', 'junk-multi-options-policy.json'), 'utf8'));
const now = new Date('2026-08-25T14:36:00.000Z');

function config() {
  return {
    businessLine: 'junk-multi-options',
    policyExecutionEnvironment: 'simulate_only',
    policyRealTradingAllowed: false,
    trdEnv: 0,
    trdMarket: 2,
    policy: {
      ...policy,
      risk_limits: { ...policy.risk_limits, allowed_underlyings: ['QQQ'] },
    },
  };
}

function signal() {
  return {
    business_line: 'junk-multi-options',
    strategy: 'junk_gex_nodes_v3',
    decision: 'trade',
    action: 'open_long_option',
    flow_dependency: 'none',
    ticker: 'QQQ',
    snapshot_at: '2026-08-25T14:35:00.000Z',
    generated_at: '2026-08-25T14:35:59.000Z',
    snapshot_state: 'fresh',
    direction: 'bullish',
    signal_type: 'gex_node_breakout_retest',
    reason_codes: ['gex_node_breakout_retest', 'gex_node_confirmed'],
    tested_node: { strike_usd: 706, net_gex_usd: -2_000_000 },
    entry_reference_usd: 706.2,
    stop_underlying_usd: 705.8,
    target_underlying_usd: 707,
    option_selection: {
      option_right: 'call',
      expiry_days: 0,
      strike_reference_usd: 707,
    },
    evidence_model: { heatmap: { assessment: 'confirm' } },
  };
}

function contract() {
  return {
    security: { market: 11, code: 'QQQ260825C00707000' },
    name: 'QQQ 2026-08-25 707 Call',
    strikeTime: '2026-08-25',
    strikePrice: 707,
    lotSize: 100,
  };
}

function optionSnapshot() {
  return {
    basic: {
      security: { market: 11, code: 'QQQ260825C00707000' },
      bidPrice: 2,
      askPrice: 2.05,
      bidVol: 30,
      askVol: 30,
      curPrice: 2.02,
      priceSpread: 0.01,
      volume: 500,
    },
    optionExData: { openInterest: 500, contractMultiplier: 100 },
    quote_source: 'push_order_book',
    quote_received_at: '2026-08-25T14:35:59.000Z',
    bid_ask_source: 'push_order_book',
    bid_ask_received_at: '2026-08-25T14:35:59.000Z',
  };
}

test('JUNKMAN-MULTI policy is isolated, simulation-only, and has seven $10k virtual lines', () => {
  assert.equal(resolveBusinessLine('junk-top100').key, 'junk-multi-options');
  assert.equal(policy.execution.environment, 'simulate_only');
  assert.equal(policy.execution.real_trading_allowed, false);
  assert.equal(policy.universe.nightwatch_coverage_required, true);
  assert.equal(policy.universe.zero_dte_chain_required, true);
  const manifest = load_junk_exit_experiment(policy);
  assert.equal(manifest.line_count, 7);
  assert.equal(manifest.total_paper_equity_usd, 70_000);
  assert.ok(manifest.lines.every((line) => line.paper_equity_usd === 10_000));
});

test('multi-symbol entry and exit plans retain isolated ownership and remarks', () => {
  const entry = buildZeroDteSimulatedEntryPlan({
    signal: signal(),
    contract: contract(),
    option_snapshot: optionSnapshot(),
    config: config(),
    now,
  });
  assert.equal(entry.gate.passed, true);
  assert.equal(entry.business_line, 'junk-multi-options');
  assert.match(entry.order.remark, /^junk_multi:/);

  const exit = buildZeroDteSimulatedExplicitExitPlan({
    owned_position: {
      business_line: 'junk-multi-options',
      strategy: 'junk_gex_nodes_v3',
      plan_id: entry.plan_id,
      code: entry.contract.code,
      expiration: '2026-08-25',
      filled_qty: 7,
      exited_qty: 0,
      pending_exit_qty: 0,
      entry_fill_price: 2.05,
    },
    option_snapshot: optionSnapshot(),
    requested_exit_qty: 2,
    config: config(),
    now,
  });
  assert.equal(exit.gate.passed, true);
  assert.equal(exit.business_line, 'junk-multi-options');
  assert.match(exit.order.remark, /^junk_multi_exit:/);
});

test('shared simulated-options entry lock is exclusive', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'junk-entry-lock-'));
  const lockPath = path.join(directory, 'entry.lock.json');
  try {
    const release = await acquireSimulatedOptionsEntryLock({
      business_line: 'zero-dte-options',
      lock_path: lockPath,
      timeout_ms: 100,
    });
    await assert.rejects(
      acquireSimulatedOptionsEntryLock({
        business_line: 'junk-multi-options',
        lock_path: lockPath,
        timeout_ms: 100,
      }),
      /Timed out acquiring/,
    );
    await release();
    const releaseAgain = await acquireSimulatedOptionsEntryLock({
      business_line: 'junk-multi-options',
      lock_path: lockPath,
      timeout_ms: 100,
    });
    await releaseAgain();
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
