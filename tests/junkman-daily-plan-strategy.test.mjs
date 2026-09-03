import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JUNKMAN_DAILY_PLAN_STRATEGY,
  evaluateJunkmanDailyPlan,
  selectPlannedOptionStrike,
} from '../apps/junk-multi-options/junkman-daily-plan-strategy.mjs';

function context(bar) {
  return { price_action_ready: true, bars_5m: [{ timestamp: '2026-09-02T13:35:00.000Z', volume: 100, ...bar }] };
}

function plan(execution, scenarios = []) {
  return {
    actionable: true,
    event_id: 'event-1',
    message_id: 'message-1',
    channel_id: '1515786763417813094',
    author_id: '414165384648720405',
    session_date_et: '2026-09-02',
    ticker: 'TEST',
    strategy_title: 'source strategy',
    scenarios,
    execution,
  };
}

const strikes = { C: [99, 100, 101, 102], P: [99, 100, 101, 102] };

test('nearest actual OTM strike comes only from the verified same-day chain', () => {
  assert.equal(selectPlannedOptionStrike({ direction: 'bull', current_price_usd: 100, strikes_by_right: strikes }), 101);
  assert.equal(selectPlannedOptionStrike({ direction: 'bear', current_price_usd: 100, strikes_by_right: strikes }), 99);
});

test('magnet lower-edge rejection follows the published center and boundary', () => {
  const decision = evaluateJunkmanDailyPlan({
    plan: plan({
      kind: 'magnet_mean_reversion',
      trigger_zone: { lower_usd: 99, upper_usd: 101 },
      long: { trigger_usd: 99, invalidation_usd: 99, target_usd: 100 },
      bear: { trigger_usd: 101, invalidation_usd: 101, target_usd: 100 },
    }, [{ kind: 'range', weight_pct: 61 }]),
    market_context: context({ open_usd: 99.2, high_usd: 99.8, low_usd: 98.9, close_usd: 99.6 }),
    strikes_by_right: strikes,
    expiration: '2026-09-02',
    now_ms: Date.parse('2026-09-02T13:35:10.000Z'),
  });
  assert.equal(decision.decision, 'trade');
  assert.equal(decision.strategy, JUNKMAN_DAILY_PLAN_STRATEGY);
  assert.equal(decision.direction, 'bull');
  assert.equal(decision.invalidation_price, 99);
  assert.equal(decision.target_price, 100);
  assert.equal(decision.source_plan_weight_pct, 61);
});

test('published bearish retest must touch the zone, reject it, and remain above its target', () => {
  const source = plan({
    kind: 'bearish_retest',
    trigger_zone: { lower_usd: 101, upper_usd: 102 },
    bear: { trigger_usd: 101, invalidation_usd: 102.2, target_usd: 98 },
  });
  const decision = evaluateJunkmanDailyPlan({
    plan: source,
    market_context: context({ open_usd: 101.4, high_usd: 101.8, low_usd: 100.1, close_usd: 100.5 }),
    strikes_by_right: strikes,
    expiration: '2026-09-02',
    now_ms: Date.parse('2026-09-02T13:35:10.000Z'),
  });
  assert.equal(decision.decision, 'trade');
  assert.equal(decision.direction, 'bear');
  assert.equal(decision.strike, 100);
});

test('an unconfirmed or already exhausted plan remains no-trade', () => {
  const source = plan({
    kind: 'bullish_retest',
    trigger_zone: { lower_usd: 99, upper_usd: 99 },
    long: { trigger_usd: 99, invalidation_usd: 98, target_usd: 100 },
  });
  const decision = evaluateJunkmanDailyPlan({
    plan: source,
    market_context: context({ open_usd: 99.2, high_usd: 100.2, low_usd: 98.9, close_usd: 100.1 }),
    strikes_by_right: strikes,
    expiration: '2026-09-02',
    now_ms: Date.parse('2026-09-02T13:35:10.000Z'),
  });
  assert.equal(decision.decision, 'no_trade');
  assert.deepEqual(decision.reason_codes, ['daily_plan_bull_price_outside_invalidation_target']);
});
