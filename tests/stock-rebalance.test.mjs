import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRebalancePlan,
  parseTargetsCsv,
  shouldProceedToBuyPhase,
  shouldUseExtendedHoursLimitOrders,
  splitRebalanceOrders,
  stockLimitPriceForOrder,
  summarizeSellPhase,
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

test('stock rebalance can reserve cash by targeting less than full invested value', () => {
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
    targetInvestedPct: 85,
    generatedAt: '2026-06-28T00:00:00.000Z',
  });

  assert.equal(plan.portfolio_value, 3000);
  assert.equal(plan.target_invested_pct, 85);
  assert.equal(plan.target_cash_pct, 15);
  assert.equal(plan.target_stock_budget, 2550);
  assert.equal(plan.target_cash_reserve, 450);
  assert.deepEqual(plan.orders.map((order) => `${order.side}:${order.symbol}:${order.qty}:${order.reason}`), [
    'SELL:TSLA:3:not_in_target_sheet',
    'SELL:AAPL:7:rebalance_overweight',
    'BUY:NVDA:10:rebalance_underweight',
    'BUY:GOOGL:6:rebalance_underweight',
    'BUY:AMZN:22:rebalance_underweight',
  ]);
  assert.deepEqual(plan.orders.map((order) => `${order.side}:${order.symbol}:${order.submit_jp_acc_type ?? 'none'}`), [
    'SELL:TSLA:none',
    'SELL:AAPL:none',
    'BUY:NVDA:1',
    'BUY:GOOGL:1',
    'BUY:AMZN:1',
  ]);
});

test('stock rebalance never sells protected symbols such as SPCX', () => {
  const targets = parseTargetsCsv(`symbol,target_pct
AAPL,20
MSFT,20
NVDA,20
GOOGL,20
AMZN,20
`);
  const positions = [
    { symbol: 'AAPL', qty: 6, can_sell_qty: 6, market_value: 600, price: 100, position_id: 'p1' },
    { symbol: 'SPCX', qty: 4, can_sell_qty: 4, market_value: 600, price: 150, position_id: 'spcx1' },
  ];
  const quotes = new Map([
    ['AAPL', { price: 100 }],
    ['MSFT', { price: 200 }],
    ['NVDA', { price: 50 }],
    ['GOOGL', { price: 100 }],
    ['AMZN', { price: 25 }],
    ['SPCX', { price: 150 }],
  ]);

  const plan = buildRebalancePlan({
    targets,
    positions,
    funds: { cash: 0 },
    quotes,
    protectedSymbols: ['SPCX'],
    generatedAt: '2026-06-28T00:00:00.000Z',
  });

  assert.equal(plan.orders.some((order) => order.symbol === 'SPCX'), false);
  assert.deepEqual(plan.protected_positions.map((row) => `${row.symbol}:${row.qty}:${row.reason}`), [
    'SPCX:4:protected_stock_symbol',
  ]);
  assert.equal(plan.off_sheet_positions.some((row) => row.symbol === 'SPCX'), false);
});

test('stock rebalance aggregates split positions and sells from each sellable lot', () => {
  const targets = parseTargetsCsv(`symbol,target_pct
AAPL,20
MSFT,20
NVDA,20
GOOGL,20
AMZN,20
`);
  const positions = [
    { symbol: 'AAPL', qty: 10, can_sell_qty: 10, market_value: 1000, price: 100, position_id: 'tokutei-aapl', jp_acc_type: 2 },
    { symbol: 'AAPL', qty: 5, can_sell_qty: 5, market_value: 500, price: 100, position_id: 'general-aapl', jp_acc_type: 1 },
  ];
  const quotes = Object.fromEntries(['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN'].map((symbol) => [symbol, { price: 100, bid: 100, ask: 101, price_spread: 0.01 }]));

  const plan = buildRebalancePlan({
    targets,
    positions,
    funds: { cash: 0 },
    quotes,
    targetInvestedPct: 100,
  });

  const aaplRow = plan.targets.find((row) => row.symbol === 'AAPL');
  assert.equal(aaplRow.current_qty, 15);
  assert.equal(aaplRow.desired_qty, 3);
  assert.deepEqual(aaplRow.position_ids, ['tokutei-aapl', 'general-aapl']);

  const aaplSells = plan.orders.filter((order) => order.side === 'SELL' && order.symbol === 'AAPL');
  assert.deepEqual(aaplSells.map((order) => `${order.qty}:${order.position_id}:${order.jp_acc_type}`), [
    '10:tokutei-aapl:2',
    '2:general-aapl:1',
  ]);
});

test('stock rebalance execution separates sell phase before buy phase', () => {
  const orders = [
    { side: 'SELL', symbol: 'TSLA', qty: 2 },
    { side: 'BUY', symbol: 'AAPL', qty: 1 },
    { side: 'SELL', symbol: 'MSFT', qty: 3 },
    { side: 'BUY', symbol: 'NVDA', qty: 4 },
  ];

  const { sellOrders, buyOrders } = splitRebalanceOrders(orders);

  assert.deepEqual(sellOrders.map((order) => `${order.side}:${order.symbol}:${order.qty}`), [
    'SELL:TSLA:2',
    'SELL:MSFT:3',
  ]);
  assert.deepEqual(buyOrders.map((order) => `${order.side}:${order.symbol}:${order.qty}`), [
    'BUY:AAPL:1',
    'BUY:NVDA:4',
  ]);
});

test('extended-hours stock rebalance uses protected limit prices', () => {
  assert.equal(shouldUseExtendedHoursLimitOrders({ stockOrderSession: 2, stockFillOutsideRTH: true }), true);
  assert.equal(shouldUseExtendedHoursLimitOrders({ stockOrderSession: 1, stockFillOutsideRTH: false }), false);

  assert.equal(stockLimitPriceForOrder({
    side: 'BUY',
    symbol: 'AAPL',
    ask: 100,
    reference_price: 99.5,
    price_spread: 0.01,
  }, 0.25), 100.25);

  assert.equal(stockLimitPriceForOrder({
    side: 'SELL',
    symbol: 'MSFT',
    bid: 200,
    reference_price: 201,
    price_spread: 0.01,
  }, 0.25), 199.5);
});

test('stock rebalance only proceeds to buy phase after all submitted sells fully fill', () => {
  const submittedSells = [
    { status: 'submitted', order_id_ex: 'S1', symbol: 'AAPL', qty: 2 },
    { status: 'submitted', order_id_ex: 'S2', symbol: 'MSFT', qty: 3 },
  ];

  const complete = summarizeSellPhase(submittedSells, [
    { orderIDEx: 'S1', orderStatus: 11, fillQty: 2 },
    { orderIDEx: 'S2', orderStatus: 11, fillQty: 3 },
  ]);
  assert.equal(complete.all_complete, true);
  assert.equal(shouldProceedToBuyPhase(complete), true);

  const partialCancelled = summarizeSellPhase(submittedSells, [
    { orderIDEx: 'S1', orderStatus: 11, fillQty: 2 },
    { orderIDEx: 'S2', orderStatus: 14, fillQty: 1 },
  ]);
  assert.equal(partialCancelled.all_complete, false);
  assert.equal(partialCancelled.failed_count, 1);
  assert.equal(shouldProceedToBuyPhase(partialCancelled), false);
});
