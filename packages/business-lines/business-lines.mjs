import path from 'node:path';
import { PROJECT_ROOT } from '../moomoo-opend/moomoo-opend.mjs';

export const BUSINESS_LINES = Object.freeze({
  'pa-options': Object.freeze({
    key: 'pa-options',
    kind: 'options',
    label: 'PA options simulation',
    policyPath: path.join(PROJECT_ROOT, 'config', 'pa-options-policy.json'),
    logPrefix: 'pa-options',
    requiredAdviceFormat: 'pa',
    enabled: true,
    legacyLogPrefixes: ['moomoo'],
  }),
  'zero-dte-options': Object.freeze({
    key: 'zero-dte-options',
    kind: 'options',
    label: '0DTE options',
    policyPath: path.join(PROJECT_ROOT, 'config', 'zero-dte-options-policy.json'),
    logPrefix: 'zero-dte-options',
    requiredAdviceFormat: 'flow',
    enabled: false,
    legacyLogPrefixes: [],
  }),
  'stock-rebalance': Object.freeze({
    key: 'stock-rebalance',
    kind: 'stock-rebalance',
    label: 'Stock rebalance',
    policyPath: path.join(PROJECT_ROOT, 'config', 'stock-rebalance-policy.json'),
    logPrefix: 'stock-rebalance',
    enabled: true,
    legacyLogPrefixes: [],
  }),
  'atr-stop': Object.freeze({
    key: 'atr-stop',
    kind: 'risk-control',
    label: 'ATR trailing stop',
    policyPath: path.join(PROJECT_ROOT, 'config', 'atr-stop-policy.json'),
    logPrefix: 'atr-stop',
    enabled: true,
    legacyLogPrefixes: [],
  }),
});

const aliases = Object.freeze({
  pa: 'pa-options',
  'pa-option': 'pa-options',
  'pa-options-sim': 'pa-options',
  options: 'pa-options',
  'options-sim': 'pa-options',
  moomoo: 'pa-options',
  '0dte': 'zero-dte-options',
  'zero-dte': 'zero-dte-options',
  zerodte: 'zero-dte-options',
  flow: 'zero-dte-options',
  stock: 'stock-rebalance',
  rebalance: 'stock-rebalance',
  atr: 'atr-stop',
  'atr-trailing-stop': 'atr-stop',
  stop: 'atr-stop',
  'risk-control': 'atr-stop',
});

export function resolveBusinessLine(value = 'pa-options') {
  const raw = String(value || 'pa-options').trim().toLowerCase();
  const key = aliases[raw] || raw;
  const line = BUSINESS_LINES[key];
  if (!line) {
    throw new Error(`Unknown business line: ${value}. Expected one of ${Object.keys(BUSINESS_LINES).join(', ')}.`);
  }
  return line;
}

export function assertBusinessLineKind(line, kind) {
  const resolved = typeof line === 'string' ? resolveBusinessLine(line) : line;
  if (resolved.kind !== kind) {
    throw new Error(`${resolved.key} is a ${resolved.kind} business line, not ${kind}.`);
  }
  return resolved;
}

export function businessLinePolicyFile(line, args = {}) {
  const resolved = typeof line === 'string' ? resolveBusinessLine(line) : line;
  return args['policy-file'] || args.policy || resolved.policyPath || undefined;
}

export function businessLineLogPath(line, suffix) {
  const resolved = typeof line === 'string' ? resolveBusinessLine(line) : line;
  return path.join(PROJECT_ROOT, 'logs', `${resolved.logPrefix}-${suffix}`);
}

export function legacyBusinessLineLogPaths(line, suffix) {
  const resolved = typeof line === 'string' ? resolveBusinessLine(line) : line;
  return (resolved.legacyLogPrefixes || []).map((prefix) => path.join(PROJECT_ROOT, 'logs', `${prefix}-${suffix}`));
}

export function moomooConfigOptionsForBusinessLine(line, args = {}) {
  const resolved = typeof line === 'string' ? resolveBusinessLine(line) : line;
  const opts = {
    envFile: args.env,
    businessLine: resolved.key,
    policyFile: businessLinePolicyFile(resolved, args),
  };
  if (resolved.requiredAdviceFormat) {
    opts.requiredAdviceFormat = resolved.requiredAdviceFormat;
  }
  return opts;
}
