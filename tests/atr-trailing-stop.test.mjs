import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateAtrWilder,
  confirmedDailyBars,
  marketableStopLimitPrice,
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
  }, bars, { period: 21, multiplier: 3.5 });

  assert.equal(raised.current_atr, 2);
  assert.equal(raised.highest_close_since_entry, 121);
  assert.equal(raised.current_stop_price, 114);
  assert.equal(raised.confirmed_bar_date, '2026-05-22');
  assert.equal(raised.confirmed_close_price, 121);
  assert.equal(raised.stop_basis, 'highest_confirmed_close_minus_atr_multiple');
  assert.equal(raised.atr_period, 21);
  assert.equal(raised.atr_multiplier, 3.5);

  const notLowered = updateDailyAtrStop({
    ...raised,
    current_stop_price: 116,
  }, bars, { period: 21, multiplier: 3.5 });

  assert.equal(notLowered.current_stop_price, 116);
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
