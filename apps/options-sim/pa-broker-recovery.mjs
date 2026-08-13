import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const PA_ENTRY_REMARK_PREFIX = 'pa_entry:';
export const PA_EXIT_REMARK_PREFIX = 'pa_exit:';

const ENTRY_ATTEMPT_STATUSES = new Set([
  'submission_intent',
  'submission_unknown',
  'submitted',
  'submission_terminal_unfilled',
]);

// Moomoo Trd_Common.OrderStatus values which prove that no valid position was
// created, provided the broker also reports fillQty=0. Missing orders, timeout
// status (4), and unknown status (-1) are deliberately not proof of rejection.
const EXPLICIT_TERMINAL_UNFILLED_STATUSES = new Set([3, 15, 21, 22, 23, 24]);
const TERMINAL_ORDER_STATUSES = new Set([3, 11, 14, 15, 21, 22, 23, 24]);
export const PA_SHARED_ORDER_MIN_INTERVAL_MS = 11_000;
export const PA_SHARED_ORDER_FETCH_TIMEOUT_MS = 8_000;
export const PA_SHARED_LOCK_LEASE_MS = 20_000;
const PA_SHARED_LOCK_RENEW_CHUNK_MS = 3_000;
const PA_SHARED_STALE_CONFIRM_MS = 50;
const processOrderPermitState = new Map();

function normalizedString(value) {
  return String(value ?? '').trim();
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stableDigest(value, length = 28) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, length);
}

function errorMessage(error) {
  return String(error?.retMsg || error?.message || error || 'unknown error');
}

export function isPaOrderRateLimitError(error) {
  const message = errorMessage(error);
  return /rate.?limit|too many|frequency|query.*(?:unfinished|not.*complete)|\u9891\u7387|\u67e5\u8be2.*\u672a\u5b8c\u6210/i.test(message);
}

function snapshotAgeMs(snapshot, nowMs) {
  const fetchedAtMs = finiteNumber(snapshot?.fetched_at_ms) ?? Date.parse(snapshot?.fetched_at || '');
  return Number.isFinite(fetchedAtMs) ? Math.max(0, nowMs - fetchedAtMs) : Number.POSITIVE_INFINITY;
}

function usableSharedSnapshot(snapshot, { nowMs, maxAgeMs, notBeforeMs }) {
  if (!snapshot || !Array.isArray(snapshot.orders)) return false;
  // A failed refresh marks the account-level snapshot degraded until a later
  // broker read succeeds. Do not silently turn a cached pre-error view back
  // into affirmative evidence while the caller is reconciling an unknown.
  if (snapshot.last_error) return false;
  const fetchedAtMs = finiteNumber(snapshot.fetched_at_ms) ?? Date.parse(snapshot.fetched_at || '');
  if (!Number.isFinite(fetchedAtMs)) return false;
  if (snapshotAgeMs(snapshot, nowMs) > maxAgeMs) return false;
  if (Number.isFinite(notBeforeMs) && fetchedAtMs < notBeforeMs) return false;
  return true;
}

