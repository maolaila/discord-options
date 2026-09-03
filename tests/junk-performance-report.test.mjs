import assert from 'node:assert/strict';
import test from 'node:test';
import {
  build_junk_performance_report,
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
