import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PA_SHARED_LOCK_LEASE_MS,
  PA_SHARED_ORDER_MIN_INTERVAL_MS,
  acquireSharedSnapshotLock,
  brokerOrderKey,
  buildPaRiskOrderView,
  buildPaEntryRemark,
  buildPaExitRemark,
  completeNdjsonChunk,
  evaluatePaAggregateExposure,
  findBrokerOrderByIds,
  getSharedPaOrderSnapshot,
  hasPaEntryAttempt,
  indexBrokerOrders,
  isJunkmanReservedOptionCode,
  isMoomooOptionCode,
  isPaOrderRateLimitError,
  isPotentiallyActiveBrokerOrder,
  materializeAcceptedEntry,
  parseStrictNdjson,
  reconcilePaEntryLedger,
  reconcilePaExitAttempt,
  releaseSharedSnapshotLock,
} from '../apps/options-sim/pa-broker-recovery.mjs';

function entryPlan(overrides = {}) {
  const executionKey = overrides.execution_key || 'pa-options|message-1|AAPL|2026-09-18|200|C';
  return {
    business_line: 'pa-options',
    mode: 'execute_simulate',
    execution_key: executionKey,
    order_status: 'submission_unknown',
    order: {
      side: 'BUY_TO_OPEN',
      code: 'AAPL260918C200000',
      qty: 2,
      price: 3.1,
      remark: buildPaEntryRemark(executionKey),
    },
    ...overrides,
  };
}

function brokerOrder(overrides = {}) {
  return {
    orderID: '10001',
    orderIDEx: 'EX-10001',
    orderStatus: 5,
    trdSide: 1,
    code: 'AAPL260918C200000',
    qty: 2,
    fillQty: 0,
    remark: buildPaEntryRemark('pa-options|message-1|AAPL|2026-09-18|200|C'),
    ...overrides,
  };
}

test('accepted-then-timeout entry is materialized from exact broker identity and never retried', () => {
  const plan = entryPlan();
  const order = brokerOrder();
  const result = reconcilePaEntryLedger({ executionRows: [plan], brokerOrders: [order] });
  assert.equal(result.materializations.length, 1);
  assert.equal(result.unresolved.length, 0);

  const submitted = materializeAcceptedEntry(plan, order, new Date('2026-08-14T00:00:00Z'));
  assert.equal(submitted.order_status, 'submitted');
  assert.equal(submitted.execution.response.s2c.orderID, '10001');
  assert.equal(submitted.execution.response.s2c.orderIDEx, 'EX-10001');
  assert.equal(hasPaEntryAttempt([plan, submitted], plan.execution_key), true);
  assert.equal(reconcilePaEntryLedger({ executionRows: [plan, submitted], brokerOrders: [order] }).materializations.length, 0);
});

test('entry recovery supports a broker order that has only orderID', () => {
  const plan = entryPlan();
  const order = brokerOrder({ orderIDEx: undefined });
  const result = reconcilePaEntryLedger({ executionRows: [plan], brokerOrders: [order] });
  assert.equal(result.materializations.length, 1);
  const submitted = materializeAcceptedEntry(plan, order);
  assert.equal(submitted.execution.response.s2c.orderID, '10001');
  assert.equal('orderIDEx' in submitted.execution.response.s2c, false);
  assert.equal(brokerOrderKey(order), '10001');
});

test('missing or timeout broker evidence remains unresolved and blocks all new PA entries', () => {
  const plan = entryPlan();
  const absent = reconcilePaEntryLedger({ executionRows: [plan], brokerOrders: [] });
  assert.equal(absent.entry_allowed, false);
  assert.equal(absent.unresolved[0].reason, 'broker_order_absent_cannot_infer_rejection');

  const timeoutWithoutIdentity = reconcilePaEntryLedger({
    executionRows: [plan],
    brokerOrders: [brokerOrder({ orderID: '', orderIDEx: '', orderStatus: 4 })],
  });
  assert.equal(timeoutWithoutIdentity.entry_allowed, false);
  assert.equal(timeoutWithoutIdentity.unresolved[0].reason, 'broker_order_identity_missing_or_unknown');
});

test('broker pa_entry remark without a local ledger is a global fail-closed blocker', () => {
  const result = reconcilePaEntryLedger({ executionRows: [], brokerOrders: [brokerOrder()] });
  assert.equal(result.entry_allowed, false);
  assert.equal(result.orphan_broker_orders.length, 1);
  assert.deepEqual(result.blocked_reasons, ['broker_pa_entry_without_local_ledger:1']);
});