async function readSharedSnapshot(snapshotPath, fsApi = fsp) {
  try {
    return JSON.parse(await fsApi.readFile(snapshotPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { corrupt_error: errorMessage(error) };
  }
}

async function writeSharedSnapshot(snapshotPath, payload, fsApi = fsp) {
  await fsApi.mkdir(path.dirname(snapshotPath), { recursive: true });
  const tmp = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
  let renamed = false;
  const handle = await fsApi.open(tmp, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await handle.sync?.();
  } finally {
    await handle.close();
  }
  try {
    await fsApi.rename(tmp, snapshotPath);
    renamed = true;
  } finally {
    if (!renamed) {
      try { await fsApi.unlink(tmp); } catch { }
    }
  }
}

function lockOwnerPath(lockPath, token) {
  return path.join(lockPath, `owner-${token}.json`);
}

function lockOwnerPayload(lock, nowMs, leaseMs) {
  return {
    version: 1,
    token: lock.token,
    pid: process.pid,
    acquired_at_ms: lock.acquired_at_ms,
    updated_at_ms: nowMs,
    lease_until_ms: nowMs + leaseMs,
    sequence: (lock.sequence || 0) + 1,
  };
}

async function createSharedSnapshotLock({ lockPath, fsApi, now, leaseMs }) {
  await fsApi.mkdir(path.dirname(lockPath), { recursive: true });
  await fsApi.mkdir(lockPath);
  const token = `${process.pid}-${randomUUID()}`;
  const acquiredAtMs = now();
  const lock = {
    lockPath,
    token,
    ownerPath: lockOwnerPath(lockPath, token),
    acquired_at_ms: acquiredAtMs,
    sequence: 0,
    fsApi,
    now,
    leaseMs,
  };
  try {
    const payload = lockOwnerPayload(lock, acquiredAtMs, leaseMs);
    await fsApi.writeFile(lock.ownerPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'wx' });
    lock.sequence = payload.sequence;
    return lock;
  } catch (error) {
    try { await fsApi.rmdir(lockPath); } catch { }
    throw error;
  }
}

async function readSharedLockInspection(lockPath, fsApi) {
  try {
    const names = (await fsApi.readdir(lockPath)).filter((name) => /^owner-.+\.json$/.test(String(name))).sort();
    const owners = [];
    for (const name of names) {
      const ownerPath = path.join(lockPath, name);
      try {
        const raw = await fsApi.readFile(ownerPath, 'utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { }
        let mtimeMs = 0;
        try { mtimeMs = (await fsApi.stat(ownerPath)).mtimeMs; } catch { }
        owners.push({ name, raw, parsed, mtime_ms: mtimeMs });
      } catch (error) {
        if (error?.code !== 'ENOENT') owners.push({ name, raw: `read-error:${errorMessage(error)}`, parsed: null });
      }
    }
    const stat = await fsApi.stat(lockPath);
    return {
      exists: true,
      owners,
      mtime_ms: Math.max(stat.mtimeMs, ...owners.map((owner) => owner.mtime_ms || 0)),
      fingerprint: owners.map(({ name, raw, mtime_ms: mtimeMs }) => `${name}:${mtimeMs}:${raw}`).join('|'),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, owners: [], fingerprint: '' };
    throw error;
  }
}

function sharedLockInspectionExpired(inspection, nowMs, leaseMs) {
  if (!inspection.exists) return false;
  if (inspection.owners.some(({ parsed }) => finiteNumber(parsed?.lease_until_ms) > nowMs)) return false;
  if (inspection.owners.some(({ parsed }) => !parsed || finiteNumber(parsed?.lease_until_ms) === null)
    && nowMs - inspection.mtime_ms <= leaseMs) return false;
  if (inspection.owners.length === 0 && nowMs - inspection.mtime_ms <= leaseMs) return false;
  return true;
}

async function tryReclaimExpiredSharedLock({ lockPath, fsApi, now, sleep, leaseMs }) {
  const first = await readSharedLockInspection(lockPath, fsApi);
  if (!sharedLockInspectionExpired(first, now(), leaseMs)) return false;
  await sleep(PA_SHARED_STALE_CONFIRM_MS);
  const second = await readSharedLockInspection(lockPath, fsApi);
  if (!second.exists
    || second.fingerprint !== first.fingerprint
    || second.mtime_ms !== first.mtime_ms
    || !sharedLockInspectionExpired(second, now(), leaseMs)) return false;
  const quarantinePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    // The rename is the ownership transition. Cleanup touches only the unique
    // quarantine path, never a replacement lock created at the original path.
    await fsApi.rename(lockPath, quarantinePath);
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) return false;
    throw error;
  }
  try { await fsApi.rm(quarantinePath, { recursive: true, force: true }); } catch { }
  return true;
}

export async function renewSharedSnapshotLock(lock) {
  const { fsApi, now, leaseMs } = lock;
  let current = null;
  try {
    current = JSON.parse(await fsApi.readFile(lock.ownerPath, 'utf8'));
  } catch {
    return false;
  }
  if (normalizedString(current.token) !== lock.token) return false;
  const nowMs = now();
  const payload = lockOwnerPayload(lock, nowMs, leaseMs);
  let handle = null;
  try {
    // r+ cannot create a token file inside a replacement owner's directory.
    handle = await fsApi.open(lock.ownerPath, 'r+');
    await handle.truncate(0);
    await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
    await handle.sync?.();
    lock.sequence = payload.sequence;
    return true;
  } catch {
    return false;
  } finally {
    try { await handle?.close(); } catch { }
  }
}

export async function releaseSharedSnapshotLock(lock) {
  if (!lock?.ownerPath || !lock?.token) return false;
  const { fsApi } = lock;
  try {
    const owner = JSON.parse(await fsApi.readFile(lock.ownerPath, 'utf8'));
    if (normalizedString(owner.token) !== lock.token) return false;
  } catch {
    return false;
  }
  try {
    // The filename itself embeds the owner token, so an old owner's finally
    // cannot unlink a newer owner's file after stale-lock replacement.
    await fsApi.unlink(lock.ownerPath);
  } catch {
    return false;
  }
  try { await fsApi.rmdir(lock.lockPath); } catch { }
  return true;
}

async function sleepWithSharedLock(lock, totalMs, sleep) {
  let remainingMs = Math.max(0, totalMs);
  while (remainingMs > 0) {
    if (!await renewSharedSnapshotLock(lock)) throw new Error('shared PA order snapshot lock ownership was lost');
    const chunkMs = Math.min(PA_SHARED_LOCK_RENEW_CHUNK_MS, remainingMs);
    await sleep(chunkMs);
    remainingMs -= chunkMs;
  }
}

export async function acquireSharedSnapshotLock({
  lockPath,
  snapshotPath,
  fsApi,
  now,
  sleep,
  maxWaitMs,
  maxAgeMs,
  notBeforeMs,
  leaseMs = PA_SHARED_LOCK_LEASE_MS,
}) {
  const startedAt = now();
  for (;;) {
    try {
      return await createSharedSnapshotLock({ lockPath, fsApi, now, leaseMs });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const cached = await readSharedSnapshot(snapshotPath, fsApi);
      const nowMs = now();
      if (usableSharedSnapshot(cached, { nowMs, maxAgeMs, notBeforeMs })) return { cached };
      if (await tryReclaimExpiredSharedLock({ lockPath, fsApi, now, sleep, leaseMs })) continue;
      if (nowMs - startedAt >= maxWaitMs) return null;
      await sleep(Math.min(100, Math.max(1, maxWaitMs - (nowMs - startedAt))));
    }
  }
}

