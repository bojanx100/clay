// Lead routing brain (CTO orchestrator, Phase 1 — see
// docs/roadmaps/planned/CTO-ORCHESTRATOR-ROADMAP.md §4).
//
// Pure decision module: classify a work item, then route it to the
// cheapest-capable provider/model with an explicit verification depth.
// Codifies the prose heuristic from model-recommendations.js into typed,
// testable decisions (audit lesson: agent prose is not evidence — and
// neither is prose a routing policy).
//
// Deliberately UNWIRED: nothing requires this module yet. The Lead (CTO
// mode) will call it when the module ships; until then it is additive-only
// dead code with tests, per the roadmap's §1.1 reversibility rule.
//
// Purity contract: no I/O, no clocks, no globals. Provider health and
// budget pressure are INJECTED by the caller (the Lead reads health at
// decision time and composes budget pressure from persisted usage signals).

var { modelCapabilityTier } = require("./model-capability");
var { healthForCandidate } = require("./lead-health");

// --- Task classification ----------------------------------------------------

// Keyword tables are ordered most-specific-first; first match wins within a
// dimension. Classification is deterministic on purpose: the gate philosophy
// demands decisions that can be replayed and audited.
var CLASS_RULES = [
  { taskClass: "design", re: /\b(architect(ure)?|design decision|api design|product decision|trade-?off|roadmap|strategy|naming|ux direction)\b/i },
  { taskClass: "security", re: /\b(security|vulnerabilit|auth[nz]?|authentication|authorization|secret|token leak|cve|injection|xss|csrf)\b/i },
  { taskClass: "debugging", re: /\b(bug|crash|regression|broken|fails?|failing|flaky|stall|hang|leak|race condition|investigate|root.?cause)\b/i },
  { taskClass: "research", re: /\b(research|investigate options|compare|evaluate|benchmark|explore|feasibilit|spike)\b/i },
  { taskClass: "review", re: /\b(review|audit|verify|qa pass|inspect)\b/i },
  { taskClass: "mechanical", re: /\b(rename|typo|bump|upgrade dependenc|reformat|lint fix|copy change|comment|dead code|move file|delete unused)\b/i },
];

var HIGH_RISK_RE = /\b(migration|schema|database|auth|security|permission|daemon|payment|billing|public api|breaking|irreversible|delete (data|user)|drop table|production|restart(?:s|ed|ing)?\b(?:\W+\w+){0,3}\W+\b(?:daemon|server|process|service|clay)\b|(?:daemon|server|process|service|clay)\b(?:\W+\w+){0,3}\W+\brestart(?:s|ed|ing)?)\b/i;
var MEDIUM_RISK_RE = /\b(provider|session|websocket|persistence|storage|config|settings|routing|pipeline)\b/i;

var LARGE_EFFORT_RE = /\b(rewrite|refactor(ing)? (the )?(module|system|architecture)|new (feature|module|subsystem)|end.?to.?end|across (all|every)|multi.?project)\b/i;
var SMALL_EFFORT_RE = /\b(typo|one.?lin(e|er)|rename|small|tiny|quick|trivial|single file|copy change|bump)\b/i;

// classifyWorkItem(item) -> { taskClass, risk, effort }
//   item: { title, body?, labels? } — labels (array of strings) win over
//   keyword inference when present ("bug", "security", "design", ...).
//
// Calibration (backtest vs trialview/v2 history, 136 issue/PR pairs):
// the TITLE is the author's summary of what the work IS; the body is
// frequently machine-generated noise (stack traces, URLs, Sentry dumps)
// that name-drops "auth"/"security" without the work being risky. So the
// title drives classification and high risk; body-only matches degrade
// to a lower confidence (class fallback, risk capped at medium).
var LABEL_CLASS = {
  bug: "debugging",
  security: "security",
  design: "design",
  architecture: "design",
  chore: "mechanical",
  mechanical: "mechanical",
  research: "research",
  spike: "research",
};

