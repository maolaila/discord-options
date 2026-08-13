'use strict';

function isLoggedInDiscordPageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['discord.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname)) return false;
    if (!url.pathname.startsWith('/channels/')) return false;
    const route = url.pathname.match(/^\/channels\/([^/]+)/);
    return Boolean(route && (route[1] === '@me' || /^\d+$/.test(route[1])));
  } catch {
    return false;
  }
}

async function recoverGatewayCaptureAfterAttach({
  pages,
  gatewayTracker,
  writeStatus,
  nowIso = () => new Date().toISOString(),
}) {
  if (!gatewayTracker || typeof gatewayTracker.snapshot !== 'function') {
    throw new TypeError('gatewayTracker is required');
  }
  if (typeof writeStatus !== 'function') throw new TypeError('writeStatus is required');

  const before = gatewayTracker.snapshot();
  if (before.active_gateway_count > 0) {
    return { outcome: 'not_needed', attempted: false, page_url: null };
  }

  const candidates = Array.from(pages || []).filter((page) => {
    try {
      return isLoggedInDiscordPageUrl(page.url());
    } catch {
      return false;
    }
  });
  const page = candidates[0];
  if (!page) {
    writeStatus({
      status: 'attached',
      gateway_state: 'disconnected',
      gateway_startup_recovery: 'waiting_for_logged_in_discord_page',
      gateway_startup_recovery_attempted_at: null,
      note: 'Waiting for a logged-in discord.com/channels page; capture will attach without clicking or sending anything.',
    });
    return { outcome: 'waiting_for_logged_in_discord_page', attempted: false, page_url: null };
  }

  const attemptedAt = nowIso();
  const pageUrl = page.url();
  writeStatus({
    status: 'attached',
    gateway_state: 'disconnected',
    gateway_startup_recovery: 'reloading_discord_page_once',
    gateway_startup_recovery_attempted_at: attemptedAt,
    gateway_startup_recovery_page_url: pageUrl,
    note: 'No Gateway was visible after CDP attach; reloading one logged-in Discord page once so WebSocket creation can be observed.',
  });

  try {
    // The capture remains observation-only: one page reload is allowed, with no
    // clicks, typing, message sends, or repeated reload loop.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    writeStatus({
      gateway_startup_recovery: 'discord_page_reloaded_once',
      gateway_startup_recovery_completed_at: nowIso(),
      note: 'Discord page reloaded once after attach; waiting for Gateway HELLO/HEARTBEAT_ACK.',
    });
    return { outcome: 'discord_page_reloaded_once', attempted: true, page_url: pageUrl };
  } catch (error) {
    writeStatus({
      status: 'attached',
      gateway_state: 'disconnected',
      gateway_startup_recovery: 'reload_failed_waiting',
      gateway_startup_recovery_failed_at: nowIso(),
      gateway_startup_recovery_error: String(error?.message || error || 'unknown_reload_error'),
      note: 'Automatic one-time Discord reload failed; capture remains attached and waiting without clicking or sending anything.',
    });
    return { outcome: 'reload_failed_waiting', attempted: true, page_url: pageUrl };
  }
}

module.exports = {
  isLoggedInDiscordPageUrl,
  recoverGatewayCaptureAfterAttach,
};