function sharedSnapshotResult(snapshot, nowMs, source = 'cache') {
  return {
    ok: true,
    degraded: false,
    source,
    orders: snapshot.orders,
    fetched_at: snapshot.fetched_at,
    fetched_at_ms: snapshot.fetched_at_ms,
    age_ms: snapshotAgeMs(snapshot, nowMs),
    next_allowed_at: snapshot.next_allowed_at || null,
    backoff_until: snapshot.backoff_until || null,
  };
}

function processPermitFor(snapshotPath) {
  return processOrderPermitState.get(snapshotPath) || {
    next_allowed_at_ms: 0,
    backoff_until_ms: 0,
    last_error: null,
  };
}

function updateProcessPermit(snapshotPath, patch = {}) {
  const current = processPermitFor(snapshotPath);
  const next = {
    ...current,
    ...patch,
    next_allowed_at_ms: Math.max(
      finiteNumber(current.next_allowed_at_ms) || 0,
      finiteNumber(patch.next_allowed_at_ms) || 0,
    ),
    backoff_until_ms: Math.max(
      finiteNumber(current.backoff_until_ms) || 0,
      finiteNumber(patch.backoff_until_ms) || 0,
    ),
  };
  processOrderPermitState.set(snapshotPath, next);
  return next;
}

function readPermitDeadline(...sources) {
  return Math.max(0, ...sources.map((source) => finiteNumber(source?.next_allowed_at_ms) || 0));
}

function readBackoffDeadline(...sources) {
  return Math.max(0, ...sources.map((source) => finiteNumber(source?.backoff_until_ms) || 0));
}

function degradedSharedSnapshot({
  snapshot,
  nowMs,
  source,
  reason,
  error = null,
  retryAtMs = 0,
}) {
  return {
    ok: false,
    degraded: true,
    source,
    orders: Array.isArray(snapshot?.orders) ? snapshot.orders : [],
    fetched_at: snapshot?.fetched_at || null,
    age_ms: snapshotAgeMs(snapshot, nowMs),
    reason,
    error,
    retry_at: retryAtMs > 0 ? new Date(retryAtMs).toISOString() : null,
  };
}

