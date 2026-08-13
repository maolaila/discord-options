'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isLoggedInDiscordPageUrl,
  recoverGatewayCaptureAfterAttach,
} = require('../apps/discord-capture/startup-recovery.cjs');

function tracker(activeGatewayCount = 0) {
  return { snapshot: () => ({ active_gateway_count: activeGatewayCount }) };
}

test('recognizes only logged-in Discord channel pages', () => {
  assert.equal(isLoggedInDiscordPageUrl('https://discord.com/channels/@me'), true);
  assert.equal(isLoggedInDiscordPageUrl('https://discord.com/channels/1/2'), true);
  assert.equal(isLoggedInDiscordPageUrl('https://canary.discord.com/channels/@me'), true);
  assert.equal(isLoggedInDiscordPageUrl('https://discord.com/login'), false);
  assert.equal(isLoggedInDiscordPageUrl('https://discord.com/channels/login'), false);
  assert.equal(isLoggedInDiscordPageUrl('https://discord.com/channels/unknown'), false);
  assert.equal(isLoggedInDiscordPageUrl('https://example.com/channels/@me'), false);
});

test('does nothing when Gateway is already active', async () => {
  let reloadCount = 0;
  const writes = [];
  const result = await recoverGatewayCaptureAfterAttach({
    pages: [{ url: () => 'https://discord.com/channels/@me', reload: async () => { reloadCount += 1; } }],
    gatewayTracker: tracker(1),
    writeStatus: (patch) => writes.push(patch),
  });

  assert.deepEqual(result, { outcome: 'not_needed', attempted: false, page_url: null });
  assert.equal(reloadCount, 0);
  assert.equal(writes.length, 0);
});

test('reloads exactly one logged-in Discord page once when Gateway predates attach', async () => {
  let firstReloadCount = 0;
  let secondReloadCount = 0;
  const writes = [];
  const first = {
    url: () => 'https://discord.com/channels/@me',
    reload: async (options) => {
      firstReloadCount += 1;
      assert.deepEqual(options, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    },
  };
  const second = {
    url: () => 'https://discord.com/channels/1/2',
    reload: async () => { secondReloadCount += 1; },
  };

  const result = await recoverGatewayCaptureAfterAttach({
    pages: [first, second],
    gatewayTracker: tracker(0),
    writeStatus: (patch) => writes.push(patch),
    nowIso: (() => {
      const values = ['2026-08-13T00:00:00.000Z', '2026-08-13T00:00:01.000Z'];
      return () => values.shift();
    })(),
  });

  assert.equal(result.outcome, 'discord_page_reloaded_once');
  assert.equal(result.attempted, true);
  assert.equal(firstReloadCount, 1);
  assert.equal(secondReloadCount, 0);
  assert.equal(writes[0].gateway_startup_recovery, 'reloading_discord_page_once');
  assert.equal(writes[1].gateway_startup_recovery, 'discord_page_reloaded_once');
});

test('reload failure is recorded and capture remains waiting', async () => {
  const writes = [];
  const result = await recoverGatewayCaptureAfterAttach({
    pages: [{
      url: () => 'https://discord.com/channels/@me',
      reload: async () => { throw new Error('page closed'); },
    }],
    gatewayTracker: tracker(0),
    writeStatus: (patch) => writes.push(patch),
    nowIso: () => '2026-08-13T00:00:00.000Z',
  });

  assert.equal(result.outcome, 'reload_failed_waiting');
  assert.equal(result.attempted, true);
  assert.equal(writes.at(-1).status, 'attached');
  assert.equal(writes.at(-1).gateway_state, 'disconnected');
  assert.equal(writes.at(-1).gateway_startup_recovery_error, 'page closed');
});

test('absence of a logged-in Discord page records waiting without a reload', async () => {
  const writes = [];
  const result = await recoverGatewayCaptureAfterAttach({
    pages: [{ url: () => 'https://discord.com/login', reload: async () => assert.fail('must not reload') }],
    gatewayTracker: tracker(0),
    writeStatus: (patch) => writes.push(patch),
  });

  assert.equal(result.outcome, 'waiting_for_logged_in_discord_page');
  assert.equal(result.attempted, false);
  assert.equal(writes.at(-1).gateway_startup_recovery, 'waiting_for_logged_in_discord_page');
});
