import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeExitTrigger,
  exitOrderClosesPosition,
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

test('stale stock lines do not trigger immediate stock stop exits', () => {
  const plan = {
    order: {
      underlying_exit_rules: {
        ...closeRules,
        use_signal_stock_lines: false,
        option_price_exit_enabled: true,
        option_stop_loss_pct: 20,
        option_take_profit_pct: 50,
        signal_stock_target: 555,
        signal_stock_stop: 579.7,
      },
    },
    signal: {
      direction: 'bear',
      stock_entry: 569.7,
      stock_target: 555,
      stock_stop: 579.7,
    },
  };

  const trigger = exitTrigger(plan, 591.27, {
    now: dateAtEtTime('14:30'), // 10:30 ET
    optionQuote: { sell_estimate_price: 25.7, bid: 25.95 },
    entryOptionPrice: 26.55,
  });

  assert.equal(trigger, null);
});

test('option price exits use fill price for stop loss and take profit', () => {
  const plan = {
    order: {
      underlying_exit_rules: {
        ...closeRules,
        use_signal_stock_lines: false,
        option_price_exit_enabled: true,
        option_stop_loss_pct: 20,
        option_take_profit_pct: 50,
      },
    },
    signal: { direction: 'bear' },
  };

  const stop = exitTrigger(plan, 591.27, {
    now: dateAtEtTime('14:30'), // 10:30 ET
    optionQuote: { sell_estimate_price: 21.2, bid: 21.25 },
    entryOptionPrice: 26.55,
  });
  assert.equal(stop.reason, 'option_20pct_stop_loss');
  assert.equal(stop.line, 21.24);
  assert.equal(stop.option_price, 21.2);

  const take = exitTrigger(plan, 591.27, {
    now: dateAtEtTime('14:30'), // 10:30 ET
    optionQuote: { sell_estimate_price: 39.85, bid: 39.9 },
    entryOptionPrice: 26.55,
  });
  assert.equal(take.reason, 'option_50pct_take_profit');
  assert.equal(take.line, 39.825);
  assert.equal(take.option_price, 39.85);
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

test('pending exit order does not count as closed just because sellable qty is locked', () => {
  assert.equal(exitOrderClosesPosition({
    expectedExitQty: 1,
    exitFilledQty: 0,
    position: { qty: 1, canSellQty: 0 },
  }), false);
});

test('exit is closed after the sell order fills or position quantity reaches zero', () => {
  assert.equal(exitOrderClosesPosition({
    expectedExitQty: 1,
    exitFilledQty: 1,
    position: { qty: 1, canSellQty: 0 },
  }), true);

  assert.equal(exitOrderClosesPosition({
    expectedExitQty: 1,
    exitFilledQty: 0,
    position: { qty: 0, canSellQty: 0 },
  }), true);
});
