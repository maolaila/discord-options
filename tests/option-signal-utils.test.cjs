const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FIELD,
  buildOrderIntent,
  parseOptionSignal,
} = require('../packages/option-signals/option-signal-utils.js');

test('PA option signal becomes actionable at 60 percent win rate without confidence or risk gates', () => {
  const signal = parseOptionSignal({
    id: 'm1',
    channel_id: 'c1',
    timestamp: '2026-06-28T14:00:00.000Z',
    captured_at: '2026-06-28T14:00:01.000Z',
    embeds: [{
      title: 'AAPL 2026-07-17 200C | PA',
      fields: [
        { name: FIELD.executionView, value: '方向：偏多，交易' },
        { name: FIELD.executionPlan, value: '入场 100 目标 150 止损 90' },
        { name: FIELD.invalidation, value: '胜率 60%' },
        { name: FIELD.riskNote, value: '风险 9' },
      ],
    }],
  }, 'test');

  assert.equal(signal.action, 'trade');
  assert.equal(signal.win_rate_pct, 60);
  assert.equal(signal.risk_score, 9);
  assert.equal(signal.signal_actionable, true);
  assert.equal(signal.full_plan_ready, true);

  const intent = buildOrderIntent(signal);
  assert.equal(intent.action, 'BUY_TO_OPEN');
  assert.equal(intent.option_stop_loss_pct, 20);
});

test('PA option signal below 60 percent win rate does not create an order intent', () => {
  const signal = parseOptionSignal({
    id: 'm2',
    channel_id: 'c1',
    embeds: [{
      title: 'AAPL 2026-07-17 200C | PA',
      fields: [
        { name: FIELD.executionView, value: '方向：偏多，交易' },
        { name: FIELD.executionPlan, value: '入场 100 目标 150 止损 90' },
        { name: FIELD.invalidation, value: '胜率 59%' },
      ],
    }],
  }, 'test');

  assert.equal(signal.signal_actionable, false);
  assert.equal(buildOrderIntent(signal), null);
});
