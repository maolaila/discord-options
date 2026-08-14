const DEFAULT_BASE_URL = 'https://api.yehangshe.com';
const DEFAULT_API_KEY_ENV = 'YEHANGSHE_API_KEY';
const MIN_SNAPSHOT_INTERVAL_MS = 1_000;

function default_sleep(delay_ms) {
  return new Promise((resolve) => setTimeout(resolve, delay_ms));
}

function header_value(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const wanted = String(name).toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return entry ? entry[1] : null;
}

export function parse_retry_after_ms(value, now_ms = Date.now()) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const retry_at_ms = Date.parse(text);
  if (!Number.isFinite(retry_at_ms)) return null;
  return Math.max(0, retry_at_ms - Number(now_ms));
}

export function create_snapshot_rate_limiter({
  min_interval_ms = MIN_SNAPSHOT_INTERVAL_MS,
  now_ms = () => Date.now(),
  sleep = default_sleep,
} = {}) {
  const interval_ms = Number(min_interval_ms);
  if (!Number.isFinite(interval_ms) || interval_ms < MIN_SNAPSHOT_INTERVAL_MS) {
    throw new Error(`snapshot min_interval_ms must be at least ${MIN_SNAPSHOT_INTERVAL_MS}`);
  }
  if (typeof now_ms !== 'function' || typeof sleep !== 'function') {
    throw new TypeError('snapshot rate limiter requires callable now_ms and sleep dependencies');
  }

  let last_started_at_ms = null;
  let queue = Promise.resolve();

  function schedule(start_request) {
    if (typeof start_request !== 'function') {
      return Promise.reject(new TypeError('snapshot limiter schedule requires a function'));
    }

    let resolve_request;
    let reject_request;
    const request_result = new Promise((resolve, reject) => {
      resolve_request = resolve;
      reject_request = reject;
    });
    const turn = queue.then(async () => {
      const current_ms = Number(now_ms());
      if (!Number.isFinite(current_ms)) throw new Error('now_ms returned a non-finite value');
      if (last_started_at_ms !== null) {
        const delay_ms = Math.max(0, (last_started_at_ms + interval_ms) - current_ms);
        if (delay_ms > 0) await sleep(delay_ms);
      }
      const started_at_ms = Number(now_ms());
      if (!Number.isFinite(started_at_ms)) throw new Error('now_ms returned a non-finite value');
      last_started_at_ms = last_started_at_ms === null
        ? started_at_ms
        : Math.max(started_at_ms, last_started_at_ms + interval_ms);
      try {
        Promise.resolve(start_request()).then(resolve_request, reject_request);
      } catch (error) {
        reject_request(error);
      }
    });
    queue = turn.catch((error) => {
      reject_request(error);
    });
    return request_result;
  }

  async function wait_for_turn() {
    return schedule(() => undefined);
  }

  return Object.freeze({
    min_interval_ms: interval_ms,
    schedule,
    wait_for_turn,
  });
}

const shared_snapshot_rate_limiter = create_snapshot_rate_limiter();

export class NightwatchRestError extends Error {
  constructor(message, {
    status = null,
    retry_after_ms = null,
    path = null,
    error_code = null,
    recoverable = null,
  } = {}) {
    super(message);
    this.name = 'NightwatchRestError';
    this.status = status;
    this.retry_after_ms = retry_after_ms;
    this.path = path;
    this.error_code = error_code;
    this.code = error_code;
    this.recoverable = recoverable;
  }
}

async function sanitized_error_metadata(response, pathname, now_ms) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Error bodies are diagnostic only. Never echo an untrusted body.
  }
  const error = payload?.error && typeof payload.error === 'object'
    ? payload.error
    : (payload && typeof payload === 'object' ? payload : {});
  const error_code = /^[A-Z0-9_]{1,64}$/.test(String(error.code || ''))
    ? String(error.code)
    : null;
  const recoverable = typeof error.recoverable === 'boolean' ? error.recoverable : null;
  const has_body_retry = error.retry_after_seconds !== null
    && error.retry_after_seconds !== undefined
    && String(error.retry_after_seconds).trim() !== '';
  const body_retry_seconds = has_body_retry ? Number(error.retry_after_seconds) : null;
  const body_retry_after_ms = Number.isFinite(body_retry_seconds) && body_retry_seconds >= 0
    ? Math.ceil(body_retry_seconds * 1_000)
    : null;
  const header_retry_after_ms = parse_retry_after_ms(
    header_value(response.headers, 'retry-after'),
    now_ms,
  );
  return {
    status: response.status,
    path: pathname,
    error_code,
    recoverable,
    retry_after_ms: body_retry_after_ms ?? header_retry_after_ms,
  };
}

