import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  MODIFY_ORDER_OP_CANCEL,
  JP_SUB_ACC_TYPE_GENERAL,
  ORDER_TYPE_LIMIT,
  ORDER_TYPE_MARKET,
  ORDER_TYPE_STOP,
  SESSION_ETH,
  SESSION_RTH,
  TIME_IN_FORCE_GTC,
  TRD_SIDE_BUY,
  TRD_SIDE_SELL,
  buildTradeHeader,
  buildLimitBuyOrderRequest,
  buildCancelOrderRequest,
  buildMarketBuyOrderRequest,
  buildMarketSellOrderRequest,
  buildOptionExecutionQuote,
  buildStopMarketSellOrderRequest,
  isProtectedStockSymbol,
  loadMoomooConfig,
  parseProtectedStockSymbols,
} from '../packages/moomoo-opend/moomoo-opend.mjs';
import {
  businessLineLogPath,
  moomooConfigOptionsForBusinessLine,
  resolveBusinessLine,
} from '../packages/business-lines/business-lines.mjs';

const smhLikeSnapshot = {
  basic: {
    bidPrice: 25.6,
    askPrice: 26.8,
    curPrice: 26.2,
    priceSpread: 0.05,
    volume: 2525,
  },
  optionExData: {
    openInterest: 2037,
  },
};

const quoteGateConfig = {
  optionRequireBidAsk: true,
  optionMinBidPrice: 0.01,
  optionMaxSpreadPctOfMid: 25,
  optionMaxRoundTripLossPct: 40,
  optionSlippageTicks: 1,
  optionSlippagePctOfSpread: 10,
  optionMinOpenInterest: 50,
  optionMinDayVolume: 1,
};

const incyWideSpreadSnapshot = {
  basic: {
    bidPrice: 2.7,
    askPrice: 3.5,
    curPrice: 3.3,
    priceSpread: 0.1,
    askVol: 2,
    bidVol: 3,
    volume: 1133,
  },
  optionExData: {
    openInterest: 786,
  },
};

test('fixed absolute spread gate blocks high-premium options when enabled', () => {
  const quote = buildOptionExecutionQuote(smhLikeSnapshot, {
    ...quoteGateConfig,
    optionMaxSpreadAbs: 1,
  });

  assert.equal(quote.tradeable, false);
  assert.equal(quote.spread_abs, 1.2);
  assert.ok(quote.reasons.includes('spread_abs_above_gate:1.2'));
});

test('fixed absolute spread gate can be disabled for copy-following simulation', () => {
  const quote = buildOptionExecutionQuote(smhLikeSnapshot, {
    ...quoteGateConfig,
    optionMaxSpreadAbs: null,
  });

  assert.equal(quote.tradeable, true);
  assert.equal(quote.spread_abs, 1.2);
  assert.equal(quote.spread_pct_of_mid, 4.58);
  assert.equal(quote.immediate_round_trip_loss_pct, 5.57);
  assert.deepEqual(quote.reasons, []);
});

test('policy null and zero option override disable the fixed absolute spread gate', () => {
  const original = process.env.MOOMOO_OPTION_MAX_SPREAD_ABS;
  delete process.env.MOOMOO_OPTION_MAX_SPREAD_ABS;

  try {
    assert.equal(loadMoomooConfig({ envFile: './__missing_test_env__' }).optionMaxSpreadAbs, null);
    assert.equal(loadMoomooConfig({ envFile: './__missing_test_env__', optionMaxSpreadAbs: 0 }).optionMaxSpreadAbs, null);
  } finally {
    if (original === undefined) {
      delete process.env.MOOMOO_OPTION_MAX_SPREAD_ABS;
    } else {
      process.env.MOOMOO_OPTION_MAX_SPREAD_ABS = original;
    }
  }
});

test('protected stock symbols default to SPCX and can be overridden', () => {
  const original = process.env.PROTECTED_STOCK_SYMBOLS;
  delete process.env.PROTECTED_STOCK_SYMBOLS;

  try {
    const config = loadMoomooConfig({ envFile: './__missing_test_env__' });
    assert.deepEqual(config.protectedStockSymbols, ['SPCX']);
    assert.equal(isProtectedStockSymbol('spcx', config.protectedStockSymbols), true);
    assert.deepEqual(parseProtectedStockSymbols('SPCX, WEN;intc'), ['SPCX', 'WEN', 'INTC']);
    assert.deepEqual(parseProtectedStockSymbols('disabled'), []);
  } finally {
    if (original === undefined) {
      delete process.env.PROTECTED_STOCK_SYMBOLS;
    } else {
      process.env.PROTECTED_STOCK_SYMBOLS = original;
    }
  }
});


