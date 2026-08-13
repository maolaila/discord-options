import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_HISTORY_DAYS = 60;
const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'key',
  'apikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'clientsecret',
  'password',
  'credential',
]);
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const LIVE_KEY_VALUE = /\bsk_(?:live|test)_[A-Za-z0-9._~-]+/gi;
const URL_CREDENTIAL_VALUE = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|secret)=)[^&#\s]*/gi;

function required_object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function date_key(value, name) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new TypeError(`${name} must be YYYY-MM-DD`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new TypeError(`${name} must be a valid calendar date`);
  }
  return text;
}

function ticker_key(value) {
  const ticker = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,15}$/.test(ticker)) throw new TypeError('snapshot.ticker is invalid');
  return ticker;
}

function iso_timestamp(value, name) {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${name} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function nullable_timestamp(value, name) {
  return value === null || value === undefined || value === '' ? null : iso_timestamp(value, name);
}

function nullable_number(value, name) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${name} must be finite or null`);
  return number;
}

function nullable_integer(value, name) {
  const number = nullable_number(value, name);
  if (number === null) return null;
  if (!Number.isInteger(number)) throw new TypeError(`${name} must be an integer or null`);
  return number;
}

function nullable_boolean(value, name) {
  if (value === null || value === undefined) return null;
  if (value === true || value === false) return value ? 1 : 0;
  if (value === 1 || value === 0) return value;
  throw new TypeError(`${name} must be boolean or null`);
}

function nullable_string(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function canonical_right(value, name) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'c' || text === 'call') return 'call';
  if (text === 'p' || text === 'put') return 'put';
  throw new TypeError(`${name} must be call or put`);
}

function json_text(value, name) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${name} must be JSON serializable: ${error.message}`);
  }
}

function json_value(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  return JSON.parse(value);
}

function sanitize_raw(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return value
      .replace(BEARER_VALUE, 'Bearer [REDACTED]')
      .replace(LIVE_KEY_VALUE, '[REDACTED]')
      .replace(URL_CREDENTIAL_VALUE, '$1[REDACTED]');
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('raw_payloads must not contain circular references');
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => sanitize_raw(item, seen));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const canonical_key = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (SENSITIVE_KEYS.has(canonical_key) || canonical_key.endsWith('apikey')) continue;
    result[key] = sanitize_raw(item, seen);
  }
  seen.delete(value);
  return result;
}

function validate_run_id(value) {
  const run_id = value === null || value === undefined || value === '' ? randomUUID() : String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run_id)) {
    throw new TypeError('run_id may contain only letters, numbers, dot, underscore, and dash');
  }
  return run_id;
}

function normalized_snapshot(snapshot, captured_at_override) {
  const outer = required_object(snapshot, 'snapshot');
  const history = outer.history_snapshot && typeof outer.history_snapshot === 'object'
    ? outer.history_snapshot
    : outer;
  const activity_trade_date = date_key(
    outer.activity_trade_date ?? history.activity_trade_date,
    'snapshot.activity_trade_date',
  );
  const oi_effective_date = date_key(
    outer.oi_effective_date ?? history.oi_effective_date,
    'snapshot.oi_effective_date',
  );
  const ticker = ticker_key(outer.ticker ?? history.ticker);
  const captured_at = iso_timestamp(
    captured_at_override ?? outer.captured_at ?? history.captured_at ?? new Date(),
    'captured_at',
  );
  const contracts = outer.contracts ?? history.contracts ?? [];
  const strikes = outer.strikes ?? history.strikes ?? [];
  if (!Array.isArray(contracts)) throw new TypeError('snapshot.contracts must be an array');
  if (!Array.isArray(strikes)) throw new TypeError('snapshot.strikes must be an array');
  const metadata = { ...outer };
  delete metadata.contracts;
  delete metadata.strikes;
  delete metadata.history_snapshot;
  return {
    outer,
    history,
    metadata,
    activity_trade_date,
    oi_effective_date,
    ticker,
    captured_at,
    source_as_of: nullable_timestamp(outer.source_as_of ?? history.source_as_of, 'snapshot.source_as_of'),
    contracts,
    strikes,
  };
}

