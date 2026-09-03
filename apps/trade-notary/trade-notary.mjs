import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  concat,
  getBytes,
  isAddress,
  keccak256,
  parseEther,
  toUtf8Bytes,
} from 'ethers';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TRADE_LOG = path.join(ROOT, 'logs', 'zero-dte-options-trades.ndjson');
const DATA_ROOT = path.join(ROOT, 'onchain-data');
const CANONICAL_ROOT = path.join(DATA_ROOT, 'canonical');
const INDEX_PATH = path.join(DATA_ROOT, 'chain-index.json');
const LOCK_PATH = path.join(DATA_ROOT, '.publish.lock');
const SCHEMA_VERSION = 'junkman-trade-batch-v1';
const RECORD_TYPE = 'FILE_PUBLISHED';
const RECORD_TYPE_CODE = 4;
const DEFAULT_STRATEGY_ID = 'junkman-spx-0dte-sim-v1';
const LEDGER_ABI = [
  'function owner() view returns (address)',
  'function commitRecord(bytes32 strategyId, bytes32 recordId, uint8 recordType, bytes32 dataHash, string uri, uint256 sourceTimestamp, string schemaVersion)',
  'event RecordCommitted(bytes32 indexed strategyId, bytes32 indexed recordId, uint8 recordType, bytes32 dataHash, string uri, uint256 sourceTimestamp, string schemaVersion, uint256 committedAt)',
];

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.keys(value).sort().flatMap((key) => (
    value[key] === undefined ? [] : [[key, sortCanonical(value[key])]]
  )));
}

export function canonical_stringify(value) {
  return JSON.stringify(sortCanonical(value));
}

export function canonical_pretty(value) {
  return `${JSON.stringify(sortCanonical(value), null, 2)}\n`;
}

export function canonical_hash(value) {
  return keccak256(toUtf8Bytes(canonical_stringify(value)));
}

export function build_merkle_root(hashes) {
  if (hashes.length === 0) return keccak256(toUtf8Bytes(''));
  let level = hashes.map((hash) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid bytes32 leaf hash.');
    return hash.toLowerCase();
  }).sort();
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] || left;
      next.push(keccak256(concat([getBytes(left), getBytes(right)])));
    }
    level = next;
  }
  return level[0];
}

function readNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).flatMap((line) => {
    const text = line.trim();
    if (!text) return [];
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  });
}

export function notarizable_trade(row) {
  if (row?.event !== 'experiment_line_position_closed') return null;
  if (row.business_line !== 'zero-dte-options') return null;
  if (row.execution_environment !== 'simulate_only') return null;
  if (!row.event_at || !row.plan_id || !row.line_id || !row.code) return null;
  const entryQty = finite(row.entry_qty);
  const entryValue = finite(row.entry_value);
  const exitQty = finite(row.exit_qty);
  const exitValue = finite(row.exit_value);
  const realizedPnl = finite(row.realized_pnl_usd);
  if ([entryQty, entryValue, exitQty, exitValue, realizedPnl].some((value) => value === null)) return null;
  return {
    business_line: 'zero-dte-options',
    code: String(row.code),
    cohort_id: row.cohort_id ? String(row.cohort_id) : null,
    entry_qty: entryQty,
    entry_value: entryValue,
    event_at: new Date(row.event_at).toISOString(),
    execution_environment: 'simulate_only',
    exit_qty: exitQty,
    exit_value: exitValue,
    experiment_id: row.experiment_id ? String(row.experiment_id) : null,
    line_id: String(row.line_id),
    plan_id: String(row.plan_id),
    realized_pnl_usd: realizedPnl,
    signal_id: row.signal_id ? String(row.signal_id) : null,
    strategy: row.strategy ? String(row.strategy) : 'junk_gex_nodes_v3',
    trigger_reason: row.trigger_reason ? String(row.trigger_reason) : null,
  };
}

export function extract_notarizable_trades(events) {
  const byHash = new Map();
  for (const event of events) {
    const trade = notarizable_trade(event);
    if (!trade) continue;
    const leafHash = canonical_hash(trade);
    if (!byHash.has(leafHash)) byHash.set(leafHash, { ...trade, leaf_hash: leafHash });
  }
  return [...byHash.values()].sort((left, right) => (
    left.event_at.localeCompare(right.event_at)
      || left.line_id.localeCompare(right.line_id)
      || left.leaf_hash.localeCompare(right.leaf_hash)
  ));
}

function defaultIndex() {
  return { schema_version: 1, batches: [] };
}

function readIndex(indexPath = INDEX_PATH) {
  if (!fs.existsSync(indexPath)) return defaultIndex();
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return Array.isArray(parsed?.batches) ? parsed : defaultIndex();
  } catch {
    throw new Error('On-chain index is invalid JSON; refusing to publish until repaired.');
  }
}

function committedLeafHashes(index) {
  return new Set((index?.batches || []).flatMap((batch) => batch.leaf_hashes || []));
}

