import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.JUNK_ACTIVE_BUSINESS_LINE = 'junk-flow-heatmap-options';

const { runJunkMultiLine } = await import('../junk-multi-options/junk-multi-line.mjs');

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isMain = invokedPath
  && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === invokedPath.toLowerCase();

if (isMain) {
  runJunkMultiLine(process.argv.slice(2)).catch((error) => {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  });
}

export { runJunkMultiLine as runJunkFlowHeatmapLine };
