// Lead trust evidence (CTO orchestrator — roadmap §11.7).
//
// Trust is a typed observation stream, not a prose judgment. Every observation
// names the decision class and interaction channel that produced it. The
// aggregation and promotion checks in this module are pure so nightly reports
// can be replayed from the ledger without consulting mutable runtime state.

var DECISION_CLASSES = [
  "debugging",
  "design",
  "implementation",
  "mechanical",
  "research",
  "review",
  "security",
];

var CHANNELS = ["text", "voice"];
var METRICS = ["gate_pass", "backtest_alignment", "refusal_correctness"];
var TRUST_EVENT_TYPE = "trust_observation";

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function oneOf(value, values) {
  return values.indexOf(value) !== -1;
}

function validTimestamp(value) {
  return typeof value === "number" && isFinite(value) && value >= 0;
}

function timestampFor(observation) {
  var hasAt = hasOwn(observation, "at");
  var hasTimestamp = hasOwn(observation, "timestamp");
  if (!hasAt && !hasTimestamp) return null;
  if (hasAt && hasTimestamp && observation.at !== observation.timestamp) return null;
  return hasAt ? observation.at : observation.timestamp;
}

function isTrustObservationEvent(observation) {
  return !!observation && observation.type === TRUST_EVENT_TYPE;
}

// Return a canonical observation, or null when the event is not a trust event
// or fails the typed schema. A missing channel is the one compatibility path:
// old, explicitly typed trust observations are conservatively treated as text.
function normalizeTrustObservation(observation) {
  if (!isTrustObservationEvent(observation)) return null;
  var channel = hasOwn(observation, "channel") ? observation.channel : "text";
  var at = timestampFor(observation);
  var evidence = observation.evidence;
  if (!oneOf(observation.decisionClass, DECISION_CLASSES)) return null;
  if (!oneOf(channel, CHANNELS)) return null;
  if (!oneOf(observation.metric, METRICS)) return null;
  if (typeof observation.outcome !== "boolean") return null;
  if (!validTimestamp(at)) return null;
  if (typeof evidence !== "string" || !evidence.trim()) return null;
  return {
    type: TRUST_EVENT_TYPE,
    at: at,
    decisionClass: observation.decisionClass,
    channel: channel,
    metric: observation.metric,
    outcome: observation.outcome,
    evidence: evidence,
  };
}

function validateTrustObservation(observation) {
  var value = normalizeTrustObservation(observation);
  return value
    ? { valid: true, value: value, errors: [] }
    : { valid: false, value: null, errors: ["invalid trust observation"] };
}

function emptyMetrics() {
  var metrics = {};
  for (var i = 0; i < METRICS.length; i++) {
    metrics[METRICS[i]] = { count: 0, passCount: 0, rate: 0, ratePct: 0 };
  }
  return metrics;
}

function addObservation(group, observation) {
  var metric = group.metrics[observation.metric];
  metric.count++;
  if (observation.outcome) metric.passCount++;
  metric.rate = Math.round((metric.passCount / metric.count) * 10000) / 100;
  metric.ratePct = metric.rate;
}

function aggregateTrustObservations(observations) {
  var groupsByKey = {};
  var valid = 0;
  var skipped = 0;
  var input = observations || [];
  for (var i = 0; i < input.length; i++) {
    var observation = normalizeTrustObservation(input[i]);
    if (!observation) {
      skipped++;
      continue;
    }
    var key = observation.decisionClass + "\u0000" + observation.channel;
    if (!groupsByKey[key]) {
      groupsByKey[key] = {
        decisionClass: observation.decisionClass,
        channel: observation.channel,
        metrics: emptyMetrics(),
      };
    }
    addObservation(groupsByKey[key], observation);
    valid++;
  }
  var keys = Object.keys(groupsByKey).sort();
  var groups = [];
  var byPair = {};
  for (var k = 0; k < keys.length; k++) {
    var group = groupsByKey[keys[k]];
    groups.push(group);
    if (!byPair[group.decisionClass]) byPair[group.decisionClass] = {};
    byPair[group.decisionClass][group.channel] = group;
  }
  return {
    groups: groups,
    byDecisionClassChannel: byPair,
    observations: valid,
    skipped: skipped,
  };
}

