import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT, ensureDir } from '../moomoo-opend/moomoo-opend.mjs';

const DEFAULT_LOCK_PATH = path.join(PROJECT_ROOT, 'logs', 'simulated-options-entry.lock.json');

function processRunning(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value < 1) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readLock(lockPath) {
  try {
    return JSON.parse(await fsp.readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}

export async function acquireSimulatedOptionsEntryLock({
  business_line,
  signal_id = null,
  lock_path = DEFAULT_LOCK_PATH,
  timeout_ms = 10_000,
  stale_after_ms = 120_000,
} = {}) {
  const ownerToken = randomUUID();
  const startedAt = Date.now();
  await ensureDir(path.dirname(lock_path));

  while (Date.now() - startedAt <= Number(timeout_ms)) {
    const payload = {
      owner_token: ownerToken,
      process_id: process.pid,
      business_line: String(business_line || ''),
      signal_id: signal_id ? String(signal_id) : null,
      acquired_at: new Date().toISOString(),
    };
    try {
      const handle = await fsp.open(lock_path, 'wx');
      await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const current = await readLock(lock_path);
        if (current?.owner_token === ownerToken && Number(current?.process_id) === process.pid) {
          await fsp.unlink(lock_path).catch(() => {});
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = await readLock(lock_path);
      const acquiredMs = Date.parse(String(current?.acquired_at || ''));
      const stale = !current
        || !Number.isFinite(acquiredMs)
        || Date.now() - acquiredMs > Number(stale_after_ms)
        || !processRunning(current?.process_id);
      if (stale) {
        await fsp.unlink(lock_path).catch(() => {});
        continue;
      }
      await sleep(100);
    }
  }
  throw new Error('Timed out acquiring the shared simulated-options entry lock.');
}
