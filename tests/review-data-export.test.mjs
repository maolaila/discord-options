import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  jsonSources,
  ndjsonSources,
  exportNdjson,
  sanitizeValue,
  stableRedaction,
} from '../ops/export-review-data.mjs';

test('review export preserves a BOM-prefixed first NDJSON record', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-export-'));
  const source = path.join(directory, 'source.ndjson');
  const destination = path.join(directory, 'destination.ndjson');
  writeFileSync(source, `\uFEFF${JSON.stringify({ event: 'first' })}\n${JSON.stringify({ event: 'second' })}\n`);

  const result = await exportNdjson({ source, destination });

  assert.deepEqual(result, { record_count: 2, invalid_line_count: 0 });
  assert.deepEqual(
    readFileSync(destination, 'utf8').trim().split('\n').map(JSON.parse),
    [{ event: 'first' }, { event: 'second' }],
  );
  rmSync(directory, { recursive: true, force: true });
});

test('review export includes complete SPX, MULTI, and FLOW-HEATMAP review datasets', () => {
  const ndjson = new Map(ndjsonSources.map(([source, output, gzip]) => [source, { output, gzip }]));
  const json = new Map(jsonSources.map(([source, output]) => [source, output]));

  for (const source of [
    'logs/zero-dte-options-decisions.ndjson',
    'logs/zero-dte-options-entry-plans.ndjson',
    'logs/zero-dte-options-exit-plans.ndjson',
    'logs/zero-dte-options-trades.ndjson',
    'logs/zero-dte-options-experiment-events.ndjson',
    'logs/junk-multi-options-decisions.ndjson',
    'logs/junk-multi-options-entry-plans.ndjson',
    'logs/junk-multi-options-exit-plans.ndjson',
    'logs/junk-multi-options-trades.ndjson',
    'logs/junk-flow-heatmap-options-decisions.ndjson',
    'logs/junk-flow-heatmap-options-entry-plans.ndjson',
    'logs/junk-flow-heatmap-options-exit-plans.ndjson',
    'logs/junk-flow-heatmap-options-trades.ndjson',
  ]) {
    assert.ok(ndjson.has(source), `missing review NDJSON source: ${source}`);
  }
  assert.equal(ndjson.get('logs/zero-dte-options-decisions.ndjson').gzip, true);
  assert.equal(ndjson.get('logs/junk-multi-options-decisions.ndjson').gzip, true);
  assert.equal(ndjson.get('logs/junk-flow-heatmap-options-decisions.ndjson').gzip, true);

  for (const source of [
    'logs/zero-dte-options-runtime-state.json',
    'logs/zero-dte-options-experiment-summary.json',
    'logs/junk-multi-options-runtime-state.json',
    'logs/junk-multi-options-status.json',
    'logs/junk-multi-options-universe.json',
    'logs/junk-multi-options-experiment-summary.json',
    'logs/junk-flow-heatmap-options-runtime-state.json',
    'logs/junk-flow-heatmap-options-status.json',
    'logs/junk-flow-heatmap-options-universe.json',
    'logs/junk-flow-heatmap-options-experiment-summary.json',
  ]) {
    assert.ok(json.has(source), `missing review JSON source: ${source}`);
  }
});

test('review export redacts Discord ids embedded in composite keys while retaining broker ids', () => {
  const messageId = '123456789012345678';
  const brokerOrderId = '999999999999999999';
  const alias = stableRedaction(messageId);
  const messageSuffix = messageId.slice(-12);

  const sanitized = sanitizeValue({
    source_signal_key: `${messageId}|MESSAGE_CREATE|SPX_2026-08-14_7780C|trade|bull`,
    signal_key: `${messageId}|MESSAGE_CREATE|SPX_2026-08-14_7780C|trade|bull`,
    trade_key: `${messageId}:SPXW260814C07780000:253622`,
    execution_key: `pa-options|${messageId}|MESSAGE_CREATE|SPXW260814C07780000`,
    _pa_execution_key: `pa-options|${messageId}|MESSAGE_CREATE|SPXW260814C07780000`,
    remark: `discord:${messageSuffix}`,
    orderID: brokerOrderId,
  });

  assert.equal(
    sanitized.source_signal_key,
    `${alias}|MESSAGE_CREATE|SPX_2026-08-14_7780C|trade|bull`,
  );
  assert.equal(
    sanitized.signal_key,
    `${alias}|MESSAGE_CREATE|SPX_2026-08-14_7780C|trade|bull`,
  );
  assert.equal(sanitized.trade_key, `${alias}:SPXW260814C07780000:253622`);
  assert.equal(
    sanitized.execution_key,
    `pa-options|${alias}|MESSAGE_CREATE|SPXW260814C07780000`,
  );
  assert.equal(
    sanitized._pa_execution_key,
    `pa-options|${alias}|MESSAGE_CREATE|SPXW260814C07780000`,
  );
  assert.equal(sanitized.remark, `discord:${stableRedaction(messageSuffix)}`);
  assert.equal(sanitized.orderID, brokerOrderId);
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(messageId));
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(messageSuffix));
});

test('review export redacts account and Discord identity key variants', () => {
  const sanitized = sanitizeValue({
    trdAccId: 'sim-account-1',
    trd_acc_id: 'sim-account-2',
    author_id: 'discord-author-1',
    bot_author_id: 'discord-bot-author-1',
    user_id: 'discord-user-1',
    username: 'discord-name',
  });

  for (const value of Object.values(sanitized)) {
    assert.match(value, /^\[redacted_id_[0-9a-f]{12}\]$/);
  }
});
