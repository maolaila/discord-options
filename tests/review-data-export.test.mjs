import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeValue,
  stableRedaction,
} from '../ops/export-review-data.mjs';

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
