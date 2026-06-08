import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeExitTrigger,
  exitTrigger,
  isRegularSessionNow,
  sellLimitPriceFromQuote,
} from '../moomoo-exit-monitor.mjs';

const closeRules = {
  exit_before_regular_session_close: true,
  close_exit_start_time_et: '15:45',
  force_close_exit_start_time_et: '15:55',
};

function dateAtEtTime(time) {
  return new Date(`2026-06-08T${time}:00Z`);
}

test('regular session detection uses New York trading hours', () => {
  assert.equal(isRegularSessionNow(dateAtEtTime('13:29')), false); // 09:29 ET
  assert.equal(isRegularSessionNow(dateAtEtTime('13:30')), true); // 09:30 ET
  assert.equal(isRegularSessionNow(dateAtEtTime('20:00')), true); // 16:00 ET
  assert.equal(isRegularSessionNow(dateAtEtTime('20:01')), false); // 16:01 ET
});

test('close exit window starts at 15:45 ET and force phase starts at 15:55 ET', () => {
  assert.equal(closeExitTrigger(closeRules, dateAtEtTime('19:44')), null); // 15:44 ET

  const standard = closeExitTrigger(closeRules, dateAtEtTime('19:45')); // 15:45 ET
  assert.equal(standard.reason, 'exit_before_regular_session_close');
  assert.equal(standard.close_exit_phase, 'standard');
  assert.equal(standard.close_exit_start_time_et, '15:45');
  assert.equal(standard.force_close_exit_start_time_et, '15:55');

  const force = closeExitTrigger(closeRules, dateAtEtTime('19:55')); // 15:55 ET
  assert.equal(force.reason, 'exit_before_regular_session_close');
  assert.equal(force.close_exit_phase, 'force');
});

test('time-based close exit does not require an underlying snapshot price', () => {
  const plan = {
    order: { underlying_exit_rules: closeRules },
    signal: { direction: 'bull', stock_entry: 100 },
  };

  const trigger = exitTrigger(plan, null, { now: dateAtEtTime('19:46') }); // 15:46 ET
  assert.equal(trigger.reason, 'exit_before_regular_session_close');
  assert.equal(trigger.underlying_price, null);
});

test('price triggers still take priority before close exit', () => {
  const plan = {
    order: { underlying_exit_rules: { ...closeRules, signal_stock_target: 105 } },
    signal: { direction: 'bull', stock_entry: 100, stock_target: 105 },
  };

  const trigger = exitTrigger(plan, 106, { now: dateAtEtTime('19:46') }); // 15:46 ET
  assert.equal(trigger.reason, 'signal_stock_target');
  assert.equal(trigger.underlying_price, 106);
});

test('force close phase uses a more aggressive protected sell limit', () => {
  const quote = {
    bid: 0.4,
    tick: 0.05,
    spread_abs: 0.1,
    sell_estimate_price: 0.35,
  };

  assert.equal(sellLimitPriceFromQuote(quote, { close_exit_phase: 'standard' }), 0.35);
  assert.equal(sellLimitPriceFromQuote(quote, { close_exit_phase: 'force' }), 0.3);
});