export function prepare_trade_batch({ events, index = defaultIndex(), strategyId = DEFAULT_STRATEGY_ID } = {}) {
  const allTrades = extract_notarizable_trades(events || []);
  const committed = committedLeafHashes(index);
  const trades = allTrades.filter((trade) => !committed.has(trade.leaf_hash));
  if (trades.length === 0) return null;
  const leafHashes = trades.map((trade) => trade.leaf_hash);
  const sourceTimestamp = trades.at(-1).event_at;
  const batch = {
    record_type: RECORD_TYPE,
    schema_version: SCHEMA_VERSION,
    strategy_id: strategyId,
    source_timestamp: sourceTimestamp,
    source: {
      business_line: 'zero-dte-options',
      execution_environment: 'simulate_only',
      pnl_basis: 'gross_option_price_change',
      fees_included: false,
    },
    range: {
      first_event_at: trades[0].event_at,
      last_event_at: sourceTimestamp,
      trade_line_record_count: trades.length,
    },
    merkle: {
      algorithm: 'keccak256-canonical-json-sorted-pairs-v1',
      leaf_count: leafHashes.length,
      root: build_merkle_root(leafHashes),
    },
    trades,
  };
  const dataHash = canonical_hash(batch);
  const recordId = keccak256(toUtf8Bytes(`${strategyId}|${RECORD_TYPE}|${sourceTimestamp}|${dataHash}`));
  return { batch, dataHash, recordId, leafHashes };
}