function classFromLabels(labels) {
  for (var li = 0; li < (labels || []).length; li++) {
    var mapped = LABEL_CLASS[String(labels[li] || "").toLowerCase()];
    if (mapped) return mapped;
  }
  return null;
}

function classFromRules(text) {
  for (var ci = 0; ci < CLASS_RULES.length; ci++) {
    if (CLASS_RULES[ci].re.test(text)) return CLASS_RULES[ci].taskClass;
  }
  return null;
}

function riskFor(title, body, taskClass) {
  var risk = "low";
  if (HIGH_RISK_RE.test(title)) risk = "high";
  else if (HIGH_RISK_RE.test(body) || MEDIUM_RISK_RE.test(title + "\n" + body)) risk = "medium";
  // Security work is never low-risk regardless of wording.
  if (taskClass === "security" && risk === "low") risk = "medium";
  return risk;
}

function classifyWorkItem(item) {
  var title = (item && item.title) || "";
  var body = (item && item.body) || "";
  var labels = (item && item.labels) || [];

  var taskClass = classFromLabels(labels) || classFromRules(title) ||
    classFromRules(body) || "implementation";
  var risk = riskFor(title, body, taskClass);

  var text = title + "\n" + body;
  var effort = LARGE_EFFORT_RE.test(text) ? "large"
    : (SMALL_EFFORT_RE.test(text) ? "small" : "medium");

  return { taskClass: taskClass, risk: risk, effort: effort };
}

// --- Routing ----------------------------------------------------------------

// Canonical model per vendor per capability tier (1=cheap/fast .. 4=frontier).
// Kept consistent with model-capability.js tier detection.
var MODEL_TABLE = {
  claude: { 1: "haiku", 2: "sonnet", 3: "opus", 4: "fable" },
  codex: { 1: "gpt-5.4-mini", 2: "gpt-5.6-luna", 3: "gpt-5.6-terra", 4: "gpt-5.6-sol" },
};

var ROUTE_TABLE = {
  claude: "claude-anthropic",
  codex: "codex-openai",
};

// Which tier a task class needs at each risk level. The table encodes
// "cheapest capable": floor tier for the work, bumped by risk — never
// premium-by-default (roadmap §4.3).
var TIER_FLOOR = {
  design:         { low: 4, medium: 4, high: 4 }, // judgment work is frontier work
  security:       { low: 3, medium: 3, high: 4 },
  debugging:      { low: 2, medium: 3, high: 3 },
  research:       { low: 3, medium: 3, high: 4 }, // long-horizon: codex-leaning
  review:         { low: 2, medium: 3, high: 3 },
  implementation: { low: 2, medium: 2, high: 3 },
  mechanical:     { low: 1, medium: 1, high: 2 },
};

// Vendor preference per task class (from the guidance heuristic: Codex for
// long-running/research-style work, Claude for judgment/debug depth).
var VENDOR_PREFERENCE = {
  design: ["claude", "codex"],
  security: ["claude", "codex"],
  debugging: ["claude", "codex"],
  research: ["codex", "claude"],
  review: ["claude", "codex"],
  implementation: ["codex", "claude"],
  mechanical: ["codex", "claude"],
};

var VERIFICATION_DEPTH = {
  high: "full-gate",     // structural metrics + behavioral verification + review
  medium: "standard",    // tests + targeted behavioral verification
  low: "light",          // tests + lint; gate still refuses regressions
};

// routeWorkItem(classification, opts) -> route
//   classification: output of classifyWorkItem
//   opts.health: { claude: "healthy"|"degraded"|"unhealthy", codex: ... }
//                (injected snapshot; missing vendor counts as healthy)
//   opts.escalated: integer 0..n — number of prior failed attempts on this
//                item; each failure bumps the tier by one (capped at 4).
//   opts.budgetPressure: { active, vendorCostRank, cheaperVendor } from
//                lead-budget. Only active === true changes vendor ordering.
// Returns { vendor, model, tier, verificationDepth, rationale } or null when
// no healthy vendor can serve the tier (caller decides to wait or ask).
function pressurePreference(preference, pressure) {
  if (!pressure || pressure.active !== true) return preference;
  var ranks = pressure.vendorCostRank || {};
  var cheaper = pressure.cheaperVendor;
  var original = {};
  for (var oi = 0; oi < preference.length; oi++) original[preference[oi]] = oi;
  var ordered = preference.slice();
  ordered.sort(function (a, b) {
    var ar = typeof ranks[a] === "number" ? ranks[a] : (a === cheaper ? -1 : Number.MAX_SAFE_INTEGER);
    var br = typeof ranks[b] === "number" ? ranks[b] : (b === cheaper ? -1 : Number.MAX_SAFE_INTEGER);
    return ar === br ? original[a] - original[b] : ar - br;
  });
  return ordered;
}