function normalized_base_url(base_url, allowed_base_urls = [DEFAULT_BASE_URL]) {
  const parsed = new URL(String(base_url || DEFAULT_BASE_URL));
  if (parsed.protocol !== 'https:') {
    throw new Error('Nightwatch base_url must use https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Nightwatch base_url must not contain credentials, query parameters, or fragments');
  }
  const normalized = parsed.toString().replace(/\/$/, '');
  const allowed = new Set((Array.isArray(allowed_base_urls) ? allowed_base_urls : [])
    .map((value) => new URL(String(value)).toString().replace(/\/$/, '')));
  if (!allowed.has(normalized)) {
    throw new Error('Nightwatch base_url is not in the credential-safe allowlist');
  }
  return normalized;
}

function normalized_path(pathname) {
  const path = String(pathname || '').trim();
  if (!path.startsWith('/')) throw new Error('Nightwatch request path must start with /');
  return path;
}

function build_url(base_url, pathname, query) {
  const url = new URL(normalized_path(pathname), `${base_url}/`);
  for (const [key, raw_value] of Object.entries(query || {})) {
    if (raw_value === undefined || raw_value === null || raw_value === '') continue;
    if (Array.isArray(raw_value)) {
      for (const item of raw_value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(raw_value));
    }
  }
  return url;
}

function normalized_ticker(ticker) {
  const value = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z0-9._^-]{1,24}$/.test(value)) throw new Error('ticker is invalid');
  return value;
}

function normalized_derived_ticker(ticker) {
  const value = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(value)) throw new Error('derived ticker is invalid');
  return value;
}

function normalized_contract(contract) {
  const value = String(contract || '').trim().toUpperCase();
  if (!/^[A-Z0-9._-]{1,64}$/.test(value)) throw new Error('contract is invalid');
  return value;
}

function is_snapshot_path(pathname) {
  return /(?:^|\/)[^/]*snapshot(?:\/|$)/.test(pathname);
}

async function response_json(response, pathname) {
  try {
    return await response.json();
  } catch {
    throw new NightwatchRestError('Nightwatch returned invalid JSON', {
      status: response.status,
      path: pathname,
    });
  }
}

