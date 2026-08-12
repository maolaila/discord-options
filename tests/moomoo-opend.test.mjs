import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_POLICY_PATH,
  MODIFY_ORDER_OP_CANCEL,
  buildCancelOrderRequest,
  buildOptionExecutionQuote,
  loadMoomooConfig,
} from '../packages/moomoo-opend/moomoo-opend.mjs';
import {
  businessLineLogPath,
  moomooConfigOptionsForBusinessLine,
  resolveBusinessLine,
} from '../packages/business-lines/business-lines.mjs';

const snapshot = {
  basic: {
    bidPrice: 25.6,
    askPrice: 26.8,
    curPrice: 26.2,
    priceSpread: 0.05,
    volume: 2525,
  },
  optionExData: { openInterest: 2037 },
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

test('fixed absolute spread gate can be enabled or disabled', () => {
  const blocked = buildOptionExecutionQuote(snapshot, {
    ...quoteGateConfig,
    optionMaxSpreadAbs: 1,
  });
  assert.equal(blocked.tradeable, false);
  assert.ok(blocked.reasons.includes('spread_abs_above_gate:1.2'));

  const allowed = buildOptionExecutionQuote(snapshot, {
    ...quoteGateConfig,
    optionMaxSpreadAbs: null,
  });
  assert.equal(allowed.tradeable, true);
  assert.deepEqual(allowed.reasons, []);
});

test('entry quote blocks immediate round-trip loss beyond the option stop', () => {
  const quote = buildOptionExecutionQuote({
    basic: {
      bidPrice: 2.7,
      askPrice: 3.5,
      curPrice: 3.3,
      priceSpread: 0.1,
      askVol: 2,
      bidVol: 3,
      volume: 1133,
    },
    optionExData: { openInterest: 786 },
  }, {
    ...quoteGateConfig,
    optionMaxSpreadPctOfMid: 35,
    optionMaxRoundTripLossPct: 50,
    optionExitStopLossPct: 25,
  });

  assert.equal(quote.tradeable, false);
  assert.ok(quote.reasons.includes('immediate_round_trip_loss_pct_above_stop_loss:27.78>25'));
});

test('JUNKMAN is the only business line and the default policy is simulation-only', () => {
  assert.equal(path.basename(DEFAULT_POLICY_PATH), 'zero-dte-options-policy.json');
  const aliases = [undefined, '0dte', 'zero-dte', 'junk-gex', 'junkman'];
  for (const alias of aliases) {
    assert.equal(resolveBusinessLine(alias).key, 'zero-dte-options');
  }
  assert.throws(() => resolveBusinessLine('unknown-line'), /Unknown business line/);

  const line = resolveBusinessLine();
  const config = loadMoomooConfig({
    ...moomooConfigOptionsForBusinessLine(line, { env: './__missing_test_env__' }),
  });
  assert.equal(line.enabled, true);
  assert.equal(config.businessLine, 'zero-dte-options');
  assert.equal(config.requiredAdviceFormat, 'gex');
  assert.equal(config.policyRealTradingAllowed, false);
  assert.equal(config.policyExecutionEnvironment, 'simulate_only');
  assert.equal(path.basename(config.policyPath), 'zero-dte-options-policy.json');
  assert.equal(path.basename(businessLineLogPath(line, 'trades.ndjson')), 'zero-dte-options-trades.ndjson');
});

test('cancel order request carries the broker order identity', () => {
  const request = buildCancelOrderRequest({
    trdEnv: 0,
    trdMarket: 2,
    accId: '123456',
  }, {
    orderIDEx: 'SIM-ABC123',
  });

  assert.equal(request.c2s.modifyOrderOp, MODIFY_ORDER_OP_CANCEL);
  assert.equal(request.c2s.orderID, 0);
  assert.equal(request.c2s.orderIDEx, 'SIM-ABC123');
  assert.equal(request.c2s.header.accID, '123456');
});