test('entry quote is blocked when immediate sell estimate is already beyond option stop loss', () => {
  const quote = buildOptionExecutionQuote(incyWideSpreadSnapshot, {
    ...quoteGateConfig,
    optionMaxSpreadPctOfMid: 35,
    optionMaxRoundTripLossPct: 50,
    optionExitStopLossPct: 25,
  });

  assert.equal(quote.tradeable, false);
  assert.equal(quote.buy_limit_price, 3.6);
  assert.equal(quote.sell_estimate_price, 2.6);
  assert.equal(quote.immediate_round_trip_loss_pct, 27.78);
  assert.equal(quote.immediate_stop_loss_guard_pct, 25);
  assert.equal(quote.immediate_stop_loss_line, 2.7);
  assert.ok(quote.reasons.includes('immediate_round_trip_loss_pct_above_stop_loss:27.78>25'));
});

test('market stock order request uses market order type and whole-share quantity', () => {
  const request = buildMarketBuyOrderRequest({
    trdEnv: 1,
    trdMarket: 2,
    accId: '123456',
  }, {
    code: 'AAPL',
    qty: 7,
    remark: 'rebalance:test',
  });

  assert.equal(request.c2s.trdSide, TRD_SIDE_BUY);
  assert.equal(request.c2s.orderType, ORDER_TYPE_MARKET);
  assert.equal(request.c2s.code, 'AAPL');
  assert.equal(request.c2s.qty, 7);
  assert.equal(request.c2s.price, undefined);
  assert.equal(request.c2s.session, SESSION_RTH);
  assert.equal(request.c2s.fillOutsideRTH, undefined);
});

test('stock orders can force JP general account for buys and omit it for sells', () => {
  const config = {
    trdEnv: 1,
    trdMarket: 2,
    accId: '123456',
    jpAccType: 2,
  };

  assert.equal(buildTradeHeader(config).jpAccType, 2);
  assert.equal(buildTradeHeader(config, { jpAccType: JP_SUB_ACC_TYPE_GENERAL }).jpAccType, JP_SUB_ACC_TYPE_GENERAL);
  assert.equal(buildTradeHeader(config, { jpAccType: null }).jpAccType, undefined);

  const buy = buildMarketBuyOrderRequest(config, {
    code: 'AAPL',
    qty: 7,
    remark: 'rebalance:buy',
  }, {
    jpAccType: JP_SUB_ACC_TYPE_GENERAL,
  });
  const sell = buildMarketSellOrderRequest(config, {
    code: 'AAPL',
    qty: 3,
    remark: 'rebalance:sell',
    positionID: 'position-1',
  }, {
    jpAccType: null,
  });

  assert.equal(buy.c2s.header.jpAccType, JP_SUB_ACC_TYPE_GENERAL);
  assert.equal(sell.c2s.header.jpAccType, undefined);
  assert.equal(sell.c2s.positionID, 'position-1');
});

test('business line config selects explicit PA policy and log prefix', () => {
  const line = resolveBusinessLine('pa');
  const config = loadMoomooConfig({
    ...moomooConfigOptionsForBusinessLine(line, { env: './__missing_test_env__' }),
  });

  assert.equal(line.key, 'pa-options');
  assert.equal(config.businessLine, 'pa-options');
  assert.equal(config.requiredAdviceFormat, 'pa');
  assert.equal(config.policyRealTradingAllowed, false);
  assert.equal(config.policyExecutionEnvironment, 'simulate_only');
  assert.equal(path.basename(config.policyPath), 'pa-options-policy.json');
  assert.equal(path.basename(businessLineLogPath(line, 'executions.ndjson')), 'pa-options-executions.ndjson');
});

test('0DTE business line is isolated from PA policy', () => {
  const line = resolveBusinessLine('0dte');
  const config = loadMoomooConfig({
    ...moomooConfigOptionsForBusinessLine(line, { env: './__missing_test_env__' }),
  });

  assert.equal(line.key, 'zero-dte-options');
  assert.equal(line.enabled, false);
  assert.equal(config.businessLine, 'zero-dte-options');
  assert.equal(config.requiredAdviceFormat, 'flow');
  assert.equal(config.policyRealTradingAllowed, false);
  assert.equal(path.basename(config.policyPath), 'zero-dte-options-policy.json');
});

