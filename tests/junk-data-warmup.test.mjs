import assert from 'node:assert/strict';
import test from 'node:test';
import { assess_both_chain_directions, start_spy_quote_warmup } from '../apps/zero-dte-options/junk-data-warmup.mjs';

const at = '2026-09-25T14:00:00Z';
const options = { ticker: 'SPX', expiration: '2026-09-25', now_ms: Date.parse(at) };
function chain() {
  return { data: { ticker: 'SPX', expiration: options.expiration, snapshot_at: at,
    greeks_as_of: at, open_interest_as_of: '2026-09-25T12:00:00Z', total_contracts: 2,
    contracts: ['C', 'P'].map(right => ({ contract_symbol: `SPXW260925${right}07725000`,
      expiration: options.expiration, strike_usd: 7725, right, gamma: 0.01, open_interest: 100 })) },
    _meta: { truncated: false, data_freshness_seconds: 0 } };
}
test('chain prewarming proves both directions without a strategy candidate', () => {
  const result = assess_both_chain_directions(chain(), options);
  assert.equal(result.ready, true);
  assert.equal(result.by_right.call.ready, true);
  assert.equal(result.by_right.put.ready, true);
});
test('one valid side cannot declare both directions ready; cached data expires', () => {
  const response = chain(); response.data.contracts[1].gamma = 0;
  const result = assess_both_chain_directions(response, options);
  assert.equal(result.by_right.call.ready, true);
  assert.equal(result.by_right.put.ready, false);
  assert.equal(result.ready, false);
  const expired = assess_both_chain_directions(chain(), { ...options, now_ms: options.now_ms + 600_001 });
  assert.equal(expired.ready, false);
  assert.ok(expired.reason_codes.includes('chain_snapshot_stale'));
});
test('underlying subscription starts without GEX and concurrent calls share one request', async () => {
  let resolve, calls = 0; const samples = [];
  const runtime = { quote_feed: { cachedSnapshots: () => [], getSnapshots: () => {
    calls++; return new Promise(done => { resolve = done; });
  } } };
  const one = start_spy_quote_warmup(runtime, value => samples.push(value), 1);
  const two = start_spy_quote_warmup(runtime, value => samples.push(value), 2);
  assert.equal(one, two);
  await Promise.resolve(); assert.equal(calls, 1);
  const sample = { basic: { security: { market: 11, code: 'SPY' }, curPrice: 770 }, quote_received_at: at };
  resolve({ snapshots: [sample] }); await one;
  assert.deepEqual(samples, [sample]);
  assert.equal(runtime.spy_warmup_promise, null);
});
test('quote warmup failures remain contained and do not hot retry', async () => {
  let calls = 0;
  const runtime = { quote_feed: { cachedSnapshots: () => [], getSnapshots: async () => {
    calls++; throw new Error('provider unavailable');
  } } };
  await start_spy_quote_warmup(runtime, () => assert.fail('no invented sample'), 1);
  assert.equal(runtime.spy_warmup_error, 'spy_quote_warmup_failed');
  assert.equal(start_spy_quote_warmup(runtime, () => {}, 2), null);
  assert.equal(calls, 1);
});
