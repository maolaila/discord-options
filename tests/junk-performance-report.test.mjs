import assert from 'node:assert/strict';
import test from 'node:test';
import { partition_performance_events } from '../packages/business-lines/trade-day-validity.mjs';
import {
  build_junk_performance_report,
  experiment_events_from_runtime_state,
  trading_date_et,
} from '../apps/control-console/junk-performance-report.mjs';

const policy = {
  exit_experiment: {
    lines: [
      {
        line_id: 'control_sl15_tp_off',
        label: 'Control SL15 TP off',
        control: true,
        paper_equity_usd: 10_000,
        catastrophic_stop_loss_pct: 15,
        option_take_profit_enabled: false,
        option_take_profit_pct: 25,
      },
      {
        line_id: 'latest_regime_lifecycle',
        label: 'Regime/lifecycle observation SL15 TP off',
        paper_equity_usd: 10_000,
        entry_profile: 'latest_regime_lifecycle_v1',
        catastrophic_stop_loss_pct: 15,
        option_take_profit_enabled: false,
        option_take_profit_pct: 25,
      },
    ],
  },
};

function entry({ at, plan = 'plan-1', line = 'control_sl15_tp_off', qty = 1, value = 2 }) {
  return {
    event_at: at,
    event: 'experiment_line_entry_allocated',
    plan_id: plan,
    line_id: line,
    qty,
    entry_value: value,
  };
}

function exitProgress({ at, plan = 'plan-1', line = 'control_sl15_tp_off', qty = 1, value = 3 }) {
  return {
    event_at: at,
    event: 'experiment_line_exit_fill_progress',
    plan_id: plan,
    line_id: line,
    qty,
    value,
  };
}

function close({ at, plan = 'plan-1', line = 'control_sl15_tp_off', entryValue = 2, exitValue = 3, pnl = 100 }) {
  return {
    event_at: at,
    event: 'experiment_line_position_closed',
    plan_id: plan,
    cohort_id: `cohort-${plan}`,
    line_id: line,
    code: 'SPXW260901C8000000',
    entry_qty: 1,
    entry_value: entryValue,
    exit_qty: 1,
    exit_value: exitValue,
    realized_pnl_usd: pnl,
  };
}

test('converts UTC timestamps to the US trading date', () => {
  assert.equal(trading_date_et('2026-09-02T01:00:00.000Z'), '2026-09-01');
  assert.equal(trading_date_et('2026-09-02T14:00:00.000Z'), '2026-09-02');
});

test('voided 9/11 is removed from every performance metric and utilization denominator, not from raw data', () => {
  const events = [];
  for (const [date, plan, pnl] of [['2026-09-10', 'valid-before', 100], ['2026-09-11', 'void-loss', -1185],
    ['2026-09-11', 'void-win', 500], ['2026-09-14', 'valid-after', 100]]) {
    events.push(entry({ at: date + 'T13:30:00Z', plan }));
    events.push(exitProgress({ at: date + 'T14:30:00Z', plan }));
    events.push(close({ at: date + 'T14:30:01Z', plan, pnl, entryValue: 12.3, exitValue: 12.3 + pnl / 100 }));
  }
  const before = JSON.stringify(events);
  const report = build_junk_performance_report({ events, policy });
  assert.deepEqual(report.available_dates, ['2026-09-10', '2026-09-14']);
  assert.equal(report.cumulative.session_hours, 13);
  const line = report.cumulative.lines[0];
  assert.equal(line.trade_count, 2); assert.equal(line.win_count, 2); assert.equal(line.loss_count, 0);
  assert.equal(line.gross_pnl_usd, 200); assert.equal(line.purchase_cost_usd, 2460);
  assert.equal(line.sale_proceeds_usd, 2660); assert.equal(line.turnover_return_pct, 8.13);
  assert.equal(line.account_return_pct, 2); assert.equal(line.profit_factor, null);
  assert.equal(report.exclusions.voided_closed_trade_count, 2);
  assert.equal(report.exclusions.voided_event_count, 6);
  assert.equal(report.voided_trading_days[0].date_et, '2026-09-11');
  assert.equal(line.time_weighted_utilization_pct, .308);
  assert.equal(JSON.stringify(events), before);
});

test('void-only data has no performance date but still exposes actual open exposure', () => {
  const events = [entry({ at: '2026-09-12T01:00:00Z' })]; // ET 9/11, not UTC 9/12
  const report = build_junk_performance_report({ events, policy });
  assert.equal(report.latest_date_et, null);
  assert.deepEqual(report.available_dates, []);
  assert.equal(report.exclusions.voided_event_count, 1);
  assert.equal(report.cumulative.lines[0].open_contract_qty, 1);
  assert.equal(partition_performance_events(events).excluded.length, 1);
  const mixed = build_junk_performance_report({ events: [
    entry({ at: '2026-09-10T13:30:00Z', plan: 'other' }), ...events,
  ], policy });
  assert.equal(mixed.cumulative.lines[0].open_contract_qty, 2);
});

