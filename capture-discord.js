#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  buildOrderIntent,
  formatSignalLine,
  parseOptionSignal,
} = require('./option-signal-utils');
const {
  appendSignalDocument,
  resolveTimeZone,
  stampSignalLogTimes,
} = require('./signal-document-writer');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('Missing dependency. Run: npm install');
  process.exit(1);
}

const ROOT = __dirname;
const LOG_DIR = path.join(ROOT, 'logs');
const MESSAGE_LOG = path.join(LOG_DIR, 'messages.ndjson');
const LIVE_SIGNAL_LOG = path.join(LOG_DIR, 'live-signals.ndjson');
const OPTION_SIGNAL_LOG = path.join(LOG_DIR, 'option-signals.ndjson');
const ORDER_INTENT_LOG = path.join(LOG_DIR, 'order-intents.ndjson');
const HISTORY_MESSAGE_LOG = path.join(LOG_DIR, 'history-messages.ndjson');
const RAW_EVENT_LOG = path.join(LOG_DIR, 'raw-events.ndjson');
const REST_LOG = path.join(LOG_DIR, 'rest-responses.ndjson');
const STATUS_FILE = path.join(LOG_DIR, 'capture-status.json');
const SIGNAL_DOC_DIR = path.join(ROOT, 'signal-docs');

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const ZLIB_SUFFIX = Buffer.from([0x00, 0x00, 0xff, 0xff]);
const SENSITIVE_KEY_RE = /(token|authorization|cookie|password|mfa|secret|session|fingerprint)/i;