test('PA aggregate exposure recognizes low-strike moomoo codes and excludes JUNK SPXW ownership', () => {
  assert.equal(isMoomooOptionCode('ALC260821C75000'), true);
  assert.equal(isMoomooOptionCode('TE260918C12000'), true);
  assert.equal(isMoomooOptionCode('META260814C620000'), true);
  assert.equal(isMoomooOptionCode('AAPL'), false);
  assert.equal(isJunkmanReservedOptionCode('SPXW260814P6400000'), true);
  assert.equal(isJunkmanReservedOptionCode('AAPL260918C200000'), false);

  const exposure = evaluatePaAggregateExposure({
    positions: [
      { code: 'ALC260821C75000', qty: 20, costPrice: 2 },
      { code: 'SPXW260814P6400000', qty: 1, costPrice: 80 },
    ],
    orders: [
      { orderID: 'PENDING', orderStatus: 5, trdSide: 1, code: 'TE260918C12000', qty: 10, fillQty: 0, price: 3 },
      { orderID: 'CANCELLED', orderStatus: 15, trdSide: 1, code: 'META260814C620000', qty: 99, fillQty: 0, price: 9 },
    ],
    code: 'AAPL260918C200000',
    requestedNotionalUsd: 3_500,
    paperEquityUsd: 10_000,
  });
  assert.equal(exposure.existing_exposure_usd, 7_000);
  assert.equal(exposure.projected_exposure_usd, 10_500);
  assert.equal(exposure.passed, false);
  assert.ok(exposure.reasons.includes('pa_total_exposure_above_10000'));
});

test('aggregate risk rejects same-contract duplication and unknown PA option cost', () => {
  const exposure = evaluatePaAggregateExposure({
    positions: [
      { code: 'AAPL260918C200000', qty: 1, costPrice: 2 },
      { code: 'ALC260821C75000', qty: 1, costPrice: null },
    ],
    orders: [],
    code: 'AAPL260918C200000',
    requestedNotionalUsd: 1_000,
    paperEquityUsd: 10_000,
  });
  assert.equal(exposure.passed, false);
  assert.ok(exposure.reasons.includes('broker_contract_position_already_exists'));
  assert.ok(exposure.reasons.includes('broker_option_position_cost_unavailable'));
});

test('recent locally accepted entry reserves exposure until the shared broker snapshot contains it', () => {
  const nowMs = Date.parse('2026-08-14T01:00:00Z');
  const submitted = entryPlan({
    order_status: 'submitted',
    execution: {
      submitted_at: new Date(nowMs - 1_000).toISOString(),
      response: { s2c: { orderID: 'LOCAL-1' } },
    },
  });
  const reserved = buildPaRiskOrderView({ brokerOrders: [], executionRows: [submitted], nowMs });
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0]._pa_local_reservation, true);
  assert.equal(evaluatePaAggregateExposure({
    positions: [],
    orders: reserved,
    code: 'MSFT260918C500000',
    requestedNotionalUsd: 9_500,
    paperEquityUsd: 10_000,
  }).passed, false);

  const visible = brokerOrder({ orderID: 'LOCAL-1', orderIDEx: undefined });
  const deduplicated = buildPaRiskOrderView({ brokerOrders: [visible], executionRows: [submitted], nowMs });
  assert.equal(deduplicated.length, 1);
  assert.equal(deduplicated[0]._pa_local_reservation, undefined);

  const expired = buildPaRiskOrderView({
    brokerOrders: [],
    executionRows: [submitted],
    nowMs: nowMs + 5 * 60_000 + 1,
  });
  assert.deepEqual(expired, []);
});

test('only explicit terminal unfilled broker status concludes an unknown entry', () => {
  const plan = entryPlan();
  const terminal = reconcilePaEntryLedger({
    executionRows: [plan],
    brokerOrders: [brokerOrder({ orderStatus: 15, fillQty: 0 })],
  });
  assert.equal(terminal.terminalizations.length, 1);
  assert.equal(terminal.unresolved.length, 0);

  const partialCancelled = reconcilePaEntryLedger({
    executionRows: [plan],
    brokerOrders: [brokerOrder({ orderStatus: 14, fillQty: 1 })],
  });
  assert.equal(partialCancelled.materializations.length, 1);
  assert.equal(partialCancelled.terminalizations.length, 0);
  assert.equal(isPotentiallyActiveBrokerOrder(brokerOrder({ orderStatus: 5 })), true);
  assert.equal(isPotentiallyActiveBrokerOrder(brokerOrder({ orderStatus: 11, fillQty: 2 })), false);
});

