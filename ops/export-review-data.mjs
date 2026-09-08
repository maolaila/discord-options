import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  statSync,
} from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const identityKeyPattern = /^(?:(?:trd_?)?acc(?:ount)?_?id|simulated_account_id|guild_?id|channel_?id|message_?id|source_message_?id|(?:bot_?)?author_?id|user_?id|user_?name)$/i;
const identityCollectionKeyPattern = /^(?:source_message_ids|decision_source_message_ids|evidence_source_message_ids|author_ids|user_ids)$/i;
const compositeIdentityKeyPattern = /^(?:source_signal_key|signal_key|trade_key|execution_key)$/i;
const secretKeyPattern = /(?:authorization|cookie|password|secret|token|websocket.*key|ws_?key)/i;

export function stableRedaction(value, kind = 'id') {
  const digest = createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
  return `[redacted_${kind}_${digest}]`;
}

function sanitizeString(value) {
  return value
    .replace(/C:\\Users\\[^\\/]+/gi, '<user>')
    .replace(/D:\\discord-options/gi, '<repo>');
}

function sanitizeRawInputString(value) {
  return sanitizeString(value)
    .replace(
      /([?&](?:token|auth|authorization|sig|signature|hm|ex)=)[^&\s]+/gi,
      '$1[redacted_secret]',
    )
    .replace(
      /(?<!\d)\d{17,20}(?!\d)/g,
      (identifier) => stableRedaction(identifier),
    );
}

function sanitizeCompositeIdentity(value) {
  if (value === null || value === undefined || value === '') return value;
  return String(value).replace(
    /(?<!\d)\d{17,20}(?!\d)/g,
    (identifier) => stableRedaction(identifier),
  );
}

function sanitizeRemark(value) {
  if (typeof value !== 'string') return value;
  const discordMatch = value.match(/^discord:(\d{6,20})$/i);
  if (discordMatch) return `discord:${stableRedaction(discordMatch[1])}`;
  return sanitizeString(value);
}

export function sanitizeValue(value, key = '') {
  if (secretKeyPattern.test(key)) return '[redacted_secret]';
  if (identityKeyPattern.test(key)) {
    if (value === null || value === undefined || value === '') return value;
    return stableRedaction(value);
  }
  if (identityCollectionKeyPattern.test(key)) {
    if (!Array.isArray(value)) return stableRedaction(value);
    return value.map((item) => stableRedaction(item));
  }
  if (compositeIdentityKeyPattern.test(key)) return sanitizeCompositeIdentity(value);
  if (/^remark$/i.test(key)) return sanitizeRemark(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeValue(childValue, childKey),
      ]),
    );
  }
  if (typeof value === 'string') return sanitizeString(value);
  return value;
}

export function sanitizeRawInputValue(value, key = '') {
  if (secretKeyPattern.test(key)) return '[redacted_secret]';
  if (identityKeyPattern.test(key)) {
    if (value === null || value === undefined || value === '') return value;
    return stableRedaction(value);
  }
  if (identityCollectionKeyPattern.test(key)) {
    if (!Array.isArray(value)) return stableRedaction(value);
    return value.map((item) => stableRedaction(item));
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRawInputValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeRawInputValue(childValue, childKey),
      ]),
    );
  }
  if (typeof value === 'string') return sanitizeRawInputString(value);
  if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) >= 1e16) {
    return stableRedaction(value);
  }
  return value;
}

function tokyoDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function parseArgs(argv) {
  const options = { date: tokyoDate(), output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--date') options.date = String(argv[++index] || '').trim();
    else if (arg === '--output') options.output = String(argv[++index] || '').trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error('--date must use YYYY-MM-DD.');
  }
  return options;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function exportNdjson({
  source,
  destination,
  gzip = false,
  sanitizer = sanitizeValue,
}) {
  await mkdir(path.dirname(destination), { recursive: true });
  const output = createWriteStream(destination, { encoding: 'utf8' });
  const encoder = gzip ? createGzip({ level: 9 }) : output;
  if (gzip) encoder.pipe(output);

  let recordCount = 0;
  let invalidLineCount = 0;
  const input = createReadStream(source, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line.replace(/^\uFEFF/, ''));
      } catch {
        invalidLineCount += 1;
        continue;
      }
      const rendered = `${JSON.stringify(sanitizer(parsed))}\n`;
      if (!encoder.write(rendered)) await once(encoder, 'drain');
      recordCount += 1;
    }
  } finally {
    encoder.end();
    await finished(output);
  }

  return { record_count: recordCount, invalid_line_count: invalidLineCount };
}

async function exportJson({ source, destination, sanitizer = sanitizeValue }) {
  await mkdir(path.dirname(destination), { recursive: true });
  const parsed = JSON.parse(await readFile(source, 'utf8'));
  await writeFile(destination, `${JSON.stringify(sanitizer(parsed), null, 2)}\n`, 'utf8');
  return { record_count: 1, invalid_line_count: 0 };
}

