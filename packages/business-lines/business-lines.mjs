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
    enabled: false,
    legacyLogPrefixes: ['moomoo'],
  }),
  'zero-dte-options': Object.freeze({
    key: 'zero-dte-options',
    kind: 'options',
    label: 'JUNKMAN GEX 0DTE simulation',
    policyPath: path.join(PROJECT_ROOT, 'config', 'zero-dte-options-policy.json'),
    logPrefix: 'zero-dte-options',
    requiredAdviceFormat: 'gex',
    enabled: true,
    legacyLogPrefixes: [],
  }),
  'junk-multi-options': Object.freeze({
    key: 'junk-multi-options',
    kind: 'options',
    label: 'JUNKMAN Top100 multi-symbol 0DTE simulation',
    policyPath: path.join(PROJECT_ROOT, 'config', 'junk-multi-options-policy.json'),
    logPrefix: 'junk-multi-options',
    requiredAdviceFormat: 'gex',
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
  'junk-gex': 'zero-dte-options',
  junkman: 'zero-dte-options',
  'junk-multi': 'junk-multi-options',
  'junk-top100': 'junk-multi-options',
  'top100-0dte': 'junk-multi-options',
});

export function resolveBusinessLine(value = 'zero-dte-options') {
  const raw = String(value || 'zero-dte-options').trim().toLowerCase();
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