test('exit submission unknown binds an accepted order by exact remark, side, code and qty', () => {
  const state = {
    status: 'exit_submission_unknown',
    exit_attempt: 1,
    exit_remark: 'pa_exit:old-compatible:a1',
    exit_qty: 2,
  };
  const order = brokerOrder({
    orderID: 'SELL-1',
    orderIDEx: undefined,
    trdSide: 2,
    remark: state.exit_remark,
  });
  const result = reconcilePaExitAttempt({ stateRow: state, brokerOrders: [order], code: order.code });
  assert.equal(result.resolution, 'accepted');
  assert.equal(result.state.status, 'exit_submitted');
  assert.equal(result.state.exit_order_id, 'SELL-1');
  assert.equal(result.state.exit_order_id_ex, null);

  const index = indexBrokerOrders([order]);
  assert.equal(findBrokerOrderByIds(index, { order_id: 'SELL-1' }), order);
});

test('exit absence never means rejection, while explicit terminal unfilled permits a unique next attempt', () => {
  const state = {
    status: 'exit_intent',
    exit_attempt: 1,
    exit_remark: 'pa_exit:first:a1',
    exit_qty: 2,
  };
  const absent = reconcilePaExitAttempt({ stateRow: state, brokerOrders: [], code: 'AAPL260918C200000' });
  assert.equal(absent.resolution, 'unresolved');
  assert.equal(absent.reason, 'broker_exit_absent_cannot_infer_rejection');

  const terminalOrder = brokerOrder({
    trdSide: 2,
    remark: state.exit_remark,
    orderStatus: 21,
    fillQty: 0,
  });
  const terminal = reconcilePaExitAttempt({
    stateRow: state,
    brokerOrders: [terminalOrder],
    code: terminalOrder.code,
  });
  assert.equal(terminal.resolution, 'terminal_unfilled');
  assert.equal(terminal.state.status, 'monitoring');
  assert.equal(terminal.state.exit_attempt, 1);
  const nextRemark = buildPaExitRemark({ executionKey: 'exec-1', buyOrderKey: 'BUY-1', attempt: 2 });
  assert.notEqual(nextRemark, state.exit_remark);
  assert.match(nextRemark, /^pa_exit:/);
});

test('old locally persisted remarks remain valid but near matches are rejected', () => {
  const plan = entryPlan({
    order: {
      side: 'BUY_TO_OPEN',
      code: 'AAPL260918C200000',
      qty: 2,
      price: 3.1,
      remark: 'discord:legacy123456',
    },
  });
  const exact = brokerOrder({ remark: 'discord:legacy123456' });
  assert.equal(reconcilePaEntryLedger({ executionRows: [plan], brokerOrders: [exact] }).materializations.length, 1);

  const near = brokerOrder({ remark: 'discord:legacy123457' });
  const result = reconcilePaEntryLedger({ executionRows: [plan], brokerOrders: [near] });
  assert.equal(result.materializations.length, 0);
  assert.equal(result.unresolved[0].reason, 'broker_order_absent_cannot_infer_rejection');
});

test('a legacy remark shared by two local execution keys is ambiguous and never binds either order', () => {
  const first = entryPlan({
    execution_key: 'legacy-exec-1',
    order: { side: 'BUY_TO_OPEN', code: 'AAPL260918C200000', qty: 2, price: 3.1, remark: 'discord:collision' },
  });
  const second = entryPlan({
    execution_key: 'legacy-exec-2',
    order: { side: 'BUY_TO_OPEN', code: 'AAPL260918C200000', qty: 2, price: 3.1, remark: 'discord:collision' },
  });
  const result = reconcilePaEntryLedger({
    executionRows: [first, second],
    brokerOrders: [brokerOrder({ remark: 'discord:collision' })],
  });
  assert.equal(result.materializations.length, 0);
  assert.equal(result.unresolved.length, 2);
  assert.ok(result.unresolved.every((row) => row.reason === 'local_submission_remark_not_unique'));
});

