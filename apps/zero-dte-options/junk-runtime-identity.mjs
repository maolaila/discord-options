export const NEW_JUNK_BUSINESS_LINE = 'junkman_new_20260925';
const variant = process.env.JUNK_RUNTIME_VARIANT || 'zero-dte-options';
if (!['zero-dte-options', NEW_JUNK_BUSINESS_LINE].includes(variant)) throw new Error('Unsupported JUNK_RUNTIME_VARIANT');
export const JUNK_RUNTIME_BUSINESS_LINE = variant;
export const JUNK_RUNTIME_STRATEGY = variant === NEW_JUNK_BUSINESS_LINE ? variant : 'junk_gex_nodes_v3';
export function junk_order_prefix(line) {
  if (line === NEW_JUNK_BUSINESS_LINE) return 'junk_new_20260925';
  if (line === 'junk-multi-options') return 'junk_multi';
  if (line === 'junk-flow-heatmap-options') return 'junk_flow_hm';
  return 'junk_gex';
}
export const JUNK_ORDER_PREFIX = junk_order_prefix(variant);