export const ndjsonSources = [
  ['logs/zero-dte-options-decisions.ndjson', 'junk/zero-dte-options-decisions.ndjson.gz', true],
  ['logs/zero-dte-options-entry-plans.ndjson', 'junk/zero-dte-options-entry-plans.ndjson', false],
  ['logs/zero-dte-options-exit-plans.ndjson', 'junk/zero-dte-options-exit-plans.ndjson', false],
  ['logs/zero-dte-options-trades.ndjson', 'junk/zero-dte-options-trades.ndjson', false],
  ['logs/zero-dte-options-experiment-events.ndjson', 'junk/zero-dte-options-experiment-events.ndjson', false],
  ['logs/zero-dte-options-flow-events.ndjson', 'junk/zero-dte-options-flow-events.ndjson', false],
  ['logs/zero-dte-options-incidents.ndjson', 'junk/zero-dte-options-incidents.ndjson', false],
  ['logs/junk-multi-options-decisions.ndjson', 'junk-multi/junk-multi-options-decisions.ndjson.gz', true],
  ['logs/junk-multi-options-entry-plans.ndjson', 'junk-multi/junk-multi-options-entry-plans.ndjson', false],
  ['logs/junk-multi-options-exit-plans.ndjson', 'junk-multi/junk-multi-options-exit-plans.ndjson', false],
  ['logs/junk-multi-options-trades.ndjson', 'junk-multi/junk-multi-options-trades.ndjson', false],
  ['logs/junk-flow-heatmap-options-decisions.ndjson', 'junk-flow-heatmap/junk-flow-heatmap-options-decisions.ndjson.gz', true],
  ['logs/junk-flow-heatmap-options-entry-plans.ndjson', 'junk-flow-heatmap/junk-flow-heatmap-options-entry-plans.ndjson', false],
  ['logs/junk-flow-heatmap-options-exit-plans.ndjson', 'junk-flow-heatmap/junk-flow-heatmap-options-exit-plans.ndjson', false],
  ['logs/junk-flow-heatmap-options-trades.ndjson', 'junk-flow-heatmap/junk-flow-heatmap-options-trades.ndjson', false],
];

export const rawInputNdjsonSources = [
  ['logs/raw-events.ndjson', 'raw-inputs/discord-gateway-events.ndjson.gz', true],
  ['logs/messages.ndjson', 'raw-inputs/discord-live-messages.ndjson.gz', true],
  ['logs/history-messages.ndjson', 'raw-inputs/discord-history-messages.ndjson.gz', true],
];

export const jsonSources = [
  ['logs/zero-dte-options-runtime-state.json', 'junk/zero-dte-options-runtime-state.json'],
  ['logs/zero-dte-options-status.json', 'junk/zero-dte-options-status.json'],
  ['logs/zero-dte-options-post-deploy-summary.json', 'junk/zero-dte-options-post-deploy-summary.json'],
  ['logs/zero-dte-options-experiment-summary.json', 'junk/zero-dte-options-experiment-summary.json'],
  ['logs/zero-dte-options-oi-structure-background.json', 'junk/zero-dte-options-oi-structure-background.json'],
  ['logs/junk-multi-options-runtime-state.json', 'junk-multi/junk-multi-options-runtime-state.json'],
  ['logs/junk-multi-options-status.json', 'junk-multi/junk-multi-options-status.json'],
  ['logs/junk-multi-options-universe.json', 'junk-multi/junk-multi-options-universe.json'],
  ['logs/junk-multi-options-experiment-summary.json', 'junk-multi/junk-multi-options-experiment-summary.json'],
  ['logs/junk-flow-heatmap-options-runtime-state.json', 'junk-flow-heatmap/junk-flow-heatmap-options-runtime-state.json'],
  ['logs/junk-flow-heatmap-options-status.json', 'junk-flow-heatmap/junk-flow-heatmap-options-status.json'],
  ['logs/junk-flow-heatmap-options-universe.json', 'junk-flow-heatmap/junk-flow-heatmap-options-universe.json'],
  ['logs/junk-flow-heatmap-options-experiment-summary.json', 'junk-flow-heatmap/junk-flow-heatmap-options-experiment-summary.json'],
];

