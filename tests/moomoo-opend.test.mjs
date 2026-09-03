import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_POLICY_PATH,
  MODIFY_ORDER_OP_CANCEL,
  buildCancelOrderRequest,
  buildOptionExecutionQuote,
  establishMoomooConnection,
  loadMoomooConfig,
  loadSharedMoomooRuntimeConfig,
  selectSimulatedUsOptionAccount,
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

test('OpenD login timeout closes the partially-started websocket client', async () => {
  let stop_count = 0;
  let socket_close_count = 0;
  const client = {
    start() {},
    stop() { stop_count += 1; },
    websock: { close() { socket_close_count += 1; } },
  };

  await assert.rejects(
    establishMoomooConnection(client, {
      host: '127.0.0.1',
      websocketPort: 33333,
      websocketSsl: false,
      websocketKey: '[test-redacted]',
    }, { timeoutMs: 5 }),
    /Timed out connecting to Moomoo OpenD WebSocket after 5ms/,
  );
  assert.equal(stop_count, 1);
  assert.equal(socket_close_count, 1);
});

test('OpenD rejected login closes the websocket client immediately', async () => {
  let stop_count = 0;
  const client = {
    start() { queueMicrotask(() => this.onlogin(false, { reason: 'rejected' })); },
    stop() { stop_count += 1; },
  };

  await assert.rejects(
    establishMoomooConnection(client, {
      host: '127.0.0.1',
      websocketPort: 33333,
      websocketSsl: false,
      websocketKey: '[test-redacted]',
    }),
    /Moomoo OpenD WebSocket login failed/,
  );
  assert.equal(stop_count, 1);
});

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

test('percentage spread and round-trip gates can be disabled while a real tick remains required', () => {
  const allowed = buildOptionExecutionQuote(snapshot, {
    ...quoteGateConfig,
    optionRequireTickSize: true,
    optionMaxSpreadPctOfMid: null,
    optionMaxRoundTripLossPct: null,
  });
  assert.equal(allowed.tradeable, true);
  assert.deepEqual(allowed.reasons, []);

  const missingTick = buildOptionExecutionQuote({
    ...snapshot,
    basic: { ...snapshot.basic, priceSpread: null },
  }, {
    ...quoteGateConfig,
    optionRequireTickSize: true,
    optionMaxSpreadPctOfMid: null,
    optionMaxRoundTripLossPct: null,
  });
  assert.equal(missingTick.tradeable, false);
  assert.ok(missingTick.reasons.includes('missing_or_invalid_price_tick'));
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

test('JUNKMAN business lines are the only registered trading lines', () => {
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

test('the shared OpenD key file wins over a stale direct process key', async () => {
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'shared-opend-config-'));
  const keyFile = path.join(temporaryRoot, 'opend-key.txt');
  const envFile = path.join(temporaryRoot, '.env');
  await fsp.writeFile(keyFile, 'current-file-key\n', 'utf8');
  await fsp.writeFile(envFile, 'MOOMOO_OPEND_WS_KEY_FILE=./opend-key.txt\n', 'utf8');

  const previousDirect = process.env.MOOMOO_OPEND_WS_KEY;
  const previousFile = process.env.MOOMOO_OPEND_WS_KEY_FILE;
  process.env.MOOMOO_OPEND_WS_KEY = 'stale-process-key';
  delete process.env.MOOMOO_OPEND_WS_KEY_FILE;
  try {
    const shared = loadSharedMoomooRuntimeConfig({ envFile });
    assert.equal(shared.websocketKey, 'current-file-key');
    assert.equal(shared.websocketKeySource, 'shared_key_file');
  } finally {
    if (previousDirect === undefined) delete process.env.MOOMOO_OPEND_WS_KEY;
    else process.env.MOOMOO_OPEND_WS_KEY = previousDirect;
    if (previousFile === undefined) delete process.env.MOOMOO_OPEND_WS_KEY_FILE;
    else process.env.MOOMOO_OPEND_WS_KEY_FILE = previousFile;
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
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

test('option simulation account selection only accepts simAccType 4', () => {
  const stock = { accID: 'stock', trdEnv: 0, trdMarketAuthList: [2], simAccType: 2 };
  const options = { accID: 'options', trdEnv: 0, trdMarketAuthList: [2], simAccType: 4 };
  assert.equal(selectSimulatedUsOptionAccount({ s2c: { accList: [stock, options] } }), options);
  assert.equal(selectSimulatedUsOptionAccount({ s2c: { accList: [stock] } }), null);
});
