'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  NIGHTWATCH_GUILD_ID,
  NIGHTWATCH_ZERO_DTE_FLOW_BOT_AUTHOR_ID,
  NIGHTWATCH_ZERO_DTE_FLOW_CHANNEL_ID,
  parseNightwatchZeroDteFlowAlerts,
} = require('../packages/option-signals/nightwatch-0dte-flow-alert.cjs');

function flowRecord(overrides = {}) {
  return {
    id: 'message-1',
    guild_id: NIGHTWATCH_GUILD_ID,
    channel_id: NIGHTWATCH_ZERO_DTE_FLOW_CHANNEL_ID,
    event_type: 'MESSAGE_CREATE',
    source: 'discord_gateway_websocket',
    timestamp: '2026-08-10T19:59:00.000Z',
    captured_at: '2026-08-10T19:59:02.000Z',
    capture_lag_ms: 2_000,
    author: {
      id: NIGHTWATCH_ZERO_DTE_FLOW_BOT_AUTHOR_ID,
      username: '0DTE FLOW Alert',
      bot: true,
    },
    content: '',
    embeds: [],
    ...overrides,
  };
}

test('splits every alert in one Discord message and treats channel-implicit expiry as 0DTE', () => {
  const events = parseNightwatchZeroDteFlowAlerts(flowRecord({
    content: [
      '@0DTE Flow Alerts',
      '\ud83d\udfe2 15:59 SPY 772C \u4e70 $122.50K 1.1K\u5f20 avg $1.08',
      '\ud83d\udd34 15:51 SPX 7750P \u4e70 $163.18K 512\u5f20 avg $3.19',
    ].join('\n'),
  }), 'live_gateway');

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.option_right), ['call', 'put']);
  assert.deepEqual(events.map((event) => event.color_indicator), ['green', 'red']);
  assert.deepEqual(events.map((event) => event.dte), [0, 0]);
  assert.deepEqual(events.map((event) => event.dte_source), ['channel_default', 'channel_default']);
  assert.equal(events[0].aggressor_side, 'ask');
  assert.equal(events[0].premium_usd, 122_500);
  assert.equal(events[0].contract_count, 1_100);
  assert.equal(events[0].expected_premium_usd, 118_800);
  assert.equal(events[0].premium_relative_error, 0.031145);
  assert.equal(events[0].premium_consistent, true);
  assert.equal(events[0].live_eligible, true);
  assert.equal(events[1].live_eligible, true);
  assert.notEqual(events[0].sub_event_id, events[1].sub_event_id);
  assert.equal(Object.hasOwn(events[0], 'action'), false);
  assert.equal(Object.hasOwn(events[0], 'order_intent'), false);
});

test('supports M premium and K contracts while validating contract notional', () => {
  const [event] = parseNightwatchZeroDteFlowAlerts(flowRecord({
    content: '\ud83d\udfe2 15:59 SPX 7750C \u4e70 $1.22M 5.7K\u5f20 avg $2.14',
  }), 'live_gateway');

  assert.equal(event.premium_usd, 1_220_000);
  assert.equal(event.contract_count, 5_700);
  assert.equal(event.expected_premium_usd, 1_219_800);
  assert.equal(event.premium_relative_error, 0.000164);
  assert.equal(event.premium_consistent, true);
  assert.equal(event.parse_valid, true);
  assert.equal(event.live_eligible, true);
});

test('archives a premium/quantity/average mismatch and makes it ineligible for live use', () => {
  const [event] = parseNightwatchZeroDteFlowAlerts(flowRecord({
    content: '\ud83d\udfe2 15:59 SPX 7750C \u4e70 $500K 100\u5f20 avg $1.00',
  }), 'live_gateway');

  assert.equal(event.premium_usd, 500_000);
  assert.equal(event.expected_premium_usd, 10_000);
  assert.equal(event.premium_relative_error, 49);
  assert.equal(event.premium_consistent, false);
  assert.equal(event.parse_valid, false);
  assert.equal(event.live_eligible, false);
  assert.equal(event.archive_only, true);
  assert.ok(event.reason_codes.includes('premium_contract_notional_mismatch'));
});

test('isolates explicit 1DTE alerts from live 0DTE eligibility', () => {
  const [event] = parseNightwatchZeroDteFlowAlerts(flowRecord({
    content: '\ud83d\udd34 15:24 SPX 1DTE 7770P \u4e70 $240K 100\u5f20 avg $24',
  }), 'live_gateway');

  assert.equal(event.dte, 1);
  assert.equal(event.dte_source, 'explicit');
  assert.equal(event.is_zero_dte, false);
  assert.equal(event.live_eligible, false);
  assert.equal(event.archive_only, true);
  assert.deepEqual(event.reason_codes, ['not_zero_dte']);
});

