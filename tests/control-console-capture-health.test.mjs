import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveCaptureHealth } from '../apps/control-console/capture-health.mjs';

const NOW = Date.parse('2026-08-13T00:10:00.000Z');

function connectedStatus(overrides = {}) {
  return {
    status: 'capturing',
    gateway_state: 'connected',
    active_gateway_count: 1,
    gateway_heartbeat_interval_ms: 40_000,
    last_gateway_connected_at: '2026-08-13T00:00:00.000Z',
    last_gateway_activity_at: '2026-08-13T00:08:20.000Z',
    last_gateway_heartbeat_ack_at: '2026-08-13T00:08:20.000Z',
    ...overrides,
  };
}

test('a fresh Gateway HEARTBEAT_ACK reports quiet_but_connected independent of messages', () => {
  const health = deriveCaptureHealth(connectedStatus({
    last_message_at: '2026-08-12T20:00:00.000Z',
  }), { nowMs: NOW, processRunning: true });

  assert.equal(health.healthy, true);
  assert.equal(health.state, 'quiet_but_connected');
  assert.equal(health.evidence, 'gateway_heartbeat_ack');
  assert.equal(health.heartbeat_ack_age_ms, 100_000);
  assert.equal(health.stale_after_ms, 120_000);
});

test('a stale ACK stays stale even when MESSAGE_CREATE timestamps look recent', () => {
  const health = deriveCaptureHealth(connectedStatus({
    updated_at: '2026-08-13T00:10:00.000Z',
    last_message_at: '2026-08-13T00:10:00.000Z',
    last_gateway_heartbeat_ack_at: '2026-08-13T00:07:59.000Z',
  }), { nowMs: NOW, processRunning: true });

  assert.equal(health.healthy, false);
  assert.equal(health.state, 'stale');
  assert.equal(health.evidence, 'gateway_heartbeat_ack');
  assert.equal(health.heartbeat_ack_age_ms, 121_000);
});

test('connection lifecycle distinguishes first-ACK grace, disconnect, and stopped process', () => {
  const connecting = deriveCaptureHealth(connectedStatus({
    gateway_heartbeat_interval_ms: 30_000,
    last_gateway_connected_at: '2026-08-13T00:09:40.000Z',
    last_gateway_activity_at: '2026-08-13T00:09:40.000Z',
    last_gateway_heartbeat_ack_at: null,
  }), { nowMs: NOW, processRunning: true });
  assert.equal(connecting.healthy, true);
  assert.equal(connecting.state, 'connecting');

  const disconnected = deriveCaptureHealth({
    gateway_state: 'disconnected',
    active_gateway_count: 0,
    last_gateway_connected_at: '2026-08-13T00:00:00.000Z',
    last_gateway_disconnected_at: '2026-08-13T00:09:50.000Z',
  }, { nowMs: NOW, processRunning: true });
  assert.equal(disconnected.healthy, false);
  assert.equal(disconnected.state, 'disconnected');

  const stopped = deriveCaptureHealth(connectedStatus(), {
    nowMs: NOW,
    processRunning: false,
  });
  assert.equal(stopped.healthy, false);
  assert.equal(stopped.state, 'stopped');
});

test('legacy capture files retain a bounded migration fallback only', () => {
  const legacy = deriveCaptureHealth({
    status: 'capturing',
    updated_at: '2026-08-13T00:09:30.000Z',
  }, { nowMs: NOW, processRunning: true });
  assert.equal(legacy.healthy, true);
  assert.equal(legacy.state, 'legacy_event_activity');
  assert.equal(legacy.evidence, 'legacy_status_updated_at');
});
