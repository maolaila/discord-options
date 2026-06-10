import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOptionExecutionQuote,
  loadMoomooConfig,
} from '../moomoo-opend.mjs';

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