function assert_row_identity(row, identity) {
  for (const [field, expected] of Object.entries(identity)) {
    if (row[field] === null || row[field] === undefined || row[field] === '') continue;
    const observed = field.endsWith('_date')
      ? date_key(row[field], `row.${field}`)
      : field === 'ticker'
        ? ticker_key(row[field])
        : row[field];
    if (observed !== expected) throw new TypeError(`row.${field} does not match snapshot identity`);
  }
}

function normalized_contract(row, identity) {
  required_object(row, 'contract row');
  assert_row_identity(row, identity);
  const contract = nullable_string(row.contract ?? row.option_symbol ?? row.symbol)?.toUpperCase();
  if (!contract) throw new TypeError('contract row requires contract');
  const right = canonical_right(row.right ?? row.option_type, 'contract.right');
  const normalized = {
    ...row,
    ...identity,
    contract,
    right,
    root: nullable_string(row.root)?.toUpperCase() ?? null,
    expiration: row.expiration === null || row.expiration === undefined
      ? null
      : date_key(row.expiration, 'contract.expiration'),
    strike_usd: nullable_number(row.strike_usd ?? row.strike, 'contract.strike_usd'),
    oi: nullable_number(row.oi ?? row.open_interest, 'contract.oi'),
    prev_oi: nullable_number(row.prev_oi ?? row.previous_open_interest, 'contract.prev_oi'),
    oi_diff: nullable_number(row.oi_diff ?? row.open_interest_diff, 'contract.oi_diff'),
    oi_change: nullable_number(row.oi_change, 'contract.oi_change'),
    volume: nullable_number(row.volume, 'contract.volume'),
    trades: nullable_integer(row.trades ?? row.trade_count, 'contract.trades'),
    avg_price_usd: nullable_number(row.avg_price_usd ?? row.avg_price, 'contract.avg_price_usd'),
    premium_usd: nullable_number(row.premium_usd ?? row.premium, 'contract.premium_usd'),
    premium_source: nullable_string(row.premium_source),
    premium_is_estimated: nullable_boolean(row.premium_is_estimated, 'contract.premium_is_estimated'),
    data_complete: nullable_boolean(row.data_complete, 'contract.data_complete'),
  };
  return normalized;
}

function normalized_strike(row, identity) {
  required_object(row, 'strike row');
  assert_row_identity(row, identity);
  const strike_usd = nullable_number(row.strike_usd ?? row.strike, 'strike.strike_usd');
  if (strike_usd === null) throw new TypeError('strike row requires strike_usd');
  const normalized = {
    ...row,
    ...identity,
    strike_usd,
    right: canonical_right(row.right ?? row.option_type, 'strike.right'),
    contract_count: nullable_integer(row.contract_count, 'strike.contract_count'),
    oi: nullable_number(row.oi, 'strike.oi'),
    prev_oi: nullable_number(row.prev_oi, 'strike.prev_oi'),
    oi_diff: nullable_number(row.oi_diff, 'strike.oi_diff'),
    volume: nullable_number(row.volume, 'strike.volume'),
    trades: nullable_integer(row.trades, 'strike.trades'),
    premium_usd: nullable_number(row.premium_usd, 'strike.premium_usd'),
  };
  return normalized;
}

function table_exists(db, table, where, params) {
  return Boolean(db.prepare(`SELECT 1 AS found FROM ${table} WHERE ${where} LIMIT 1`).get(...params));
}

