import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { open_junk_oi_research_store } from './junk-oi-research-store.mjs';

function temp_fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'junk-oi-store-'));
  return {
    directory,
    db_path: path.join(directory, 'research.sqlite'),
    raw_dir: path.join(directory, 'raw'),
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

function snapshot(activity_trade_date = '2026-08-10', oi_effective_date = '2026-08-11') {
  return {
    kind: 'junk_oi_structure_background',
    version: 1,
    ticker: 'SPX',
    context_only: true,
    settlement_lagged: true,
    usable: true,
    state: 'usable_context',
    activity_trade_date,
    oi_effective_date,
    source_as_of: `${oi_effective_date}T12:00:00.000Z`,
    captured_at: `${oi_effective_date}T13:00:00.000Z`,
    score: { value: 62.5, directional_interpretation_allowed: false },
    reason_codes: ['not_intraday_trade_evidence'],
    evidence: { coverage_limit: 'highlighted_subset' },
    contracts: [
      {
        contract: 'SPXW260811C05000000',
        root: 'SPXW',
        ticker: 'SPX',
        expiration: '2026-08-11',
        right: 'call',
        strike_usd: 5000,
        oi: 100,
        prev_oi: null,
        oi_diff: null,
        volume: 30,
        premium_usd: null,
        data_complete: false,
        history: { observation_count: 1 },
      },
      {
        contract: 'SPXW260811P05000000',
        root: 'SPXW',
        ticker: 'SPX',
        expiration: '2026-08-11',
        right: 'put',
        strike_usd: 5000,
        oi: 120,
        prev_oi: 110,
        oi_diff: 10,
        volume: 40,
        premium_usd: 25_000,
        data_complete: true,
      },
    ],
    strikes: [
      {
        ticker: 'SPX',
        strike_usd: 5000,
        right: 'call',
        contract_count: 1,
        oi: 100,
        prev_oi: null,
        oi_diff: null,
        volume: 30,
        contracts: ['SPXW260811C05000000'],
      },
      {
        ticker: 'SPX',
        strike_usd: 5000,
        right: 'put',
        contract_count: 1,
        oi: 120,
        prev_oi: 110,
        oi_diff: 10,
        volume: 40,
        contracts: ['SPXW260811P05000000'],
      },
    ],
  };
}

test('first ingestion writes normalized facts, preserves null, and atomically redacts raw credentials', () => {
  const fixture = temp_fixture();
  const store = open_junk_oi_research_store(fixture);
  try {
    const result = store.ingest_snapshot(snapshot(), {
      run_id: 'run-first',
      raw_payloads: {
        response: { rows: [1] },
        authorization: 'Bearer should-not-survive',
        nested: { api_key: 'sk_live_should-not-survive', note: 'Bearer also-secret' },
      },
    });
    assert.equal(result.idempotent, false);
    assert.deepEqual(result.inserted, { contracts: 2, strikes: 2, tickers: 1, total: 5 });
    const latest = store.load_latest({ ticker: 'spx' });
    assert.equal(latest.contracts.length, 2);
    assert.equal(latest.contracts[0].prev_oi, null);
    assert.equal(latest.contracts[0].premium_usd, null);
    assert.equal(latest.strikes[0].prev_oi, null);
    const raw = readFileSync(result.raw_path, 'utf8');
    assert.doesNotMatch(raw, /should-not-survive|sk_live_/);
    assert.match(raw, /\[REDACTED\]/);

    const inspection = new DatabaseSync(fixture.db_path, { readOnly: true });
    try {
      assert.equal(inspection.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    } finally {
      inspection.close();
    }
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test('same daily identity is an idempotent upsert and does not add fact rows', () => {
  const fixture = temp_fixture();
  const store = open_junk_oi_research_store(fixture);
  try {
    store.ingest_snapshot(snapshot(), { run_id: 'run-one' });
    const repeat = store.ingest_snapshot(snapshot(), { run_id: 'run-two' });
    assert.equal(repeat.idempotent, true);
    assert.deepEqual(repeat.inserted, { contracts: 0, strikes: 0, tickers: 0, total: 0 });
    assert.deepEqual(repeat.updated, { contracts: 2, strikes: 2, tickers: 1, total: 5 });
    const db = new DatabaseSync(fixture.db_path, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contract_daily').get().count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM strike_daily').get().count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ticker_daily').get().count, 1);
    assert.equal(db.prepare('SELECT idempotent FROM ingestion_runs WHERE run_id=?').get('run-two').idempotent, 1);
    db.close();
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test('call and put at the same strike remain separate strike facts', () => {
  const fixture = temp_fixture();
  const store = open_junk_oi_research_store(fixture);
  try {
    store.ingest_snapshot(snapshot());
    const rows = store.load_latest({ ticker: 'SPX' }).strikes;
    assert.deepEqual(rows.map((row) => `${row.strike_usd}:${row.right}`), ['5000:call', '5000:put']);
    assert.deepEqual(rows.map((row) => row.oi), [100, 120]);
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test('history_snapshot-only input is accepted and loads as a directly reusable history snapshot', () => {
  const fixture = temp_fixture();
  const store = open_junk_oi_research_store(fixture);
  try {
    const full = snapshot();
    const nested = {
      kind: full.kind,
      version: full.version,
      ticker: full.ticker,
      context_only: true,
      settlement_lagged: true,
      evidence: full.evidence,
      history_snapshot: {
        ticker: full.ticker,
        activity_trade_date: full.activity_trade_date,
        oi_effective_date: full.oi_effective_date,
        source_as_of: full.source_as_of,
        captured_at: full.captured_at,
        contracts: full.contracts,
        strikes: full.strikes,
      },
    };
    store.ingest_snapshot(nested);
    const history_snapshots = store.load_history({ ticker: 'SPX', limit_days: 3 });
    assert.equal(history_snapshots.length, 1);
    assert.deepEqual(
      Object.keys(history_snapshots[0]).filter((key) => [
        'ticker', 'activity_trade_date', 'oi_effective_date', 'contracts', 'strikes',
      ].includes(key)).sort(),
      ['activity_trade_date', 'contracts', 'oi_effective_date', 'strikes', 'ticker'],
    );
    assert.equal(history_snapshots[0].contracts.length, 2);
    assert.equal(history_snapshots[0].strikes.length, 2);
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test('three-day history returns the newest three observations in chronological order', () => {
  const fixture = temp_fixture();
  const store = open_junk_oi_research_store(fixture);
  try {
    for (const [activity, effective] of [
      ['2026-08-06', '2026-08-07'],
      ['2026-08-07', '2026-08-08'],
      ['2026-08-08', '2026-08-09'],
      ['2026-08-09', '2026-08-10'],
    ]) {
      const item = snapshot(activity, effective);
      item.contracts = [];
      item.strikes = [];
      store.ingest_snapshot(item);
    }
    const history = store.load_history({ ticker: 'SPX', limit_days: 3 });
    assert.deepEqual(history.map((row) => row.activity_trade_date), [
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
    ]);
    assert.equal(store.load_latest({ ticker: 'SPX' }).activity_trade_date, '2026-08-09');
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test('a row failure rolls back the run and every fact inserted earlier in the transaction', () => {
  const fixture = temp_fixture();
  const store = open_junk_oi_research_store(fixture);
  try {
    const broken = snapshot();
    broken.contracts.push({ right: 'call', strike_usd: 5010 });
    assert.throws(
      () => store.ingest_snapshot(broken, { run_id: 'run-rollback' }),
      /requires contract/,
    );
    assert.equal(store.load_latest({ ticker: 'SPX' }), null);
    const db = new DatabaseSync(fixture.db_path, { readOnly: true });
    for (const table of ['ingestion_runs', 'contract_daily', 'strike_daily', 'ticker_daily']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
    }
    db.close();
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test('facts survive close and reopen', () => {
  const fixture = temp_fixture();
  let store = open_junk_oi_research_store(fixture);
  try {
    store.ingest_snapshot(snapshot(), { run_id: 'run-persist' });
    store.close();
    store = open_junk_oi_research_store(fixture);
    const latest = store.load_latest({ ticker: 'SPX' });
    assert.equal(latest.activity_trade_date, '2026-08-10');
    assert.equal(latest.contracts[1].contract, 'SPXW260811P05000000');
    assert.equal(latest.evidence.coverage_limit, 'highlighted_subset');
  } finally {
    store.close();
    fixture.cleanup();
  }
});
