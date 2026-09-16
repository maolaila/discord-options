import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildZeroDteSimulatedExitPlan } from './zero-dte-moomoo-exit.mjs';
import { exit_config_for_variant, load_junk_exit_experiment } from './junk-exit-experiment.mjs';
import { record_trading_date_et, trade_day_exclusion } from '../../packages/business-lines/trade-day-validity.mjs';

const number = (v) => v === null || v === undefined || v === '' ? null
  : Number.isFinite(Number(v)) ? Number(v) : null;
const round = (v) => Number(v.toFixed(4));

export function replay_observation({ row, snapshot, underlying_price_usd, now, schedule_exit_rule_overrides }) {
  if (!snapshot?.basic?.security?.code || !row.plan_id) return null;
  const basic = snapshot.basic;
  return {
    schema_version: 1, source: 'live_exit_input', observation_only: true,
    recorded_at: new Date().toISOString(), evaluated_at: now.toISOString(),
    plan_id: row.plan_id, code: row.code, underlying_price_usd: number(underlying_price_usd),
    schedule_exit_rule_overrides: schedule_exit_rule_overrides || {},
    option_snapshot: {
      basic: Object.fromEntries(['security', 'bidPrice', 'askPrice', 'bidVol', 'askVol',
        'curPrice', 'priceSpread', 'volume'].map((key) => [key, basic[key]])),
      optionExData: { openInterest: snapshot.optionExData?.openInterest,
        contractMultiplier: snapshot.optionExData?.contractMultiplier },
      quote_source: snapshot.quote_source, quote_received_at: snapshot.quote_received_at,
      bid_ask_source: snapshot.bid_ask_source, bid_ask_received_at: snapshot.bid_ask_received_at,
      order_book: snapshot.order_book,
    },
  };
}

export function create_replay_recorder(file, { write = null } = {}) {
  let queue = Promise.resolve();
  let pending = 0, written = 0, dropped = 0, error = null;
  const save = write || (async (records) => {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  });
  return {
    record(records) {
      const rows = records.filter(Boolean);
      if (!rows.length) return;
      if (pending >= 4) { dropped += rows.length; return; }
      pending += 1;
      queue = queue.then(() => save(rows)).then(() => { written += rows.length; error = null; })
        .catch(() => { dropped += rows.length; error = 'replay_write_failed'; })
        .finally(() => { pending -= 1; });
    },
    status: () => ({ written, dropped, pending, error }),
    idle: () => queue,
  };
}

// Reuse the production EXIT PLANNER only. No broker execution function is called.
// A modeled exit is an immediate fill at the planner's bid-minus-buffer estimate.
export function replay_exit_variant({ row, variant, samples, config, max_gap_ms = 45_000 }) {
  const entry = Date.parse(row.entry_filled_at || row.entry_submitted_at);
  const qty = number(variant.allocated_entry_qty);
  const price = number(row.entry_fill_price);
  const empty = (reason, more = {}) => ({ status: 'incomplete', reason, ...more });
  if (!Number.isFinite(entry) || !(qty > 0) || !(price > 0)) return empty('entry_missing');
  const sorted = [...samples].filter((s) => s.plan_id === row.plan_id
    && s.code === row.code && Date.parse(s.evaluated_at) >= entry)
    .sort((a, b) => Date.parse(a.evaluated_at) - Date.parse(b.evaluated_at));
  if (!sorted.length) return empty('no_recorded_quote_path');
  let position = {
    business_line: 'zero-dte-options', strategy: config.policy.strategy.id,
    plan_id: row.plan_id, code: row.code, expiration: row.expiration,
    filled_qty: qty, exited_qty: 0, pending_exit_qty: 0, entry_fill_price: price,
    entry_filled_at: new Date(entry).toISOString(), direction: row.direction,
    invalidation_price: row.invalidation_price, target_price: row.target_price,
    setup_type: row.setup_type, peak_option_return_pct: null, breakeven_armed: false,
  };
  const fills = [];
  let prior = entry, last = null, proceeds = 0, mfe = -Infinity, mae = Infinity;
  const multiplier = number(row.contract_multiplier) || 100;
  for (const sample of sorted) {
    const at = Date.parse(sample.evaluated_at);
    if (at === last) continue;
    if (at - prior > max_gap_ms) return empty('quote_path_gap', { gap_ms: at - prior });
    const basic = sample.option_snapshot?.basic;
    const quoteAt = Date.parse(sample.option_snapshot?.bid_ask_received_at
      || sample.option_snapshot?.quote_received_at);
    if (basic?.security?.code !== row.code || !(number(basic?.bidPrice) > 0)
      || !(number(basic?.askPrice) >= number(basic?.bidPrice))
      || !(number(basic?.priceSpread) > 0)
      || !Number.isFinite(quoteAt) || at - quoteAt > max_gap_ms || quoteAt - at > 15_000) {
      return empty('invalid_or_stale_quote');
    }
    if (!(number(sample.underlying_price_usd) > 0)) return empty('underlying_price_missing');
    const plan = buildZeroDteSimulatedExitPlan({
      owned_position: position, option_snapshot: sample.option_snapshot,
      underlying_price_usd: sample.underlying_price_usd,
      config: exit_config_for_variant({ ...config,
        schedule_exit_rule_overrides: sample.schedule_exit_rule_overrides }, variant),
      now: new Date(at),
    });
    const ret = number(plan.management_update?.option_return_pct);
    if (ret !== null) { mfe = Math.max(mfe, ret); mae = Math.min(mae, ret); }
    position = { ...position, ...plan.management_update };
    if (plan.trigger && !plan.gate.passed) return empty('exit_gate_failed');
    if (plan.gate.passed) {
      const exit_price = number(plan.order.price ?? plan.quote?.sell_estimate_price);
      if (!(exit_price > 0)) return empty('exit_price_missing');
      proceeds += exit_price * plan.order.qty * multiplier;
      position.exited_qty += plan.order.qty;
      fills.push({ at: sample.evaluated_at, qty: plan.order.qty, price: exit_price, reason: plan.trigger.reason });
      if (position.exited_qty >= qty) {
        const cost = price * qty * multiplier;
        return { status: 'complete', sample_count: sorted.indexOf(sample) + 1,
          model: 'immediate_fill_at_recorded_bid_minus_buffer', fills,
          cost_usd: round(cost), proceeds_usd: round(proceeds), gross_pnl_usd: round(proceeds - cost),
          invested_return_pct: round((proceeds - cost) / cost * 100),
          observed_mfe_pct: round(mfe), observed_mae_pct: round(mae) };
      }
    }
    prior = at; last = at;
  }
  return empty('path_ends_before_exit', { remaining_qty: qty - position.exited_qty });
}