test('a voided cohort later recorded on another day is excluded in full', () => {
  const events = [entry({ at: '2026-09-11T14:00:00Z' }),
    close({ at: '2026-09-14T14:00:00Z' })];
  const report = build_junk_performance_report({ events, policy });
  assert.equal(report.exclusions.voided_event_count, 2);
  assert.equal(report.cumulative.lines[0].gross_pnl_usd, 0);
});

test('reports each line independently with account and turnover returns', () => {
  const events = [
    entry({ at: '2026-09-01T13:30:00.000Z' }),
    exitProgress({ at: '2026-09-01T14:30:00.000Z' }),
    close({ at: '2026-09-01T14:30:00.001Z' }),
    entry({ at: '2026-09-01T13:30:00.002Z', line: 'latest_regime_lifecycle' }),
    exitProgress({ at: '2026-09-01T14:30:00.002Z', line: 'latest_regime_lifecycle', value: 1 }),
    close({ at: '2026-09-01T14:30:00.003Z', line: 'latest_regime_lifecycle', exitValue: 1, pnl: -100 }),
  ];
  const report = build_junk_performance_report({ events, policy, generatedAt: new Date('2026-09-02T00:00:00Z') });
  assert.equal(report.latest_date_et, '2026-09-01');
  assert.equal(report.latest_day.lines.length, 2);
  assert.equal('aggregate' in report.latest_day, false);

  const control = report.cumulative.lines.find((line) => line.line_id === 'control_sl15_tp_off');
  assert.deepEqual({
    trades: control.trade_count,
    wins: control.win_count,
    losses: control.loss_count,
    cost: control.purchase_cost_usd,
    proceeds: control.sale_proceeds_usd,
    pnl: control.gross_pnl_usd,
    accountReturn: control.account_return_pct,
    turnoverReturn: control.turnover_return_pct,
    averageEntry: control.average_entry_usd,
    averageEntryRate: control.average_entry_rate_pct,
  }, {
    trades: 1,
    wins: 1,
    losses: 0,
    cost: 200,
    proceeds: 300,
    pnl: 100,
    accountReturn: 1,
    turnoverReturn: 50,
    averageEntry: 200,
    averageEntryRate: 2,
  });
  assert.equal(control.time_weighted_utilization_pct, 0.308);

  const observer = report.cumulative.lines.find((line) => line.line_id === 'latest_regime_lifecycle');
  assert.equal(observer.observation_only, true);
  assert.equal(observer.gross_pnl_usd, -100);
  assert.equal(observer.account_return_pct, -1);
  assert.equal(observer.turnover_return_pct, -50);
});

test('uses only complete priced closes and accepts broker summary as open-position authority', () => {
  const events = [
    entry({ at: '2026-09-01T13:30:00.000Z', plan: 'priced' }),
    exitProgress({ at: '2026-09-01T14:00:00.000Z', plan: 'priced' }),
    close({ at: '2026-09-01T14:00:00.001Z', plan: 'priced' }),
    entry({ at: '2026-09-02T13:30:00.000Z', plan: 'unpriced', value: 4 }),
  ];
  const report = build_junk_performance_report({
    events,
    policy,
    experimentSummary: {
      lines: [{ experiment_line_id: 'control_sl15_tp_off', open_contract_qty: 0 }],
    },
  });
  const control = report.cumulative.lines.find((line) => line.line_id === 'control_sl15_tp_off');
  assert.equal(report.latest_date_et, '2026-09-02');
  assert.equal(report.exclusions.entry_without_priced_close_count, 1);
  assert.equal(control.trade_count, 1);
  assert.equal(control.open_contract_qty, 0);
  assert.equal(control.time_weighted_utilization_pct, 0.077);
});

test('builds an independent MULTI report from its persisted experiment ledger', () => {
  const events = experiment_events_from_runtime_state({
    orders: {
      'multi-plan': {
        plan_id: 'multi-plan',
        code: 'QQQ260908C720000',
        experiment_ledger: {
          cohort_id: 'multi-cohort',
          created_at: '2026-09-08T15:20:14.000Z',
          updated_at: '2026-09-08T15:33:41.000Z',
          variants: {
            control_sl15_tp_off: {
              line_id: 'control_sl15_tp_off',
              status: 'closed',
              allocated_entry_qty: 4,
              allocated_entry_value: 2,
              allocated_exit_qty: 4,
              allocated_exit_value: 1.6,
              realized_pnl_usd: -40,
            },
          },
        },
      },
    },
  });
  const report = build_junk_performance_report({
    events,
    policy,
    title: 'JUNKMAN-MULTI 收益报表',
    source: 'logs/junk-multi-options-runtime-state.json',
    businessLine: 'junk-multi-options',
  });
  const control = report.latest_day.lines.find((line) => line.line_id === 'control_sl15_tp_off');
  assert.equal(events.length, 3);
  assert.equal(report.business_line, 'junk-multi-options');
  assert.equal(report.latest_date_et, '2026-09-08');
  assert.equal(control.trade_count, 1);
  assert.equal(control.purchase_cost_usd, 200);
  assert.equal(control.sale_proceeds_usd, 160);
  assert.equal(control.gross_pnl_usd, -40);
  assert.equal(control.turnover_return_pct, -20);
});
