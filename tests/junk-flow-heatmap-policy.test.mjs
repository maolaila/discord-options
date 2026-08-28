import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyUnusualFlowHeatmapGate,
  buildRecentUnusualFlowSeeds,
  readRecentUnusualFlowSeeds,
  selectRecentUnusualFlowEvents,
} from '../apps/junk-flow-heatmap-options/junk-flow-heatmap-source.mjs';
import { shouldPollFlowSource } from '../apps/junk-multi-options/junk-multi-line.mjs';
import { resolveBusinessLine } from '../packages/business-lines/business-lines.mjs';

const root = path.resolve(import.meta.dirname, '..');
const policy = JSON.parse(await fsp.readFile(
  path.join(root, 'config', 'junk-flow-heatmap-options-policy.json'),
  'utf8',
));
const nowMs = Date.parse('2026-08-28T14:50:00.000Z');

function flowEvent(overrides = {}) {
  return {
    schema_version: 'nightwatch_zero_dte_flow_event.v1',
    sub_event_id: 'event-call',
    message_id: 'message-1',
    message_timestamp: '2026-08-28T14:49:30.000Z',
    captured_at: '2026-08-28T14:49:30.100Z',
    trading_date_et: '2026-08-28',
    ticker: 'SPX',
    dte: 0,
    is_zero_dte: true,
    strike: 7755,
    right_code: 'C',
    aggressor_side: 'ask',
    execution_type: 'sweep',
    premium_usd: 177100,
    contract_count: 161,
    parse_valid: true,
    premium_consistent: true,
    live_eligible: true,
    archive_only: false,
    ...overrides,
  };
}

test('flow plus Heatmap line is deterministic simulation-only with seven $10k ledgers', () => {
  assert.equal(resolveBusinessLine('flow-heatmap').key, 'junk-flow-heatmap-options');
  assert.equal(policy.business_line.id, 'junk-flow-heatmap-options');
  assert.equal(policy.execution.environment, 'simulate_only');
  assert.equal(policy.execution.real_trading_allowed, false);
  assert.equal(policy.execution.ai_decisioning_allowed, false);
  assert.equal(policy.execution.external_model_calls_allowed, false);
  assert.equal(policy.universe.poll_interval_seconds, 30);
  assert.equal(policy.provider.fixed_sample_interval_seconds, 300);
  assert.equal(policy.strategy.flow_event_max_age_seconds, 300);
  assert.equal(policy.strategy.require_heatmap_snapshot, true);
  assert.equal(policy.strategy.require_heatmap_confirmation, true);
  assert.equal(policy.exit_experiment.lines.length, 7);
  assert.ok(policy.exit_experiment.lines.every((line) => line.paper_equity_usd === 10_000));
});

test('Flow source cadence remains 30 seconds independently of the 15-second broker loop', () => {
  const lastPollAt = '2026-08-28T14:50:00.000Z';
  assert.equal(shouldPollFlowSource({ universe_present: false, last_poll_at: lastPollAt, now_ms: nowMs }), true);
  assert.equal(shouldPollFlowSource({
    universe_present: true,
    last_poll_at: lastPollAt,
    now_ms: Date.parse('2026-08-28T14:50:29.999Z'),
  }), false);
  assert.equal(shouldPollFlowSource({
    universe_present: true,
    last_poll_at: lastPollAt,
    now_ms: Date.parse('2026-08-28T14:50:30.000Z'),
  }), true);
});

test('crawler source accepts only fresh authenticated 0DTE ask-side alerts', () => {
  const result = selectRecentUnusualFlowEvents([
    flowEvent(),
    flowEvent({ sub_event_id: 'old', message_timestamp: '2026-08-28T14:40:00.000Z' }),
    flowEvent({ sub_event_id: 'archive', live_eligible: false, archive_only: true }),
    flowEvent({ sub_event_id: 'bid', aggressor_side: 'bid' }),
    flowEvent({ sub_event_id: 'one-dte', dte: 1, is_zero_dte: false }),
    flowEvent({ sub_event_id: 'multileg', execution_type: 'multileg' }),
  ], {
    session_date_et: '2026-08-28',
    now_ms: nowMs,
    max_event_age_ms: 300_000,
  });
  assert.deepEqual(result.accepted.map((event) => event.sub_event_id), ['event-call']);
  assert.equal(result.rejected.length, 5);
});

test('crawler reads a bounded local tail instead of rescanning the growing archive', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'junk-flow-tail-'));
  const file = path.join(directory, 'flow.ndjson');
  try {
    await fsp.writeFile(file, `${'x'.repeat(1_100_000)}\n${JSON.stringify(flowEvent())}\n`, 'utf8');
    const result = await readRecentUnusualFlowSeeds(file, {
      session_date_et: '2026-08-28',
      now_ms: nowMs,
    });
    assert.equal(result.source_status, 'ready');
    assert.deepEqual(result.accepted.map((event) => event.sub_event_id), ['event-call']);
    assert.equal(result.tail_diagnostics.truncated_head, true);
    assert.ok(result.tail_diagnostics.bytes_read <= 1_048_576);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('same-time opposite flow is marked conflicted instead of picking a direction silently', () => {
  const result = buildRecentUnusualFlowSeeds([
    flowEvent(),
    flowEvent({ sub_event_id: 'event-put', right_code: 'P', strike: 7750 }),
  ], { session_date_et: '2026-08-28', now_ms: nowMs });
  assert.equal(result.seeds.length, 1);
  assert.equal(result.seeds[0].flow_conflict, true);
  assert.deepEqual(result.seeds[0].contemporaneous_event_ids, ['event-call', 'event-put']);
});

test('entry requires JUNKMAN trade direction, same strike, fresh flow, and exact Heatmap confirmation', () => {
  const decision = {
    ticker: 'SPX',
    decision: 'trade',
    action: 'buy_to_open',
    direction: 'bull',
    tested_node: { strike_usd: 7755 },
    reason_codes: ['breakout_retest_confirmed'],
    evidence_model: { heatmap: { assessment: 'confirm' } },
  };
  const finalist = { ticker: 'SPX', flow_event: flowEvent(), flow_conflict: false };
  const passed = applyUnusualFlowHeatmapGate(decision, finalist, { now_ms: nowMs });
  assert.equal(passed.decision, 'trade');
  assert.equal(passed.flow_heatmap_evidence.gate_passed, true);

  const wrongStrike = applyUnusualFlowHeatmapGate(
    { ...decision, tested_node: { strike_usd: 7750 } },
    finalist,
    { now_ms: nowMs },
  );
  assert.equal(wrongStrike.decision, 'no_trade');
  assert.ok(wrongStrike.reason_codes.includes('unusual_flow_strike_not_same_as_tested_node'));

  const noHeatmap = applyUnusualFlowHeatmapGate(
    { ...decision, evidence_model: { heatmap: { assessment: 'neutral' } } },
    finalist,
    { now_ms: nowMs },
  );
  assert.equal(noHeatmap.decision, 'no_trade');
  assert.ok(noHeatmap.reason_codes.includes('heatmap_tested_node_not_confirmed'));
});
