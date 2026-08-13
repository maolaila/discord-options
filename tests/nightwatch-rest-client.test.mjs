import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NightwatchRestError,
  create_nightwatch_rest_client,
  create_snapshot_rate_limiter,
  parse_retry_after_ms,
} from '../packages/nightwatch-api/nightwatch-rest-client.mjs';

function json_response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const wanted = String(name).toLowerCase();
        const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
        return entry ? entry[1] : null;
      },
    },
    json: async () => payload,
  };
}

test('discover uses bearer authentication without placing a key in the URL', async () => {
  const requests = [];
  const client = create_nightwatch_rest_client({
    api_key: 'test_token',
    fetch_impl: async (url, options) => {
      requests.push({ url: String(url), options });
      return json_response(200, { quota: { monthly_remaining: 99 } });
    },
  });

  const result = await client.discover_datasets();

  assert.equal(result.quota.monthly_remaining, 99);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.yehangshe.com/v1/discover');
  assert.equal(requests[0].url.includes('test_token'), false);
  assert.equal(requests[0].options.headers.authorization, 'Bearer test_token');
  assert.equal(requests[0].options.redirect, 'error');
});

test('all snapshot requests share a limiter enforcing at least one second', async () => {
  let clock_ms = 0;
  const starts = [];
  const sleeps = [];
  const sleep = async (delay_ms) => {
    sleeps.push(delay_ms);
    clock_ms += delay_ms;
  };
  const limiter = create_snapshot_rate_limiter({
    min_interval_ms: 1_000,
    now_ms: () => clock_ms,
    sleep,
  });
  const client = create_nightwatch_rest_client({
    api_key: 'test_token',
    now_ms: () => clock_ms,
    sleep,
    snapshot_rate_limiter: limiter,
    fetch_impl: async () => {
      starts.push(clock_ms);
      return json_response(200, { state: 'fresh' });
    },
  });

  await Promise.all([
    client.get_dealer_gex_snapshot('spx'),
    client.get_heatmap_snapshot('spx'),
  ]);

  assert.deepEqual(starts, [0, 1_000]);
  assert.deepEqual(sleeps, [1_000]);
});

test('paid options, heatmap, and stock methods use the official GET paths and snake_case query fields', async () => {
  const requests = [];
  const client = create_nightwatch_rest_client({
    api_key: 'test_token',
    snapshot_rate_limiter: create_snapshot_rate_limiter({
      now_ms: () => 0,
      sleep: async () => {},
    }),
    fetch_impl: async (url, options) => {
      requests.push({ url: String(url), options });
      return json_response(200, { data: {}, _meta: {} });
    },
  });

  await client.get_options_chain_snapshot('spx', { query: { expiration: '2026-08-11' } });
  await client.get_options_atm_chains('spy', { query: { expiration: '2026-08-11' } });
  await client.get_options_oi_change('spx', { query: { expiration: '2026-08-11' } });
  await client.get_options_options_volume('spy', { query: { min_volume: 1000 } });
  await client.get_options_contract_intraday('spy260811c00775000');
  await client.get_options_contract_greeks_series('spy260811c00775000', {
    query: {
      from: '2026-08-11T09:30:00-04:00',
      to: '2026-08-11T10:00:00-04:00',
      interval: '1m',
    },
  });
  await client.get_options_contract_volume_profile('spy260811c00775000');
  await client.get_heatmap_cell_history('spx', {
    query: { expiration: '2026-08-11', strike: 7750, limit: 390 },
  });
  await client.get_stock_state('spx');
  await client.get_index_ohlc('spx');

  assert.deepEqual(requests.map((request) => request.url), [
    'https://api.yehangshe.com/v1/options/chain-snapshot/SPX?expiration=2026-08-11',
    'https://api.yehangshe.com/v1/options/atm-chains/SPY?expiration=2026-08-11',
    'https://api.yehangshe.com/v1/options/oi-change/SPX?expiration=2026-08-11',
    'https://api.yehangshe.com/v1/options/options-volume/SPY?min_volume=1000',
    'https://api.yehangshe.com/v1/options/contract-intraday/SPY260811C00775000',
    'https://api.yehangshe.com/v1/options/contract-greeks-series/SPY260811C00775000?from=2026-08-11T09%3A30%3A00-04%3A00&to=2026-08-11T10%3A00%3A00-04%3A00&interval=1m',
    'https://api.yehangshe.com/v1/options/contract-volume-profile/SPY260811C00775000',
    'https://api.yehangshe.com/v1/derived/heatmap/SPX/cell-history?expiration=2026-08-11&strike=7750&limit=390',
    'https://api.yehangshe.com/v1/stocks/stock-state/SPX',
    'https://api.yehangshe.com/v1/stocks/index-ohlc/SPX',
  ]);
  assert.ok(requests.every((request) => request.options.method === 'GET'));
  assert.ok(requests.every((request) => request.options.headers.authorization === 'Bearer test_token'));
});

test('daily options methods normalize and percent-encode ticker path segments', async () => {
  const requests = [];
  const client = create_nightwatch_rest_client({
    api_key: 'test_token',
    fetch_impl: async (url) => {
      requests.push(String(url));
      return json_response(200, { data: [] });
    },
  });

  await client.get_options_oi_change(' ^spx ');
  await client.get_options_options_volume(' ^ndx ');

  assert.deepEqual(requests, [
    'https://api.yehangshe.com/v1/options/oi-change/%5ESPX',
    'https://api.yehangshe.com/v1/options/options-volume/%5ENDX',
  ]);
});

