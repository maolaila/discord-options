import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exactFixedSampleBucket,
  inferOptionStrikeStep,
  validateNightwatchTickerEvidence,
} from '../apps/junk-multi-options/junk-multi-universe.mjs';
import {
  buildMultiSymbolMarketContext,
} from '../apps/junk-multi-options/junk-multi-market-context.mjs';
import { moomooUnderlyingCode } from '../apps/junk-multi-options/junk-multi-line.mjs';

test('strike step is inferred from the actual same-day option chain', () => {
  assert.equal(inferOptionStrikeStep([
    { strikePrice: 100 }, { strikePrice: 102.5 }, { strikePrice: 105 }, { strikePrice: 105 },
  ]), 2.5);
});

test('Nightwatch ticker evidence requires matching ticker, session, freshness, and bucket', () => {
  const now = Date.parse('2026-08-25T14:42:00.000Z');
  const evidence = validateNightwatchTickerEvidence({
    ticker: 'QQQ',
    session_date_et: '2026-08-25',
    expected_bucket_at: '2026-08-25T14:35:00.000Z',
    now_ms: now,
    gex_response: { data: { ticker: 'QQQ', session_date_et: '2026-08-25', state: 'fresh', snapshot_at: '2026-08-25T14:35:00.000Z' } },
    heatmap_response: { data: { ticker: 'QQQ', session_date_et: '2026-08-25', state: 'fresh', generated_at: '2026-08-25T14:35:00.000Z' } },
  });
  assert.equal(evidence.passed, true);
  assert.equal(exactFixedSampleBucket('2026-08-25T14:39:59.000Z', '2026-08-25T14:35:00.000Z'), true);
});

test('Heatmap degradation is advisory when the sourced entry model treats it as neutral', () => {
  const evidence = validateNightwatchTickerEvidence({
    ticker: 'QQQ',
    session_date_et: '2026-08-25',
    expected_bucket_at: '2026-08-25T14:35:00.000Z',
    now_ms: Date.parse('2026-08-25T14:42:00.000Z'),
    require_heatmap_snapshot: false,
    gex_response: { data: { ticker: 'QQQ', session_date_et: '2026-08-25', state: 'fresh', snapshot_at: '2026-08-25T14:35:00.000Z' } },
    heatmap_response: null,
  });
  assert.equal(evidence.passed, true);
  assert.deepEqual(evidence.reasons, []);
  assert.ok(evidence.advisory_reasons.includes('heatmap_state_not_fresh:missing'));
  assert.ok(evidence.advisory_reasons.includes('heatmap_timestamp_invalid'));
});

test('own-symbol five-minute history produces closed bars and VWAP', () => {
  const context = buildMultiSymbolMarketContext({
    s2c: { klList: [
      { time: '2026-08-25 09:30:00', openPrice: 100, highPrice: 102, lowPrice: 99, closePrice: 101, volume: 100, turnover: 10_100 },
      { time: '2026-08-25 09:35:00', openPrice: 101, highPrice: 103, lowPrice: 100, closePrice: 102, volume: 200, turnover: 20_400 },
      { time: '2026-08-25 09:40:00', openPrice: 102, highPrice: 104, lowPrice: 101, closePrice: 103, volume: 300, turnover: 30_900 },
    ] },
  }, {
    session_date_et: '2026-08-25',
    now_ms: Date.parse('2026-08-25T13:43:00.000Z'),
  });
  assert.equal(context.bars_5m.length, 2);
  assert.equal(context.last_price_usd, 102);
  assert.equal(context.vwap_usd, 101.666667);
});

test('moomoo uses its index code for SPX without changing ordinary tickers', () => {
  assert.equal(moomooUnderlyingCode('SPX'), '.SPX');
  assert.equal(moomooUnderlyingCode('spy'), 'SPY');
  assert.equal(moomooUnderlyingCode('AAPL'), 'AAPL');
});