async function fetchOrdersWithTimeout(fetchOrders, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(fetchOrders),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`GetOrderList timed out after ${timeoutMs}ms`);
          error.code = 'PA_GET_ORDER_LIST_TIMEOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function getSharedPaOrderSnapshot({
  snapshotPath,
  lockPath = `${snapshotPath}.lock`,
  fetchOrders,
  maxAgeMs = 30_000,
  notBeforeMs = Number.NEGATIVE_INFINITY,
  waitForPermit = false,
  maxWaitMs = 15_000,
  minIntervalMs = PA_SHARED_ORDER_MIN_INTERVAL_MS,
  fetchTimeoutMs = PA_SHARED_ORDER_FETCH_TIMEOUT_MS,
  lockLeaseMs = PA_SHARED_LOCK_LEASE_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fsApi = fsp,
} = {}) {
  if (!snapshotPath || typeof fetchOrders !== 'function') throw new Error('shared PA order snapshot requires snapshotPath and fetchOrders');
  if (!(finiteNumber(fetchTimeoutMs) > 0) || finiteNumber(fetchTimeoutMs) >= finiteNumber(lockLeaseMs)) {
    throw new Error('shared PA order fetch timeout must be positive and shorter than the lock lease');
  }
  const permitPath = `${snapshotPath}.permit.json`;
  const initialNow = now();
  let snapshot = await readSharedSnapshot(snapshotPath, fsApi);
  let permit = await readSharedSnapshot(permitPath, fsApi);
  const processPermit = processPermitFor(snapshotPath);
  if (permit?.corrupt_error) {
    return degradedSharedSnapshot({
      snapshot,
      nowMs: initialNow,
      source: 'permit_corrupt',
      reason: 'shared_order_permit_corrupt',
      error: permit.corrupt_error,
    });
  }
  const backoffUntilMs = readBackoffDeadline(snapshot, permit, processPermit);
  if (initialNow < backoffUntilMs) {
    return degradedSharedSnapshot({
      snapshot,
      nowMs: initialNow,
      source: 'backoff',
      reason: 'shared_order_snapshot_backoff',
      error: processPermit.last_error || permit?.last_error || snapshot?.last_error || null,
      retryAtMs: backoffUntilMs,
    });
  }
  if (usableSharedSnapshot(snapshot, { nowMs: initialNow, maxAgeMs, notBeforeMs })) {
    return sharedSnapshotResult(snapshot, initialNow, 'cache');
  }

  let lock = null;
  try {
    lock = await acquireSharedSnapshotLock({
      lockPath,
      snapshotPath,
      fsApi,
      now,
      sleep,
      maxWaitMs: waitForPermit ? maxWaitMs : 0,
      maxAgeMs,
      notBeforeMs,
      leaseMs: lockLeaseMs,
    });
  } catch (error) {
    return {
      ok: false,
      degraded: true,
      source: 'lock_error',
      orders: Array.isArray(snapshot?.orders) ? snapshot.orders : [],
      fetched_at: snapshot?.fetched_at || null,
      age_ms: snapshotAgeMs(snapshot, now()),
      reason: 'shared_order_snapshot_lock_error',
      error: errorMessage(error),
    };
  }
  if (lock?.cached) return sharedSnapshotResult(lock.cached, now(), 'peer_cache');
  if (!lock) {
    snapshot = await readSharedSnapshot(snapshotPath, fsApi);
    return {
      ok: false,
      degraded: true,
      source: 'lock_wait',
      orders: Array.isArray(snapshot?.orders) ? snapshot.orders : [],
      fetched_at: snapshot?.fetched_at || null,
      age_ms: snapshotAgeMs(snapshot, now()),
      reason: 'shared_order_snapshot_lock_busy',
      error: null,
    };
  }

  try {
    snapshot = await readSharedSnapshot(snapshotPath, fsApi);
    permit = await readSharedSnapshot(permitPath, fsApi);
    let currentNow = now();
    if (permit?.corrupt_error) {
      return degradedSharedSnapshot({
        snapshot,
        nowMs: currentNow,
        source: 'permit_corrupt',
        reason: 'shared_order_permit_corrupt',
        error: permit.corrupt_error,
      });
    }
    const processGate = processPermitFor(snapshotPath);
    const currentBackoffUntilMs = readBackoffDeadline(snapshot, permit, processGate);
    if (currentNow < currentBackoffUntilMs) {
      return degradedSharedSnapshot({
        snapshot,
        nowMs: currentNow,
        source: 'backoff_after_lock',
        reason: 'shared_order_snapshot_backoff',
        error: processGate.last_error || permit?.last_error || snapshot?.last_error || null,
        retryAtMs: currentBackoffUntilMs,
      });
    }
    if (usableSharedSnapshot(snapshot, { nowMs: currentNow, maxAgeMs, notBeforeMs })) {
      return sharedSnapshotResult(snapshot, currentNow, 'cache_after_lock');
    }
    const previousFetchedAtMs = finiteNumber(snapshot?.fetched_at_ms);
    const cadencePermitAtMs = previousFetchedAtMs === null ? 0 : previousFetchedAtMs + minIntervalMs;
    const nextAllowedAtMs = Math.max(cadencePermitAtMs,
      readPermitDeadline(snapshot, permit, processGate),
    );
    if (currentNow < nextAllowedAtMs) {
      const waitMs = nextAllowedAtMs - currentNow;
      if (!waitForPermit || waitMs > maxWaitMs) {
        return {
          ok: false,
          degraded: true,
          source: 'permit_wait',
          orders: Array.isArray(snapshot?.orders) ? snapshot.orders : [],
          fetched_at: snapshot?.fetched_at || null,
          age_ms: snapshotAgeMs(snapshot, currentNow),
          reason: 'shared_order_snapshot_refresh_deferred',
          error: null,
          retry_at: new Date(nextAllowedAtMs).toISOString(),
        };
      }
      await sleepWithSharedLock(lock, waitMs, sleep);
      currentNow = now();
    }

    if (!await renewSharedSnapshotLock(lock)) {
      return degradedSharedSnapshot({
        snapshot,
        nowMs: currentNow,
        source: 'lock_lost',
        reason: 'shared_order_snapshot_lock_lost',
        error: 'shared PA order snapshot lock ownership was lost before broker fetch',
      });
    }
    const attemptStartedAtMs = now();
    const attemptNextAllowedAtMs = attemptStartedAtMs + minIntervalMs;
    const attemptPermit = {
      version: 1,
      owner_token: lock.token,
      attempt_started_at: new Date(attemptStartedAtMs).toISOString(),
      attempt_started_at_ms: attemptStartedAtMs,
      next_allowed_at: new Date(attemptNextAllowedAtMs).toISOString(),
      next_allowed_at_ms: attemptNextAllowedAtMs,
      backoff_until: null,
      backoff_until_ms: 0,
      last_error: null,
    };
    updateProcessPermit(snapshotPath, {
      next_allowed_at_ms: attemptNextAllowedAtMs,
      last_error: null,
    });
    try {
      // Persist the permit before touching OpenD. If the main snapshot later
      // fails to rename, a peer process still sees the account-level cadence.
      await writeSharedSnapshot(permitPath, attemptPermit, fsApi);
    } catch (error) {
      updateProcessPermit(snapshotPath, {
        next_allowed_at_ms: attemptNextAllowedAtMs,
        backoff_until_ms: attemptNextAllowedAtMs,
        last_error: errorMessage(error),
      });
      return degradedSharedSnapshot({
        snapshot,
        nowMs: attemptStartedAtMs,
        source: 'permit_persist_error',
        reason: 'shared_order_permit_persist_error',
        error: errorMessage(error),
        retryAtMs: attemptNextAllowedAtMs,
      });
    }

    try {
      const orders = await fetchOrdersWithTimeout(fetchOrders, fetchTimeoutMs);
      if (!Array.isArray(orders)) throw new Error('GetOrderList did not return an order array');
      const fetchedAtMs = now();
      if (!await renewSharedSnapshotLock(lock)) {
        updateProcessPermit(snapshotPath, {
          next_allowed_at_ms: attemptNextAllowedAtMs,
          backoff_until_ms: attemptNextAllowedAtMs,
          last_error: 'shared PA order snapshot lock ownership was lost after broker fetch',
        });
        return degradedSharedSnapshot({
          snapshot,
          nowMs: fetchedAtMs,
          source: 'lock_lost',
          reason: 'shared_order_snapshot_lock_lost',
          error: 'shared PA order snapshot lock ownership was lost after broker fetch',
          retryAtMs: attemptNextAllowedAtMs,
        });
      }
      const nextAllowed = fetchedAtMs + minIntervalMs;
      updateProcessPermit(snapshotPath, {
        next_allowed_at_ms: nextAllowed,
        backoff_until_ms: 0,
        last_error: null,
      });
      const nextSnapshot = {
        version: 1,
        fetched_at: new Date(fetchedAtMs).toISOString(),
        fetched_at_ms: fetchedAtMs,
        next_allowed_at: new Date(nextAllowed).toISOString(),
        next_allowed_at_ms: nextAllowed,
        backoff_until: null,
        backoff_until_ms: 0,
        last_error: null,
        orders,
      };
      try {
        await writeSharedSnapshot(snapshotPath, nextSnapshot, fsApi);
      } catch (error) {
        updateProcessPermit(snapshotPath, {
          next_allowed_at_ms: nextAllowed,
          backoff_until_ms: nextAllowed,
          last_error: errorMessage(error),
        });
        return degradedSharedSnapshot({
          snapshot: nextSnapshot,
          nowMs: fetchedAtMs,
          source: 'persist_error',
          reason: 'shared_order_snapshot_persist_error',
          error: errorMessage(error),
          retryAtMs: nextAllowed,
        });
      }
      return sharedSnapshotResult(nextSnapshot, fetchedAtMs, 'broker');
    } catch (error) {
      const failedAtMs = now();
      const rateLimited = isPaOrderRateLimitError(error);
      const timedOut = error?.code === 'PA_GET_ORDER_LIST_TIMEOUT';
      const backoffMs = rateLimited || timedOut ? 30_000 : 5_000;
      const backoffUntil = failedAtMs + backoffMs;
      const nextAllowedAfterError = Math.max(attemptNextAllowedAtMs, backoffUntil);
      updateProcessPermit(snapshotPath, {
        next_allowed_at_ms: nextAllowedAfterError,
        backoff_until_ms: backoffUntil,
        last_error: errorMessage(error),
      });
      const degradedSnapshot = {
        ...(snapshot && !snapshot.corrupt_error ? snapshot : {}),
        version: 1,
        next_allowed_at: new Date(backoffUntil).toISOString(),
        next_allowed_at_ms: backoffUntil,
        backoff_until: new Date(backoffUntil).toISOString(),
        backoff_until_ms: backoffUntil,
        last_error: errorMessage(error),
        last_error_kind: rateLimited ? 'rate_limited' : timedOut ? 'timeout' : 'transient',
        last_error_at: new Date(failedAtMs).toISOString(),
        orders: Array.isArray(snapshot?.orders) ? snapshot.orders : [],
      };
      let persistenceError = null;
      const degradedPermit = {
        ...attemptPermit,
        next_allowed_at: new Date(nextAllowedAfterError).toISOString(),
        next_allowed_at_ms: nextAllowedAfterError,
        backoff_until: new Date(backoffUntil).toISOString(),
        backoff_until_ms: backoffUntil,
        last_error: errorMessage(error),
        last_error_kind: degradedSnapshot.last_error_kind,
      };
      try {
        await writeSharedSnapshot(permitPath, degradedPermit, fsApi);
      } catch (persistError) {
        persistenceError = `permit: ${errorMessage(persistError)}`;
      }
      try {
        await writeSharedSnapshot(snapshotPath, degradedSnapshot, fsApi);
      } catch (persistError) {
        persistenceError = [persistenceError, `snapshot: ${errorMessage(persistError)}`].filter(Boolean).join('; ');
      }
      return {
        ok: false,
        degraded: true,
        source: 'broker_error',
        orders: degradedSnapshot.orders,
        fetched_at: degradedSnapshot.fetched_at || null,
        age_ms: snapshotAgeMs(degradedSnapshot, failedAtMs),
        reason: rateLimited
          ? 'get_order_list_rate_limited'
          : timedOut ? 'get_order_list_timeout' : 'get_order_list_transient_error',
        error: persistenceError
          ? `${degradedSnapshot.last_error}; snapshot persistence failed: ${persistenceError}`
          : degradedSnapshot.last_error,
        retry_at: degradedSnapshot.backoff_until,
      };
    }
  } finally {
    await releaseSharedSnapshotLock(lock);
  }
}

