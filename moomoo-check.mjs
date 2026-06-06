import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  PROJECT_ROOT,
  connectMoomoo,
  ensureDir,
  fetchGlobalState,
  fetchMoomooAccounts,
  loadMoomooConfig,
  maskId,
  normalizeForJson,
  parseCliArgs,
  summarizeAccounts,
} from './moomoo-opend.mjs';

const args = parseCliArgs();
const config = loadMoomooConfig({ envFile: args.env });

const printableConfig = {
  envFile: config.envFile || '',
  envLoaded: config.envLoaded,
  host: config.host,
  websocketPort: config.websocketPort,
  websocketSsl: config.websocketSsl,
  websocketKeyLoaded: Boolean(config.websocketKey),
  accId: maskId(config.accId),
  trdEnv: config.trdEnv,
  trdMarket: config.trdMarket,
  jpAccType: config.jpAccType,
};

let connection;
try {
  connection = await connectMoomoo(config);
  const [globalState, accounts] = await Promise.all([
    fetchGlobalState(connection.client),
    fetchMoomooAccounts(connection.client),
  ]);

  const payload = {
    checked_at: new Date().toISOString(),
    config: printableConfig,
    global_state: normalizeForJson(globalState),
    account_summary: summarizeAccounts(accounts).map(({ rawAccID, ...summary }) => summary),
    accounts_raw: normalizeForJson(accounts),
  };

  const logsDir = path.join(PROJECT_ROOT, 'logs');
  await ensureDir(logsDir);
  const outPath = path.join(logsDir, 'moomoo-check.json');
  await fsp.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log('OpenD connection: OK');
  console.log(`Config: host=${config.host} ws_port=${config.websocketPort} ssl=${config.websocketSsl} key_loaded=${Boolean(config.websocketKey)}`);
  console.log(`Global: qotLogined=${Boolean(globalState.s2c?.qotLogined)} trdLogined=${Boolean(globalState.s2c?.trdLogined)} marketUS=${globalState.s2c?.marketUS}`);
  const summaries = summarizeAccounts(accounts);
  console.log(`Accounts: ${summaries.length}`);
  for (const summary of summaries) {
    console.log(`#${summary.index} accID=${summary.accID} trdEnv=${summary.trdEnv} markets=${JSON.stringify(summary.trdMarketAuthList)} accType=${summary.accType} simAccType=${summary.simAccType ?? ''} jpAccType=${JSON.stringify(summary.jpAccType)}`);
  }
  console.log(`Wrote: ${outPath}`);
} finally {
  connection?.close();
}
