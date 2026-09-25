import { assess_directional_chain_provenance } from './junk-gex-strategy.mjs';
import { JUNK_GEX_MAX_AGE_MS } from './junk-gex-freshness.mjs';

export function assess_both_chain_directions(response, { ticker, expiration, now_ms = Date.now() }) {
  const common = { option_chain_snapshot: response, ticker, expiration, now_ms, max_age_ms: JUNK_GEX_MAX_AGE_MS };
  const call = assess_directional_chain_provenance({ ...common, direction: 'bullish' });
  const put = assess_directional_chain_provenance({ ...common, direction: 'bearish' });
  return {
    ready: call.ready && put.ready,
    reason_codes: [...new Set([...call.reason_codes, ...put.reason_codes])],
    by_right: { call, put },
  };
}

// Subscribe independently of GEX availability. Never delay broker reconciliation
// or fabricate the historical price sample needed to align an SPX anchor.
export function start_spy_quote_warmup(runtime, ingest, now_ms = Date.now()) {
  if (runtime.spy_warmup_promise) return runtime.spy_warmup_promise;
  const security = { market: 11, code: 'SPY' };
  const cached = runtime.quote_feed.cachedSnapshots([security])[0];
  if (cached) { ingest(cached, { at_ms: now_ms }); return null; }
  if (now_ms < (runtime.spy_warmup_retry_at_ms || 0)) return null;
  runtime.spy_warmup_retry_at_ms = now_ms + 60_000;
  let timer;
  runtime.spy_warmup_promise = Promise.resolve()
    .then(() => Promise.race([
      runtime.quote_feed.getSnapshots([security], { orderBookSecurities: [] }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('SPY warmup timed out')), 10_000);
      }),
    ]))
    .then(result => {
      const sample = result.snapshots?.find(row => row.basic?.security?.code === 'SPY');
      if (sample) ingest(sample, { at_ms: Date.now() });
      runtime.spy_warmup_error = null;
    })
    .catch(() => { runtime.spy_warmup_error = 'spy_quote_warmup_failed'; })
    .finally(() => { clearTimeout(timer); runtime.spy_warmup_promise = null; });
  return runtime.spy_warmup_promise;
}
