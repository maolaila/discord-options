import { createHash } from 'node:crypto';

const DEFAULT_EXPERIMENT_ID = 'junk_exit_grid_v1';

function finiteNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveNumber(value, fallback = null) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : fallback;
}

function nonnegativeInteger(value, fallback = 0) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function normalizedString(value) {
  return String(value ?? '').trim();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value, length = 20) {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, length);
}

function normalizedLine(raw, index) {
  const lineId = normalizedString(raw?.line_id).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_]{1,31}$/.test(lineId)) {
    throw new Error(`Invalid JUNK exit experiment line_id at index ${index}.`);
  }
  const equity = positiveNumber(raw?.paper_equity_usd);
  if (equity !== 10_000) throw new Error(`Experiment line ${lineId} must use paper_equity_usd=10000.`);
  const stop = positiveNumber(raw?.catastrophic_stop_loss_pct);
  if (stop === null || stop > 100) throw new Error(`Experiment line ${lineId} has an invalid catastrophic stop.`);
  const takeProfitEnabled = raw?.option_take_profit_enabled === true;
  const takeProfit = positiveNumber(raw?.option_take_profit_pct);
  if (takeProfitEnabled && (takeProfit === null || takeProfit > 1_000)) {
    throw new Error(`Experiment line ${lineId} has an invalid fixed take profit.`);
  }
  const exitProfile = {
    catastrophic_stop_loss_pct: stop,
    option_stop_loss_pct: stop,
    option_take_profit_enabled: takeProfitEnabled,
    option_take_profit_pct: takeProfit ?? 25,
  };
  return {
    line_id: lineId,
    label: normalizedString(raw?.label) || lineId,
    control: raw?.control === true,
    paper_equity_usd: equity,
    exit_profile: exitProfile,
    exit_profile_hash: digest(exitProfile, 16),
  };
}

function sharedExitRulesSnapshot(exitRules = {}) {
  const variableFields = new Set([
    'catastrophic_stop_loss_pct',
    'option_stop_loss_pct',
    'option_take_profit_enabled',
    'option_take_profit_pct',
  ]);
  return Object.fromEntries(Object.entries(exitRules || {})
    .filter(([key]) => !variableFields.has(key))
    .map(([key, value]) => [key, stableValue(value)]));
}

export function load_junk_exit_experiment(policy = {}) {
  const raw = policy?.exit_experiment || {};
  if (raw.enabled !== true) {
    return {
      enabled: false,
      experiment_id: normalizedString(raw.experiment_id) || DEFAULT_EXPERIMENT_ID,
      lines: [],
      line_count: 0,
      total_paper_equity_usd: 0,
    };
  }
  if (raw.paired_entry !== true || raw.broker_execution_mode !== 'aggregate_single_position') {
    throw new Error('JUNK exit experiment requires paired_entry=true and broker_execution_mode=aggregate_single_position.');
  }
  const lines = (Array.isArray(raw.lines) ? raw.lines : []).map(normalizedLine);
  if (lines.length < 2 || lines.length > 12) throw new Error('JUNK exit experiment requires between 2 and 12 lines.');
  if (new Set(lines.map((line) => line.line_id)).size !== lines.length) {
    throw new Error('JUNK exit experiment line_id values must be unique.');
  }
  if (new Set(lines.map((line) => line.exit_profile_hash)).size !== lines.length) {
    throw new Error('JUNK exit experiment lines must have unique fixed SL/TP profiles.');
  }
  if (lines.filter((line) => line.control).length !== 1) {
    throw new Error('JUNK exit experiment requires exactly one control line.');
  }
  const baseRules = policy?.exit_rules || {};
  const control = lines.find((line) => line.control);
  const baseStop = positiveNumber(baseRules.catastrophic_stop_loss_pct ?? baseRules.option_stop_loss_pct, 15);
  const baseTpEnabled = baseRules.option_take_profit_enabled === true;
  const baseTp = positiveNumber(baseRules.option_take_profit_pct, 25);
  if (control.exit_profile.catastrophic_stop_loss_pct !== baseStop
    || control.exit_profile.option_take_profit_enabled !== baseTpEnabled
    || (baseTpEnabled && control.exit_profile.option_take_profit_pct !== baseTp)) {
    throw new Error('JUNK exit experiment control line must match the active base exit rules.');
  }
  const experimentId = normalizedString(raw.experiment_id) || DEFAULT_EXPERIMENT_ID;
  const version = Math.max(1, nonnegativeInteger(raw.version, 1));
  const capQtyByVisibleAsk = policy?.execution_quality?.cap_qty_by_visible_ask === true;
  const maxQtyToAskVolumeRatio = positiveNumber(policy?.execution_quality?.max_qty_to_ask_volume_ratio);
  if (!capQtyByVisibleAsk || maxQtyToAskVolumeRatio === null) {
    throw new Error('JUNK exit experiment requires a positive visible-ask liquidity cap configuration.');
  }
  const sharedExitRules = sharedExitRulesSnapshot(baseRules);
  const snapshot = {
    experiment_id: experimentId,
    version,
    paired_entry: true,
    broker_execution_mode: 'aggregate_single_position',
    paper_equity_usd_per_line: 10_000,
    shared_exit_rules: sharedExitRules,
    shared_exit_rules_hash: digest(sharedExitRules, 16),
    execution_quality: {
      cap_qty_by_visible_ask: true,
      max_qty_to_ask_volume_ratio: maxQtyToAskVolumeRatio,
    },
    lines,
  };
  return {
    enabled: true,
    ...snapshot,
    manifest_hash: digest(snapshot, 20),
    line_count: lines.length,
    total_paper_equity_usd: lines.length * 10_000,
    control_line_id: control.line_id,
  };
}