export function build_exit_replay_report({ state, policy, observations = [], date_et = null, now = new Date() }) {
  const manifest = load_junk_exit_experiment(policy);
  const config = { businessLine: 'zero-dte-options', policyExecutionEnvironment: 'simulate_only',
    policyRealTradingAllowed: false, trdEnv: 0, trdMarket: 2, policy };
  const samplesByPlan = new Map();
  for (const sample of observations) {
    const rows = samplesByPlan.get(sample.plan_id) || [];
    rows.push(sample); samplesByPlan.set(sample.plan_id, rows);
  }
  const groups = new Map();
  const cohorts = [];
  for (const row of Object.values(state.orders || {})) {
    const day = record_trading_date_et(row);
    if (!row.experiment_ledger || (date_et && day !== date_et)) continue;
    const exclusion = trade_day_exclusion(row);
    const details = { plan_id: row.plan_id, date_et: day, code: row.code,
      excluded_reason: exclusion?.reason_code || null,
      replay_lab_url: `https://yehangshe.com/app/replay-lab?ticker=SPX&date=${day}`, lines: [] };
    for (const line of manifest.lines) {
      const variant = row.experiment_ledger.variants?.[line.line_id];
      if (!variant || variant.entry_eligible === false || !(number(variant.allocated_entry_qty) > 0)) continue;
      const multiplier = number(row.contract_multiplier) || 100;
      const complete = variant.allocated_exit_qty === variant.allocated_entry_qty
        && number(variant.allocated_entry_value) > 0 && number(variant.allocated_exit_value) !== null
        && variant.comparison_eligible === true && !exclusion;
      const cost = complete ? variant.allocated_entry_value * multiplier : null;
      const proceeds = complete ? variant.allocated_exit_value * multiplier : null;
      const replay = exclusion ? { status: 'excluded', reason: exclusion.reason_code }
        : replay_exit_variant({ row, variant, samples: samplesByPlan.get(row.plan_id) || [], config });
      details.lines.push({ line_id: line.line_id, frozen_exit_profile: variant.exit_profile,
        actual_comparable: complete, actual_cost_usd: cost, actual_proceeds_usd: proceeds,
        actual_gross_pnl_usd: complete ? round(proceeds - cost) : null, replay });
      const key = `${day}|${line.line_id}`;
      const group = groups.get(key) || { date_et: day, line_id: line.line_id,
        trades: 0, wins: 0, losses: 0, flat: 0, remaining_qty: 0,
        purchase_cost_usd: 0, sale_proceeds_usd: 0, gross_pnl_usd: 0,
        excluded_or_incomplete: 0, replay_complete: 0, replay_incomplete: 0,
        modeled_cost_usd: 0, modeled_gross_pnl_usd: 0 };
      group.remaining_qty += Math.max(0, variant.allocated_entry_qty - variant.allocated_exit_qty
        - (variant.expired_settled_qty || 0));
      if (complete) {
        group.trades += 1; group.purchase_cost_usd += cost; group.sale_proceeds_usd += proceeds;
        group.gross_pnl_usd += proceeds - cost;
        group[proceeds > cost ? 'wins' : proceeds < cost ? 'losses' : 'flat'] += 1;
      } else group.excluded_or_incomplete += 1;
      if (replay.status === 'complete') {
        group.replay_complete += 1; group.modeled_cost_usd += replay.cost_usd;
        group.modeled_gross_pnl_usd += replay.gross_pnl_usd;
      } else group.replay_incomplete += 1;
      groups.set(key, group);
    }
    cohorts.push(details);
  }
  return { schema_version: 1, generated_at: now.toISOString(), observation_only: true,
    scope: 'retained_three_lines_by_us_trading_day', fees_included: false,
    limitations: ['No sum across experiment lines.', 'Historical cohorts use their frozen exit rules.',
      'Modeled fills do not reproduce order queues, broker latency or partial fills.',
      'Missing/stale/gapped quote paths are excluded from modeled returns.',
      'No intrabar extrema or unobserved prices are invented.'],
    groups: [...groups.values()].sort((a, b) => a.date_et.localeCompare(b.date_et)
      || a.line_id.localeCompare(b.line_id)).map((g) => ({ ...g,
      purchase_cost_usd: round(g.purchase_cost_usd), sale_proceeds_usd: round(g.sale_proceeds_usd),
      gross_pnl_usd: round(g.gross_pnl_usd),
      invested_return_pct: g.purchase_cost_usd ? round(g.gross_pnl_usd / g.purchase_cost_usd * 100) : null,
      modeled_gross_pnl_usd: round(g.modeled_gross_pnl_usd),
      modeled_return_pct: g.modeled_cost_usd ? round(g.modeled_gross_pnl_usd / g.modeled_cost_usd * 100) : null,
    })), cohorts };
}