export function buildPaEntryRemark(executionKey) {
  return `${PA_ENTRY_REMARK_PREFIX}${stableDigest(executionKey)}`;
}

export function buildPaExitRemark({ executionKey = '', buyOrderKey = '', attempt = 1 } = {}) {
  const attemptNumber = Math.max(1, Math.floor(finiteNumber(attempt) || 1));
  return `${PA_EXIT_REMARK_PREFIX}${stableDigest(`${executionKey}|${buyOrderKey}`, 22)}:a${attemptNumber}`;
}

export function brokerOrderIds(order = {}) {
  return {
    order_id: normalizedString(order.orderID),
    order_id_ex: normalizedString(order.orderIDEx),
  };
}

export function brokerOrderKey(order = {}) {
  const ids = brokerOrderIds(order);
  return ids.order_id_ex || ids.order_id || '';
}

export function brokerOrderRemark(order = {}) {
  return normalizedString(order.remark ?? order.orderRemark);
}

export function isMoomooOptionCode(code) {
  return /\d{6}[CP]\d+$/i.test(normalizedString(code));
}

export function isJunkmanReservedOptionCode(code) {
  return /^SPXW?\d{6}[CP]\d+$/i.test(normalizedString(code));
}

export function isExplicitTerminalUnfilledOrder(order = {}) {
  const status = finiteNumber(order.orderStatus);
  const fillQty = finiteNumber(order.fillQty) || 0;
  return fillQty <= 0 && EXPLICIT_TERMINAL_UNFILLED_STATUSES.has(status);
}