test('daily options methods reject invalid ticker path input before sending credentials', () => {
  let calls = 0;
  const client = create_nightwatch_rest_client({
    api_key: 'secret_test_token',
    fetch_impl: async () => {
      calls += 1;
      return json_response(200, {});
    },
  });

  assert.throws(
    () => client.get_options_oi_change('../SPX'),
    /ticker is invalid/,
  );
  assert.throws(
    () => client.get_options_options_volume('SPX/../../secret'),
    /ticker is invalid/,
  );
  assert.equal(calls, 0);
});

test('daily options HTTP errors expose the exact sanitized request path', async () => {
  const client = create_nightwatch_rest_client({
    api_key: 'secret_test_token',
    fetch_impl: async () => json_response(503, { error: 'upstream failed' }),
  });

  await assert.rejects(
    () => client.get_options_oi_change('spx'),
    (error) => {
      assert.ok(error instanceof NightwatchRestError);
      assert.equal(error.status, 503);
      assert.equal(error.path, '/v1/options/oi-change/SPX');
      assert.equal(error.message, 'Nightwatch request returned HTTP 503');
      assert.equal(error.message.includes('secret_test_token'), false);
      return true;
    },
  );
});

test('chain-snapshot is treated as a snapshot and shares the one-second limiter', async () => {
  let clock_ms = 0;
  const starts = [];
  const limiter = create_snapshot_rate_limiter({
    now_ms: () => clock_ms,
    sleep: async (delay_ms) => { clock_ms += delay_ms; },
  });
  const client = create_nightwatch_rest_client({
    api_key: 'test_token',
    now_ms: () => clock_ms,
    sleep: async (delay_ms) => { clock_ms += delay_ms; },
    snapshot_rate_limiter: limiter,
    fetch_impl: async () => {
      starts.push(clock_ms);
      return json_response(200, { data: {} });
    },
  });

  await Promise.all([
    client.get_options_chain_snapshot('SPX', { query: { expiration: '2026-08-11' } }),
    client.get_heatmap_snapshot('SPX'),
  ]);

  assert.deepEqual(starts, [0, 1_000]);
});

test('contract path values are normalized and reject path-like input', () => {
  const client = create_nightwatch_rest_client({
    api_key: 'test_token',
    fetch_impl: async () => json_response(200, {}),
  });

  assert.throws(
    () => client.get_options_contract_intraday('../secret'),
    /contract is invalid/,
  );
});

test('snapshot limiter rejects intervals below one second', () => {
  assert.throws(
    () => create_snapshot_rate_limiter({ min_interval_ms: 999 }),
    /at least 1000/,
  );
});

test('429 retries wait for Retry-After before trying again', async () => {
  let clock_ms = 0;
  const sleeps = [];
  let calls = 0;
  const client = create_nightwatch_rest_client({
    api_key: 'test_token',
    now_ms: () => clock_ms,
    sleep: async (delay_ms) => {
      sleeps.push(delay_ms);
      clock_ms += delay_ms;
    },
    fetch_impl: async () => {
      calls += 1;
      if (calls === 1) return json_response(429, {}, { 'Retry-After': '2' });
      return json_response(200, { ok: true });
    },
  });

  const result = await client.discover_datasets();

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2_000]);
});

test('429 failure exposes retry metadata but never the bearer token', async () => {
  const client = create_nightwatch_rest_client({
    api_key: 'secret_test_token',
    max_429_retries: 0,
    fetch_impl: async () => json_response(429, {}, { 'retry-after': '3' }),
  });

  await assert.rejects(
    () => client.discover_datasets(),
    (error) => {
      assert.ok(error instanceof NightwatchRestError);
      assert.equal(error.status, 429);
      assert.equal(error.retry_after_ms, 3_000);
      assert.equal(error.message.includes('secret_test_token'), false);
      return true;
    },
  );
});

test('network failures are sanitized before reaching logs or callers', async () => {
  const client = create_nightwatch_rest_client({
    api_key: 'secret_test_token',
    fetch_impl: async () => {
      throw new Error('proxy echoed Authorization: Bearer secret_test_token');
    },
  });

  await assert.rejects(
    () => client.discover_datasets(),
    (error) => {
      assert.ok(error instanceof NightwatchRestError);
      assert.equal(error.message, 'Nightwatch request failed: network error');
      assert.equal(error.message.includes('secret_test_token'), false);
      return true;
    },
  );
});

test('bearer credentials can only be sent to the allowlisted HTTPS API origin', () => {
  assert.throws(
    () => create_nightwatch_rest_client({
      base_url: 'https://attacker.invalid',
      api_key: 'test_token',
    }),
    /credential-safe allowlist/,
  );
  assert.throws(
    () => create_nightwatch_rest_client({
      base_url: 'http://api.yehangshe.com',
      api_key: 'test_token',
    }),
    /must use https/,
  );
});

test('Retry-After parser accepts delta seconds and HTTP dates', () => {
  const now_ms = Date.parse('2026-08-10T12:00:00.000Z');
  assert.equal(parse_retry_after_ms('1.25', now_ms), 1_250);
  assert.equal(parse_retry_after_ms('Sun, 10 Aug 2026 12:00:03 GMT', now_ms), 3_000);
  assert.equal(parse_retry_after_ms('invalid', now_ms), null);
});
