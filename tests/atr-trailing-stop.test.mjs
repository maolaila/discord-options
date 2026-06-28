import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateAtrWilder,
  confirmedDailyBars,
  marketableStopLimitPrice,
  reconcileBrokerStopOrder,
  updateDailyAtrStop,
} from '../apps/atr-stop/atr-trailing-stop.mjs';

function steadyBars(count) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index;
    return {
      date: `2026-05-${String(index + 1).padStart(2, '0')}`,
      high: close + 1,
      low: close - 1,
      close,
    };
  });
}

test('Wilder ATR uses true range and smoothing', () => {
  assert.equal(calculateAtrWilder(steadyBars(22), 21), 2);
});

test('daily ATR stop updates highest close and never lowers the stop', () => {
  const bars = steadyBars(22);
  const raised = updateDailyAtrStop({
    symbol: 'AAPL',
    entry_price: 100,
    highest_close_since_entry: 120,
    current_stop_price: 100,
    status: 'HELD',
  }, bars, { period: 21 });

  assert.equal(raised.current_atr, 2);
  assert.equal(raised.highest_close_since_entry, 121);
  assert.equal(raised.current_stop_price, 116);
  assert.equal(raised.confirmed_bar_date, '2026-05-22');
  assert.equal(raised.confirmed_close_price, 121);
  assert.equal(raised.atr_stop_price, 116);
  assert.equal(raised.initial_loss_floor, 88);
  assert.equal(raised.breakeven_floor, 100.5);
  assert.equal(raised.profit_trailing_floor, 102.85);
  assert.equal(raised.stop_source, 'atr_stop');
  assert.equal(raised.stop_basis, 'max_previous_atr_initial_breakeven_profit_floors');
  assert.equal(raised.atr_period, 21);
  assert.equal(raised.atr_multiplier, 2.5);

  const notLowered = updateDailyAtrStop({
    ...raised,
    current_stop_price: 117,
  }, bars, { period: 21 });

  assert.equal(notLowered.current_stop_price, 117);
  assert.equal(notLowered.stop_moved_up, false);
});

test('daily ATR stop can initialize highest close from entry date bars', () => {
  const bars = steadyBars(25);
  const initialized = updateDailyAtrStop({
    symbol: 'AAPL',
    entry_date: '2026-05-10',
    entry_price: 100,
    status: 'HELD',
  }, bars, { period: 21, multiplier: 3.5 });

  assert.equal(initialized.highest_close_since_entry, 124);
  assert.equal(initialized.current_stop_price, 117);
});

test('ATR stop defaults to 2.5 times ATR', () => {
  const bars = steadyBars(22);
  const stop = updateDailyAtrStop({
    symbol: 'AAPL',
    entry_price: 100,
    highest_close_since_entry: 120,
    status: 'HELD',
  }, bars, { period: 21 });

  assert.equal(stop.atr_points, 2);
  assert.equal(stop.atr_stop_price, 116);
  assert.equal(stop.current_stop_price, 116);
});

test('initial stop is not below entry price minus 12 percent', () => {
  const stop = updateDailyAtrStop({
    symbol: 'AAPL',
    entry_price: 100,
    status: 'HELD',
  }, [
    { date: '2026-05-01', high: 100, low: 100, close: 100 },
    { date: '2026-05-02', high: 130, low: 80, close: 100 },
  ], { period: 1 });

  assert.equal(stop.atr_stop_price, -25);
  assert.equal(stop.initial_loss_floor, 88);
  assert.equal(stop.current_stop_price, 88);
  assert.equal(stop.stop_source, 'initial_loss_floor');
});

test('breakeven floor lifts stop after 8 percent profit', () => {
  const stop = updateDailyAtrStop({
    symbol: 'AAPL',
    entry_price: 100,
    status: 'HELD',
  }, [
    { date: '2026-05-01', high: 100, low: 100, close: 100 },
    { date: '2026-05-02', high: 130, low: 80, close: 109 },
  ], { period: 1 });

  assert.equal(stop.breakeven_floor, 100.5);
  assert.equal(stop.current_stop_price, 100.5);
  assert.equal(stop.stop_source, 'breakeven_floor');
});

test('profit protection floor limits drawdown after 15 percent profit', () => {
  const stop = updateDailyAtrStop({
    symbol: 'AAPL',
    entry_price: 100,
    status: 'HELD',
  }, [
    { date: '2026-05-01', high: 100, low: 100, close: 100 },
    { date: '2026-05-02', high: 150, low: 80, close: 120 },
  ], { period: 1 });

  assert.equal(stop.profit_trailing_floor, 102);
  assert.equal(stop.current_stop_price, 102);
  assert.equal(stop.stop_source, 'profit_trailing_floor');
});