test('rejects color and option-right mismatches instead of inferring direction', () => {
  const [event] = parseNightwatchZeroDteFlowAlerts(flowRecord({
    content: '\ud83d\udfe2 15:51 SPX 7750P \u4e70 $163.18K 512\u5f20 avg $3.19',
  }), 'live_gateway');

  assert.equal(event.parse_valid, false);
  assert.equal(event.live_eligible, false);
  assert.ok(event.reason_codes.includes('color_right_mismatch'));
});

test('REST observations and stale gateway captures are archive only', () => {
  const baseRecord = flowRecord({
    content: '\ud83d\udfe2 15:59 SPY 772C \u4e70 $122.50K 1.1K\u5f20 avg $1.08',
  });
  const [restEvent] = parseNightwatchZeroDteFlowAlerts(baseRecord, 'rest_archive');
  const [staleEvent] = parseNightwatchZeroDteFlowAlerts({ ...baseRecord, capture_lag_ms: 15_001 }, 'live_gateway');

  assert.equal(restEvent.live_eligible, false);
  assert.ok(restEvent.reason_codes.includes('archive_observation_only'));
  assert.equal(staleEvent.live_eligible, false);
  assert.ok(staleEvent.reason_codes.includes('capture_lag_exceeded'));
});

test('allows up to five seconds of future clock skew while preserving the raw capture lag', () => {
  const baseRecord = flowRecord({
    content: '\ud83d\udfe2 15:59 SPY 772C \u4e70 $122.50K 1.1K\u5f20 avg $1.08',
  });
  const [boundaryEvent] = parseNightwatchZeroDteFlowAlerts({
    ...baseRecord,
    capture_lag_ms: -5_000,
  }, 'live_gateway');
  const [beyondToleranceEvent] = parseNightwatchZeroDteFlowAlerts({
    ...baseRecord,
    id: 'message-2',
    capture_lag_ms: -5_001,
  }, 'live_gateway');

  assert.equal(boundaryEvent.capture_lag_ms, -5_000);
  assert.equal(boundaryEvent.live_eligible, true);
  assert.deepEqual(boundaryEvent.reason_codes, []);
  assert.equal(beyondToleranceEvent.capture_lag_ms, -5_001);
  assert.equal(beyondToleranceEvent.live_eligible, false);
  assert.equal(beyondToleranceEvent.archive_only, true);
  assert.ok(beyondToleranceEvent.reason_codes.includes('negative_capture_lag'));
});

test('a claimed live observation from a non-gateway source stays archive only', () => {
  const [event] = parseNightwatchZeroDteFlowAlerts(flowRecord({
    source: 'discord_rest_channel_messages',
    content: '\ud83d\udfe2 15:59 SPY 772C \u4e70 $122.50K 1.1K\u5f20 avg $1.08',
  }), 'live_gateway');

  assert.equal(event.live_eligible, false);
  assert.ok(event.reason_codes.includes('not_gateway_source'));
});

test('requires exact guild, channel, bot author id and bot flag', () => {
  const valid = flowRecord({ content: '\ud83d\udfe2 15:59 SPY 772C \u4e70 $122.50K 1.1K\u5f20 avg $1.08' });

  assert.equal(parseNightwatchZeroDteFlowAlerts({ ...valid, guild_id: 'wrong' }, 'live_gateway').length, 0);
  assert.equal(parseNightwatchZeroDteFlowAlerts({ ...valid, channel_id: 'wrong' }, 'live_gateway').length, 0);
  assert.equal(parseNightwatchZeroDteFlowAlerts({ ...valid, author: { ...valid.author, id: 'wrong' } }, 'live_gateway').length, 0);
  assert.equal(parseNightwatchZeroDteFlowAlerts({ ...valid, author: { ...valid.author, bot: false } }, 'live_gateway').length, 0);
});

test('fingerprint is shared by duplicate payloads while child ids remain message-specific', () => {
  const content = '\ud83d\udfe2 15:59 SPY 772C \u4e70 $122.50K 1.1K\u5f20 avg $1.08';
  const [first] = parseNightwatchZeroDteFlowAlerts(flowRecord({ id: 'message-1', content }), 'live_gateway');
  const [sameMessage] = parseNightwatchZeroDteFlowAlerts(flowRecord({ id: 'message-1', content }), 'live_gateway');
  const [otherMessage] = parseNightwatchZeroDteFlowAlerts(flowRecord({ id: 'message-2', content }), 'live_gateway');

  assert.equal(first.payload_fingerprint, otherMessage.payload_fingerprint);
  assert.equal(first.sub_event_id, sameMessage.sub_event_id);
  assert.notEqual(first.sub_event_id, otherMessage.sub_event_id);
});