function pairPolicy(map, decisionClass, channel) {
  if (!map || typeof map !== "object") return null;
  var key = decisionClass + ":" + channel;
  if (map[key] && typeof map[key] === "object") return map[key];
  if (map[decisionClass] && map[decisionClass][channel]) return map[decisionClass][channel];
  return null;
}

function copyObject(base, override) {
  var result = {};
  var key;
  for (key in (base || {})) result[key] = base[key];
  for (key in (override || {})) result[key] = override[key];
  return result;
}

function resolvePolicy(policy, decisionClass, channel) {
  if (!policy || typeof policy !== "object") return null;
  var pair = pairPolicy(policy.pairs, decisionClass, channel) ||
    pairPolicy(policy.byDecisionClassChannel, decisionClass, channel) ||
    pairPolicy(policy.classes, decisionClass, channel);
  if (pair) {
    var merged = copyObject(policy, pair);
    if (policy.thresholds || pair.thresholds) {
      merged.thresholds = copyObject(policy.thresholds, pair.thresholds);
    }
    return merged;
  }
  if (policy.thresholds || hasOwn(policy, "minimumSamples") || hasOwn(policy, "minSamples")) {
    return policy;
  }
  return null;
}

function minimumSamples(policy, metric) {
  var value = hasOwn(policy, "minimumSamples") ? policy.minimumSamples : policy.minSamples;
  if (value && typeof value === "object") value = value[metric];
  return typeof value === "number" && isFinite(value) && value >= 1 ? Math.ceil(value) : null;
}

function thresholdPercent(policy, metric) {
  var thresholds = policy.thresholds || policy.minRates || {};
  var value = thresholds[metric];
  if (typeof value !== "number" || !isFinite(value) || value < 0 || value > 100) return null;
  return value <= 1 ? value * 100 : value;
}

function exactGroup(aggregate, decisionClass, channel) {
  var groups = aggregate && aggregate.groups;
  if (!Array.isArray(groups)) groups = aggregateTrustObservations(aggregate || []).groups;
  for (var i = 0; i < groups.length; i++) {
    if (groups[i].decisionClass === decisionClass && groups[i].channel === channel) return groups[i];
  }
  return null;
}

// Evaluate one exact decisionClass × channel pair. No policy means no
// promotion: observations are evidence, not an implicit autonomy change.
function evaluatePromotionEligibility(aggregate, decisionClass, channel, policy) {
  var result = {
    decisionClass: decisionClass,
    channel: channel,
    eligible: false,
    canAutoPromote: false,
    reason: "policy_missing",
    metrics: {},
  };
  if (!oneOf(decisionClass, DECISION_CLASSES) || !oneOf(channel, CHANNELS)) {
    result.reason = "invalid_pair";
    return result;
  }
  var resolved = resolvePolicy(policy, decisionClass, channel);
  if (!resolved) return result;
  result.policySupplied = true;
  var group = exactGroup(aggregate, decisionClass, channel);
  var eligible = true;
  var reason = "eligible";
  for (var i = 0; i < METRICS.length; i++) {
    var metric = METRICS[i];
    var summary = group && group.metrics[metric] ? group.metrics[metric] : emptyMetrics()[metric];
    var min = minimumSamples(resolved, metric);
    var threshold = thresholdPercent(resolved, metric);
    var enough = min !== null && summary.count >= min;
    var meets = threshold !== null && summary.rate >= threshold;
    result.metrics[metric] = {
      count: summary.count,
      passCount: summary.passCount,
      rate: summary.rate,
      minimumSamples: min,
      threshold: threshold,
      enoughSamples: enough,
      meetsThreshold: meets,
    };
    if (!enough) {
      eligible = false;
      reason = min === null ? "invalid_policy" : "insufficient_samples";
    } else if (!meets) {
      eligible = false;
      if (reason === "eligible") reason = threshold === null ? "invalid_policy" : "threshold_not_met";
    }
  }
  result.eligible = eligible;
  result.canAutoPromote = eligible;
  result.reason = reason;
  return result;
}

