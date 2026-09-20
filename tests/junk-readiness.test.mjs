import assert from 'node:assert/strict';
import test from 'node:test';
import { assess_junk_readiness } from '../apps/zero-dte-options/junk-readiness.mjs';

const now = '2026-09-21T14:35:30Z';
function input() {
  return { now_ms: Date.parse(now), watcher: { running: true, heartbeat_fresh: true },
    broker_check: { checked_at: now, global_state: { qot_logined: true, trd_logined: true },
      account_summary: [{ trading_environment: 0, simulated_account_type: 4, trading_market_auth_list: [2] }] },
    status: { updated_at: now, execution_environment: 'simulate_only', real_trading_allowed: false,
      mode: 'execute_simulate', broker_recovery: { status: 'complete' }, session_date_et: '2026-09-21',
      market_schedule: { entry_open: true }, market_context: { price_action_ready: true },
      last_decision: { decision: 'no_trade', reason_codes: ['waiting_for_node_confirmation'] },
      provider: { gex_freshness: { readiness: 'ready' }, last_gex: { snapshot_at: '2026-09-21T14:30:00Z', session_date_et: '2026-09-21' },
        directional_option_chain: { status: 'ready', validation: { ready: true, reason_codes: [] },
          snapshot_at: now, greeks_as_of: now, available_at: now, expiration: '2026-09-21' } } } };
}
test('ready runtime and GEX cannot hide a failed direction chain', () => {
  const fixture = input();
  fixture.status.provider.directional_option_chain = { status: 'request_failed', error_code: 'RESPONSE_TOO_LARGE' };
  const result = assess_junk_readiness(fixture);
  assert.equal(result.runtime_ready, true);
  assert.equal(result.ready_for_entry_evaluation, false);
  assert.ok(result.data_reasons.includes('RESPONSE_TOO_LARGE'));
});
test('stale broker success and stopped watcher do not report operational readiness', () => {
  const fixture = input();
  fixture.broker_check.checked_at = '2026-09-18T20:00:00Z';
  fixture.watcher.running = false;
  const result = assess_junk_readiness(fixture);
  assert.equal(result.runtime_ready, false);
  assert.equal(result.broker_ready, false);
  assert.ok(result.broker_reasons.includes('broker_check_stale'));
});
test('a full data check is distinct from market hours and the trade signal', () => {
  const fixture = input();
  const result = assess_junk_readiness(fixture);
  assert.equal(result.ready_for_entry_evaluation, true);
  assert.equal(result.signal_decision, 'no_trade');
  fixture.status.market_schedule.entry_open = false;
  assert.equal(assess_junk_readiness(fixture).ready_for_entry_evaluation, false);
  fixture.status.provider.directional_option_chain.greeks_as_of = '2026-09-18T20:00:00Z';
  assert.equal(assess_junk_readiness(fixture).entry_data_ready, false);
});
test('a cached Call check cannot hide a subsequent missing Put reference', () => {
  const fixture = input();
  fixture.status.last_decision.reason_codes = ['missing_put_directional_gex_reference'];
  assert.equal(assess_junk_readiness(fixture).entry_data_ready, false);
});