function candidateHealth(health, vendor, model) {
  return healthForCandidate(health, vendor, ROUTE_TABLE[vendor], model);
}

function pickVendor(preference, health, tier, pressure) {
  var ordered = pressurePreference(preference, pressure);
  for (var vi = 0; vi < ordered.length; vi++) {
    var vendor = ordered[vi];
    var model = MODEL_TABLE[vendor] && MODEL_TABLE[vendor][tier];
    if (!model) continue;
    if (candidateHealth(health, vendor, model) === "unhealthy") continue;
    return {
      vendor: vendor,
      providerRouteId: ROUTE_TABLE[vendor],
      model: model,
      fallback: vi > 0,
      budgetPreferred: pressure && pressure.active === true && vendor !== preference[0],
    };
  }
  return null;
}

function pressureFromOptions(opts) {
  if (!opts) return null;
  if (opts.budgetPressure) return opts.budgetPressure;
  if (opts.budget) return opts.budget.pressure || null;
  return null;
}

function routeRationale(taskClass, risk, escalated, tier, pick) {
  var reason = taskClass + "/" + risk;
  if (escalated) reason += " (escalated x" + escalated + ")";
  reason += " -> tier " + tier + " on " + pick.vendor;
  if (pick.budgetPreferred) reason += " (budget pressure: cheaper capable vendor)";
  else if (pick.fallback) reason += " (preferred vendor unavailable)";
  return reason;
}

function approvalFields(route, pressure) {
  if (!pressure || pressure.active !== true || route.tier !== 4) return route;
  route.needsApproval = true;
  route.approvalReason = "tier-4 staffing under budget pressure";
  return route;
}

function routeWorkItem(classification, opts) {
  var options = opts || {};
  var health = options.health || {};
  var escalated = options.escalated || 0;
  var budgetPressure = pressureFromOptions(options);
  var taskClass = classification.taskClass || "implementation";
  var risk = classification.risk || "low";

  var floors = TIER_FLOOR[taskClass] || TIER_FLOOR.implementation;
  var tier = floors[risk] || floors.low;
  tier = Math.min(4, tier + escalated);

  var preference = VENDOR_PREFERENCE[taskClass] || VENDOR_PREFERENCE.implementation;
  var pick = pickVendor(preference, health, tier, budgetPressure);
  if (!pick) return null;
  var route = {
    vendor: pick.vendor,
    providerRouteId: pick.providerRouteId,
    model: pick.model,
    tier: tier,
    verificationDepth: VERIFICATION_DEPTH[risk] || "standard",
    rationale: routeRationale(taskClass, risk, escalated, tier, pick),
  };
  return approvalFields(route, budgetPressure);
}

// Sanity hook: the canonical models must land in the tiers this table
// claims, per model-capability.js. Exported for tests.
function tableConsistent() {
  for (var vendor in MODEL_TABLE) {
    for (var tier in MODEL_TABLE[vendor]) {
      if (modelCapabilityTier(MODEL_TABLE[vendor][tier]) !== Number(tier)) return false;
    }
  }
  return true;
}

module.exports = {
  classifyWorkItem: classifyWorkItem,
  routeWorkItem: routeWorkItem,
  tableConsistent: tableConsistent,
  MODEL_TABLE: MODEL_TABLE,
  TIER_FLOOR: TIER_FLOOR,
  ROUTE_TABLE: ROUTE_TABLE,
};
