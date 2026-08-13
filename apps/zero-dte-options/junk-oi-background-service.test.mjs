import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compact_junk_oi_structure_background,
  junk_oi_expected_dual_dates,
  refresh_junk_oi_structure_background,
} from './junk-oi-background-service.mjs';

const calendar = {
  closed_dates_et: ['2026-07-03', '2026-09-07'],
};

function contract(overrides = {}) {
  return {
    option_symbol: 'SPXW260813C07750000',
    prev_date: '2026-08-12',
    date: '2026-08-13',
    oi: 150,
    prev_oi: 100,
    oi_diff: 50,
    volume: 75,
    trades: 5,
    avg_price_usd: 2,
    premium_usd: 15_000,
    ...overrides,
  };
}

test('dual-date resolver skips weekends and configured market holidays', () => {
  assert.deepEqual(junk_oi_expected_dual_dates('2026-08-13', calendar), {
    activity_trade_date: '2026-08-12',
    oi_effective_date: '2026-08-13',
  });
  assert.deepEqual(junk_oi_expected_dual_dates('2026-07-06', calendar), {
    activity_trade_date: '2026-07-02',
    oi_effective_date: '2026-07-06',
  });
  assert.throws(() => junk_oi_expected_dual_dates('2026-09-07', calendar), /open US options session/);
});

test('refresh persists a usable daily snapshot while optional volume failure remains neutral', async () => {
  const calls = [];
  const ingested = [];
  const result = await refresh_junk_oi_structure_background({
    nightwatch: {
      get_options_oi_change: async (ticker) => {
        calls.push(`oi:${ticker}`);
        return { as_of: '2026-08-13T04:00:00.000Z', contracts: [contract()] };
      },
      get_options_options_volume: async (ticker) => {
        calls.push(`volume:${ticker}`);
        throw new Error('HTTP 503 Bearer secret_value');
      },
    },
    store: {
      load_history: async () => [],
      ingest_snapshot: async (snapshot, options) => {
        ingested.push({ snapshot, options });
        return { idempotent: false };
      },
    },
    session_date_et: '2026-08-13',
    market_calendar: calendar,
    captured_at: '2026-08-13T14:00:00.000Z',
  });
  assert.deepEqual(calls, ['oi:SPX', 'volume:SPX']);
  assert.equal(result.background.usable, true);
  assert.equal(result.background.can_trigger_trade, false);
  assert.equal(result.background.can_veto_candidate, false);
  assert.equal(result.background.optional_context_errors.length, 1);
  assert.equal(result.background.optional_context_errors[0].includes('secret_value'), false);
  assert.equal(ingested.length, 1);
  assert.equal(result.ingestion.idempotent, false);
});

test('optional volume 429 is not swallowed so the watcher can honor Retry-After', async () => {
  const limited = Object.assign(new Error('HTTP 429'), { status: 429, retry_after_ms: 60_000 });
  await assert.rejects(
    refresh_junk_oi_structure_background({
      nightwatch: {
        get_options_oi_change: async () => ({
          as_of: '2026-08-13T04:00:00.000Z',
          contracts: [contract()],
        }),
        get_options_options_volume: async () => { throw limited; },
      },
      store: {
        load_history: async () => [],
        ingest_snapshot: async () => { throw new Error('must not persist after 429'); },
      },
      session_date_et: '2026-08-13',
      market_calendar: calendar,
      captured_at: '2026-08-13T14:00:00.000Z',
    }),
    (error) => error === limited,
  );
});

test('invalid OI dual-date evidence is fail-closed and never persisted', async () => {
  let ingested = 0;
  const result = await refresh_junk_oi_structure_background({
    nightwatch: {
      get_options_oi_change: async () => ({
        as_of: '2026-08-13T04:00:00.000Z',
        contracts: [contract({ prev_date: '2026-08-11' })],
      }),
      get_options_options_volume: async () => null,
    },
    store: {
      load_history: async () => [],
      ingest_snapshot: async () => { ingested += 1; },
    },
    session_date_et: '2026-08-13',
    market_calendar: calendar,
    captured_at: '2026-08-13T14:00:00.000Z',
  });
  assert.equal(result.background.usable, false);
  assert.ok(result.background.reason_codes.includes('activity_trade_date_mismatch'));
  assert.equal(ingested, 0);
});

test('compact background remains context-only and keeps deterministic top rows', () => {
  const compact = compact_junk_oi_structure_background({
    usable: true,
    state: 'usable_context',
    contracts: [
      { contract: 'B', oi_diff: 2, premium_usd: 100 },
      { contract: 'A', oi_diff: -9, premium_usd: 1 },
    ],
    strikes: [
      { strike_usd: 5, right: 'call', oi_diff: 1 },
      { strike_usd: 4, right: 'put', oi_diff: 4 },
    ],
  }, { top_n: 1 });
  assert.equal(compact.can_trigger_trade, false);
  assert.equal(compact.can_veto_candidate, false);
  assert.equal(compact.top_contracts[0].contract, 'A');
  assert.equal(compact.top_strikes[0].strike_usd, 4);
});