export function isBrokerAcceptedOrder(order = {}) {
  return Boolean(brokerOrderKey(order)) && !isExplicitTerminalUnfilledOrder(order);
}

export function isPotentiallyActiveBrokerOrder(order = {}) {
  const status = finiteNumber(order.orderStatus);
  return Boolean(brokerOrderKey(order)) && !TERMINAL_ORDER_STATUSES.has(status);
}

export function isTerminalBrokerOrder(order = {}) {
  return TERMINAL_ORDER_STATUSES.has(finiteNumber(order.orderStatus));
}

export function evaluatePaAggregateExposure({
  positions = [],
  orders = [],
  code = '',
  requestedNotionalUsd,
  paperEquityUsd = 10_000,
} = {}) {
  const expectedCode = normalizedString(code);
  const activeOrders = (orders || []).filter((order) => !isTerminalBrokerOrder(order));
  const reasons = [];
  if ((positions || []).some((row) => normalizedString(row?.code) === expectedCode && (finiteNumber(row?.qty) || 0) > 0)) {
    reasons.push('broker_contract_position_already_exists');
  }
  if (activeOrders.some((row) => normalizedString(row?.code) === expectedCode)) {
    reasons.push('broker_contract_order_already_pending');
  }

  let existingExposureUsd = 0;
  for (const row of positions || []) {
    const qty = finiteNumber(row?.qty);
    if (!isMoomooOptionCode(row?.code) || isJunkmanReservedOptionCode(row?.code) || !(qty > 0)) continue;
    const cost = finiteNumber(row?.costPrice);
    if (!(cost > 0)) {
      reasons.push('broker_option_position_cost_unavailable');
      continue;
    }
    existingExposureUsd += qty * cost * 100;
  }
  for (const row of activeOrders) {
    if (finiteNumber(row?.trdSide) !== 1 || !isMoomooOptionCode(row?.code) || isJunkmanReservedOptionCode(row?.code)) continue;
    const remainingQty = Math.max(0, (finiteNumber(row?.qty) || 0) - (finiteNumber(row?.fillQty) || 0));
    const price = finiteNumber(row?.price);
    if (remainingQty > 0 && !(price > 0)) {
      reasons.push('broker_pending_buy_price_unavailable');
      continue;
    }
    existingExposureUsd += remainingQty * price * 100;
  }
  const requested = finiteNumber(requestedNotionalUsd);
  const equity = finiteNumber(paperEquityUsd);
  if (!(requested > 0)) reasons.push('invalid_requested_notional');
  if (!(equity > 0)) reasons.push('invalid_paper_equity');
  if (requested > 0 && equity > 0 && existingExposureUsd + requested > equity + 0.01) {
    reasons.push('pa_total_exposure_above_10000');
  }
  return {
    passed: reasons.length === 0,
    reasons,
    existing_exposure_usd: Number(existingExposureUsd.toFixed(2)),
    requested_notional_usd: requested === null ? null : Number(requested.toFixed(2)),
    projected_exposure_usd: requested === null ? null : Number((existingExposureUsd + requested).toFixed(2)),
    paper_equity_usd: equity,
  };
}

function normalizedAttemptSpec({ remark, side, code, qty } = {}) {
  return {
    remark: normalizedString(remark),
    side: finiteNumber(side),
    code: normalizedString(code).toUpperCase(),
    qty: finiteNumber(qty),
  };
}

export function brokerOrderMatchesAttempt(order, attempt) {
  const expected = normalizedAttemptSpec(attempt);
  const actual = normalizedAttemptSpec({
    remark: brokerOrderRemark(order),
    side: order?.trdSide,
    code: order?.code,
    qty: order?.qty,
  });
  return Boolean(expected.remark)
    && actual.remark === expected.remark
    && actual.side === expected.side
    && actual.code === expected.code
    && actual.qty === expected.qty;
}

export function indexBrokerOrders(orders = []) {
  const byId = new Map();
  for (const order of orders || []) {
    const ids = brokerOrderIds(order);
    if (ids.order_id) byId.set(ids.order_id, order);
    if (ids.order_id_ex) byId.set(ids.order_id_ex, order);
  }
  return byId;
}

