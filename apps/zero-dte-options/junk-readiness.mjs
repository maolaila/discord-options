import { JUNK_GEX_MAX_AGE_MS } from './junk-gex-freshness.mjs';

function fresh(value, now_ms, max_ms) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) && now_ms - time >= -5_000 && now_ms - time <= max_ms;
}

/** Operations assessment only; never substitutes for the execution gates. */
export function assess_junk_readiness({ status = {}, watcher = {}, broker_check = {}, now_ms = Date.now() } = {}) {
  const runtime_reasons = [];
  if (!watcher.running) runtime_reasons.push('watcher_stopped');
  if (!watcher.heartbeat_fresh || !fresh(status.updated_at, now_ms, 90_000)) runtime_reasons.push('watcher_heartbeat_stale');
  if (status.execution_environment !== 'simulate_only' || status.real_trading_allowed !== false
    || status.mode !== 'execute_simulate') runtime_reasons.push('simulation_mode_unverified');
  if (status.broker_recovery?.status !== 'complete') runtime_reasons.push('broker_reconciliation_incomplete');
  const broker_reasons = [];
  if (!fresh(broker_check.checked_at, now_ms, 180_000)) broker_reasons.push('broker_check_stale');
  if (broker_check.global_state?.qot_logined !== true || broker_check.global_state?.trd_logined !== true) {
    broker_reasons.push('broker_not_authenticated');
  }
  if (!broker_check.account_summary?.some(account => account.trading_environment === 0
    && account.simulated_account_type === 4 && account.trading_market_auth_list?.includes(2))) {
    broker_reasons.push('simulation_option_account_unverified');
  }
  const data_reasons = [];
  const provider = status.provider || {};
  if (provider.gex_freshness?.readiness !== 'ready'
    || !fresh(provider.last_gex?.snapshot_at, now_ms, JUNK_GEX_MAX_AGE_MS)
    || provider.last_gex?.session_date_et !== status.session_date_et) data_reasons.push('gex_not_ready');
  if (status.market_context?.price_action_ready !== true) data_reasons.push('price_action_not_ready');
  const chain = provider.directional_option_chain;
  const requires_directional_chain = status.option_selection_mode !== 'atm';
  if (requires_directional_chain && !chain) data_reasons.push('directional_chain_not_checked');
  else if (requires_directional_chain && (chain.status !== 'ready' || chain.validation?.ready !== true
    || chain.expiration !== status.session_date_et
    || !fresh(chain.snapshot_at, now_ms, JUNK_GEX_MAX_AGE_MS)
    || !fresh(chain.greeks_as_of, now_ms, JUNK_GEX_MAX_AGE_MS)
    || !fresh(chain.available_at, now_ms, JUNK_GEX_MAX_AGE_MS))) {
    data_reasons.push(...(chain.validation?.reason_codes?.length
      ? chain.validation.reason_codes : [chain.error_code || 'directional_chain_not_ready']));
  }
  const latest_reasons = status.last_decision?.reason_codes || [];
  data_reasons.push(...latest_reasons.filter(reason => /^missing_(call|put)_directional_gex_reference$/.test(reason)));
  const runtime_ready = runtime_reasons.length === 0 && broker_reasons.length === 0;
  const entry_window_open = status.market_schedule?.entry_open === true;
  const entry_data_ready = data_reasons.length === 0;
  return {
    checked_at: new Date(now_ms).toISOString(),
    runtime_ready,
    broker_ready: broker_reasons.length === 0,
    entry_window_open,
    entry_data_ready,
    ready_for_entry_evaluation: runtime_ready && entry_window_open && entry_data_ready,
    runtime_reasons,
    broker_reasons,
    data_reasons: [...new Set(data_reasons)],
    // A healthy dependency check is not a trade signal or an execution permit.
    signal_decision: status.last_decision?.decision || 'not_evaluated',
  };
}
