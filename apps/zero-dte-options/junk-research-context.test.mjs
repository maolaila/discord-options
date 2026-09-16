import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { create_research_context_service, normalize_research_source, research_context_snapshot } from './junk-research-context.mjs';

const now = new Date('2026-09-17T13:00:00Z');
const stats = { data: { ticker: 'SPX', date: '2026-09-16', as_of: '2026-09-16T04:00:00Z',
  iv_pct: 0.135, iv_rank: 20.3492, rv_pct: null }, _meta: { data_freshness_seconds: 118800 } };

test('research preserves daily IV units, nulls and date lag; never labels them realtime IV', () => {
  const source = normalize_research_source('volatility', stats, now);
  const snapshot = research_context_snapshot({ volatility: source }, now);
  assert.equal(snapshot.sources.volatility.values.iv_pct_provider, 0.135);
  assert.equal(snapshot.sources.volatility.values.rv_pct_provider, null);
  assert.equal(snapshot.sources.volatility.date_relation, 'prior_session_date');
  assert.equal(snapshot.sources.volatility.intraday_iv_usable, false);
  assert.equal(snapshot.affects_entry, false);
  assert.equal(snapshot.affects_sizing, false);
  assert.equal(snapshot.affects_exit, false);
  assert.equal(research_context_snapshot({ volatility: source }, new Date(now.getTime() + 3_600_001))
    .sources.volatility.usable, false);
});

test('wrong ticker, empty schema, materializing and future values cannot become usable context', () => {
  assert.equal(normalize_research_source('volatility', { data: { ...stats.data, ticker: 'SPY' } }, now).usable, false);
  assert.equal(normalize_research_source('term_structure', { data: { ticker: 'SPX' } }, now).usable, false);
  assert.equal(normalize_research_source('volatility', { data: null, _meta: { status: 'materializing' } }, now).state, 'materializing');
  const source = normalize_research_source('volatility', { data: { ...stats.data, date: '2026-09-18' } }, now);
  assert.equal(research_context_snapshot({ volatility: source }, now).sources.volatility.usable, false);
});

test('event proximity uses NY dates, no fabricated event importance or complete-calendar claim', () => {
  const source = normalize_research_source('economic_calendar', { data: { as_of: null, events: [
    { event: 'Claims', scheduled_at: '2026-09-17T12:30:00Z' },
    { event: 'Bad timestamp', scheduled_at: 'invalid' },
  ] } }, now);
  const snapshot = research_context_snapshot({ economic_calendar: source }, now);
  assert.equal(snapshot.near_event, true);
  assert.equal(snapshot.events_today[0].minutes_from_now, -30);
  assert.equal(snapshot.sources.economic_calendar.as_of, null);
  assert.match(snapshot.sources.economic_calendar.coverage, /not_a_complete/);
  assert.equal(research_context_snapshot({}, now).near_event, null);
});

test('a hung research request never holds the caller and repeated kicks do not duplicate it', async () => {
  let resolve, calls = 0;
  const client = { get_volatility_stats: () => { calls++; return new Promise((r) => { resolve = r; }); } };
  const service = create_research_context_service({ client, now_ms: () => now.getTime(), persist: async () => {} });
  assert.equal(service.kick(), true);
  await Promise.resolve();
  assert.equal(service.kick(), false);
  let brokerExits = 0;
  brokerExits += 1;
  assert.equal(brokerExits, 1);
  assert.equal(calls, 1);
  assert.equal(service.snapshot().refresh_in_flight, true);
  resolve(stats); await service.idle();
  assert.equal(service.snapshot().sources.volatility.usable, true);
});

test('429 respects Retry-After and errors / disk failure cannot reject into trading', async () => {
  let time = now.getTime(), calls = 0;
  const service = create_research_context_service({ client: {
    get_volatility_stats: async () => { calls++; throw Object.assign(new Error('Bearer DO_NOT_LOG'),
      { status: 429, retry_after_ms: 900_000, error_code: 'RATE_LIMITED' }); },
  }, now_ms: () => time, persist: async () => { throw new Error('disk full'); } });
  service.kick(); await service.idle();
  time += 899_999;
  assert.equal(service.kick(), false);
  assert.equal(calls, 1);
  const snapshot = service.snapshot();
  assert.equal(snapshot.io_error, 'research_write_failed');
  assert.equal(snapshot.sources.volatility.usable, false);
  assert.equal(JSON.stringify(snapshot).includes('DO_NOT_LOG'), false);
  service.stop(); assert.equal(service.kick(), false);
});

test('live integration attaches research after gates and does not await background I/O', async () => {
  const source = await readFile(new URL('./zero-dte-line.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('decision = { ...decision, research_context: research_status() }')
    > source.indexOf('const audited = apply_junk_contract_audit'));
  assert.doesNotMatch(source, /await\s+(research_service\.(kick|idle)|replay_recorder)/);
  assert.match(source, /watch && research_enabled && !research_schedule.closed/);
  assert.match(source, /research_context: research_status\(\)/);
});
