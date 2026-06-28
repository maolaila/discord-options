import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRebalancePlan,
  parseTargetsCsv,
} from '../apps/stock-rebalance/stock-rebalance-live.mjs';

test('stock target CSV requires exactly five symbols and defaults to equal weights', () => {
  const targets = parseTargetsCsv(`symbol,target_pct
AAPL,
MSFT,
NVDA,
GOOGL,
AMZN,
`);

  assert.deepEqual(targets.map((row) => row.symbol), ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN']);
  assert.deepEqual(targets.map((row) => row.target_pct), [20, 20, 20, 20, 20]);
});

test('stock rebalance plan sells off-sheet holdings and adjusts target holdings in whole shares', () => {
  const targets = parseTargetsCsv(`symbol,target_pct
AAPL,20
MSFT,20
NVDA,20
GOOGL,20
AMZN,20
`);
  const positions = [
    { symbol: 'AAPL', qty: 12, can_sell_qty: 12, market_value: 1200, price: 100, position_id: 'p1' },
    { symbol: 'MSFT', qty: 2, can_sell_qty: 2, market_value: 400, price: 200, position_id: 'p2' },
    { symbol: 'TSLA', qty: 3, can_sell_qty: 3, market_value: 900, price: 300, position_id: 'p3' },
  ];
  const quotes = new Map([
    ['AAPL', { price: 100 }],
    ['MSFT', { price: 200 }],
    ['NVDA', { price: 50 }],
    ['GOOGL', { price: 100 }],
    ['AMZN', { price: 25 }],
    ['TSLA', { price: 300 }],
  ]);

  const plan = buildRebalancePlan({
    targets,
    positions,
    funds: { cash: 500 },
    quotes,
    generatedAt: '2026-06-28T00:00:00.000Z',
  });

  assert.equal(plan.portfolio_value, 3000);
  assert.deepEqual(plan.orders.map((order) => `${order.side}:${order.symbol}:${order.qty}:${order.reason}`), [
    'SELL:TSLA:3:not_in_target_sheet',
    'SELL:AAPL:6:rebalance_overweight',
    'BUY:MSFT:1:rebalance_underweight',
    'BUY:NVDA:12:rebalance_underweight',
    'BUY:GOOGL:6:rebalance_underweight',
    'BUY:AMZN:24:rebalance_underweight',
  ]);
});