function write_atomic_raw({ raw_dir, run_id, captured_at, raw_payloads, existing_run }) {
  if (!raw_dir || raw_payloads === null || raw_payloads === undefined) return { raw_path: existing_run?.raw_path ?? null, wrote: false };
  mkdirSync(raw_dir, { recursive: true });
  const raw_path = path.join(raw_dir, `${run_id}.json`);
  if (existsSync(raw_path)) {
    if (existing_run) return { raw_path, wrote: false };
    throw new Error(`raw payload already exists without matching ingestion run: ${run_id}`);
  }
  const temp_path = path.join(raw_dir, `.${run_id}.${randomUUID()}.tmp`);
  const envelope = {
    run_id,
    captured_at,
    payloads: sanitize_raw(raw_payloads),
  };
  try {
    writeFileSync(temp_path, `${json_text(envelope, 'raw_payloads')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp_path, raw_path);
  } catch (error) {
    rmSync(temp_path, { force: true });
    throw error;
  }
  return { raw_path, wrote: true };
}

function create_schema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS ingestion_runs (
      run_id TEXT PRIMARY KEY,
      activity_trade_date TEXT NOT NULL,
      oi_effective_date TEXT NOT NULL,
      ticker TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      source_as_of TEXT,
      status TEXT NOT NULL CHECK (status IN ('completed')),
      idempotent INTEGER NOT NULL CHECK (idempotent IN (0, 1)),
      contract_rows INTEGER NOT NULL,
      strike_rows INTEGER NOT NULL,
      inserted_fact_rows INTEGER NOT NULL,
      updated_fact_rows INTEGER NOT NULL,
      raw_path TEXT,
      evidence_json TEXT
    );

    CREATE TABLE IF NOT EXISTS contract_daily (
      activity_trade_date TEXT NOT NULL,
      oi_effective_date TEXT NOT NULL,
      ticker TEXT NOT NULL,
      contract TEXT NOT NULL,
      right TEXT NOT NULL CHECK (right IN ('call', 'put')),
      root TEXT,
      expiration TEXT,
      strike_usd REAL,
      oi REAL,
      prev_oi REAL,
      oi_diff REAL,
      oi_change REAL,
      volume REAL,
      trades INTEGER,
      avg_price_usd REAL,
      premium_usd REAL,
      premium_source TEXT,
      premium_is_estimated INTEGER CHECK (premium_is_estimated IS NULL OR premium_is_estimated IN (0, 1)),
      data_complete INTEGER CHECK (data_complete IS NULL OR data_complete IN (0, 1)),
      reason_codes_json TEXT,
      history_json TEXT,
      evidence_json TEXT,
      row_json TEXT NOT NULL,
      source_as_of TEXT,
      captured_at TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
      PRIMARY KEY (activity_trade_date, oi_effective_date, ticker, contract, right)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS strike_daily (
      activity_trade_date TEXT NOT NULL,
      oi_effective_date TEXT NOT NULL,
      ticker TEXT NOT NULL,
      strike_usd REAL NOT NULL,
      right TEXT NOT NULL CHECK (right IN ('call', 'put')),
      contract_count INTEGER,
      oi REAL,
      prev_oi REAL,
      oi_diff REAL,
      volume REAL,
      trades INTEGER,
      premium_usd REAL,
      expirations_json TEXT,
      contracts_json TEXT,
      incomplete_fields_json TEXT,
      history_json TEXT,
      evidence_json TEXT,
      row_json TEXT NOT NULL,
      source_as_of TEXT,
      captured_at TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
      PRIMARY KEY (activity_trade_date, oi_effective_date, ticker, strike_usd, right)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS ticker_daily (
      activity_trade_date TEXT NOT NULL,
      oi_effective_date TEXT NOT NULL,
      ticker TEXT NOT NULL,
      source_as_of TEXT,
      captured_at TEXT NOT NULL,
      usable INTEGER CHECK (usable IS NULL OR usable IN (0, 1)),
      state TEXT,
      context_only INTEGER CHECK (context_only IS NULL OR context_only IN (0, 1)),
      settlement_lagged INTEGER CHECK (settlement_lagged IS NULL OR settlement_lagged IN (0, 1)),
      score_value REAL,
      score_json TEXT,
      options_volume_json TEXT,
      reason_codes_json TEXT,
      evidence_json TEXT,
      metadata_json TEXT,
      run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
      PRIMARY KEY (activity_trade_date, oi_effective_date, ticker)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS ingestion_runs_ticker_date
      ON ingestion_runs (ticker, activity_trade_date DESC, oi_effective_date DESC, captured_at DESC);
  `);
}

const UPSERT_CONTRACT = `
  INSERT INTO contract_daily (
    activity_trade_date, oi_effective_date, ticker, contract, right, root, expiration, strike_usd,
    oi, prev_oi, oi_diff, oi_change, volume, trades, avg_price_usd, premium_usd, premium_source,
    premium_is_estimated, data_complete, reason_codes_json, history_json, evidence_json, row_json,
    source_as_of, captured_at, run_id
  ) VALUES (${Array(26).fill('?').join(', ')})
  ON CONFLICT (activity_trade_date, oi_effective_date, ticker, contract, right) DO UPDATE SET
    root=excluded.root, expiration=excluded.expiration, strike_usd=excluded.strike_usd,
    oi=excluded.oi, prev_oi=excluded.prev_oi, oi_diff=excluded.oi_diff, oi_change=excluded.oi_change,
    volume=excluded.volume, trades=excluded.trades, avg_price_usd=excluded.avg_price_usd,
    premium_usd=excluded.premium_usd, premium_source=excluded.premium_source,
    premium_is_estimated=excluded.premium_is_estimated, data_complete=excluded.data_complete,
    reason_codes_json=excluded.reason_codes_json, history_json=excluded.history_json,
    evidence_json=excluded.evidence_json, row_json=excluded.row_json, source_as_of=excluded.source_as_of,
    captured_at=excluded.captured_at, run_id=excluded.run_id
`;

const UPSERT_STRIKE = `
  INSERT INTO strike_daily (
    activity_trade_date, oi_effective_date, ticker, strike_usd, right, contract_count, oi, prev_oi,
    oi_diff, volume, trades, premium_usd, expirations_json, contracts_json, incomplete_fields_json,
    history_json, evidence_json, row_json, source_as_of, captured_at, run_id
  ) VALUES (${Array(21).fill('?').join(', ')})
  ON CONFLICT (activity_trade_date, oi_effective_date, ticker, strike_usd, right) DO UPDATE SET
    contract_count=excluded.contract_count, oi=excluded.oi, prev_oi=excluded.prev_oi,
    oi_diff=excluded.oi_diff, volume=excluded.volume, trades=excluded.trades,
    premium_usd=excluded.premium_usd, expirations_json=excluded.expirations_json,
    contracts_json=excluded.contracts_json, incomplete_fields_json=excluded.incomplete_fields_json,
    history_json=excluded.history_json, evidence_json=excluded.evidence_json, row_json=excluded.row_json,
    source_as_of=excluded.source_as_of, captured_at=excluded.captured_at, run_id=excluded.run_id
`;

const UPSERT_TICKER = `
  INSERT INTO ticker_daily (
    activity_trade_date, oi_effective_date, ticker, source_as_of, captured_at, usable, state,
    context_only, settlement_lagged, score_value, score_json, options_volume_json,
    reason_codes_json, evidence_json, metadata_json, run_id
  ) VALUES (${Array(16).fill('?').join(', ')})
  ON CONFLICT (activity_trade_date, oi_effective_date, ticker) DO UPDATE SET
    source_as_of=excluded.source_as_of, captured_at=excluded.captured_at, usable=excluded.usable,
    state=excluded.state, context_only=excluded.context_only,
    settlement_lagged=excluded.settlement_lagged, score_value=excluded.score_value,
    score_json=excluded.score_json, options_volume_json=excluded.options_volume_json,
    reason_codes_json=excluded.reason_codes_json, evidence_json=excluded.evidence_json,
    metadata_json=excluded.metadata_json, run_id=excluded.run_id
`;

function row_boolean(value) {
  return value === null || value === undefined ? null : Boolean(value);
}

function contract_from_db(row) {
  const stored = json_value(row.row_json, {});
  return {
    ...stored,
    activity_trade_date: row.activity_trade_date,
    oi_effective_date: row.oi_effective_date,
    ticker: row.ticker,
    contract: row.contract,
    right: row.right,
    root: row.root,
    expiration: row.expiration,
    strike_usd: row.strike_usd,
    oi: row.oi,
    prev_oi: row.prev_oi,
    oi_diff: row.oi_diff,
    oi_change: row.oi_change,
    volume: row.volume,
    trades: row.trades,
    avg_price_usd: row.avg_price_usd,
    premium_usd: row.premium_usd,
    premium_source: row.premium_source,
    premium_is_estimated: row_boolean(row.premium_is_estimated),
    data_complete: row_boolean(row.data_complete),
    reason_codes: json_value(row.reason_codes_json, null),
    history: json_value(row.history_json, null),
    evidence: json_value(row.evidence_json, null),
  };
}

function strike_from_db(row) {
  const stored = json_value(row.row_json, {});
  return {
    ...stored,
    activity_trade_date: row.activity_trade_date,
    oi_effective_date: row.oi_effective_date,
    ticker: row.ticker,
    strike_usd: row.strike_usd,
    right: row.right,
    contract_count: row.contract_count,
    oi: row.oi,
    prev_oi: row.prev_oi,
    oi_diff: row.oi_diff,
    volume: row.volume,
    trades: row.trades,
    premium_usd: row.premium_usd,
    expirations: json_value(row.expirations_json, null),
    contracts: json_value(row.contracts_json, null),
    incomplete_fields: json_value(row.incomplete_fields_json, null),
    history: json_value(row.history_json, null),
    evidence: json_value(row.evidence_json, null),
  };
}

/**
 * Open the settlement-lagged JUNKMAN OI research store. This store is not an
 * execution signal source and deliberately has no broker or order API.
 */
export function open_junk_oi_research_store({ db_path, raw_dir = null } = {}) {
  const database_path = String(db_path ?? '').trim();
  if (!database_path) throw new TypeError('db_path is required');
  const resolved_db_path = database_path === ':memory:' ? database_path : path.resolve(database_path);
  const resolved_raw_dir = raw_dir === null || raw_dir === undefined || raw_dir === ''
    ? null
    : path.resolve(String(raw_dir));
  if (resolved_db_path !== ':memory:') mkdirSync(path.dirname(resolved_db_path), { recursive: true });

  const db = new DatabaseSync(resolved_db_path);
  try {
    create_schema(db);
  } catch (error) {
    try { db.close(); } catch { /* preserve the schema error */ }
    throw error;
  }
  let closed = false;

  const contract_statement = db.prepare(UPSERT_CONTRACT);
  const strike_statement = db.prepare(UPSERT_STRIKE);
  const ticker_statement = db.prepare(UPSERT_TICKER);

  function assert_open() {
    if (closed) throw new Error('JUNK OI research store is closed');
  }

  function ingest_snapshot(snapshot, { raw_payloads = null, run_id: requested_run_id = null, captured_at = null } = {}) {
    assert_open();
    const normalized = normalized_snapshot(snapshot, captured_at);
    const run_id = validate_run_id(requested_run_id);
    const identity = {
      activity_trade_date: normalized.activity_trade_date,
      oi_effective_date: normalized.oi_effective_date,
      ticker: normalized.ticker,
    };
    const existing_run = db.prepare(`
      SELECT activity_trade_date, oi_effective_date, ticker, raw_path
      FROM ingestion_runs WHERE run_id = ?
    `).get(run_id) ?? null;
    if (existing_run && (
      existing_run.activity_trade_date !== identity.activity_trade_date
        || existing_run.oi_effective_date !== identity.oi_effective_date
        || existing_run.ticker !== identity.ticker
    )) {
      throw new Error(`run_id ${run_id} already belongs to a different snapshot identity`);
    }
    let raw_result = { raw_path: existing_run?.raw_path ?? null, wrote: false };
    let transaction_open = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      transaction_open = true;
      db.prepare(`
        INSERT INTO ingestion_runs (
          run_id, activity_trade_date, oi_effective_date, ticker, captured_at, source_as_of,
          status, idempotent, contract_rows, strike_rows, inserted_fact_rows,
          updated_fact_rows, raw_path, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'completed', 0, 0, 0, 0, 0, ?, ?)
        ON CONFLICT (run_id) DO UPDATE SET
          activity_trade_date=excluded.activity_trade_date,
          oi_effective_date=excluded.oi_effective_date,
          ticker=excluded.ticker,
          captured_at=excluded.captured_at,
          source_as_of=excluded.source_as_of,
          status='completed',
          raw_path=COALESCE(excluded.raw_path, ingestion_runs.raw_path),
          evidence_json=excluded.evidence_json
      `).run(
        run_id,
        identity.activity_trade_date,
        identity.oi_effective_date,
        identity.ticker,
        normalized.captured_at,
        normalized.source_as_of,
        existing_run?.raw_path ?? null,
        json_text(normalized.outer.evidence, 'snapshot.evidence'),
      );

      let inserted_contracts = 0;
      let updated_contracts = 0;
      for (const source_row of normalized.contracts) {
        const row = normalized_contract(source_row, identity);
        const existed = table_exists(
          db,
          'contract_daily',
          'activity_trade_date=? AND oi_effective_date=? AND ticker=? AND contract=? AND right=?',
          [identity.activity_trade_date, identity.oi_effective_date, identity.ticker, row.contract, row.right],
        );
        contract_statement.run(
          identity.activity_trade_date, identity.oi_effective_date, identity.ticker, row.contract, row.right,
          row.root, row.expiration, row.strike_usd, row.oi, row.prev_oi, row.oi_diff, row.oi_change,
          row.volume, row.trades, row.avg_price_usd, row.premium_usd, row.premium_source,
          row.premium_is_estimated, row.data_complete, json_text(row.reason_codes, 'contract.reason_codes'),
          json_text(row.history, 'contract.history'), json_text(row.evidence, 'contract.evidence'),
          json_text(row, 'contract row'), normalized.source_as_of, normalized.captured_at, run_id,
        );
        if (existed) updated_contracts += 1;
        else inserted_contracts += 1;
      }

      let inserted_strikes = 0;
      let updated_strikes = 0;
      for (const source_row of normalized.strikes) {
        const row = normalized_strike(source_row, identity);
        const existed = table_exists(
          db,
          'strike_daily',
          'activity_trade_date=? AND oi_effective_date=? AND ticker=? AND strike_usd=? AND right=?',
          [identity.activity_trade_date, identity.oi_effective_date, identity.ticker, row.strike_usd, row.right],
        );
        strike_statement.run(
          identity.activity_trade_date, identity.oi_effective_date, identity.ticker, row.strike_usd, row.right,
          row.contract_count, row.oi, row.prev_oi, row.oi_diff, row.volume, row.trades, row.premium_usd,
          json_text(row.expirations, 'strike.expirations'), json_text(row.contracts, 'strike.contracts'),
          json_text(row.incomplete_fields, 'strike.incomplete_fields'), json_text(row.history, 'strike.history'),
          json_text(row.evidence, 'strike.evidence'), json_text(row, 'strike row'), normalized.source_as_of,
          normalized.captured_at, run_id,
        );
        if (existed) updated_strikes += 1;
        else inserted_strikes += 1;
      }

      const ticker_existed = table_exists(
        db,
        'ticker_daily',
        'activity_trade_date=? AND oi_effective_date=? AND ticker=?',
        [identity.activity_trade_date, identity.oi_effective_date, identity.ticker],
      );
      const score_value = normalized.outer.score && typeof normalized.outer.score === 'object'
        ? nullable_number(normalized.outer.score.value, 'snapshot.score.value')
        : nullable_number(normalized.outer.score, 'snapshot.score');
      ticker_statement.run(
        identity.activity_trade_date, identity.oi_effective_date, identity.ticker, normalized.source_as_of,
        normalized.captured_at, nullable_boolean(normalized.outer.usable, 'snapshot.usable'),
        nullable_string(normalized.outer.state), nullable_boolean(normalized.outer.context_only, 'snapshot.context_only'),
        nullable_boolean(normalized.outer.settlement_lagged, 'snapshot.settlement_lagged'), score_value,
        json_text(normalized.outer.score, 'snapshot.score'),
        json_text(normalized.outer.options_volume, 'snapshot.options_volume'),
        json_text(normalized.outer.reason_codes, 'snapshot.reason_codes'),
        json_text(normalized.outer.evidence, 'snapshot.evidence'),
        json_text(normalized.metadata, 'snapshot metadata'), run_id,
      );

      const inserted_tickers = ticker_existed ? 0 : 1;
      const updated_tickers = ticker_existed ? 1 : 0;
      const inserted_fact_rows = inserted_contracts + inserted_strikes + inserted_tickers;
      const updated_fact_rows = updated_contracts + updated_strikes + updated_tickers;
      const idempotent = inserted_fact_rows === 0;

      raw_result = write_atomic_raw({
        raw_dir: resolved_raw_dir,
        run_id,
        captured_at: normalized.captured_at,
        raw_payloads,
        existing_run,
      });
      db.prepare(`
        UPDATE ingestion_runs SET
          idempotent=?, contract_rows=?, strike_rows=?, inserted_fact_rows=?, updated_fact_rows=?, raw_path=?
        WHERE run_id=?
      `).run(
        idempotent ? 1 : 0,
        normalized.contracts.length,
        normalized.strikes.length,
        inserted_fact_rows,
        updated_fact_rows,
        raw_result.raw_path,
        run_id,
      );
      db.exec('COMMIT');
      transaction_open = false;
      return Object.freeze({
        run_id,
        ...identity,
        captured_at: normalized.captured_at,
        idempotent,
        inserted: Object.freeze({
          contracts: inserted_contracts,
          strikes: inserted_strikes,
          tickers: inserted_tickers,
          total: inserted_fact_rows,
        }),
        updated: Object.freeze({
          contracts: updated_contracts,
          strikes: updated_strikes,
          tickers: updated_tickers,
          total: updated_fact_rows,
        }),
        raw_path: raw_result.raw_path,
      });
    } catch (error) {
      if (transaction_open) {
        try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      }
      if (raw_result.wrote) rmSync(raw_result.raw_path, { force: true });
      throw error;
    }
  }

  function load_history({ ticker, limit_days = 60 } = {}) {
    assert_open();
    const normalized_ticker = ticker_key(ticker);
    const limit = Number(limit_days);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_DAYS) {
      throw new RangeError(`limit_days must be an integer between 1 and ${MAX_HISTORY_DAYS}`);
    }
    const ticker_rows = db.prepare(`
      SELECT * FROM (
        SELECT * FROM ticker_daily
        WHERE ticker=?
        ORDER BY activity_trade_date DESC, oi_effective_date DESC, captured_at DESC
        LIMIT ?
      ) ORDER BY activity_trade_date ASC, oi_effective_date ASC, captured_at ASC
    `).all(normalized_ticker, limit);
    const contract_query = db.prepare(`
      SELECT * FROM contract_daily
      WHERE activity_trade_date=? AND oi_effective_date=? AND ticker=?
      ORDER BY expiration ASC, strike_usd ASC, right ASC, contract ASC
    `);
    const strike_query = db.prepare(`
      SELECT * FROM strike_daily
      WHERE activity_trade_date=? AND oi_effective_date=? AND ticker=?
      ORDER BY strike_usd ASC, right ASC
    `);
    return ticker_rows.map((ticker_row) => {
      const params = [ticker_row.activity_trade_date, ticker_row.oi_effective_date, ticker_row.ticker];
      const metadata = json_value(ticker_row.metadata_json, {});
      return {
        ...metadata,
        ticker: ticker_row.ticker,
        activity_trade_date: ticker_row.activity_trade_date,
        oi_effective_date: ticker_row.oi_effective_date,
        source_as_of: ticker_row.source_as_of,
        captured_at: ticker_row.captured_at,
        usable: row_boolean(ticker_row.usable),
        state: ticker_row.state,
        context_only: row_boolean(ticker_row.context_only),
        settlement_lagged: row_boolean(ticker_row.settlement_lagged),
        score: json_value(ticker_row.score_json, ticker_row.score_value),
        options_volume: json_value(ticker_row.options_volume_json, null),
        reason_codes: json_value(ticker_row.reason_codes_json, null),
        evidence: json_value(ticker_row.evidence_json, null),
        contracts: contract_query.all(...params).map(contract_from_db),
        strikes: strike_query.all(...params).map(strike_from_db),
      };
    });
  }

  function load_latest({ ticker } = {}) {
    const history = load_history({ ticker, limit_days: 1 });
    return history.length === 0 ? null : history[0];
  }

  function close() {
    if (closed) return;
    db.close();
    closed = true;
  }

  return Object.freeze({ ingest_snapshot, load_history, load_latest, close });
}
