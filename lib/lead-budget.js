// Lead daily budget snapshot (CTO orchestrator routing input).
//
// Clay already persists one typed `result` event per completed provider turn:
//   { type: "result", _ts, cost, usage }
// The session that owns the history supplies the vendor. This module folds
// those existing signals into daily per-vendor spend/usage without adding a
// second source of truth.
//
// Pure and replayable: callers inject the session snapshots, day window,
// limits and vendor cost ranks. No clocks, files, provider APIs or pricing
// tables are read here. Missing telemetry is explicit and never interpreted
// as zero usage or as proof that a budget is healthy.

var DAY_MS = 24 * 3600000;
var DEFAULT_PRESSURE_RATIO = 0.8;

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function firstNumber(obj, names) {
  if (!obj) return null;
  for (var i = 0; i < names.length; i++) {
    if (finiteNonNegative(obj[names[i]])) return obj[names[i]];
  }
  return null;
}

function usageValues(usage) {
  var input = firstNumber(usage, ["input_tokens", "inputTokens"]);
  var output = firstNumber(usage, ["output_tokens", "outputTokens"]);
  var cacheRead = firstNumber(usage, ["cache_read_input_tokens", "cacheReadInputTokens", "cached_input_tokens"]);
  var cacheWrite = firstNumber(usage, ["cache_creation_input_tokens", "cacheCreationInputTokens"]);
  var available = input !== null || output !== null || cacheRead !== null || cacheWrite !== null;
  return {
    available: available,
    inputTokens: input || 0,
    outputTokens: output || 0,
    cacheReadTokens: cacheRead || 0,
    cacheWriteTokens: cacheWrite || 0,
  };
}

function emptyVendor() {
  return {
    turns: 0,
    spendUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    spendAvailable: false,
    spendComplete: true,
    usageAvailable: false,
    usageComplete: true,
  };
}

function resultTime(result) {
  if (result && finiteNonNegative(result._ts)) return result._ts;
  if (result && finiteNonNegative(result.at)) return result.at;
  return null;
}

function resultEvents(history) {
  var out = [];
  for (var i = 0; i < (history || []).length; i++) {
    if (history[i] && history[i].type === "result") out.push(history[i]);
  }
  out.sort(function (a, b) { return (resultTime(a) || 0) - (resultTime(b) || 0); });
  return out;
}

function costDelta(cost, previousCost) {
  if (!finiteNonNegative(cost)) return null;
  if (!finiteNonNegative(previousCost) || cost < previousCost) return cost;
  return cost - previousCost;
}

function addResult(vendorUsage, result, delta, spendComplete) {
  vendorUsage.turns++;
  if (delta === null) {
    vendorUsage.spendComplete = false;
  } else {
    vendorUsage.spendAvailable = true;
    vendorUsage.spendUsd += delta;
    if (!spendComplete) vendorUsage.spendComplete = false;
  }
  var usage = usageValues(result.usage);
  if (!usage.available) {
    vendorUsage.usageComplete = false;
    return;
  }
  vendorUsage.usageAvailable = true;
  vendorUsage.inputTokens += usage.inputTokens;
  vendorUsage.outputTokens += usage.outputTokens;
  vendorUsage.cacheReadTokens += usage.cacheReadTokens;
  vendorUsage.cacheWriteTokens += usage.cacheWriteTokens;
  vendorUsage.totalTokens += usage.inputTokens + usage.outputTokens;
}