export function findBrokerOrderByIds(ordersOrIndex, { orderID, orderIDEx, order_id, order_id_ex } = {}) {
  const index = ordersOrIndex instanceof Map ? ordersOrIndex : indexBrokerOrders(ordersOrIndex);
  for (const id of [orderIDEx, order_id_ex, orderID, order_id].map(normalizedString).filter(Boolean)) {
    const match = index.get(id);
    if (match) return match;
  }
  return null;
}

export function buildPaRiskOrderView({
  brokerOrders = [],
  executionRows = [],
  nowMs = Date.now(),
  localReservationMs = 5 * 60_000,
} = {}) {
  const riskOrders = [...(brokerOrders || [])];
  const brokerIndex = indexBrokerOrders(brokerOrders);
  const latestByExecutionKey = new Map();
  for (const row of executionRows || []) {
    const key = executionKeyOf(row);
    if (key) latestByExecutionKey.set(key, row);
  }
  for (const row of latestByExecutionKey.values()) {
    if (normalizedString(row.order_status) !== 'submitted') continue;
    const submittedAtMs = Math.max(
      ...[row.execution?.submitted_at, row.execution?.reconciled_at, row.planned_at]
        .map((value) => Date.parse(value || ''))
        .filter(Number.isFinite),
      Number.NEGATIVE_INFINITY,
    );
    if (Number.isFinite(submittedAtMs) && nowMs - submittedAtMs > localReservationMs) continue;
    const responseOrder = row.execution?.response?.s2c || {};
    const ids = brokerOrderIds(responseOrder);
    const spec = entryAttemptSpec(row);
    const brokerMatch = findBrokerOrderByIds(brokerIndex, ids)
      || (brokerOrders || []).find((order) => brokerOrderMatchesAttempt(order, spec));
    if (brokerMatch) continue;
    if (!spec.code || !(spec.qty > 0)) continue;
    riskOrders.push({
      ...(ids.order_id ? { orderID: ids.order_id } : {}),
      ...(ids.order_id_ex ? { orderIDEx: ids.order_id_ex } : {}),
      orderStatus: 5,
      trdSide: 1,
      code: spec.code,
      qty: spec.qty,
      fillQty: 0,
      price: finiteNumber(row.order?.price),
      remark: spec.remark,
      _pa_local_reservation: true,
      _pa_execution_key: executionKeyOf(row),
    });
  }
  return riskOrders;
}

function executionKeyOf(row = {}) {
  return normalizedString(row.execution_key);
}

function entryAttemptSpec(row = {}) {
  return normalizedAttemptSpec({
    remark: row.order?.remark,
    side: 1,
    code: row.order?.code,
    qty: row.order?.qty,
  });
}

export function hasPaEntryAttempt(executionRows = [], executionKey) {
  const expected = normalizedString(executionKey);
  return (executionRows || []).some((row) => executionKeyOf(row) === expected
    && ENTRY_ATTEMPT_STATUSES.has(normalizedString(row.order_status)));
}

export function reconcilePaEntryLedger({ executionRows = [], brokerOrders = [] } = {}) {
  const latestByExecutionKey = new Map();
  const knownRemarks = new Set();
  const remarkOwners = new Map();
  for (const row of executionRows || []) {
    const key = executionKeyOf(row);
    const status = normalizedString(row.order_status);
    const remark = normalizedString(row.order?.remark);
    if (remark) knownRemarks.add(remark);
    if (key && ENTRY_ATTEMPT_STATUSES.has(status)) {
      latestByExecutionKey.set(key, row);
      if (remark) {
        const owners = remarkOwners.get(remark) || new Set();
        owners.add(key);
        remarkOwners.set(remark, owners);
      }
    }
  }

  const materializations = [];
  const terminalizations = [];
  const unresolved = [];
  for (const [executionKey, row] of latestByExecutionKey) {
    const status = normalizedString(row.order_status);
    if (status !== 'submission_intent' && status !== 'submission_unknown') continue;
    const spec = entryAttemptSpec(row);
    if (!spec.remark || spec.side !== 1 || !spec.code || !(spec.qty > 0)) {
      unresolved.push({ execution_key: executionKey, reason: 'local_submission_identity_incomplete', plan: row });
      continue;
    }
    if ((remarkOwners.get(spec.remark)?.size || 0) !== 1) {
      unresolved.push({ execution_key: executionKey, reason: 'local_submission_remark_not_unique', plan: row });
      continue;
    }
    const matches = (brokerOrders || []).filter((order) => brokerOrderMatchesAttempt(order, spec));
    if (matches.length === 0) {
      unresolved.push({ execution_key: executionKey, reason: 'broker_order_absent_cannot_infer_rejection', plan: row });
      continue;
    }
    if (matches.length !== 1) {
      unresolved.push({ execution_key: executionKey, reason: 'broker_order_match_ambiguous', match_count: matches.length, plan: row });
      continue;
    }
    const brokerOrder = matches[0];
    if (isExplicitTerminalUnfilledOrder(brokerOrder)) {
      terminalizations.push({ execution_key: executionKey, plan: row, broker_order: brokerOrder });
    } else if (isBrokerAcceptedOrder(brokerOrder)) {
      materializations.push({ execution_key: executionKey, plan: row, broker_order: brokerOrder });
    } else {
      unresolved.push({ execution_key: executionKey, reason: 'broker_order_identity_missing_or_unknown', plan: row, broker_order: brokerOrder });
    }
  }

  const orphanBrokerOrders = (brokerOrders || []).filter((order) => {
    const remark = brokerOrderRemark(order);
    return remark.startsWith(PA_ENTRY_REMARK_PREFIX) && !knownRemarks.has(remark);
  });
  const blockedReasons = [];
  if (unresolved.length > 0) blockedReasons.push(`entry_submission_unresolved:${unresolved.length}`);
  if (orphanBrokerOrders.length > 0) blockedReasons.push(`broker_pa_entry_without_local_ledger:${orphanBrokerOrders.length}`);
  return {
    materializations,
    terminalizations,
    unresolved,
    orphan_broker_orders: orphanBrokerOrders,
    blocked_reasons: blockedReasons,
    entry_allowed: blockedReasons.length === 0,
  };
}

