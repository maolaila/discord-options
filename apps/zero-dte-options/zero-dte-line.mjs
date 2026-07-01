import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  PROJECT_ROOT,
  ensureDir,
  loadMoomooConfig,
  parseCliArgs,
} from '../../packages/moomoo-opend/moomoo-opend.mjs';
import {
  businessLineLogPath,
  moomooConfigOptionsForBusinessLine,
  resolveBusinessLine,
} from '../../packages/business-lines/business-lines.mjs';

const args = parseCliArgs();
const businessLine = resolveBusinessLine('zero-dte-options');
const statusPath = businessLineLogPath(businessLine, 'status.json');

function isTruthyFlag(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

async function writeStatus(payload) {
  await ensureDir(path.dirname(statusPath));
  await fsp.writeFile(statusPath, `${JSON.stringify({ updated_at: new Date().toISOString(), ...payload }, null, 2)}\n`, 'utf8');
}

const requestedExecution = isTruthyFlag(args.watch)
  || isTruthyFlag(args['execute-simulate'])
  || isTruthyFlag(args['execute-real']);
const config = loadMoomooConfig(moomooConfigOptionsForBusinessLine(businessLine, args));
const status = {
  phase: 'disabled_pending_development',
  business_line: businessLine.key,
  enabled: businessLine.enabled,
  policy_path: path.relative(PROJECT_ROOT, config.policyPath),
  required_advice_format: config.requiredAdviceFormat,
  reason: '0DTE/Nightwatch is intentionally isolated from the PA options simulator and has not been implemented as a trading line yet.',
};

await writeStatus(status);
console.log(JSON.stringify(status, null, 2));

if (requestedExecution) {
  throw new Error('0DTE options line is not implemented for trading execution yet.');
}