function aggregateSession(session, summary) {
  if (!session) return;
  var events = resultEvents(session.history);
  var inWindow = events.filter(function (event) {
    var at = resultTime(event);
    return at !== null && at >= summary.dayStartAt && at < summary.dayEndAt;
  });
  if (!inWindow.length) return;
  if (!session.vendor) {
    summary.unattributedSessions++;
    return;
  }
  var vendor = String(session.vendor).toLowerCase();
  var previousCost = null;
  var missingCostSinceBaseline = false;
  var createdInWindow = finiteNonNegative(session.createdAt) &&
    session.createdAt >= summary.dayStartAt && session.createdAt < summary.dayEndAt;
  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    var at = resultTime(event);
    var delta = costDelta(event.cost, previousCost);
    var complete = delta !== null && !missingCostSinceBaseline &&
      (previousCost !== null || createdInWindow);
    if (finiteNonNegative(event.cost)) {
      previousCost = event.cost;
      missingCostSinceBaseline = false;
    } else {
      missingCostSinceBaseline = true;
    }
    if (at === null || at < summary.dayStartAt || at >= summary.dayEndAt) continue;
    if (!summary.byVendor[vendor]) summary.byVendor[vendor] = emptyVendor();
    addResult(summary.byVendor[vendor], event, delta, complete);
  }
}

function finalizeTotals(summary) {
  var totals = emptyVendor();
  var vendors = Object.keys(summary.byVendor);
  for (var i = 0; i < vendors.length; i++) {
    var usage = summary.byVendor[vendors[i]];
    totals.turns += usage.turns;
    totals.spendUsd += usage.spendUsd;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheWriteTokens += usage.cacheWriteTokens;
    totals.totalTokens += usage.totalTokens;
    totals.spendAvailable = totals.spendAvailable || usage.spendAvailable;
    totals.usageAvailable = totals.usageAvailable || usage.usageAvailable;
    totals.spendComplete = totals.spendComplete && usage.spendComplete;
    totals.usageComplete = totals.usageComplete && usage.usageComplete;
    usage.spendUsd = Math.round(usage.spendUsd * 1000000) / 1000000;
  }
  if (!totals.turns) {
    totals.spendComplete = false;
    totals.usageComplete = false;
  }
  totals.spendUsd = Math.round(totals.spendUsd * 1000000) / 1000000;
  summary.totals = totals;
  summary.dataAvailable = totals.spendAvailable || totals.usageAvailable;
  summary.missingData = !summary.dataAvailable || !totals.spendComplete ||
    !totals.usageComplete || summary.unattributedSessions > 0;
  return summary;
}

// aggregateDailyUsage(sessions, opts) -> daily typed snapshot
//   sessions: [{ vendor, createdAt, history: [persisted session events] }]
//   opts.dayStartAt: inclusive epoch-ms boundary (required for a real day)
//   opts.dayEndAt: exclusive boundary (defaults to start + 24h)
// Cost is cumulative within a provider session, so earlier results establish
// the baseline and only positive in-window deltas count toward daily spend.
// createdAt proves that a first in-window cost began during this day; without
// either signal the known spend is retained but marked partial.
function aggregateDailyUsage(sessions, opts) {
  var start = opts && finiteNonNegative(opts.dayStartAt) ? opts.dayStartAt : 0;
  var end = opts && finiteNonNegative(opts.dayEndAt) ? opts.dayEndAt : start + DAY_MS;
  var summary = {
    type: "daily_vendor_usage",
    dayStartAt: start,
    dayEndAt: end,
    byVendor: {},
    totals: null,
    dataAvailable: false,
    missingData: true,
    unattributedSessions: 0,
  };
  for (var i = 0; i < (sessions || []).length; i++) aggregateSession(sessions[i], summary);
  return finalizeTotals(summary);
}

function normalizedCostRanks(ranks) {
  var out = {};
  for (var vendor in (ranks || {})) {
    if (finiteNonNegative(ranks[vendor])) out[String(vendor).toLowerCase()] = ranks[vendor];
  }
  return out;
}

function cheapestVendor(ranks) {
  var vendors = Object.keys(ranks).sort(function (a, b) {
    return ranks[a] === ranks[b] ? a.localeCompare(b) : ranks[a] - ranks[b];
  });
  return vendors.length ? vendors[0] : null;
}

function metricState(value, available, complete, limit, threshold) {
  if (!finiteNonNegative(limit) || limit === 0) return null;
  if (!available) return { ratio: null, conclusive: false };
  var ratio = value / limit;
  return { ratio: ratio, conclusive: complete || ratio >= threshold };
}

