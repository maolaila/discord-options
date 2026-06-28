import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MODIFY_ORDER_OP_CANCEL,
  ORDER_TYPE_MARKET,
  TRD_SIDE_BUY,
  buildCancelOrderRequest,
  buildMarketBuyOrderRequest,
  buildOptionExecutionQuote,
  loadMoomooConfig,
} from '../packages/moomoo-opend/moomoo-opend.mjs';

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