test('cursor chunk consumes only complete newline-terminated NDJSON records', () => {
  const first = `${JSON.stringify({ id: 1 })}\n`;
  const partial = '{"id":2';
  const chunk = completeNdjsonChunk(Buffer.from(first + partial));
  assert.equal(chunk.text, first);
  assert.equal(chunk.consumed_bytes, Buffer.byteLength(first));
  assert.equal(chunk.partial_tail_bytes, Buffer.byteLength(partial));
  assert.deepEqual(parseStrictNdjson(chunk.text, 'cursor-test'), [{ id: 1 }]);

  const noNewline = completeNdjsonChunk(Buffer.from(partial));
  assert.equal(noNewline.consumed_bytes, 0);
  assert.equal(noNewline.partial_tail_bytes, Buffer.byteLength(partial));
});

test('corrupt durable NDJSON fails closed instead of skipping a damaged row', () => {
  assert.throws(
    () => parseStrictNdjson('{"ok":true}\n{"broken":', 'ledger.ndjson'),
    /ledger\.ndjson:2 is not valid JSON/,
  );
});

test('entry and exit loops share one account-level broker snapshot within the PA rate budget', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-order-snapshot-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const snapshotPath = path.join(tempDir, 'orders.json');
  let clock = 0;
  let fetchCount = 0;
  const fetchOrders = async () => {
    fetchCount += 1;
    return [brokerOrder({ orderID: String(fetchCount), orderIDEx: `EX-${fetchCount}` })];
  };
  const invoke = (overrides = {}) => getSharedPaOrderSnapshot({
    snapshotPath,
    fetchOrders,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    ...overrides,
  });

  const first = await invoke({ maxAgeMs: 30_000 });
  assert.equal(first.ok, true);
  assert.equal(first.source, 'broker');
  assert.equal(fetchCount, 1);

  // Simulate repeated entry and exit cycles; they must reuse one snapshot.
  for (clock = 500; clock <= 8_000; clock += 500) {
    const cached = await invoke({ maxAgeMs: 8_000 });
    assert.equal(cached.ok, true);
  }
  assert.equal(fetchCount, 1);

  // An active-position exit refreshes at the shared permit, 11 seconds after
  // the prior call, which is below the required 15-second broker-first delay.
  clock = 9_000;
  const activeRefresh = await invoke({ maxAgeMs: 8_000, waitForPermit: true, maxWaitMs: 15_000 });
  assert.equal(activeRefresh.ok, true);
  assert.equal(activeRefresh.source, 'broker');
  assert.equal(clock, PA_SHARED_ORDER_MIN_INTERVAL_MS);
  assert.equal(fetchCount, 2);

  clock = 20_000;
  const nextActiveRefresh = await invoke({ maxAgeMs: 8_000, waitForPermit: true, maxWaitMs: 15_000 });
  assert.equal(nextActiveRefresh.ok, true);
  assert.equal(clock, PA_SHARED_ORDER_MIN_INTERVAL_MS * 2);
  assert.equal(fetchCount, 3);

  // Across arbitrarily many local loops in the first 30 seconds, PA consumes
  // only three GetOrderList calls, leaving capacity for the JUNK process.
  for (clock = 22_500; clock < 30_000; clock += 500) {
    const cached = await invoke({ maxAgeMs: 8_000 });
    assert.equal(cached.ok, true);
  }
  assert.equal(fetchCount, 3);
});

test('a new submission timestamp forces a post-intent broker refresh before reconciliation', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-order-post-intent-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const snapshotPath = path.join(tempDir, 'orders.json');
  let clock = 100_000;
  let fetchCount = 0;
  const fetchOrders = async () => {
    fetchCount += 1;
    return [];
  };
  const common = {
    snapshotPath,
    fetchOrders,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };

  await getSharedPaOrderSnapshot({ ...common, maxAgeMs: 30_000 });
  const intentPersistedAt = clock + 1_000;
  clock = intentPersistedAt;
  const reconciled = await getSharedPaOrderSnapshot({
    ...common,
    maxAgeMs: 30_000,
    notBeforeMs: intentPersistedAt,
    waitForPermit: true,
    maxWaitMs: 15_000,
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.source, 'broker');
  assert.equal(fetchCount, 2);
  assert.ok(reconciled.fetched_at_ms >= intentPersistedAt);
  assert.ok(clock - intentPersistedAt < 15_000);
});