function cohortId(basePlan, manifest) {
  return `junk_cohort_${digest({
    experiment_id: manifest.experiment_id,
    manifest_hash: manifest.manifest_hash,
    signal_id: basePlan?.signal?.signal_id,
    contract: basePlan?.contract?.code,
    generated_at: basePlan?.signal?.generated_at,
  }, 20)}`;
}

export function build_junk_experiment_cohort(base_plan, manifest) {
  if (!manifest?.enabled) return base_plan;
  if (!base_plan || typeof base_plan !== 'object') throw new Error('A base JUNK entry plan is required.');
  const perLineQty = nonnegativeInteger(base_plan?.position_sizing?.qty);
  const aggregateQty = perLineQty * manifest.line_count;
  const reasons = [...(base_plan?.gate?.reasons || [])];
  if (perLineQty < 1) reasons.push('experiment_missing_positive_per_line_qty');
  const askSize = positiveNumber(base_plan?.quote?.ask_size_contracts);
  const maxAskRatio = positiveNumber(manifest?.execution_quality?.max_qty_to_ask_volume_ratio);
  if (askSize === null) {
    reasons.push('experiment_visible_ask_size_missing');
  } else if (maxAskRatio === null) {
    reasons.push('experiment_visible_ask_cap_ratio_missing');
  } else if (aggregateQty > Math.max(1, Math.floor(askSize * maxAskRatio))) {
    reasons.push(`experiment_aggregate_qty_exceeds_visible_ask_cap:${aggregateQty}`);
  }
  const cohort_id = cohortId(base_plan, manifest);
  const planId = `zero_dte_${digest({ cohort_id, aggregate_qty: aggregateQty }, 20)}`;
  const ready = base_plan?.gate?.passed === true && reasons.length === 0 && aggregateQty > 0;
  const perLineEstimated = positiveNumber(base_plan?.position_sizing?.estimated_position_usd, 0);
  const positionSizing = {
    ...(base_plan?.position_sizing || {}),
    qty: aggregateQty,
    per_line_qty: perLineQty,
    aggregate_qty: aggregateQty,
    paper_equity_usd: manifest.total_paper_equity_usd,
    paper_equity_usd_per_line: 10_000,
    estimated_position_usd: Number((perLineEstimated * manifest.line_count).toFixed(2)),
    estimated_position_usd_per_line: perLineEstimated,
    experiment_line_count: manifest.line_count,
  };
  return {
    ...base_plan,
    schema_version: Math.max(2, nonnegativeInteger(base_plan.schema_version, 1)),
    plan_id: planId,
    order_status: ready ? 'ready_for_simulation' : 'gate_failed',
    gate: { ...(base_plan.gate || {}), passed: ready, reasons: [...new Set(reasons)] },
    position_sizing: positionSizing,
    order: base_plan.order ? {
      ...base_plan.order,
      qty: aggregateQty,
      remark: `junk_gex:exp:${cohort_id.slice(-20)}`.slice(0, 60),
    } : null,
    experiment: {
      experiment_id: manifest.experiment_id,
      version: manifest.version,
      manifest_hash: manifest.manifest_hash,
      cohort_id,
      paired_entry: true,
      broker_execution_mode: manifest.broker_execution_mode,
      paper_equity_usd_per_line: 10_000,
      total_paper_equity_usd: manifest.total_paper_equity_usd,
      per_line_entry_qty: perLineQty,
      aggregate_entry_qty: aggregateQty,
      control_line_id: manifest.control_line_id,
      shared_exit_rules: manifest.shared_exit_rules,
      shared_exit_rules_hash: manifest.shared_exit_rules_hash,
      execution_quality: manifest.execution_quality,
      lines: manifest.lines,
    },
  };
}

