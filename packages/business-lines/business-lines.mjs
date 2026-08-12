import path from 'node:path';
import { PROJECT_ROOT } from '../moomoo-opend/moomoo-opend.mjs';

export const BUSINESS_LINES = Object.freeze({
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
});

const aliases = Object.freeze({
  '0dte': 'zero-dte-options',
  'zero-dte': 'zero-dte-options',
  zerodte: 'zero-dte-options',
  'junk-gex': 'zero-dte-options',
  junkman: 'zero-dte-options',
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