function isPromotionEligible(aggregate, decisionClass, channel, policy) {
  return evaluatePromotionEligibility(aggregate, decisionClass, channel, policy).eligible;
}

function addConfiguredPairs(map, pairs) {
  if (!map || typeof map !== "object") return;
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (key.indexOf(":") !== -1) {
      pairs[key] = true;
      continue;
    }
    var nested = map[key];
    if (!nested || typeof nested !== "object") continue;
    for (var c = 0; c < CHANNELS.length; c++) {
      if (nested[CHANNELS[c]]) pairs[key + ":" + CHANNELS[c]] = true;
    }
  }
}

function configuredPairs(policy) {
  var pairs = {};
  addConfiguredPairs(policy && policy.pairs, pairs);
  addConfiguredPairs(policy && policy.byDecisionClassChannel, pairs);
  addConfiguredPairs(policy && policy.classes, pairs);
  return pairs;
}

function addObservedPairs(aggregate, pairs) {
  for (var i = 0; i < aggregate.groups.length; i++) {
    var group = aggregate.groups[i];
    pairs[group.decisionClass + ":" + group.channel] = true;
  }
}

function pairParts(key) {
  var separator = key.indexOf(":");
  if (separator === -1) return null;
  return { decisionClass: key.slice(0, separator), channel: key.slice(separator + 1) };
}

function composeTrustReport(observations, policy) {
  var aggregate = aggregateTrustObservations(observations);
  var promotions = [];
  var allEligible = true;
  if (policy) {
    var pairs = configuredPairs(policy);
    addObservedPairs(aggregate, pairs);
    var keys = Object.keys(pairs).sort();
    for (var i = 0; i < keys.length; i++) {
      var pair = pairParts(keys[i]);
      if (!pair) continue;
      var eligibility = evaluatePromotionEligibility(aggregate, pair.decisionClass, pair.channel, policy);
      promotions.push(eligibility);
      if (!eligibility.eligible) allEligible = false;
    }
  }
  return {
    groups: aggregate.groups,
    byDecisionClassChannel: aggregate.byDecisionClassChannel,
    observations: aggregate.observations,
    skipped: aggregate.skipped,
    policySupplied: !!policy,
    promotionEligible: policy ? promotions : [],
    pass: policy ? allEligible && promotions.length > 0 : null,
  };
}

function formatTrustReport(report) {
  var parts = [];
  var groups = (report && report.groups) || [];
  parts.push("trust " + (groups.length ? groups.length + " class/channel pair(s)" : "no observations"));
  for (var i = 0; i < groups.length; i++) {
    var group = groups[i];
    var metrics = [];
    for (var m = 0; m < METRICS.length; m++) {
      var summary = group.metrics[METRICS[m]];
      metrics.push(METRICS[m] + " " + summary.passCount + "/" + summary.count + " (" + summary.rate + "%)");
    }
    parts.push(group.decisionClass + "/" + group.channel + ": " + metrics.join(", "));
  }
  if (report && report.skipped) parts.push("skipped " + report.skipped + " malformed");
  if (report && report.policySupplied) parts.push("promotion " + (report.pass ? "eligible" : "held"));
  return parts.join(" · ");
}

module.exports = {
  DECISION_CLASSES: DECISION_CLASSES,
  CHANNELS: CHANNELS,
  METRICS: METRICS,
  TRUST_EVENT_TYPE: TRUST_EVENT_TYPE,
  isTrustObservationEvent: isTrustObservationEvent,
  normalizeTrustObservation: normalizeTrustObservation,
  validateTrustObservation: validateTrustObservation,
  aggregateTrustObservations: aggregateTrustObservations,
  aggregate: aggregateTrustObservations,
  evaluatePromotionEligibility: evaluatePromotionEligibility,
  isPromotionEligible: isPromotionEligible,
  composeTrustReport: composeTrustReport,
  formatTrustReport: formatTrustReport,
};