test('GetOrderList rate-limit and transient errors degrade with bounded backoff and never imply broker absence', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-order-backoff-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const snapshotPath = path.join(tempDir, 'orders.json');
  let clock = 200_000;
  let fetchCount = 0;
  let mode = 'success';
  const priorOrder = brokerOrder({ orderID: 'PRIOR', orderIDEx: 'PRIOR-EX' });
  const fetchOrders = async () => {
    fetchCount += 1;
    if (mode === 'rate') throw new Error('retType=-1 \u67e5\u8be2\u672a\u5b8c\u6210\u8ba2\u5355\u9891\u7387\u592a\u9ad8');
    if (mode === 'transient') throw new Error('OpenD connection reset');
    return [priorOrder];
  };
  const invoke = (overrides = {}) => getSharedPaOrderSnapshot({
    snapshotPath,
    fetchOrders,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    ...overrides,
  });

  assert.equal((await invoke()).ok, true);
  mode = 'rate';
  clock += 12_000;
  const rateLimited = await invoke({ maxAgeMs: 8_000 });
  assert.equal(rateLimited.ok, false);
  assert.equal(rateLimited.reason, 'get_order_list_rate_limited');
  assert.deepEqual(rateLimited.orders, [priorOrder]);
  assert.equal(isPaOrderRateLimitError(new Error('retType=-1 \u9891\u7387\u592a\u9ad8')), true);
  const callsAfterRateLimit = fetchCount;

  // Even though cached rows exist, the failed refresh stays explicitly
  // degraded during backoff and cannot be interpreted as a successful absence.
  clock += 10_000;
  const duringRateBackoff = await invoke({ maxAgeMs: 30_000 });
  assert.equal(duringRateBackoff.ok, false);
  assert.equal(duringRateBackoff.source, 'backoff');
  assert.deepEqual(duringRateBackoff.orders, [priorOrder]);
  assert.equal(fetchCount, callsAfterRateLimit);

  // At the bounded retry point a successful read clears degradation.
  mode = 'success';
  clock += 20_000;
  const recovered = await invoke({ maxAgeMs: 30_000 });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.source, 'broker');
  assert.equal(fetchCount, callsAfterRateLimit + 1);

  mode = 'transient';
  clock += 12_000;
  const transient = await invoke({ maxAgeMs: 8_000 });
  assert.equal(transient.ok, false);
  assert.equal(transient.reason, 'get_order_list_transient_error');
  const callsAfterTransient = fetchCount;
  clock += 4_999;
  assert.equal((await invoke({ maxAgeMs: 30_000 })).ok, false);
  assert.equal(fetchCount, callsAfterTransient);
  mode = 'success';
  clock += 1;
  const cadenceStillHeld = await invoke({ maxAgeMs: 30_000 });
  assert.equal(cadenceStillHeld.ok, false);
  assert.equal(fetchCount, callsAfterTransient);
  clock += PA_SHARED_ORDER_MIN_INTERVAL_MS - 5_000;
  assert.equal((await invoke({ maxAgeMs: 30_000 })).ok, true);
  assert.equal(fetchCount, callsAfterTransient + 1);
});