test('ATR expansion cannot lower the final stop', () => {
  const stop = updateDailyAtrStop({
    symbol: 'AAPL',
    entry_price: 100,
    current_stop_price: 110,
    highest_close_since_entry: 120,
    status: 'HELD',
  }, [
    { date: '2026-05-01', high: 100, low: 100, close: 100 },
    { date: '2026-05-02', high: 160, low: 70, close: 120 },
  ], { period: 1 });

  assert.equal(stop.atr_stop_price, -105);
  assert.equal(stop.profit_trailing_floor, 102);
  assert.equal(stop.current_stop_price, 110);
  assert.equal(stop.stop_source, 'previous_stop');
  assert.equal(stop.stop_moved_up, false);
});

test('ATR daily update ignores same-day bar before confirmed New York close', () => {
  const bars = [
    { date: '2026-06-26', high: 101, low: 99, close: 100 },
    { date: '2026-06-29', high: 111, low: 95, close: 110 },
  ];

  assert.deepEqual(
    confirmedDailyBars(bars, new Date('2026-06-29T19:59:00Z')).map((bar) => bar.date),
    ['2026-06-26'],
  );
  assert.deepEqual(
    confirmedDailyBars(bars, new Date('2026-06-29T20:05:00Z')).map((bar) => bar.date),
    ['2026-06-26', '2026-06-29'],
  );
});

test('marketable ATR stop sell limit is below realtime price and rounded to tick', () => {
  assert.equal(marketableStopLimitPrice(100, { bufferPct: 0.35, tick: 0.05 }), 99.65);
  assert.equal(marketableStopLimitPrice(10.03, { bufferPct: 0.5, tick: 0.01 }), 9.97);
});

test('broker GTC stop order is cancel/replaced when final stop moves up', async () => {
  const calls = [];
  const result = await reconcileBrokerStopOrder(null, {}, {
    symbol: 'AAPL',
    status: 'HELD',
    shares: 10,
    can_sell_qty: 10,
    position_id: 123,
    current_stop_price: 105,
    stop_order_id_ex: 'OLD',
    stop_order_stop_price: 100,
  }, {
    execute: true,
    nowIso: '2026-06-29T14:00:00.000Z',
    deps: {
      cancelOrder: async (_client, _config, order) => {
        calls.push(['cancel', order.orderIDEx]);
        return { s2c: { orderIDEx: order.orderIDEx } };
      },
      placeStopMarketSellOrder: async (_client, _config, order) => {
        calls.push(['place', order.code, order.qty, order.stopPrice]);
        return { s2c: { orderIDEx: 'NEW' } };
      },
      appendOrder: async () => {},
    },
  });

  assert.deepEqual(calls, [
    ['cancel', 'OLD'],
    ['place', 'AAPL', 10, 105],
  ]);
  assert.equal(result.replaced, 1);
  assert.equal(result.position.stop_order_id_ex, 'NEW');
  assert.equal(result.position.stop_order_stop_price, 105);
  assert.equal(result.position.stop_order_type, 'STOP_MARKET');
});

test('broker GTC stop order is not updated when final stop does not move up', async () => {
  const calls = [];
  const result = await reconcileBrokerStopOrder(null, {}, {
    symbol: 'AAPL',
    status: 'HELD',
    shares: 10,
    can_sell_qty: 10,
    current_stop_price: 100,
    stop_order_id_ex: 'OLD',
    stop_order_stop_price: 100,
  }, {
    execute: true,
    deps: {
      cancelOrder: async () => { calls.push('cancel'); },
      placeStopMarketSellOrder: async () => { calls.push('place'); },
      appendOrder: async () => {},
    },
  });

  assert.deepEqual(calls, []);
  assert.equal(result.unchanged, 1);
  assert.equal(result.position.stop_order_id_ex, 'OLD');
});

test('close below final stop cancels old stop and queues next-open sell', async () => {
  const calls = [];
  const result = await reconcileBrokerStopOrder(null, {}, {
    symbol: 'AAPL',
    status: 'HELD',
    shares: 10,
    can_sell_qty: 10,
    current_stop_price: 100,
    confirmed_close_price: 99,
    stop_order_id_ex: 'OLD',
    stop_order_stop_price: 95,
  }, {
    execute: true,
    nowIso: '2026-06-29T21:00:00.000Z',
    deps: {
      cancelOrder: async (_client, _config, order) => {
        calls.push(['cancel', order.orderIDEx]);
        return { s2c: { orderIDEx: order.orderIDEx } };
      },
      placeStopMarketSellOrder: async () => { calls.push(['place']); },
      appendOrder: async () => {},
    },
  });

  assert.deepEqual(calls, [['cancel', 'OLD']]);
  assert.equal(result.queued_next_open, 1);
  assert.equal(result.placed, 0);
  assert.equal(result.position.status, 'STOP_TRIGGERED_AFTER_CLOSE');
  assert.equal(result.position.next_open_sell_required, true);
  assert.equal(result.position.stop_order_id_ex, '');
});