function pressureThreshold(opts) {
  if (opts && finiteNonNegative(opts.pressureRatio)) return opts.pressureRatio;
  return DEFAULT_PRESSURE_RATIO;
}

function conclusiveRatio(states) {
  var ratios = [];
  for (var i = 0; i < states.length; i++) {
    if (states[i] && states[i].conclusive) ratios.push(states[i].ratio);
  }
  return ratios.length ? Math.max.apply(null, ratios) : null;
}

function pressureReason(active, known) {
  if (active) return "daily budget pressure threshold reached";
  if (known) return "daily budget below pressure threshold";
  return "budget pressure unknown: limits or usage data incomplete";
}

// evaluateBudgetPressure(daily, opts) -> deterministic routing input
// Limits and relative vendor cost ranks are policy, so callers inject them.
// Partial data may prove pressure (known spend already crossed the threshold),
// but partial data below the threshold cannot prove that the budget is safe.
function evaluateBudgetPressure(daily, opts) {
  var options = opts || {};
  var threshold = pressureThreshold(options);
  var totals = daily && daily.totals ? daily.totals : emptyVendor();
  var spend = metricState(totals.spendUsd, totals.spendAvailable, totals.spendComplete,
    options.dailySpendLimitUsd, threshold);
  var tokens = metricState(totals.totalTokens, totals.usageAvailable, totals.usageComplete,
    options.dailyTokenLimit, threshold);
  var configured = (spend ? 1 : 0) + (tokens ? 1 : 0);
  var conclusiveCount = (spend && spend.conclusive ? 1 : 0) +
    (tokens && tokens.conclusive ? 1 : 0);
  var ratio = conclusiveRatio([spend, tokens]);
  var active = ratio !== null && ratio >= threshold;
  var known = configured > 0 && (active || conclusiveCount === configured);
  var ranks = normalizedCostRanks(options.vendorCostRank);
  return {
    active: active,
    known: known,
    ratio: known ? ratio : null,
    threshold: threshold,
    cheaperVendor: cheapestVendor(ranks),
    vendorCostRank: ranks,
    reason: pressureReason(active, known),
  };
}

function buildDailyBudget(sessions, opts) {
  var daily = aggregateDailyUsage(sessions, opts);
  daily.pressure = evaluateBudgetPressure(daily, opts);
  return daily;
}

function formatInteger(value) {
  return Math.round(value || 0).toLocaleString("en-US");
}

function formatVendorBurn(vendor, usage) {
  var spend = usage.spendAvailable
    ? "$" + usage.spendUsd.toFixed(2) + (usage.spendComplete ? "" : " partial")
    : "spend unavailable";
  var tokens = usage.usageAvailable
    ? formatInteger(usage.totalTokens) + " tokens" + (usage.usageComplete ? "" : " partial")
    : "usage unavailable";
  return vendor + " " + spend + ", " + tokens + " (" + usage.turns + " turn" + (usage.turns === 1 ? "" : "s") + ")";
}

function formatBurnRate(daily) {
  if (!daily || !daily.dataAvailable) return "burn rate unavailable (no recorded result usage for today)";
  var vendors = Object.keys(daily.byVendor || {}).sort();
  var parts = [];
  for (var i = 0; i < vendors.length; i++) {
    parts.push(formatVendorBurn(vendors[i], daily.byVendor[vendors[i]]));
  }
  if (daily.pressure && daily.pressure.active) {
    parts.push("budget pressure " + Math.round(daily.pressure.ratio * 100) + "%");
  } else if (daily.pressure && !daily.pressure.known) {
    parts.push("budget pressure unknown");
  }
  return "burn rate today: " + parts.join("; ");
}

module.exports = {
  aggregateDailyUsage: aggregateDailyUsage,
  evaluateBudgetPressure: evaluateBudgetPressure,
  buildDailyBudget: buildDailyBudget,
  formatBurnRate: formatBurnRate,
  DAY_MS: DAY_MS,
  DEFAULT_PRESSURE_RATIO: DEFAULT_PRESSURE_RATIO,
};
