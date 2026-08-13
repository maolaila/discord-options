'use strict';

const DISCORD_GATEWAY_OP_DISPATCH = 0;
const DISCORD_GATEWAY_OP_RECONNECT = 7;
const DISCORD_GATEWAY_OP_INVALID_SESSION = 9;
const DISCORD_GATEWAY_OP_HELLO = 10;
const DISCORD_GATEWAY_OP_HEARTBEAT_ACK = 11;

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isDiscordGatewayPayload(payload) {
  return Boolean(
    payload
    && typeof payload === 'object'
    && Number.isInteger(Number(payload.op))
    && Number(payload.op) >= 0
    && Number(payload.op) <= DISCORD_GATEWAY_OP_HEARTBEAT_ACK
  );
}

function createGatewayHealthTracker({ writeStatus, nowIso = () => new Date().toISOString() }) {
  if (typeof writeStatus !== 'function') {
    throw new TypeError('createGatewayHealthTracker requires writeStatus');
  }

  const connections = new Map();
  let lastHeartbeatAckAt = null;
  let lastActivityAt = null;

  function activeHeartbeatIntervalMs() {
    const intervals = [...connections.values()]
      .map((connection) => positiveNumber(connection.heartbeat_interval_ms))
      .filter((value) => value !== null);
    return intervals.length ? Math.max(...intervals) : null;
  }

  function basePatch() {
    return {
      active_gateway_count: connections.size,
      gateway_heartbeat_interval_ms: activeHeartbeatIntervalMs(),
      last_gateway_activity_at: lastActivityAt,
      last_gateway_heartbeat_ack_at: lastHeartbeatAckAt,
    };
  }

  function registerConnection(connectionId, url, source = 'websocket_created') {
    const id = String(connectionId || '');
    if (!id) throw new TypeError('gateway connection id is required');

    const observedAt = nowIso();
    const existing = connections.get(id);
    connections.set(id, {
      connected_at: existing?.connected_at || observedAt,
      heartbeat_interval_ms: existing?.heartbeat_interval_ms || null,
      last_activity_at: existing?.last_activity_at || observedAt,
      last_heartbeat_ack_at: existing?.last_heartbeat_ack_at || null,
      url: String(url || existing?.url || 'unknown_websocket'),
    });
    lastActivityAt = observedAt;

    writeStatus({
      ...basePatch(),
      status: 'capturing',
      gateway_state: 'connected',
      last_gateway_connected_at: observedAt,
      last_gateway_connection_source: source,
      last_gateway_url: String(url || existing?.url || 'unknown_websocket'),
    });
  }

  function observePayload(connectionId, payload, url = '') {
    if (!isDiscordGatewayPayload(payload)) return false;

    const id = String(connectionId || '');
    if (!id) return false;
    if (!connections.has(id)) registerConnection(id, url, 'observed_gateway_payload');

    const observedAt = nowIso();
    const connection = connections.get(id);
    connection.last_activity_at = observedAt;
    if (url) connection.url = String(url);
    lastActivityAt = observedAt;

    const opcode = Number(payload.op);
    const patch = {
      ...basePatch(),
      status: 'capturing',
      gateway_state: 'connected',
      last_gateway_activity_at: observedAt,
      last_gateway_opcode: opcode,
      last_gateway_url: connection.url,
    };

    if (opcode === DISCORD_GATEWAY_OP_HELLO) {
      const heartbeatIntervalMs = positiveNumber(payload.d?.heartbeat_interval);
      if (heartbeatIntervalMs !== null) {
        connection.heartbeat_interval_ms = heartbeatIntervalMs;
        patch.gateway_heartbeat_interval_ms = activeHeartbeatIntervalMs();
      }
      patch.last_gateway_hello_at = observedAt;
    } else if (opcode === DISCORD_GATEWAY_OP_HEARTBEAT_ACK) {
      connection.last_heartbeat_ack_at = observedAt;
      lastHeartbeatAckAt = observedAt;
      patch.last_gateway_heartbeat_ack_at = observedAt;
    } else if (opcode === DISCORD_GATEWAY_OP_RECONNECT) {
      patch.last_gateway_reconnect_requested_at = observedAt;
    } else if (opcode === DISCORD_GATEWAY_OP_INVALID_SESSION) {
      patch.last_gateway_invalid_session_at = observedAt;
    } else if (opcode === DISCORD_GATEWAY_OP_DISPATCH) {
      patch.last_gateway_dispatch_at = observedAt;
    }

    writeStatus(patch);
    return true;
  }

  function closeConnection(connectionId, reason = 'websocket_closed') {
    const id = String(connectionId || '');
    if (!connections.has(id)) return false;

    connections.delete(id);
    const closedAt = nowIso();
    writeStatus({
      ...basePatch(),
      status: connections.size ? 'capturing' : 'disconnected',
      gateway_state: connections.size ? 'connected' : 'disconnected',
      last_gateway_disconnected_at: closedAt,
      last_gateway_disconnect_reason: String(reason || 'websocket_closed'),
    });
    return true;
  }

  function observeFrameError(connectionId, errorMessage) {
    const id = String(connectionId || '');
    if (!connections.has(id)) return false;
    writeStatus({
      ...basePatch(),
      status: 'capturing',
      gateway_state: 'connected',
      last_gateway_frame_error_at: nowIso(),
      last_gateway_frame_error: String(errorMessage || 'unknown_websocket_frame_error'),
    });
    return true;
  }

  function snapshot() {
    return {
      ...basePatch(),
      gateway_state: connections.size ? 'connected' : 'disconnected',
    };
  }

  return Object.freeze({
    closeConnection,
    observeFrameError,
    observePayload,
    registerConnection,
    snapshot,
  });
}

module.exports = {
  DISCORD_GATEWAY_OP_DISPATCH,
  DISCORD_GATEWAY_OP_HEARTBEAT_ACK,
  DISCORD_GATEWAY_OP_HELLO,
  DISCORD_GATEWAY_OP_INVALID_SESSION,
  DISCORD_GATEWAY_OP_RECONNECT,
  createGatewayHealthTracker,
  isDiscordGatewayPayload,
};