function resolveConfig(root = ROOT) {
  dotenv.config({ path: path.join(root, '.env'), override: false, quiet: true });
  const network = process.env.DEFAULT_NETWORK || 'base-mainnet';
  if (!['base-mainnet', 'base-sepolia'].includes(network)) throw new Error(`Unsupported on-chain network: ${network}`);
  const mainnet = network === 'base-mainnet';
  const rpcUrl = mainnet ? process.env.BASE_MAINNET_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL;
  const ledgerAddress = mainnet ? process.env.BASE_MAINNET_LEDGER_ADDRESS : process.env.BASE_SEPOLIA_LEDGER_ADDRESS;
  const startBlock = finite(mainnet ? process.env.BASE_MAINNET_LEDGER_START_BLOCK : process.env.BASE_SEPOLIA_LEDGER_START_BLOCK, 0);
  const privateKeyPath = path.resolve(root, process.env.EVM_PRIVATE_KEY_FILE || './secrets/evm_private_key.txt');
  const strategyId = process.env.JUNKMAN_ONCHAIN_STRATEGY_ID || DEFAULT_STRATEGY_ID;
  const maxGasEth = process.env.ONCHAIN_MAX_GAS_ETH_PER_TX || '0.0005';
  if (!rpcUrl) throw new Error(`Missing RPC URL for ${network}.`);
  if (!ledgerAddress || !isAddress(ledgerAddress)) throw new Error(`Missing or invalid ledger address for ${network}.`);
  if (!fs.existsSync(privateKeyPath)) throw new Error('EVM private key file is missing.');
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8').trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('EVM private key file is invalid.');
  return {
    network,
    chainId: mainnet ? 8453 : 84532,
    rpcUrl,
    ledgerAddress,
    startBlock,
    privateKey: privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`,
    strategyId,
    maxGasWei: parseEther(maxGasEth),
    explorerBaseUrl: mainnet ? 'https://basescan.org' : 'https://sepolia.basescan.org',
  };
}

async function atomicWriteJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, canonical_pretty(value), 'utf8');
  await fsp.rename(temporary, filePath);
}

async function withPublishLock(action) {
  await fsp.mkdir(DATA_ROOT, { recursive: true });
  try {
    const stat = await fsp.stat(LOCK_PATH);
    if (Date.now() - stat.mtimeMs > 15 * 60 * 1000) await fsp.unlink(LOCK_PATH);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let handle;
  try {
    handle = await fsp.open(LOCK_PATH, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('A trade-record publication is already running.');
    throw error;
  }
  try {
    return await action();
  } finally {
    await handle?.close().catch(() => {});
    await fsp.unlink(LOCK_PATH).catch(() => {});
  }
}

function publicConfig(config) {
  return {
    network: config.network,
    chain_id: config.chainId,
    contract_address: config.ledgerAddress,
    strategy_id: config.strategyId,
    explorer_base_url: config.explorerBaseUrl,
  };
}

function fileNameFor(prepared) {
  const firstDate = prepared.batch.range.first_event_at.slice(0, 10);
  const lastDate = prepared.batch.range.last_event_at.slice(0, 10);
  return `junkman-batch_${firstDate}_${lastDate}_${prepared.recordId.slice(2, 10)}.json`;
}

export function trade_notary_status() {
  const index = readIndex();
  let config = null;
  let configError = null;
  try {
    config = publicConfig(resolveConfig());
  } catch (error) {
    configError = error.message;
  }
  const latest = index.batches.at(-1) || null;
  return {
    configured: Boolean(config),
    config_error: configError,
    ...config,
    committed_batch_count: index.batches.length,
    committed_trade_line_record_count: committedLeafHashes(index).size,
    latest_batch: latest ? {
      record_id: latest.record_id,
      data_hash: latest.data_hash,
      tx_hash: latest.tx_hash,
      block_number: latest.block_number,
      committed_at: latest.committed_at,
      trade_line_record_count: latest.trade_line_record_count,
      explorer_url: latest.explorer_url,
    } : null,
  };
}

export async function publish_new_trade_records({ dryRun = false } = {}) {
  return withPublishLock(async () => {
    const config = resolveConfig();
    const index = readIndex();
    const events = readNdjson(TRADE_LOG);
    const prepared = prepare_trade_batch({ events, index, strategyId: config.strategyId });
    if (!prepared) return { status: 'already_current', ...trade_notary_status() };

    const canonicalPath = path.join(CANONICAL_ROOT, fileNameFor(prepared));
    await atomicWriteJson(canonicalPath, prepared.batch);
    const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
    const wallet = new Wallet(config.privateKey, provider);
    const contract = new Contract(config.ledgerAddress, LEDGER_ABI, wallet);
    const owner = String(await contract.owner());
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error('Configured wallet is not the ledger contract owner.');
    }
    const args = [
      keccak256(toUtf8Bytes(config.strategyId)),
      prepared.recordId,
      RECORD_TYPE_CODE,
      prepared.dataHash,
      '',
      BigInt(Math.floor(new Date(prepared.batch.source_timestamp).getTime() / 1000)),
      SCHEMA_VERSION,
    ];
    const gas = await contract.commitRecord.estimateGas(...args);
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice;
    if (!maxFeePerGas) throw new Error('Unable to determine Base transaction fee.');
    const estimatedMaxGasWei = gas * maxFeePerGas;
    if (estimatedMaxGasWei > config.maxGasWei) {
      throw new Error('Estimated Base transaction fee exceeds ONCHAIN_MAX_GAS_ETH_PER_TX.');
    }
    if (dryRun) {
      return {
        status: 'dry_run',
        ...publicConfig(config),
        record_id: prepared.recordId,
        data_hash: prepared.dataHash,
        merkle_root: prepared.batch.merkle.root,
        trade_line_record_count: prepared.leafHashes.length,
        estimated_gas: gas.toString(),
        estimated_max_gas_wei: estimatedMaxGasWei.toString(),
        canonical_path: path.relative(ROOT, canonicalPath).replaceAll('\\', '/'),
      };
    }

    const transaction = await contract.commitRecord(...args);
    const receipt = await transaction.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error('Base transaction was not confirmed successfully.');
    const ledgerInterface = new Interface(LEDGER_ABI);
    const committedEvent = receipt.logs.flatMap((log) => {
      try {
        const parsed = ledgerInterface.parseLog(log);
        return parsed?.name === 'RecordCommitted' ? [parsed] : [];
      } catch {
        return [];
      }
    }).find((event) => String(event.args.recordId).toLowerCase() === prepared.recordId.toLowerCase());
    if (!committedEvent || String(committedEvent.args.dataHash).toLowerCase() !== prepared.dataHash.toLowerCase()) {
      throw new Error('Confirmed receipt did not contain the expected RecordCommitted proof.');
    }

    const committedAt = new Date().toISOString();
    const row = {
      record_id: prepared.recordId,
      data_hash: prepared.dataHash,
      merkle_root: prepared.batch.merkle.root,
      leaf_hashes: prepared.leafHashes,
      trade_line_record_count: prepared.leafHashes.length,
      source_timestamp: prepared.batch.source_timestamp,
      schema_version: SCHEMA_VERSION,
      strategy_id: config.strategyId,
      network: config.network,
      chain_id: config.chainId,
      contract_address: config.ledgerAddress,
      tx_hash: transaction.hash,
      block_number: Number(receipt.blockNumber),
      committed_at: committedAt,
      canonical_path: path.relative(ROOT, canonicalPath).replaceAll('\\', '/'),
      explorer_url: `${config.explorerBaseUrl}/tx/${transaction.hash}`,
    };
    index.batches.push(row);
    await atomicWriteJson(INDEX_PATH, index);
    return {
      status: 'committed',
      ...publicConfig(config),
      record_id: row.record_id,
      data_hash: row.data_hash,
      merkle_root: row.merkle_root,
      trade_line_record_count: row.trade_line_record_count,
      source_timestamp: row.source_timestamp,
      schema_version: row.schema_version,
      tx_hash: row.tx_hash,
      block_number: row.block_number,
      committed_at: row.committed_at,
      canonical_path: row.canonical_path,
      explorer_url: row.explorer_url,
    };
  });
}
