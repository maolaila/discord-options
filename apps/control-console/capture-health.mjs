export const DEFAULT_CAPTURE_HEARTBEAT_FRESH_MS = 90_000;

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function timestampAgeMs(value, nowMs) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : null;
}

export function deriveCaptureHealth(captureStatus, {
  processRunning = true,
  nowMs = Date.now(),
  defaultFreshMs = DEFAULT_CAPTURE_HEARTBEAT_FRESH_MS,
} = {}) {
  const status = captureStatus || {};
  const gatewayState = String(status.gateway_state || '').trim().toLowerCase();
  const activeGatewayCount = Math.max(0, Math.floor(Number(status.active_gateway_count) || 0));
  const heartbeatIntervalMs = positiveNumber(status.gateway_heartbeat_interval_ms);
  const staleAfterMs = Math.max(
    positiveNumber(defaultFreshMs) || DEFAULT_CAPTURE_HEARTBEAT_FRESH_MS,
    heartbeatIntervalMs === null ? 0 : heartbeatIntervalMs * 3,
  );
  const heartbeatAckAgeMs = timestampAgeMs(status.last_gateway_heartbeat_ack_at, nowMs);
  const gatewayActivityAgeMs = timestampAgeMs(status.last_gateway_activity_at, nowMs);
  const gatewayConnectedAgeMs = timestampAgeMs(status.last_gateway_connected_at, nowMs);

  const base = {
    healthy: false,
    state: 'disconnected',
    connected: false,
    evidence: 'gateway_lifecycle',
    active_gateway_count: activeGatewayCount,
    heartbeat_age_ms: heartbeatAckAgeMs,
    heartbeat_ack_age_ms: heartbeatAckAgeMs,
    gateway_activity_age_ms: gatewayActivityAgeMs,
    stale_after_ms: staleAfterMs,
    heartbeat_interval_ms: heartbeatIntervalMs,
    last_heartbeat_ack_at: status.last_gateway_heartbeat_ack_at || null,
    last_gateway_connected_at: status.last_gateway_connected_at || null,
    last_gateway_disconnected_at: status.last_gateway_disconnected_at || null,
  };

  if (!processRunning) {
    return { ...base, state: 'stopped', evidence: 'capture_process' };
  }

  // Compatibility for a capture process that has not yet restarted onto the
  // lifecycle-aware schema. Once gateway_state is present, message timestamps
  // are never used as the connection-health signal.
  if (!gatewayState) {
    const legacyAgeMs = timestampAgeMs(status.updated_at, nowMs);
    const healthy = status.status === 'capturing'
      && legacyAgeMs !== null
      && legacyAgeMs <= staleAfterMs;
    return {
      ...base,
      healthy,
      state: healthy ? 'legacy_event_activity' : 'stale',
      connected: healthy,
      evidence: 'legacy_status_updated_at',
      heartbeat_age_ms: legacyAgeMs,
    };
  }

  const connected = activeGatewayCount > 0 && gatewayState !== 'disconnected';
  if (!connected) {
    return {
      ...base,
      state: status.last_gateway_connected_at ? 'disconnected' : 'waiting_for_gateway',
    };
  }

  if (heartbeatAckAgeMs !== null) {
    const healthy = heartbeatAckAgeMs <= staleAfterMs;
    return {
      ...base,
      healthy,
      state: healthy ? 'quiet_but_connected' : 'stale',
      connected: true,
      evidence: 'gateway_heartbeat_ack',
    };
  }

  // Discord sends the first ACK only after the browser's first heartbeat.
  // Treat the bounded interval immediately after HELLO/connection as a normal
  // connecting state rather than a false outage.
  const connectionEvidenceAgeMs = gatewayActivityAgeMs ?? gatewayConnectedAgeMs;
  const withinFirstAckGrace = connectionEvidenceAgeMs !== null
    && connectionEvidenceAgeMs <= staleAfterMs;
  return {
    ...base,
    healthy: withinFirstAckGrace,
    state: withinFirstAckGrace ? 'connecting' : 'stale',
    connected: true,
    evidence: withinFirstAckGrace ? 'gateway_connection_grace' : 'gateway_heartbeat_ack_missing',
    heartbeat_age_ms: connectionEvidenceAgeMs,
  };
}
