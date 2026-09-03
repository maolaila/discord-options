'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  JUNKMAN_ANALYSIS_AUTHOR_ID,
  JUNKMAN_ANALYSIS_CHANNEL_ID,
  parseJunkmanAnalysisPlan,
  readJunkmanAnalysisPlanSource,
} = require('../packages/option-signals/junkman-analysis-plan.cjs');

function record(content, { id = '100', timestamp = '2026-09-02T13:31:00.000Z', author = JUNKMAN_ANALYSIS_AUTHOR_ID } = {}) {
  return {
    id,
    channel_id: JUNKMAN_ANALYSIS_CHANNEL_ID,
    author: { id: author, username: 'junk_man', bot: false },
    content,
    timestamp,
    captured_at: timestamp,
  };
}

test('parses the current structured analysis post without inventing levels', () => {
  const plan = parseJunkmanAnalysisPlan(record(`
## ⚡ AAPL
> 💵 当前参考价 **326.59**｜🟢 **正 GEX｜钉住/均值回归**
- 🔴 **325** \`CALL WALL\`｜站稳回踩看 **330**
- 🔵 **323** \`FLIP\`｜上方接受偏多
- 🟣 **327.5** \`MAGNET\`｜中心附近不追单
- 🟢 **320** \`PUT WALL\`｜守住看 **327.5**
**🎯 开盘策略｜Flip 上方回踩多**
- 触发｜目标：回踩不破 Flip 上沿 **323.4** 后重新走高｜Call Wall/上行节点 **330**
- 失效｜避免：接受 Flip 下沿 **322.6** 下方｜若紧贴开盘价先等待。
**🎬 三情景｜结构权重**
- 📈 **多头接受 23%**｜**326.59** → **327.5** → **330**
- ↔️ **区间钉住 61%**｜**326.59** → **327.5** → **325**
- 📉 **空头扩张 16%**｜**326.59** → **325** → **323**
`));
  assert.equal(plan.actionable, true);
  assert.equal(plan.session_date_et, '2026-09-02');
  assert.equal(plan.ticker, 'AAPL');
  assert.equal(plan.reference_price_usd, 326.59);
  assert.equal(plan.key_levels.call_wall.lower_usd, 325);
  assert.deepEqual(plan.execution, {
    kind: 'bullish_retest',
    trigger_zone: { lower_usd: 323.4, upper_usd: 323.4 },
    long: { trigger_usd: 323.4, invalidation_usd: 322.6, target_usd: 330 },
  });
  assert.deepEqual(plan.scenarios.map((row) => row.weight_pct), [23, 61, 16]);
});

test('parses two-sided Flip confirmation and rejects the wrong author', () => {
  const content = `
## ⚡ META
> 💵 当前参考价 **576.6174**｜🟡 **正负混合｜方向选择**
**🎯 开盘策略｜Flip 方向确认**
- 触发｜目标：接受 Flip 上沿 **576.8** 做多，或接受下沿 **576** 做空｜向上看 **577.5**；向下看 **575**
- 失效｜避免：突破后重新回到 Flip 区内｜区内来回穿越时等待。
`;
  const plan = parseJunkmanAnalysisPlan(record(content));
  assert.equal(plan.actionable, true);
  assert.deepEqual(plan.execution, {
    kind: 'flip_direction_confirmation',
    trigger_zone: { lower_usd: 576, upper_usd: 576.8 },
    long: { trigger_usd: 576.8, invalidation_usd: 576.8, target_usd: 577.5 },
    bear: { trigger_usd: 576, invalidation_usd: 576, target_usd: 575 },
  });
  assert.equal(parseJunkmanAnalysisPlan(record(content, { author: 'wrong' })), null);
});

test('the daily source keeps only current complete non-reserved detailed plans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'junkman-plan-'));
  const file = path.join(dir, 'plans.ndjson');
  const complete = parseJunkmanAnalysisPlan(record(`
## ⚡ QQQ
> 💵 当前参考价 **706.41**｜🔴 **负 GEX｜放大/加速**
**🎯 开盘策略｜Put Wall 下方接受/反抽空**
- 触发｜目标：反抽 Put Wall **706.76**–**707.24** 受阻并重新走低｜下一下行目的地 **699**
- 失效｜避免：重新接受 Put Wall 上沿 **707.24** 上方｜低开远离时不追空。
`, { id: 'qqq' }));
  const old = { ...complete, event_id: 'old', message_id: 'old', session_date_et: '2026-09-01' };
  const reserved = { ...complete, event_id: 'spx', message_id: 'spx', ticker: 'SPX' };
  fs.writeFileSync(file, [old, reserved, complete].map((row) => JSON.stringify(row)).join('\n'));
  const source = readJunkmanAnalysisPlanSource(file, { session_date_et: '2026-09-02' });
  assert.equal(source.source_status, 'current_session_plans_ready');
  assert.deepEqual(source.seeds.map((row) => row.ticker), ['QQQ']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a newer incomplete edit revokes an older actionable plan for the same ticker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'junkman-plan-edit-'));
  const file = path.join(dir, 'plans.ndjson');
  const complete = parseJunkmanAnalysisPlan(record(`
## ⚡ QQQ
> 💵 当前参考价 **706.41**｜🔴 **负 GEX｜放大/加速**
**🎯 开盘策略｜Put Wall 下方接受/反抽空**
- 触发｜目标：反抽 Put Wall **706.76**–**707.24** 受阻并重新走低｜下一下行目的地 **699**
- 失效｜避免：重新接受 Put Wall 上沿 **707.24** 上方｜低开远离时不追空。
`, { id: 'qqq-edit', timestamp: '2026-09-02T13:31:00.000Z' }));
  const revoked = {
    ...complete,
    event_id: 'newer-incomplete-edit',
    message_timestamp: '2026-09-02T13:32:00.000Z',
    actionable: false,
    execution: null,
    rejection_reasons: ['strategy_execution_unparseable'],
  };
  fs.writeFileSync(file, [complete, revoked].map((row) => JSON.stringify(row)).join('\n'));
  const source = readJunkmanAnalysisPlanSource(file, { session_date_et: '2026-09-02' });
  assert.equal(source.source_status, 'waiting_for_current_session_plans');
  assert.equal(source.seeds.length, 0);
  assert.deepEqual(source.rejected, [{
    message_id: 'qqq-edit',
    ticker: 'QQQ',
    reasons: ['strategy_execution_unparseable'],
  }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
