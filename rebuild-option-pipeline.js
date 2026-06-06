#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
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

const ROOT = __dirname;
const LOG_DIR = path.join(ROOT, 'logs');
const MESSAGE_LOG = path.join(LOG_DIR, 'messages.ndjson');
const HISTORY_LOG = path.join(LOG_DIR, 'history-messages.ndjson');
const LIVE_SIGNAL_LOG = path.join(LOG_DIR, 'live-signals.ndjson');
const OPTION_SIGNAL_LOG = path.join(LOG_DIR, 'option-signals.ndjson');
const ORDER_INTENT_LOG = path.join(LOG_DIR, 'order-intents.ndjson');
const UTF8_BOM = '\ufeff';

function parseArgs(argv) {
  const args = {
    writeDocs: false,
    signalDocDir: path.join(ROOT, 'signal-docs', `rebuild-${new Date().toISOString().replace(/[:.]/g, '-')}`),
    signalDocTimeZone: process.env.SIGNAL_DOC_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write-docs') args.writeDocs = true;
    else if (arg === '--doc-dir') args.signalDocDir = path.resolve(argv[++i] || args.signalDocDir);
    else if (arg === '--signal-doc-tz') args.signalDocTimeZone = argv[++i] || args.signalDocTimeZone;
    else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  args.signalDocTimeZone = resolveTimeZone(args.signalDocTimeZone);
  return args;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const text = stripBom(fs.readFileSync(file, 'utf8'));
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function writeJsonLines(file, rows) {
  fs.writeFileSync(
    file,
    `${UTF8_BOM}${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`,
    'utf8'
  );
}

function uniqueBy(rows, keyFn) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const liveMessages = readJsonLines(MESSAGE_LOG);
  const historyMessages = readJsonLines(HISTORY_LOG);

  const liveSignals = [];
  const optionSignalEntries = [];
  const orderIntents = [];
  const rebuildLoggedAt = new Date().toISOString();

  for (const record of liveMessages) {
    const signal = parseOptionSignal(record, 'LIVE_SIGNAL');
    if (!signal) continue;
    liveSignals.push(record);
    optionSignalEntries.push({ signal, record });
  }

  for (const record of historyMessages) {
    const signal = parseOptionSignal(record, 'REST_SIGNAL');
    if (!signal) continue;
    optionSignalEntries.push({ signal, record });
  }

  const uniqueLiveSignals = uniqueBy(liveSignals, (record) => record.id);
  const uniqueOptionSignalEntries = uniqueBy(optionSignalEntries, (entry) => entry.signal.signal_key);
  for (const entry of uniqueOptionSignalEntries) {
    stampSignalLogTimes(entry.signal, rebuildLoggedAt, 'rebuild_from_existing_logs');
  }
  const uniqueOptionSignals = uniqueOptionSignalEntries.map((entry) => entry.signal);

  for (const entry of uniqueOptionSignalEntries) {
    const { signal, record } = entry;
    const intent = buildOrderIntent(signal);
    if (intent) orderIntents.push(intent);
    if (options.writeDocs) {
      appendSignalDocument({
        signal,
        record,
        intent,
        signalDocDir: options.signalDocDir,
        timeZone: options.signalDocTimeZone,
      });
    }
  }
  const uniqueOrderIntents = uniqueBy(orderIntents, (intent) => intent.message_id);

  writeJsonLines(LIVE_SIGNAL_LOG, uniqueLiveSignals);
  writeJsonLines(OPTION_SIGNAL_LOG, uniqueOptionSignals);
  writeJsonLines(ORDER_INTENT_LOG, uniqueOrderIntents);

  const recent = uniqueOptionSignals.slice(-5).map(formatSignalLine);
  console.log(JSON.stringify({
    live_signals: uniqueLiveSignals.length,
    option_signal_observations: uniqueOptionSignals.length,
    order_intents: uniqueOrderIntents.length,
    signal_documents: options.writeDocs ? options.signalDocDir : null,
    recent,
  }, null, 2));
}

main();
