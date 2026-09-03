import { publish_new_trade_records, trade_notary_status } from './trade-notary.mjs';

const command = process.argv[2] || 'status';
if (command === 'status') {
  console.log(JSON.stringify(trade_notary_status(), null, 2));
} else if (command === 'dry-run') {
  console.log(JSON.stringify(await publish_new_trade_records({ dryRun: true }), null, 2));
} else if (command === 'publish') {
  console.log(JSON.stringify(await publish_new_trade_records(), null, 2));
} else {
  throw new Error(`Unknown trade-notary command: ${command}`);
}