export function create_junk_experiment_ledger(experiment, now = new Date()) {
  if (!experiment?.cohort_id || !Array.isArray(experiment?.lines)) return null;
  const variants = Object.fromEntries(experiment.lines.map((line) => [line.line_id, {
    line_id: line.line_id,
    label: line.label,
    control: line.control === true,
    paper_equity_usd: 10_000,
    exit_profile: { ...line.exit_profile },
    exit_profile_hash: line.exit_profile_hash,
    shared_exit_rules: { ...(experiment.shared_exit_rules || {}) },
    shared_exit_rules_hash: experiment.shared_exit_rules_hash || null,
    allocated_entry_qty: 0,
    allocated_entry_value: 0,
    allocated_exit_qty: 0,
    allocated_exit_value: 0,
    pending_exit_qty: 0,
    option_return_pct: null,
    peak_option_return_pct: null,
    breakeven_armed: false,
    partial_target_taken: false,
    management_floor_pct: null,
    comparison_eligible: true,
    comparison_exclusion_reason: null,
    status: 'awaiting_entry_allocation',
    realized_pnl_usd: null,
  }]));
  return {
    experiment_id: experiment.experiment_id,
    version: experiment.version,
    manifest_hash: experiment.manifest_hash,
    cohort_id: experiment.cohort_id,
    control_line_id: experiment.control_line_id,
    shared_exit_rules: { ...(experiment.shared_exit_rules || {}) },
    shared_exit_rules_hash: experiment.shared_exit_rules_hash || null,
    execution_quality: { ...(experiment.execution_quality || {}) },
    paper_equity_usd_per_line: 10_000,
    line_count: experiment.lines.length,
    per_line_entry_qty_requested: experiment.per_line_entry_qty,
    aggregate_entry_qty_requested: experiment.aggregate_entry_qty,
    variants,
    entry_allocation_finalized: false,
    allocated_entry_qty: 0,
    unallocated_entry_qty: 0,
    unallocated_exited_qty: 0,
    unallocated_exit_value: 0,
    pending_exit_batch: null,
    ownership_status: 'pending_entry_fill',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

export function finalize_junk_experiment_entry_allocation(ledger, {
  filled_qty,
  fill_avg_price,
  now = new Date(),
} = {}) {
  if (!ledger || ledger.entry_allocation_finalized) return ledger;
  const lineIds = Object.keys(ledger.variants || {}).sort();
  if (lineIds.length < 1) throw new Error('Experiment ledger has no variants.');
  const filledQty = nonnegativeInteger(filled_qty);
  const avg = positiveNumber(fill_avg_price, 0);
  if (filledQty > 0 && avg <= 0) {
    throw new Error('Experiment entry allocation requires a broker-confirmed positive fill average price.');
  }
  const perLineQty = Math.floor(filledQty / lineIds.length);
  const allocatedQty = perLineQty * lineIds.length;
  const unallocatedQty = filledQty - allocatedQty;
  const variants = { ...ledger.variants };
  for (const lineId of lineIds) {
    variants[lineId] = {
      ...variants[lineId],
      allocated_entry_qty: perLineQty,
      allocated_entry_value: Number((perLineQty * avg).toFixed(8)),
      status: perLineQty > 0 ? 'open' : 'not_allocated',
    };
  }
  return {
    ...ledger,
    variants,
    entry_allocation_finalized: true,
    entry_fill_avg_price: avg || null,
    allocated_entry_qty: allocatedQty,
    unallocated_entry_qty: unallocatedQty,
    ownership_status: 'reconciled',
    allocation_quality: perLineQty > 0 ? (unallocatedQty > 0 ? 'paired_with_unallocated_remainder' : 'fully_paired') : 'cohort_unpaired_liquidate_all',
    updated_at: now.toISOString(),
  };
}

export function finalize_junk_experiment_unpriced_entry_allocation(ledger, {
  filled_qty,
  now = new Date(),
} = {}) {
  if (!ledger || ledger.entry_allocation_finalized) return ledger;
  const lineIds = Object.keys(ledger.variants || {}).sort();
  if (lineIds.length < 1) throw new Error('Experiment ledger has no variants.');
  const filledQty = nonnegativeInteger(filled_qty);
  if (filledQty < 1) throw new Error('Unpriced experiment force-close requires a positive broker fill quantity.');
  const perLineQty = Math.floor(filledQty / lineIds.length);
  const allocatedQty = perLineQty * lineIds.length;
  const unallocatedQty = filledQty - allocatedQty;
  const variants = { ...ledger.variants };
  for (const lineId of lineIds) {
    variants[lineId] = {
      ...variants[lineId],
      allocated_entry_qty: perLineQty,
      allocated_entry_value: null,
      comparison_eligible: false,
      comparison_exclusion_reason: 'entry_fill_average_missing_force_close_unpriced',
      status: perLineQty > 0 ? 'open' : 'not_allocated',
      realized_pnl_usd: null,
    };
  }
  return {
    ...ledger,
    variants,
    entry_allocation_finalized: true,
    entry_fill_avg_price: null,
    entry_fill_unpriced: true,
    allocated_entry_qty: allocatedQty,
    unallocated_entry_qty: unallocatedQty,
    ownership_status: 'force_close_unpriced',
    allocation_quality: perLineQty > 0
      ? (unallocatedQty > 0 ? 'unpriced_paired_with_unallocated_remainder' : 'unpriced_fully_paired')
      : 'unpriced_cohort_unpaired_liquidate_all',
    updated_at: now.toISOString(),
  };
}

export function exit_config_for_variant(base_config, variant) {
  if (!variant?.line_id || !variant?.exit_profile) throw new Error('A valid experiment variant is required.');
  return {
    ...base_config,
    policy: {
      ...(base_config?.policy || {}),
      exit_rules: {
        ...(base_config?.policy?.exit_rules || {}),
        ...(variant.shared_exit_rules || {}),
        ...variant.exit_profile,
        ...(base_config?.schedule_exit_rule_overrides || {}),
      },
    },
    experimentLineId: variant.line_id,
  };
}

export function experiment_variant_remaining_qty(variant) {
  return Math.max(0, nonnegativeInteger(variant?.allocated_entry_qty) - nonnegativeInteger(variant?.allocated_exit_qty));
}

export function experiment_unallocated_remaining_qty(ledger) {
  return Math.max(0, nonnegativeInteger(ledger?.unallocated_entry_qty) - nonnegativeInteger(ledger?.unallocated_exited_qty));
}

export function experiment_total_remaining_qty(ledger) {
  return Object.values(ledger?.variants || {}).reduce(
    (sum, variant) => sum + experiment_variant_remaining_qty(variant),
    experiment_unallocated_remaining_qty(ledger),
  );
}

export function experiment_all_variants_flat(ledger) {
  return Boolean(ledger?.entry_allocation_finalized)
    && experiment_total_remaining_qty(ledger) === 0
    && !ledger?.pending_exit_batch;
}

function allocationTargets(allocations, cumulativeQty, allocationOrder = []) {
  const normalized = new Map(Object.entries(allocations || {})
    .map(([key, qty]) => [key, nonnegativeInteger(qty)])
    .filter(([, qty]) => qty > 0));
  const preferred = [...new Set((Array.isArray(allocationOrder) ? allocationOrder : [])
    .map(normalizedString)
    .filter((key) => normalized.has(key)))];
  const remainingKeys = [...normalized.keys()]
    .filter((key) => !preferred.includes(key))
    .sort((left, right) => left.localeCompare(right));
  const entries = [...preferred, ...remainingKeys].map((key) => [key, normalized.get(key)]);
  const total = entries.reduce((sum, [, qty]) => sum + qty, 0);
  const bounded = Math.min(total, nonnegativeInteger(cumulativeQty));
  if (total < 1 || bounded < 1) return Object.fromEntries(entries.map(([key]) => [key, 0]));
  // Build one immutable, deterministic round-robin slot sequence for the
  // batch, then take a prefix for each cumulative broker fill. Prefix
  // allocation is monotonic by construction: a line can never lose an
  // already-accounted contract when cumulative fill quantity increases (the
  // Alabama paradox makes largest-remainder allocation unsafe here).
  const remaining = new Map(entries);
  const slots = [];
  while (slots.length < total) {
    let progressed = false;
    for (const [key] of entries) {
      const left = remaining.get(key) || 0;
      if (left < 1) continue;
      slots.push(key);
      remaining.set(key, left - 1);
      progressed = true;
    }
    if (!progressed) break;
  }
  const targets = Object.fromEntries(entries.map(([key]) => [key, 0]));
  for (const key of slots.slice(0, bounded)) targets[key] += 1;
  return targets;
}

function batchAllocationOrder(ledger, allocations, attemptNo) {
  const keys = Object.keys(allocations || {}).filter((key) => key !== '__unallocated__').sort();
  const unallocated = Object.hasOwn(allocations || {}, '__unallocated__') ? ['__unallocated__'] : [];
  if (keys.length < 2) return [...unallocated, ...keys];
  const seed = parseInt(digest({ cohort_id: ledger?.cohort_id, attempt_no: attemptNo }, 8), 16);
  const rotation = Number.isFinite(seed) ? seed % keys.length : 0;
  return [...unallocated, ...keys.slice(rotation), ...keys.slice(0, rotation)];
}

export function begin_junk_experiment_exit_batch(ledger, {
  allocations,
  reason_by_line = {},
  attempt_no,
  remark,
  now = new Date(),
} = {}) {
  if (!ledger?.entry_allocation_finalized || ledger.pending_exit_batch) {
    throw new Error('Experiment exit batch cannot start from the current ledger state.');
  }
  const normalizedAllocations = {};
  for (const [key, rawQty] of Object.entries(allocations || {})) {
    const qty = nonnegativeInteger(rawQty);
    const available = key === '__unallocated__'
      ? experiment_unallocated_remaining_qty(ledger)
      : experiment_variant_remaining_qty(ledger.variants?.[key]);
    if (qty > 0) normalizedAllocations[key] = Math.min(qty, available);
  }
  const requestedQty = Object.values(normalizedAllocations).reduce((sum, qty) => sum + qty, 0);
  if (requestedQty < 1) throw new Error('Experiment exit batch requires positive owned allocations.');
  const normalizedAttemptNo = nonnegativeInteger(attempt_no, 1);
  const allocationOrder = batchAllocationOrder(ledger, normalizedAllocations, normalizedAttemptNo);
  const variants = { ...ledger.variants };
  for (const [lineId, qty] of Object.entries(normalizedAllocations)) {
    if (lineId === '__unallocated__') continue;
    variants[lineId] = { ...variants[lineId], pending_exit_qty: qty };
  }
  return {
    ...ledger,
    variants,
    pending_exit_batch: {
      attempt_no: normalizedAttemptNo,
      remark: normalizedString(remark) || null,
      allocations: normalizedAllocations,
      allocation_order: allocationOrder,
      reason_by_line: { ...reason_by_line },
      requested_qty: requestedQty,
      accounted_fill_qty: 0,
      accounted_qty_by_key: Object.fromEntries(Object.keys(normalizedAllocations).map((key) => [key, 0])),
      accounted_value_by_key: Object.fromEntries(Object.keys(normalizedAllocations).map((key) => [key, 0])),
      created_at: now.toISOString(),
    },
    updated_at: now.toISOString(),
  };
}

export function apply_junk_experiment_exit_cumulative_fill(ledger, {
  cumulative_fill_qty,
  cumulative_fill_avg_price,
  terminal = false,
  now = new Date(),
} = {}) {
  const batch = ledger?.pending_exit_batch;
  if (!batch) return { ledger, deltas: [] };
  const avg = positiveNumber(cumulative_fill_avg_price, 0);
  if (nonnegativeInteger(cumulative_fill_qty) > 0 && avg <= 0) {
    throw new Error('Experiment exit allocation requires a broker-confirmed positive cumulative fill average price.');
  }
  const targets = allocationTargets(batch.allocations, cumulative_fill_qty, batch.allocation_order);
  const variants = { ...ledger.variants };
  const deltas = [];
  let unallocatedExitedQty = nonnegativeInteger(ledger.unallocated_exited_qty);
  let unallocatedExitValue = finiteNumber(ledger.unallocated_exit_value, 0);
  const accountedQty = { ...(batch.accounted_qty_by_key || {}) };
  const accountedValue = { ...(batch.accounted_value_by_key || {}) };
  for (const [key, targetQty] of Object.entries(targets)) {
    const previousQty = nonnegativeInteger(accountedQty[key]);
    if (targetQty < previousQty) {
      throw new Error(`Experiment cumulative fill allocation regressed for ${key}: ${targetQty}<${previousQty}.`);
    }
    const previousValue = finiteNumber(accountedValue[key], 0);
    const targetValue = Number((targetQty * avg).toFixed(8));
    const deltaQty = Math.max(0, targetQty - previousQty);
    const deltaValue = Number((targetValue - previousValue).toFixed(8));
    accountedQty[key] = targetQty;
    accountedValue[key] = targetValue;
    if (key === '__unallocated__') {
      unallocatedExitedQty += deltaQty;
      unallocatedExitValue = Number((unallocatedExitValue + deltaValue).toFixed(8));
    } else if (variants[key]) {
      const variant = variants[key];
      const exitedQty = Math.min(nonnegativeInteger(variant.allocated_entry_qty), nonnegativeInteger(variant.allocated_exit_qty) + deltaQty);
      const exitValue = Number((finiteNumber(variant.allocated_exit_value, 0) + deltaValue).toFixed(8));
      const remainingQty = Math.max(0, nonnegativeInteger(variant.allocated_entry_qty) - exitedQty);
      const entryPrice = positiveNumber(ledger.entry_fill_avg_price, 0);
      const realized = ledger.entry_fill_unpriced !== true && remainingQty === 0 && exitedQty > 0
        ? Number(((exitValue - exitedQty * entryPrice) * 100).toFixed(2))
        : null;
      variants[key] = {
        ...variant,
        allocated_exit_qty: exitedQty,
        allocated_exit_value: exitValue,
        pending_exit_qty: Math.max(0, nonnegativeInteger(variant.pending_exit_qty) - deltaQty),
        status: remainingQty === 0 && exitedQty > 0 ? 'closed' : 'open',
        realized_pnl_usd: realized,
      };
    }
    if (deltaQty > 0 || Math.abs(deltaValue) > 1e-8) {
      deltas.push({ line_id: key === '__unallocated__' ? null : key, allocation_key: key, qty: deltaQty, value: deltaValue, cumulative_qty: targetQty, cumulative_value: targetValue });
    }
  }
  const filled = Object.values(targets).reduce((sum, qty) => sum + qty, 0);
  let pending = {
    ...batch,
    accounted_fill_qty: filled,
    accounted_qty_by_key: accountedQty,
    accounted_value_by_key: accountedValue,
  };
  if (terminal) {
    for (const [key] of Object.entries(batch.allocations)) {
      if (key !== '__unallocated__' && variants[key]) variants[key] = { ...variants[key], pending_exit_qty: 0 };
    }
    const variantKeys = Object.keys(batch.allocations || {}).filter((key) => key !== '__unallocated__');
    if (filled > 0 && filled < nonnegativeInteger(batch.requested_qty) && variantKeys.length >= 2) {
      // A paired cohort is a complete-case experiment. If one multi-line
      // broker batch is only partially filled, every line in that cohort is
      // excluded from the optimization leaderboard (while actual PnL remains
      // recorded) so untouched lines cannot masquerade as a fair comparison.
      for (const key of Object.keys(variants)) {
        if (!variants[key]) continue;
        variants[key] = {
          ...variants[key],
          comparison_eligible: false,
          comparison_exclusion_reason: 'multi_line_exit_batch_terminal_partial_fill',
        };
      }
    }
    pending = null;
  }
  const terminalPairingIssue = terminal
    && filled > 0
    && filled < nonnegativeInteger(batch.requested_qty)
    && Object.keys(batch.allocations || {}).filter((key) => key !== '__unallocated__').length >= 2;
  return {
    ledger: {
      ...ledger,
      variants,
      unallocated_exited_qty: unallocatedExitedQty,
      unallocated_exit_value: unallocatedExitValue,
      pending_exit_batch: pending,
      comparison_pairing_issue_count: nonnegativeInteger(ledger.comparison_pairing_issue_count)
        + (terminalPairingIssue ? 1 : 0),
      ownership_status: 'reconciled',
      updated_at: now.toISOString(),
    },
    deltas,
  };
}

export function update_junk_experiment_variant_management(ledger, line_id, management_update = {}) {
  const lineId = normalizedString(line_id);
  const variant = ledger?.variants?.[lineId];
  if (!variant) return ledger;
  const previousPeak = finiteNumber(variant.peak_option_return_pct);
  const observedPeak = finiteNumber(management_update.peak_option_return_pct);
  const peak = previousPeak === null ? observedPeak : (observedPeak === null ? previousPeak : Math.max(previousPeak, observedPeak));
  return {
    ...ledger,
    variants: {
      ...ledger.variants,
      [lineId]: {
        ...variant,
        option_return_pct: finiteNumber(management_update.option_return_pct),
        peak_option_return_pct: peak,
        breakeven_armed: variant.breakeven_armed === true || management_update.breakeven_armed === true,
        partial_target_taken: variant.partial_target_taken === true || management_update.partial_target_taken === true,
        management_floor_pct: finiteNumber(management_update.management_floor_pct, finiteNumber(variant.management_floor_pct)),
      },
    },
  };
}

export function summarize_junk_exit_experiment(state) {
  const rows = Object.values(state?.orders || {}).filter((row) => row?.experiment_ledger?.experiment_id);
  function aggregate(selectedRows) {
    const summaries = {};
    let unallocatedRealizedPnl = 0;
    let unallocatedClosedCohortCount = 0;
    let unallocatedOpenContractQty = 0;
    let comparisonPairingIssueCount = 0;
    for (const row of selectedRows) {
      const ledger = row.experiment_ledger;
      const entryPrice = positiveNumber(ledger.entry_fill_avg_price, 0);
      const unallocatedExitedQty = nonnegativeInteger(ledger.unallocated_exited_qty);
      const unallocatedEntryQty = nonnegativeInteger(ledger.unallocated_entry_qty);
      if (unallocatedExitedQty > 0 && entryPrice > 0) {
        unallocatedRealizedPnl += (finiteNumber(ledger.unallocated_exit_value, 0)
          - unallocatedExitedQty * entryPrice) * 100;
      }
      unallocatedOpenContractQty += experiment_unallocated_remaining_qty(ledger);
      if (unallocatedEntryQty > 0 && unallocatedExitedQty >= unallocatedEntryQty) {
        unallocatedClosedCohortCount += 1;
      }
      comparisonPairingIssueCount += nonnegativeInteger(ledger.comparison_pairing_issue_count);
      for (const variant of Object.values(ledger.variants || {})) {
        const summaryKey = `${ledger.manifest_hash || 'unknown'}:${variant.line_id}`;
        const line = summaries[summaryKey] || {
          manifest_hash: ledger.manifest_hash || null,
          experiment_version: nonnegativeInteger(ledger.version, 1),
          experiment_line_id: variant.line_id,
          label: variant.label,
          control: variant.control === true,
          paper_equity_usd: 10_000,
          cohort_count: 0,
          closed_trade_count: 0,
          comparable_closed_trade_count: 0,
          win_count: 0,
          loss_count: 0,
          comparable_win_count: 0,
          comparable_loss_count: 0,
          realized_pnl_usd: 0,
          realized_pnl_to_date_usd: 0,
          comparable_realized_pnl_usd: 0,
          open_contract_qty: 0,
          comparison_excluded_cohort_count: 0,
        };
        line.cohort_count += variant.allocated_entry_qty > 0 ? 1 : 0;
        line.open_contract_qty += experiment_variant_remaining_qty(variant);
        const entryPrice = positiveNumber(ledger.entry_fill_avg_price, 0);
        const exitedQty = nonnegativeInteger(variant.allocated_exit_qty);
        const realizedToDate = entryPrice > 0 && exitedQty > 0
          ? (finiteNumber(variant.allocated_exit_value, 0) - exitedQty * entryPrice) * 100
          : 0;
        line.realized_pnl_to_date_usd += realizedToDate;
        if (variant.status === 'closed' && finiteNumber(variant.realized_pnl_usd) !== null) {
          line.closed_trade_count += 1;
          line.realized_pnl_usd += variant.realized_pnl_usd;
          if (variant.realized_pnl_usd > 0) line.win_count += 1;
          if (variant.realized_pnl_usd < 0) line.loss_count += 1;
          if (variant.comparison_eligible !== false) {
            line.comparable_closed_trade_count += 1;
            line.comparable_realized_pnl_usd += variant.realized_pnl_usd;
            if (variant.realized_pnl_usd > 0) line.comparable_win_count += 1;
            if (variant.realized_pnl_usd < 0) line.comparable_loss_count += 1;
          } else {
            line.comparison_excluded_cohort_count += 1;
          }
        }
        summaries[summaryKey] = line;
      }
    }
    const lines = Object.values(summaries).map((line) => ({
      ...line,
      realized_pnl_usd: Number(line.realized_pnl_usd.toFixed(2)),
      realized_pnl_to_date_usd: Number(line.realized_pnl_to_date_usd.toFixed(2)),
      comparable_realized_pnl_usd: Number(line.comparable_realized_pnl_usd.toFixed(2)),
      win_rate_pct: line.closed_trade_count > 0
        ? Number((line.win_count / line.closed_trade_count * 100).toFixed(2))
        : null,
      comparable_win_rate_pct: line.comparable_closed_trade_count > 0
        ? Number((line.comparable_win_count / line.comparable_closed_trade_count * 100).toFixed(2))
        : null,
      return_on_paper_equity_pct: Number((line.realized_pnl_usd / line.paper_equity_usd * 100).toFixed(4)),
      comparable_return_on_paper_equity_pct: Number((line.comparable_realized_pnl_usd / line.paper_equity_usd * 100).toFixed(4)),
    })).sort((left, right) => (
      normalizedString(left.manifest_hash).localeCompare(normalizedString(right.manifest_hash))
        || left.experiment_line_id.localeCompare(right.experiment_line_id)
    ));
    const aggregateRealizedPnl = lines.reduce((sum, line) => sum + line.realized_pnl_usd, 0);
    const aggregateRealizedPnlToDate = lines.reduce((sum, line) => sum + line.realized_pnl_to_date_usd, 0);
    return {
      pnl_basis: 'gross_option_price_change',
      fees_included: false,
      cohort_count: new Set(selectedRows.map((row) => row.experiment_ledger.cohort_id)).size,
      lines,
      aggregate_realized_pnl_usd: Number(aggregateRealizedPnl.toFixed(2)),
      aggregate_realized_pnl_to_date_usd: Number(aggregateRealizedPnlToDate.toFixed(2)),
      unallocated_realized_pnl_usd: Number(unallocatedRealizedPnl.toFixed(2)),
      unallocated_closed_cohort_count: unallocatedClosedCohortCount,
      unallocated_open_contract_qty: unallocatedOpenContractQty,
      comparison_pairing_issue_count: comparisonPairingIssueCount,
      physical_realized_pnl_usd: Number((aggregateRealizedPnl + unallocatedRealizedPnl).toFixed(2)),
      physical_realized_pnl_to_date_usd: Number((aggregateRealizedPnlToDate + unallocatedRealizedPnl).toFixed(2)),
    };
  }
  const all = aggregate(rows);
  const sessionDateEt = normalizedString(state?.session_date_et);
  const session = aggregate(sessionDateEt
    ? rows.filter((row) => normalizedString(row?.expiration) === sessionDateEt)
    : []);
  return {
    experiment_id: rows.at(-1)?.experiment_ledger?.experiment_id || null,
    enabled: all.lines.length > 0,
    ...all,
    session_date_et: sessionDateEt || null,
    session_cohort_count: session.cohort_count,
    session_lines: session.lines,
    session_aggregate_realized_pnl_usd: session.aggregate_realized_pnl_usd,
    session_aggregate_realized_pnl_to_date_usd: session.aggregate_realized_pnl_to_date_usd,
    session_unallocated_realized_pnl_usd: session.unallocated_realized_pnl_usd,
    session_physical_realized_pnl_usd: session.physical_realized_pnl_usd,
    session_physical_realized_pnl_to_date_usd: session.physical_realized_pnl_to_date_usd,
    generated_at: new Date().toISOString(),
  };
}

export const JUNK_EXIT_EXPERIMENT_DEFAULT_ID = DEFAULT_EXPERIMENT_ID;
