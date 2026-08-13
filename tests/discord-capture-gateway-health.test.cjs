'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createGatewayHealthTracker,
  isDiscordGatewayPayload,
} = require('../apps/discord-capture/gateway-health.cjs');

test('gateway lifecycle and HEARTBEAT_ACK actively refresh capture health without messages', () => {
  let now = '2026-08-13T00:00:00.000Z';
  const writes = [];
  const tracker = createGatewayHealthTracker({
    nowIso: () => now,
    writeStatus: (patch) => writes.push(patch),
  });

  tracker.registerConnection('page-1:ws-1', 'wss://gateway.discord.gg/?v=9');
  assert.equal(writes.at(-1).gateway_state, 'connected');
  assert.equal(writes.at(-1).active_gateway_count, 1);

  now = '2026-08-13T00:00:01.000Z';
  tracker.observePayload('page-1:ws-1', {
    op: 10,
    d: { heartbeat_interval: 41_250 },
  });
  assert.equal(writes.at(-1).gateway_heartbeat_interval_ms, 41_250);
  assert.equal(writes.at(-1).last_gateway_hello_at, now);

  now = '2026-08-13T00:00:42.250Z';
  tracker.observePayload('page-1:ws-1', { op: 11, d: null });
  assert.equal(writes.at(-1).status, 'capturing');
  assert.equal(writes.at(-1).gateway_state, 'connected');
  assert.equal(writes.at(-1).last_gateway_heartbeat_ack_at, now);
  assert.equal(writes.at(-1).last_gateway_activity_at, now);
  assert.equal(Object.hasOwn(writes.at(-1), 'last_message_at'), false);
});

test('multiple gateway connections stay connected until the final websocket closes', () => {
  let tick = 0;
  const writes = [];
  const tracker = createGatewayHealthTracker({
    nowIso: () => `2026-08-13T00:00:0${tick++}.000Z`,
    writeStatus: (patch) => writes.push(patch),
  });

  tracker.registerConnection('page-1:ws-1', 'wss://gateway.discord.gg/');
  tracker.registerConnection('page-2:ws-2', 'wss://gateway.discord.gg/');
  assert.equal(writes.at(-1).active_gateway_count, 2);

  tracker.closeConnection('page-1:ws-1');
  assert.equal(writes.at(-1).status, 'capturing');
  assert.equal(writes.at(-1).gateway_state, 'connected');
  assert.equal(writes.at(-1).active_gateway_count, 1);

  tracker.closeConnection('page-2:ws-2');
  assert.equal(writes.at(-1).status, 'disconnected');
  assert.equal(writes.at(-1).gateway_state, 'disconnected');
  assert.equal(writes.at(-1).active_gateway_count, 0);
  assert.equal(writes.at(-1).last_gateway_disconnect_reason, 'websocket_closed');
});

test('an observed ACK can establish a gateway missed by CDP websocket-created replay', () => {
  const writes = [];
  const tracker = createGatewayHealthTracker({
    nowIso: () => '2026-08-13T00:00:42.250Z',
    writeStatus: (patch) => writes.push(patch),
  });

  assert.equal(tracker.observePayload('page-1:existing-ws', { op: 11 }, ''), true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].last_gateway_connection_source, 'observed_gateway_payload');
  assert.equal(writes[1].last_gateway_heartbeat_ack_at, '2026-08-13T00:00:42.250Z');
  assert.equal(tracker.snapshot().active_gateway_count, 1);

  assert.equal(tracker.observePayload('not-gateway', { hello: 'world' }), false);
  assert.equal(isDiscordGatewayPayload({ op: 11 }), true);
  assert.equal(isDiscordGatewayPayload({ op: 99 }), false);
});