test('concurrent PA consumers coalesce onto one broker read through the shared lock', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-order-lock-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const snapshotPath = path.join(tempDir, 'orders.json');
  let fetchCount = 0;
  let releaseFetch;
  const fetchBarrier = new Promise((resolve) => { releaseFetch = resolve; });
  const first = getSharedPaOrderSnapshot({
    snapshotPath,
    maxAgeMs: 30_000,
    fetchOrders: async () => {
      fetchCount += 1;
      await fetchBarrier;
      return [];
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = getSharedPaOrderSnapshot({
    snapshotPath,
    maxAgeMs: 30_000,
    waitForPermit: true,
    maxWaitMs: 1_000,
    fetchOrders: async () => {
      fetchCount += 1;
      return [];
    },
  });
  releaseFetch();
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(fetchCount, 1);
  assert.ok(['peer_cache', 'cache', 'cache_after_lock'].includes(results[1].source));
});

test('an old lock mtime never permits a second broker read while the owner lease is live', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-order-live-lease-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const snapshotPath = path.join(tempDir, 'orders.json');
  const lockPath = `${snapshotPath}.lock`;
  const now = () => Date.now();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const owner = await acquireSharedSnapshotLock({
    lockPath,
    snapshotPath,
    fsApi: fs,
    now,
    sleep,
    maxWaitMs: 0,
    maxAgeMs: 0,
    notBeforeMs: Number.NEGATIVE_INFINITY,
  });
  const deliberatelyOld = new Date(Date.now() - PA_SHARED_LOCK_LEASE_MS * 3);
  await fs.utimes(lockPath, deliberatelyOld, deliberatelyOld);
  await fs.utimes(owner.ownerPath, deliberatelyOld, deliberatelyOld);
  let brokerCalls = 0;
  const contender = await getSharedPaOrderSnapshot({
    snapshotPath,
    lockPath,
    maxAgeMs: 0,
    fetchOrders: async () => {
      brokerCalls += 1;
      return [];
    },
  });
  assert.equal(contender.ok, false);
  assert.equal(contender.reason, 'shared_order_snapshot_lock_busy');
  assert.equal(brokerCalls, 0);
  assert.equal(await releaseSharedSnapshotLock(owner), true);
});

test('an old owner finally cannot delete a replacement owners token or lock directory', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-order-owner-token-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const snapshotPath = path.join(tempDir, 'orders.json');
  const lockPath = `${snapshotPath}.lock`;
  const common = {
    lockPath,
    snapshotPath,
    fsApi: fs,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxWaitMs: 0,
    maxAgeMs: 0,
    notBeforeMs: Number.NEGATIVE_INFINITY,
  };
  const ownerA = await acquireSharedSnapshotLock(common);
  const quarantinedA = `${lockPath}.stale-test-a`;
  await fs.rename(lockPath, quarantinedA);
  const ownerB = await acquireSharedSnapshotLock(common);

  assert.notEqual(ownerA.token, ownerB.token);
  assert.equal(await releaseSharedSnapshotLock(ownerA), false);
  assert.equal(JSON.parse(await fs.readFile(ownerB.ownerPath, 'utf8')).token, ownerB.token);
  const contenderC = await acquireSharedSnapshotLock(common);
  assert.equal(contenderC, null);
  assert.equal(await releaseSharedSnapshotLock(ownerB), true);
  await fs.rm(quarantinedA, { recursive: true, force: true });
});

test('snapshot persist failure retains process and cross-process permits so an immediate retry cannot call broker', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-order-persist-gate-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const snapshotPath = path.join(tempDir, 'orders.json');
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'rename') {
        return async (source, destination) => {
          if (destination === snapshotPath) {
            const error = new Error('injected snapshot rename failure');
            error.code = 'EIO';
            throw error;
          }
          return target.rename(source, destination);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let brokerCalls = 0;
  const fetchOrders = async () => {
    brokerCalls += 1;
    return [];
  };
  const first = await getSharedPaOrderSnapshot({ snapshotPath, fetchOrders, fsApi: failingFs });
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'shared_order_snapshot_persist_error');
  assert.equal(brokerCalls, 1);

  const sameProcess = await getSharedPaOrderSnapshot({ snapshotPath, fetchOrders, fsApi: failingFs });
  assert.equal(sameProcess.ok, false);
  assert.equal(brokerCalls, 1);

  // A fresh module instance has no in-memory state and therefore proves that
  // the separately persisted permit also protects another process.
  const peerModule = await import(`../apps/options-sim/pa-broker-recovery.mjs?peer=${Date.now()}`);
  const peer = await peerModule.getSharedPaOrderSnapshot({ snapshotPath, fetchOrders, fsApi: fs });
  assert.equal(peer.ok, false);
  assert.equal(peer.reason, 'shared_order_snapshot_refresh_deferred');
  assert.equal(brokerCalls, 1);
});

test('GetOrderList has a hard timeout shorter than the lock lease and timeout never triggers an immediate retry', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-order-timeout-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const snapshotPath = path.join(tempDir, 'orders.json');
  let brokerCalls = 0;
  const neverReturns = async () => {
    brokerCalls += 1;
    return new Promise(() => {});
  };
  const startedAt = Date.now();
  const timedOut = await getSharedPaOrderSnapshot({
    snapshotPath,
    fetchOrders: neverReturns,
    fetchTimeoutMs: 25,
    lockLeaseMs: 250,
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, 'get_order_list_timeout');
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(brokerCalls, 1);
  assert.equal((await getSharedPaOrderSnapshot({
    snapshotPath,
    fetchOrders: neverReturns,
    fetchTimeoutMs: 25,
    lockLeaseMs: 250,
  })).ok, false);
  assert.equal(brokerCalls, 1);
});