function parseArgs(argv) {
  const args = {
    allEvents: false,
    cdpEndpoint: 'http://127.0.0.1:9222',
    channelId: '',
    historyMessageIds: new Set(),
    historyMessageLog: HISTORY_MESSAGE_LOG,
    liveSignalIds: new Set(),
    liveSignalLog: LIVE_SIGNAL_LOG,
    optionSignalKeys: new Set(),
    optionSignalLog: OPTION_SIGNAL_LOG,
    orderIntentIds: new Set(),
    orderIntentLog: ORDER_INTENT_LOG,
    printAllMessages: false,
    rest: false,
    signalDocDir: SIGNAL_DOC_DIR,
    signalDocTimeZone: process.env.SIGNAL_DOC_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all-events') args.allEvents = true;
    else if (arg === '--cdp') args.cdpEndpoint = argv[++i] || args.cdpEndpoint;
    else if (arg === '--channel-id') args.channelId = argv[++i] || '';
    else if (arg === '--print-all-messages') args.printAllMessages = true;
    else if (arg === '--rest') args.rest = true;
    else if (arg === '--signal-doc-tz') args.signalDocTimeZone = argv[++i] || args.signalDocTimeZone;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }

  if (args.channelId && !/^\d+$/.test(args.channelId)) {
    console.error(`Invalid channel id: ${args.channelId}`);
    process.exit(2);
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  npm run capture
  node .\\capture-discord.js [options]

Options:
  --all-events      Log all Discord gateway dispatch events, not only MESSAGE_CREATE
  --cdp <url>       Browser CDP endpoint, default http://127.0.0.1:9222
  --channel-id <id> Optional: only keep REST message observations for this channel
  --print-all-messages Print non-signal chat messages to console too
  --rest            Also log Discord REST API JSON responses
  --signal-doc-tz <tz> Time zone used for daily signal documents
  -h, --help        Show this help
`.trim());
}

function ensureFile(file) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, UTF8_BOM);
    return;
  }

  const stats = fs.statSync(file);
  if (stats.size === 0) {
    fs.writeFileSync(file, UTF8_BOM);
    return;
  }

  const fd = fs.openSync(file, 'r');
  try {
    const firstBytes = Buffer.alloc(Math.min(3, stats.size));
    fs.readSync(fd, firstBytes, 0, firstBytes.length, 0);
    if (firstBytes.length === 3 && firstBytes.equals(UTF8_BOM)) return;
  } finally {
    fs.closeSync(fd);
  }

  const existing = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([UTF8_BOM, existing]));
}

function ensureDirs(options) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(options.signalDocDir, { recursive: true });
  ensureFile(MESSAGE_LOG);
  ensureFile(options.liveSignalLog);
  ensureFile(options.optionSignalLog);
  ensureFile(options.orderIntentLog);
  ensureFile(options.historyMessageLog);
  ensureFile(RAW_EVENT_LOG);
  if (options.rest) ensureFile(REST_LOG);
  if (!fs.existsSync(STATUS_FILE)) writeStatus({ status: 'created' });
}

function appendJsonLine(file, value) {
  ensureFile(file);
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function readStatus() {
  if (!fs.existsSync(STATUS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8').replace(/^\ufeff/, ''));
  } catch {
    return {};
  }
}

function writeStatus(patch) {
  const status = {
    ...readStatus(),
    ...patch,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(STATUS_FILE, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
}

function displayPath(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readExistingMessageIds(file) {
  const ids = new Set();
  if (!file || !fs.existsSync(file)) return ids;

  const text = stripBom(fs.readFileSync(file, 'utf8'));
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = safeParseJson(line);
    if (record && record.id) ids.add(String(record.id));
  }

  return ids;
}

function readExistingFieldValues(file, field) {
  const values = new Set();
  if (!file || !fs.existsSync(file)) return values;

  const text = stripBom(fs.readFileSync(file, 'utf8'));
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = safeParseJson(line);
    if (record && record[field]) values.add(String(record[field]));
  }

  return values;
}

function isDiscordGateway(url) {
  const lower = String(url || '').toLowerCase();
  return lower.startsWith('wss://gateway') && (lower.includes('discord.gg') || lower.includes('discord.com'));
}

function isDiscordRestApi(url) {
  const lower = String(url || '').toLowerCase();
  return lower.startsWith('https://discord.com/api/') || lower.startsWith('https://canary.discord.com/api/');
}

function parseDiscordChannelMessagesUrl(value) {
  try {
    const url = new URL(value);
    if (!['discord.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname)) return null;

    const match = url.pathname.match(/^\/api\/(?:v\d+\/)?channels\/(\d+)\/messages$/);
    if (!match) return null;

    return {
      channel_id: match[1],
      before: url.searchParams.get('before'),
      after: url.searchParams.get('after'),
      around: url.searchParams.get('around'),
      limit: url.searchParams.get('limit'),
    };
  } catch {
    return null;
  }
}

function looksLikeDiscordMessage(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.channel_id === 'string' &&
    value.author &&
    typeof value.author === 'object' &&
    typeof value.timestamp === 'string' &&
    ('content' in value || 'embeds' in value || 'attachments' in value)
  );
}

function collectDiscordMessages(value, output = []) {
  if (!value || typeof value !== 'object') return output;

  if (looksLikeDiscordMessage(value)) {
    output.push(value);
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectDiscordMessages(item, output);
    return output;
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectDiscordMessages(child, output);
  }

  return output;
}

function endsWith(buffer, suffix) {
  if (buffer.length < suffix.length) return false;
  return suffix.every((byte, index) => buffer[buffer.length - suffix.length + index] === byte);
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function redact(value) {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : redact(child);
  }
  return output;
}

class GatewayZlibDecoder {
  constructor() {
    this.reset();
    this.queue = Promise.resolve();
  }

  reset() {
    this.outputChunks = [];
    this.lastError = null;
    this.inflate = zlib.createInflate();
    this.inflate.on('data', (chunk) => this.outputChunks.push(chunk));
    this.inflate.on('error', (error) => {
      this.lastError = error;
    });
  }

  decode(buffer) {
    this.queue = this.queue.then(() => this.decodeLocked(buffer));
    return this.queue;
  }

  async decodeLocked(buffer) {
    if (!buffer.length) return [];

    if (buffer[0] === 0x7b) {
      const direct = safeParseJson(buffer.toString('utf8'));
      if (direct) return [direct];
    }

    const complete = endsWith(buffer, ZLIB_SUFFIX);

    try {
      await new Promise((resolve, reject) => {
        this.inflate.write(buffer, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      if (!complete) return [];

      await new Promise((resolve) => setImmediate(resolve));
      if (this.lastError) throw this.lastError;

      const text = Buffer.concat(this.outputChunks).toString('utf8');
      this.outputChunks = [];
      const parsed = safeParseJson(text);
      return parsed ? [parsed] : [];
    } catch {
      this.reset();

      try {
        const inflated = zlib.inflateSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        const parsed = safeParseJson(inflated.toString('utf8'));
        return parsed ? [parsed] : [];
      } catch {
        return [];
      }
    }
  }
}

function normalizeUser(author) {
  return {
    id: author && author.id ? author.id : null,
    username: author && author.username ? author.username : null,
    global_name: author && author.global_name ? author.global_name : null,
    discriminator: author && author.discriminator ? author.discriminator : null,
    bot: Boolean(author && author.bot),
  };
}

function normalizeMentions(mentions) {
  return Array.isArray(mentions)
    ? mentions.map((mention) => ({
        id: mention.id,
        username: mention.username,
        global_name: mention.global_name,
        bot: Boolean(mention.bot),
      }))
    : [];
}

function normalizeAttachments(attachments) {
  return Array.isArray(attachments)
    ? attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        url: attachment.url,
        content_type: attachment.content_type,
        size: attachment.size,
      }))
    : [];
}

function normalizeEmbeds(embeds) {
  return Array.isArray(embeds)
    ? embeds.map((embed) => ({
        type: embed.type,
        title: embed.title,
        url: embed.url,
        description: embed.description,
        color: embed.color,
        footer: embed.footer ? { text: embed.footer.text } : null,
        fields: Array.isArray(embed.fields)
          ? embed.fields.map((field) => ({
              name: field.name,
              value: field.value,
              inline: Boolean(field.inline),
            }))
          : [],
      }))
    : [];
}

function normalizeDiscordMessage(data, sourceFields) {
  const capturedAt = sourceFields.captured_at || new Date().toISOString();
  const messageTime = data.timestamp ? Date.parse(data.timestamp) : NaN;
  const capturedTime = Date.parse(capturedAt);
  const captureLagMs = Number.isFinite(messageTime) && Number.isFinite(capturedTime)
    ? capturedTime - messageTime
    : null;

  return {
    ...sourceFields,
    captured_at: capturedAt,
    capture_lag_ms: captureLagMs,
    id: data.id,
    guild_id: data.guild_id || null,
    channel_id: data.channel_id || null,
    type: data.type,
    author: normalizeUser(data.author || {}),
    content: data.content || '',
    timestamp: data.timestamp || null,
    edited_timestamp: data.edited_timestamp || null,
    mention_everyone: Boolean(data.mention_everyone),
    mention_roles: Array.isArray(data.mention_roles) ? data.mention_roles : [],
    mentions: normalizeMentions(data.mentions),
    attachments: normalizeAttachments(data.attachments),
    embeds: normalizeEmbeds(data.embeds),
    pinned: Boolean(data.pinned),
    tts: Boolean(data.tts),
    flags: data.flags,
  };
}

function normalizeGatewayMessage(payload, url) {
  return normalizeDiscordMessage(payload.d || {}, {
    captured_at: new Date().toISOString(),
    event_type: payload.t,
    sequence: payload.s,
    source: 'discord_gateway_websocket',
    gateway_url: url || 'unknown_websocket',
  });
}

function normalizeRestChannelMessage(message, meta) {
  return normalizeDiscordMessage(message, {
    captured_at: new Date().toISOString(),
    event_type: 'REST_CHANNEL_MESSAGES',
    source: 'discord_rest_channel_messages',
    request_url: meta.url,
    request: meta.channel_request,
  });
}

function printMessage(record) {
  const author = record.author.global_name || record.author.username || record.author.id || 'unknown';
  const where = record.guild_id ? `${record.guild_id}/${record.channel_id}` : record.channel_id;
  const content = record.content ? record.content.replace(/\s+/g, ' ') : '[empty content]';
  console.log(`[${record.captured_at}] MESSAGE_CREATE channel=${where} author=${author}: ${content}`);
}

function firstEmbed(record) {
  return record && Array.isArray(record.embeds) && record.embeds.length ? record.embeds[0] : null;
}

function isOptionSignal(record) {
  const embed = firstEmbed(record);
  if (!embed || !embed.title) return false;
  return /^[A-Z][A-Z0-9.-]*\s+\d{4}-\d{2}-\d{2}\s+[0-9]+(?:\.[0-9]+)?[CP]\s+\|/.test(embed.title);
}

function getEmbedField(embed, names) {
  if (!embed || !Array.isArray(embed.fields)) return '';
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const found = embed.fields.find((field) => wanted.has(String(field.name || '').toLowerCase()));
  return found ? String(found.value || '') : '';
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function signalLine(record, sourceLabel) {
  const embed = firstEmbed(record);
  const author = record.author.global_name || record.author.username || record.author.id || 'unknown';
  const title = oneLine(embed.title);
  const execution = oneLine(getEmbedField(embed, ['执行观点', '执行计划', 'decision', '结论']));
  const invalidation = oneLine(getEmbedField(embed, ['失效条件', 'confidence_score']));
  const risk = oneLine(getEmbedField(embed, ['风险提示', '执行要点']));
  const lag = record.capture_lag_ms === null || record.capture_lag_ms === undefined
    ? ''
    : ` lag=${record.capture_lag_ms}ms`;

  const details = [execution, invalidation, risk].filter(Boolean).join(' | ');
  return `[${record.captured_at}] ${sourceLabel} channel=${record.channel_id} id=${record.id}${lag} author=${author} | ${title}${details ? ` | ${details}` : ''}`;
}

function appendLiveSignal(record, options) {
  if (!options.liveSignalLog) return false;
  if (record.id && options.liveSignalIds.has(String(record.id))) return false;

  appendJsonLine(options.liveSignalLog, record);
  if (record.id) options.liveSignalIds.add(String(record.id));
  return true;
}

function appendOptionSignal(signal, options) {
  if (!options.optionSignalLog) return false;
  if (signal.signal_key && options.optionSignalKeys.has(signal.signal_key)) return false;

  stampSignalLogTimes(signal, new Date().toISOString(), 'live_capture');
  appendJsonLine(options.optionSignalLog, signal);
  if (signal.signal_key) options.optionSignalKeys.add(signal.signal_key);
  return true;
}

function appendOrderIntent(intent, options) {
  if (!intent || !options.orderIntentLog) return false;
  if (intent.message_id && options.orderIntentIds.has(String(intent.message_id))) return false;

  appendJsonLine(options.orderIntentLog, intent);
  if (intent.message_id) options.orderIntentIds.add(String(intent.message_id));
  return true;
}

function processOptionAdvice(record, observedVia, options) {
  const signal = parseOptionSignal(record, observedVia);
  if (!signal) return false;

  const added = appendOptionSignal(signal, options);
  if (observedVia === 'LIVE_SIGNAL') {
    appendLiveSignal(record, options);
  }

  if (added) {
    const intent = buildOrderIntent(signal);
    if (appendOrderIntent(intent, options)) {
      console.log(`[${intent.created_at}] ORDER_INTENT ${intent.action} ${intent.ticker} ${intent.expiration} ${intent.strike}${intent.option_type} status=${intent.status}`);
    }
    const docFile = appendSignalDocument({
      signal,
      record,
      intent,
      signalDocDir: options.signalDocDir,
      timeZone: options.signalDocTimeZone,
    });
    writeStatus({
      status: 'capturing',
      last_option_signal_at: signal.logged_at,
      last_option_signal_message_id: signal.message_id,
      last_option_signal_title: signal.title,
      last_option_signal_channel_id: signal.channel_id,
      last_option_signal_received_at: signal.received_at,
      last_order_intent_message_id: intent ? intent.message_id : null,
    });
    console.log(formatSignalLine(signal));
    console.log(`[${signal.logged_at}] SIGNAL_DOC ${displayPath(docFile)} received_to_logged=${signal.received_to_logged_lag_ms}ms id=${signal.message_id}`);
  }

  return true;
}

function appendHistoryMessage(record, options) {
  if (!options.historyMessageLog) return false;
  if (options.channelId && record.channel_id !== options.channelId) return false;
  if (record.id && options.historyMessageIds.has(String(record.id))) return false;

  appendJsonLine(options.historyMessageLog, record);
  if (record.id) options.historyMessageIds.add(String(record.id));
  return true;
}

function printRestCaptureSummary(channelRequest, fetchedCount, newCount, url) {
  const cursor = channelRequest && channelRequest.before
    ? ` before=${channelRequest.before}`
    : channelRequest && channelRequest.after
      ? ` after=${channelRequest.after}`
      : channelRequest && channelRequest.around
        ? ` around=${channelRequest.around}`
        : '';
  const channel = channelRequest && channelRequest.channel_id ? channelRequest.channel_id : 'embedded';
  console.log(
    `[${new Date().toISOString()}] REST_MESSAGES channel=${channel} fetched=${fetchedCount} new=${newCount}${cursor} url=${url}`
  );
}

function handleRestMessagesPayload(parsed, meta, options) {
  const messages = collectDiscordMessages(parsed);
  if (!messages.length) return;

  let newCount = 0;
  let newSignalCount = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = normalizeRestChannelMessage(message, meta);
    if (appendHistoryMessage(record, options)) {
      newCount += 1;
      if (processOptionAdvice(record, 'REST_SIGNAL', options)) {
        newSignalCount += 1;
      }
    }
  }

  printRestCaptureSummary(meta.channel_request, messages.length, newCount, meta.url);
  if (newSignalCount) {
    const channel = meta.channel_request && meta.channel_request.channel_id ? meta.channel_request.channel_id : 'embedded';
    console.log(`[${new Date().toISOString()}] REST_SIGNAL_COUNT channel=${channel} new_signals=${newSignalCount}`);
  }
}

function handleGatewayPayload(payload, url, options) {
  if (!payload || typeof payload !== 'object') return;

  const isDispatch = payload.op === 0 && typeof payload.t === 'string';
  if (!isDispatch) return;
  const isMessageEvent = payload.t === 'MESSAGE_CREATE' || payload.t === 'MESSAGE_UPDATE';
  if (!options.allEvents && !isMessageEvent) return;

  const rawRecord = {
    captured_at: new Date().toISOString(),
    source: 'discord_gateway_websocket',
    gateway_url: url || 'unknown_websocket',
    op: payload.op,
    event_type: payload.t,
    sequence: payload.s,
    data: redact(payload.d),
  };
  appendJsonLine(RAW_EVENT_LOG, rawRecord);
  writeStatus({
    status: 'capturing',
    last_gateway_event_at: rawRecord.captured_at,
    last_gateway_event_type: payload.t,
    last_gateway_sequence: payload.s,
  });

  if (isMessageEvent) {
    const messageRecord = normalizeGatewayMessage(payload, url);
    appendJsonLine(MESSAGE_LOG, messageRecord);
    writeStatus({
      status: 'capturing',
      last_message_at: messageRecord.captured_at,
      last_message_id: messageRecord.id,
      last_message_channel_id: messageRecord.channel_id,
      last_message_event_type: messageRecord.event_type,
    });
    if (!processOptionAdvice(messageRecord, 'LIVE_SIGNAL', options) && options.printAllMessages) {
      printMessage(messageRecord);
    }
  } else if (options.allEvents) {
    console.log(`[${rawRecord.captured_at}] ${payload.t}`);
  }
}

async function attachNetworkCapture(context, page, options) {
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');

  const websocketUrls = new Map();
  const decoders = new Map();
  const restResponses = new Map();

  client.on('Network.webSocketCreated', ({ requestId, url }) => {
    websocketUrls.set(requestId, url);
    if (isDiscordGateway(url)) {
      decoders.set(requestId, new GatewayZlibDecoder());
      writeStatus({
        status: 'capturing',
        last_gateway_connected_at: new Date().toISOString(),
        last_gateway_url: url,
      });
      console.log(`Discord gateway connected: ${url}`);
    }
  });

  client.on('Network.webSocketClosed', ({ requestId }) => {
    websocketUrls.delete(requestId);
    decoders.delete(requestId);
  });

  client.on('Network.webSocketFrameReceived', async ({ requestId, response }) => {
    const knownUrl = websocketUrls.get(requestId) || '';
    if (knownUrl && !isDiscordGateway(knownUrl)) return;

    if (response.opcode === 1) {
      const payload = safeParseJson(response.payloadData);
      handleGatewayPayload(payload, knownUrl, options);
      return;
    }

    if (response.opcode !== 2) return;

    let decoder = decoders.get(requestId);
    if (!decoder) {
      decoder = new GatewayZlibDecoder();
      decoders.set(requestId, decoder);
    }

    const frameBuffer = Buffer.from(response.payloadData || '', 'base64');
    const payloads = await decoder.decode(frameBuffer);
    for (const payload of payloads) {
      handleGatewayPayload(payload, knownUrl, options);
    }
  });

  client.on('Network.responseReceived', ({ requestId, response }) => {
    if (!String(response.mimeType || '').includes('json')) return;

    const channelRequest = parseDiscordChannelMessagesUrl(response.url);
    const scanDiscordMessages = isDiscordRestApi(response.url);
    const captureChannelMessages = Boolean(
      channelRequest && (!options.channelId || channelRequest.channel_id === options.channelId)
    );
    const captureRawRest = options.rest && isDiscordRestApi(response.url);

    if (!scanDiscordMessages && !captureChannelMessages && !captureRawRest) return;

    restResponses.set(requestId, {
      captured_at: new Date().toISOString(),
      scan_discord_messages: scanDiscordMessages,
      capture_channel_messages: captureChannelMessages,
      capture_raw_rest: captureRawRest,
      channel_request: channelRequest,
      source: 'discord_rest_response',
      url: response.url,
      status: response.status,
      status_text: response.statusText,
      mime_type: response.mimeType,
    });
  });

  client.on('Network.loadingFinished', async ({ requestId }) => {
    const meta = restResponses.get(requestId);
    if (!meta) return;
    restResponses.delete(requestId);

    try {
      const body = await client.send('Network.getResponseBody', { requestId });
      const parsed = body.base64Encoded
        ? safeParseJson(Buffer.from(body.body, 'base64').toString('utf8'))
        : safeParseJson(body.body);

      if (meta.scan_discord_messages) {
        handleRestMessagesPayload(parsed, meta, options);
      }

      if (meta.capture_raw_rest) {
        appendJsonLine(REST_LOG, {
          ...meta,
          body: redact(parsed || body.body),
        });
      }
    } catch (error) {
      if (meta.capture_raw_rest) {
        appendJsonLine(REST_LOG, {
          ...meta,
          error: String(error.message || error),
        });
      }
    }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.signalDocTimeZone = resolveTimeZone(options.signalDocTimeZone);
  ensureDirs(options);
  writeStatus({
    status: 'starting',
    started_at: new Date().toISOString(),
    cdp_endpoint: options.cdpEndpoint,
    signal_doc_dir: displayPath(options.signalDocDir),
    signal_doc_timezone: options.signalDocTimeZone,
    note: 'Refresh Discord after this listener is attached so the compressed gateway websocket starts from the beginning.',
  });
  if (options.liveSignalLog) {
    options.liveSignalIds = readExistingMessageIds(options.liveSignalLog);
  }
  if (options.optionSignalLog) {
    options.optionSignalKeys = readExistingFieldValues(options.optionSignalLog, 'signal_key');
  }
  if (options.orderIntentLog) {
    options.orderIntentIds = readExistingFieldValues(options.orderIntentLog, 'message_id');
  }
  if (options.historyMessageLog) {
    options.historyMessageIds = readExistingMessageIds(options.historyMessageLog);
  }

  console.log(`CDP endpoint: ${options.cdpEndpoint}`);
  console.log(`Message log: ${displayPath(MESSAGE_LOG)}`);
  console.log(`Live signal log: ${displayPath(options.liveSignalLog)}`);
  console.log(`Unified option signal log: ${displayPath(options.optionSignalLog)}`);
  console.log(`Order intent log: ${displayPath(options.orderIntentLog)}`);
  console.log(`Daily signal documents: ${displayPath(options.signalDocDir)}/*.md timezone=${options.signalDocTimeZone}`);
  console.log(`History message API log: ${displayPath(options.historyMessageLog)}`);
  console.log('Console output: option advice only. Use --print-all-messages to also print ordinary chat.');
  if (options.channelId) {
    console.log(`History API channel filter: ${options.channelId}`);
  } else {
    console.log('History API capture: all Discord /channels/{id}/messages responses.');
  }
  console.log('Run .\\start-discord-cdp.ps1 first, then open or refresh Discord after this listener is attached.');
  console.log('This process only listens to browser network events. It does not control the page.');

  let browser;
  try {
    browser = await chromium.connectOverCDP(options.cdpEndpoint);
  } catch (error) {
    console.error(`Failed to connect to CDP endpoint: ${options.cdpEndpoint}`);
    console.error('Start the browser first: .\\start-discord-cdp.ps1');
    console.error(error.message || error);
    process.exit(1);
  }
  const attachedPages = new WeakSet();

  const attachPage = async (context, page) => {
    if (attachedPages.has(page)) return;
    attachedPages.add(page);
    await attachNetworkCapture(context, page, options);
  };

  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      await attachPage(context, page);
    }
    context.on('page', (page) => {
      attachPage(context, page).catch((error) => {
        console.error(`Failed to attach page: ${error.message || error}`);
      });
    });
  }

  const pageCount = browser.contexts().reduce((count, context) => count + context.pages().length, 0);
  writeStatus({
    status: 'attached',
    attached_at: new Date().toISOString(),
    attached_page_count: pageCount,
  });
  console.log(`Attached to ${pageCount} existing page(s). Press Ctrl+C to stop.`);
  process.stdin.resume();

  process.on('SIGINT', () => {
    console.log('\nStopping capture...');
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