export function create_nightwatch_rest_client({
  base_url = DEFAULT_BASE_URL,
  api_key,
  api_key_env = DEFAULT_API_KEY_ENV,
  api_key_provider,
  fetch_impl = globalThis.fetch,
  sleep = default_sleep,
  now_ms = () => Date.now(),
  snapshot_rate_limiter = shared_snapshot_rate_limiter,
  max_429_retries = 3,
  allowed_base_urls = [DEFAULT_BASE_URL],
  request_timeout_ms = 10_000,
} = {}) {
  if (typeof fetch_impl !== 'function') {
    throw new Error('A fetch implementation is required for Nightwatch REST');
  }
  if (typeof sleep !== 'function' || typeof now_ms !== 'function') {
    throw new TypeError('sleep and now_ms must be functions');
  }
  if (!snapshot_rate_limiter || typeof snapshot_rate_limiter.wait_for_turn !== 'function') {
    throw new TypeError('snapshot_rate_limiter must expose wait_for_turn()');
  }
  if (Number(snapshot_rate_limiter.min_interval_ms) < MIN_SNAPSHOT_INTERVAL_MS) {
    throw new Error(`snapshot_rate_limiter must enforce at least ${MIN_SNAPSHOT_INTERVAL_MS}ms`);
  }
  const retry_limit = Number(max_429_retries);
  if (!Number.isInteger(retry_limit) || retry_limit < 0) {
    throw new Error('max_429_retries must be a non-negative integer');
  }
  const timeout_ms = Number(request_timeout_ms);
  if (!Number.isFinite(timeout_ms) || timeout_ms < 1_000 || timeout_ms > 120_000) {
    throw new Error('request_timeout_ms must be between 1000 and 120000');
  }

  const resolved_base_url = normalized_base_url(base_url, allowed_base_urls);
  const resolve_api_key = typeof api_key_provider === 'function'
    ? api_key_provider
    : () => api_key || process.env[api_key_env];

  async function get_json(pathname, { query = {}, signal } = {}) {
    const path = normalized_path(pathname);
    let retry_count = 0;

    while (true) {
      let resolved_api_key;
      try {
        resolved_api_key = await resolve_api_key();
      } catch {
        throw new NightwatchRestError('Nightwatch API key provider failed', { path });
      }
      const token = String(resolved_api_key || '').trim();
      if (!token) {
        throw new NightwatchRestError(`Nightwatch API key is missing; set ${api_key_env}`, { path });
      }

      let response;
      const controller = new AbortController();
      const abort_from_parent = () => controller.abort(signal?.reason);
      if (signal?.aborted) abort_from_parent();
      else signal?.addEventListener?.('abort', abort_from_parent, { once: true });
      const timeout_id = setTimeout(() => controller.abort(new Error('Nightwatch request timeout')), timeout_ms);
      try {
        const start_request = () => fetch_impl(build_url(resolved_base_url, path, query), {
          method: 'GET',
          redirect: 'error',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
        });
        response = is_snapshot_path(path) && typeof snapshot_rate_limiter.schedule === 'function'
          ? await snapshot_rate_limiter.schedule(start_request)
          : await (async () => {
            if (is_snapshot_path(path)) await snapshot_rate_limiter.wait_for_turn();
            return start_request();
          })();
      } catch (error) {
        const reason = error?.name === 'AbortError' ? 'request aborted' : 'network error';
        throw new NightwatchRestError(`Nightwatch request failed: ${reason}`, { path });
      } finally {
        clearTimeout(timeout_id);
        signal?.removeEventListener?.('abort', abort_from_parent);
      }

      if (response.status === 429) {
        const metadata = await sanitized_error_metadata(response, path, now_ms());
        const retry_after_ms = metadata.retry_after_ms;
        const retryable = retry_after_ms !== null
          && metadata.error_code !== 'QUOTA_EXHAUSTED';
        if (!retryable || retry_count >= retry_limit) {
          throw new NightwatchRestError('Nightwatch rate limit retry budget exhausted', {
            ...metadata,
          });
        }
        retry_count += 1;
        await sleep(retry_after_ms);
        continue;
      }

      if (!response.ok) {
        const metadata = await sanitized_error_metadata(response, path, now_ms());
        const code_suffix = metadata.error_code ? ` (${metadata.error_code})` : '';
        throw new NightwatchRestError(
          `Nightwatch request returned HTTP ${response.status}${code_suffix}`,
          metadata,
        );
      }

      return response_json(response, path);
    }
  }

  return Object.freeze({
    base_url: resolved_base_url,
    discover_datasets: (options) => get_json('/v1/discover', options),
    get_dealer_gex_snapshot: (ticker, options) => get_json(
      `/v1/derived/dealer-gex/${encodeURIComponent(normalized_derived_ticker(ticker))}/snapshot`,
      options,
    ),
    get_heatmap_snapshot: (ticker, options) => get_json(
      `/v1/derived/heatmap/${encodeURIComponent(normalized_derived_ticker(ticker))}/snapshot`,
      options,
    ),
    get_dealer_gex_history: (ticker, options) => get_json(
      `/v1/derived/dealer-gex/${encodeURIComponent(normalized_derived_ticker(ticker))}/history`,
      options,
    ),
    get_standard_gex_history: (ticker, options) => get_json(
      `/v1/derived/standard-gex/${encodeURIComponent(normalized_derived_ticker(ticker))}/history`,
      options,
    ),
    get_options_chain_snapshot: (ticker, options) => get_json(
      `/v1/options/chain-snapshot/${encodeURIComponent(normalized_ticker(ticker))}`,
      options,
    ),
    get_options_atm_chains: (ticker, options) => get_json(
      `/v1/options/atm-chains/${encodeURIComponent(normalized_ticker(ticker))}`,
      options,
    ),
    get_options_oi_change: (ticker, options) => get_json(
      `/v1/options/oi-change/${encodeURIComponent(normalized_ticker(ticker))}`,
      options,
    ),
    get_options_options_volume: (ticker, options) => get_json(
      `/v1/options/options-volume/${encodeURIComponent(normalized_ticker(ticker))}`,
      options,
    ),
    get_options_contract_intraday: (contract, options) => get_json(
      `/v1/options/contract-intraday/${encodeURIComponent(normalized_contract(contract))}`,
      options,
    ),
    get_options_contract_greeks_series: (contract, options) => get_json(
      `/v1/options/contract-greeks-series/${encodeURIComponent(normalized_contract(contract))}`,
      options,
    ),
    get_options_contract_volume_profile: (contract, options) => get_json(
      `/v1/options/contract-volume-profile/${encodeURIComponent(normalized_contract(contract))}`,
      options,
    ),
    get_heatmap_history: (ticker, options) => get_json(
      `/v1/derived/heatmap/${encodeURIComponent(normalized_derived_ticker(ticker))}/history`,
      options,
    ),
    get_stock_state: (ticker, options) => get_json(
      `/v1/stocks/stock-state/${encodeURIComponent(normalized_ticker(ticker))}`,
      options,
    ),
    get_index_ohlc: (ticker, options) => get_json(
      `/v1/stocks/index-ohlc/${encodeURIComponent(normalized_ticker(ticker))}`,
      options,
    ),
    get_json,
  });
}