export const rawInputJsonSources = [
  ['logs/capture-status.json', 'raw-inputs/discord-capture-status.json'],
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputRoot = path.resolve(
    projectRoot,
    options.output || path.join('review-data', options.date),
  );
  if (!outputRoot.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error('Review output must stay inside the repository.');
  }
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  const manifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    snapshot_date_jst: options.date,
    public_repository_safe_export: true,
    redaction: {
      credentials: 'replaced',
      account_discord_and_message_ids: 'stable_sha256_aliases',
      local_user_and_repository_paths: 'normalized',
    },
    included_redacted_raw_inputs: [
      'Discord Gateway events captured from the browser session',
      'parsed live and historical Discord messages',
      'Discord capture lifecycle status',
    ],
    excluded: [
      'browser profile and authentication state',
      'real-order and SPCX helper records',
      'general trade journal; strategy-specific structured records retained',
      'SQLite WAL/SHM runtime files; redacted OI JSON snapshots retained',
    ],
    files: [],
  };

  for (const [sourceName, outputName, gzip] of ndjsonSources) {
    const source = path.join(projectRoot, sourceName);
    if (!existsSync(source)) continue;
    const destination = path.join(outputRoot, outputName);
    const counts = await exportNdjson({ source, destination, gzip });
    manifest.files.push({
      source: sourceName,
      output: path.relative(projectRoot, destination).replaceAll('\\', '/'),
      encoding: gzip ? 'gzip_ndjson' : 'ndjson',
      source_bytes: statSync(source).size,
      output_bytes: (await stat(destination)).size,
      sha256: await sha256File(destination),
      ...counts,
    });
  }

  for (const [sourceName, outputName, gzip] of rawInputNdjsonSources) {
    const source = path.join(projectRoot, sourceName);
    if (!existsSync(source)) continue;
    const destination = path.join(outputRoot, outputName);
    const counts = await exportNdjson({
      source,
      destination,
      gzip,
      sanitizer: sanitizeRawInputValue,
    });
    manifest.files.push({
      source: sourceName,
      output: path.relative(projectRoot, destination).replaceAll('\\', '/'),
      encoding: gzip ? 'gzip_ndjson' : 'ndjson',
      dataset_class: 'redacted_raw_input',
      source_bytes: statSync(source).size,
      output_bytes: (await stat(destination)).size,
      sha256: await sha256File(destination),
      ...counts,
    });
  }

  for (const [sourceName, outputName] of jsonSources) {
    const source = path.join(projectRoot, sourceName);
    if (!existsSync(source)) continue;
    const destination = path.join(outputRoot, outputName);
    const counts = await exportJson({ source, destination });
    manifest.files.push({
      source: sourceName,
      output: path.relative(projectRoot, destination).replaceAll('\\', '/'),
      encoding: 'json',
      source_bytes: statSync(source).size,
      output_bytes: (await stat(destination)).size,
      sha256: await sha256File(destination),
      ...counts,
    });
  }

  for (const [sourceName, outputName] of rawInputJsonSources) {
    const source = path.join(projectRoot, sourceName);
    if (!existsSync(source)) continue;
    const destination = path.join(outputRoot, outputName);
    const counts = await exportJson({
      source,
      destination,
      sanitizer: sanitizeRawInputValue,
    });
    manifest.files.push({
      source: sourceName,
      output: path.relative(projectRoot, destination).replaceAll('\\', '/'),
      encoding: 'json',
      dataset_class: 'redacted_raw_input',
      source_bytes: statSync(source).size,
      output_bytes: (await stat(destination)).size,
      sha256: await sha256File(destination),
      ...counts,
    });
  }

  const rawOiDirectory = path.join(projectRoot, 'data/junk-oi-research/raw');
  if (existsSync(rawOiDirectory)) {
    for (const name of (await readdir(rawOiDirectory)).filter((item) => item.endsWith('.json')).sort()) {
      const source = path.join(rawOiDirectory, name);
      const destination = path.join(outputRoot, 'junk/oi-raw', name);
      const counts = await exportJson({ source, destination });
      manifest.files.push({
        source: path.relative(projectRoot, source).replaceAll('\\', '/'),
        output: path.relative(projectRoot, destination).replaceAll('\\', '/'),
        encoding: 'json',
        source_bytes: statSync(source).size,
        output_bytes: (await stat(destination)).size,
        sha256: await sha256File(destination),
        ...counts,
      });
    }
  }

  const invalidLineCount = manifest.files.reduce(
    (sum, item) => sum + Number(item.invalid_line_count || 0),
    0,
  );
  if (invalidLineCount > 0) {
    throw new Error(`Review export refused: ${invalidLineCount} invalid NDJSON line(s) would be omitted.`);
  }

  manifest.files.sort((left, right) => left.output.localeCompare(right.output));
  await writeFile(
    path.join(outputRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  const totalOutputBytes = manifest.files.reduce((sum, item) => sum + item.output_bytes, 0);
  const readme = `# Trading review snapshot ${options.date}\n\n`
    + `Generated from local runtime records at ${manifest.generated_at}. This export is designed for a public repository. Credentials, account identifiers, Discord identifiers, and local user paths are redacted.\n\n`
    + `Files: ${manifest.files.length}\n\n`
    + `Exported bytes: ${totalOutputBytes}\n\n`
    + `The cumulative SPX, MULTI, FLOW, and redacted raw Discord input streams are gzip-compressed NDJSON. Use \`gzip -dc <file>\` or a gzip-capable analysis tool. See \`manifest.json\` for source mapping, counts, hashes, and exclusions.\n`;
  await writeFile(path.join(outputRoot, 'README.md'), readme, 'utf8');

  console.log(JSON.stringify({
    output: path.relative(projectRoot, outputRoot).replaceAll('\\', '/'),
    files: manifest.files.length,
    total_output_bytes: totalOutputBytes,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