export function materializeAcceptedEntry(plan, brokerOrder, now = new Date()) {
  const ids = brokerOrderIds(brokerOrder);
  return {
    ...plan,
    order_status: 'submitted',
    execution: {
      ...(plan.execution || {}),
      reconciled_at: now.toISOString(),
      recovered_from: normalizedString(plan.order_status),
      response: {
        retType: 0,
        retMsg: 'materialized_from_broker_reconciliation',
        errCode: 0,
        s2c: {
          ...(ids.order_id ? { orderID: ids.order_id } : {}),
          ...(ids.order_id_ex ? { orderIDEx: ids.order_id_ex } : {}),
        },
      },
      broker_order: brokerOrder,
    },
  };
}

export function materializeTerminalUnfilledEntry(plan, brokerOrder, now = new Date()) {
  return {
    ...plan,
    order_status: 'submission_terminal_unfilled',
    execution: {
      ...(plan.execution || {}),
      reconciled_at: now.toISOString(),
      recovered_from: normalizedString(plan.order_status),
      broker_order: brokerOrder,
    },
  };
}

export function reconcilePaExitAttempt({ stateRow = {}, brokerOrders = [], code } = {}) {
  const status = normalizedString(stateRow.status);
  if (status !== 'exit_intent' && status !== 'exit_submission_unknown') {
    return { resolution: 'not_needed', state: stateRow };
  }
  const spec = normalizedAttemptSpec({
    remark: stateRow.exit_remark,
    side: 2,
    code,
    qty: stateRow.exit_qty,
  });
  if (!spec.remark || spec.side !== 2 || !spec.code || !(spec.qty > 0)) {
    return { resolution: 'unresolved', reason: 'local_exit_identity_incomplete', state: stateRow };
  }
  const matches = (brokerOrders || []).filter((order) => brokerOrderMatchesAttempt(order, spec));
  if (matches.length === 0) {
    return { resolution: 'unresolved', reason: 'broker_exit_absent_cannot_infer_rejection', state: stateRow };
  }
  if (matches.length !== 1) {
    return { resolution: 'unresolved', reason: 'broker_exit_match_ambiguous', match_count: matches.length, state: stateRow };
  }
  const brokerOrder = matches[0];
  if (isExplicitTerminalUnfilledOrder(brokerOrder)) {
    return {
      resolution: 'terminal_unfilled',
      broker_order: brokerOrder,
      state: {
        ...stateRow,
        status: 'monitoring',
        exit_attempt: Math.max(1, Math.floor(finiteNumber(stateRow.exit_attempt) || 1)),
        exit_terminal_unfilled: true,
        exit_terminal_status: brokerOrder.orderStatus ?? null,
        exit_retry_after_terminal: true,
        exit_order_id: null,
        exit_order_id_ex: null,
        updated_at: new Date().toISOString(),
      },
    };
  }
  if (!isBrokerAcceptedOrder(brokerOrder)) {
    return { resolution: 'unresolved', reason: 'broker_exit_identity_missing_or_unknown', broker_order: brokerOrder, state: stateRow };
  }
  const ids = brokerOrderIds(brokerOrder);
  return {
    resolution: 'accepted',
    broker_order: brokerOrder,
    state: {
      ...stateRow,
      status: 'exit_submitted',
      exit_order_id: ids.order_id || null,
      exit_order_id_ex: ids.order_id_ex || null,
      exit_order_status: brokerOrder.orderStatus ?? null,
      exit_reconciled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
}

export function parseStrictNdjson(text, source = 'NDJSON') {
  return String(text || '')
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => Boolean(line))
    .map(({ line, lineNumber }) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${source}:${lineNumber} is not valid JSON: ${error.message}`);
      }
    });
}

export function completeNdjsonChunk(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return { text: '', consumed_bytes: 0, partial_tail_bytes: bytes.length };
  }
  return {
    text: bytes.subarray(0, lastNewline + 1).toString('utf8'),
    consumed_bytes: lastNewline + 1,
    partial_tail_bytes: bytes.length - lastNewline - 1,
  };
}