test('stock rebalance and ATR stop have dedicated business-line policies', () => {
  const stockLine = resolveBusinessLine('rebalance');
  const atrLine = resolveBusinessLine('atr');
  const stockConfig = loadMoomooConfig({
    ...moomooConfigOptionsForBusinessLine(stockLine, { env: './__missing_test_env__' }),
  });
  const atrConfig = loadMoomooConfig({
    ...moomooConfigOptionsForBusinessLine(atrLine, { env: './__missing_test_env__' }),
  });

  assert.equal(stockLine.key, 'stock-rebalance');
  assert.equal(stockConfig.businessLine, 'stock-rebalance');
  assert.equal(stockConfig.policyRealTradingAllowed, true);
  assert.equal(path.basename(stockConfig.policyPath), 'stock-rebalance-policy.json');
  assert.equal(atrLine.key, 'atr-stop');
  assert.equal(atrLine.kind, 'risk-control');
  assert.equal(atrConfig.businessLine, 'atr-stop');
  assert.equal(atrConfig.policyRealTradingAllowed, true);
  assert.equal(path.basename(atrConfig.policyPath), 'atr-stop-policy.json');
});

test('extended-hours limit stock order request sets session and outside-RTH permission', () => {
  const request = buildLimitBuyOrderRequest({
    trdEnv: 1,
    trdMarket: 2,
    accId: '123456',
  }, {
    code: 'AAPL',
    qty: 7,
    price: 195.25,
    remark: 'rebalance:premarket',
  }, {
    session: SESSION_ETH,
    fillOutsideRTH: true,
  });

  assert.equal(request.c2s.trdSide, TRD_SIDE_BUY);
  assert.equal(request.c2s.orderType, ORDER_TYPE_LIMIT);
  assert.equal(request.c2s.code, 'AAPL');
  assert.equal(request.c2s.qty, 7);
  assert.equal(request.c2s.price, 195.25);
  assert.equal(request.c2s.session, SESSION_ETH);
  assert.equal(request.c2s.fillOutsideRTH, true);
});

test('stock order session config parses extended-hours aliases', () => {
  const config = loadMoomooConfig({
    envFile: './__missing_test_env__',
    stockOrderSession: 'extended-hours',
    stockFillOutsideRTH: true,
    stockLimitBufferPct: 0.5,
    stockBuyJpAccType: JP_SUB_ACC_TYPE_GENERAL,
  });

  assert.equal(config.stockOrderSession, SESSION_ETH);
  assert.equal(config.stockFillOutsideRTH, true);
  assert.equal(config.stockLimitBufferPct, 0.5);
  assert.equal(config.stockBuyJpAccType, JP_SUB_ACC_TYPE_GENERAL);
});

test('GTC stop-market sell order request uses auxPrice and RTH session', () => {
  const request = buildStopMarketSellOrderRequest({
    trdEnv: 1,
    trdMarket: 2,
    accId: '123456',
  }, {
    code: 'AAPL',
    qty: 7,
    stopPrice: 123.45,
    remark: 'atr-stop:test',
    positionID: 987,
  });

  assert.equal(request.c2s.trdSide, TRD_SIDE_SELL);
  assert.equal(request.c2s.orderType, ORDER_TYPE_STOP);
  assert.equal(request.c2s.code, 'AAPL');
  assert.equal(request.c2s.qty, 7);
  assert.equal(request.c2s.auxPrice, 123.45);
  assert.equal(request.c2s.price, undefined);
  assert.equal(request.c2s.timeInForce, TIME_IN_FORCE_GTC);
  assert.equal(request.c2s.session, SESSION_RTH);
  assert.equal(request.c2s.positionID, 987);
});

test('cancel order request uses ModifyOrder cancel operation and orderIDEx', () => {
  const request = buildCancelOrderRequest({
    trdEnv: 1,
    trdMarket: 2,
    accId: '123456',
  }, {
    orderIDEx: 'ABC123',
  });

  assert.equal(request.c2s.modifyOrderOp, MODIFY_ORDER_OP_CANCEL);
  assert.equal(request.c2s.orderID, 0);
  assert.equal(request.c2s.orderIDEx, 'ABC123');
  assert.equal(request.c2s.header.accID, '123456');
});
