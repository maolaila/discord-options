#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MESSAGE_LOG = path.join(ROOT, 'logs', 'messages.ndjson');
const LIVE_SIGNAL_LOG = path.join(ROOT, 'logs', 'live-signals.ndjson');
const UTF8_BOM = '\ufeff';

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

function isOptionSignal(record) {
  const embed = record && Array.isArray(record.embeds) && record.embeds[0];
  if (!embed || !embed.title) return false;
  return /^[A-Z][A-Z0-9.-]*\s+\d{4}-\d{2}-\d{2}\s+[0-9]+(?:\.[0-9]+)?[CP]\s+\|/.test(embed.title);
}

function main() {
  const signals = readJsonLines(MESSAGE_LOG).filter(isOptionSignal);
  const unique = [];
  const seen = new Set();

  for (const signal of signals) {
    if (seen.has(signal.id)) continue;
    seen.add(signal.id);
    unique.push(signal);
  }

  fs.writeFileSync(
    LIVE_SIGNAL_LOG,
    `${UTF8_BOM}${unique.map((record) => JSON.stringify(record)).join('\n')}${unique.length ? '\n' : ''}`,
    'utf8'
  );

  console.log(`Rebuilt ${path.relative(ROOT, LIVE_SIGNAL_LOG)} with ${unique.length} live signal(s).`);
}

main();
