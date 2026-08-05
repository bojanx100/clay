// Lead staffing adapter (CTO orchestrator brick 4 — roadmap §4.2).
//
// Turns a routed backlog item into a fully specified target-project execution
// command. Slice 9 deliberately does not produce a Lead-local delegate_task
// fallback: a missing canonical target becomes typed attention instead.
// This module owns WHAT the Lead asks for:
//   - a complete worker brief (objective, context, ownership boundaries)
//   - acceptance criteria derived from the route's verification depth,
//     encoding the audit doctrine: agent prose is not evidence — done means
//     observable proof.
//
// Pure module, unwired (§1.1): the Lead loop calls composeStaffingDecision and
// sends a green command through the cross-project execution router.
var projectIdentity = require("./project-identity");

// --- Verification criteria per depth ------------------------------------------

// The done-gate ladder (roadmap §5, resolved question 12.3): what a worker
// must PROVE before reporting WORKER_STATUS: complete.
var CRITERIA = {
  "light": [
    "Targeted tests for the changed code pass (run them; include the command and result).",
    "Lint/typecheck on touched files is clean.",
    "No unrelated files changed.",
  ],
  "standard": [
    "Full test suite passes (include counts).",
    "The changed behavior is exercised end-to-end at least once — describe the observable evidence, not intentions.",
    "Coverage on touched files does not drop below the last green build.",
    "No unrelated files changed.",
  ],
  "full-gate": [
    "Full test suite passes (include counts) and a regression test for this specific change exists.",
    "The changed behavior is verified end-to-end with observable evidence (logs, output, or state inspection — prose claims do not count).",
    "Coverage and complexity on touched files do not regress from the last green build.",
    "Diagnostics canaries stay quiet during verification (~/.clay/recovery-events*.log, diag*.log) when the change touches daemon paths.",
    "An explicit risk note: what could break, and how a reviewer can check.",
  ],
};

function verificationCriteria(depth) {
  var list = CRITERIA[depth] || CRITERIA.standard;
  return list.join(" ");
}

function stableId(value, prefix) {
  var cleaned = String(value || "").trim().replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 220);
  return cleaned ? prefix + cleaned : "";
}

function staffingRoute(item, opts) {
  var options = opts || {};
  var targetProject = projectIdentity.normalizeProjectRef(options.targetProject);
  if (!targetProject) return { ok: false, reason: "target_project_required" };
  if (targetProject.projectId === projectIdentity.LEAD_PROJECT_ID) {
    return { ok: false, reason: "lead_execution_forbidden" };
  }
  var portfolioTaskId = options.portfolioTaskId || stableId(item && item.id, "portfolio-");
  var bindingRevision = Number.isInteger(options.bindingRevision) && options.bindingRevision > 0 ?
    options.bindingRevision : 1;
  var idempotencyKey = options.idempotencyKey ||
    stableId(portfolioTaskId + "-r" + bindingRevision, "staff-");
  if (!projectIdentity.isTaskId(portfolioTaskId) || !projectIdentity.isTaskId(idempotencyKey)) {
    return { ok: false, reason: "stable_binding_identity_required" };
  }
  return {
    ok: true,
    targetProject: targetProject,
    portfolioTaskId: portfolioTaskId,
    bindingRevision: bindingRevision,
    idempotencyKey: idempotencyKey,
    mode: options.mode === "direct_leaf" ? "direct_leaf" : "project_coordinator",
  };
}

function staffingAttention(item, reason) {
  return {
    ok: false,
    reason: reason,
    attention: {
      type: "staffing_attention",
      itemId: String(item && item.id || ""),
      reason: reason,
      fallbackAllowed: false,
    },
  };
}

function readOnlyItem(item) {
  var taskClass = item && item.classification && item.classification.taskClass;
  return taskClass === "review" || taskClass === "research";
}

function ownedPathsFor(item, opts) {
  var ownedPaths = opts && opts.ownedPaths || "";
  if (readOnlyItem(item) && ownedPaths.indexOf("read-only:") !== 0) {
    return "read-only:" + (ownedPaths || "entire repository");
  }
  return ownedPaths;
}

function staffingContext(item, route, opts) {
  var parts = [
    "Source: " + item.source + (item.url ? " (" + item.url + ")" : "") + ", project: " + item.project + ".",
    "Classified " + item.classification.taskClass + "/" + item.classification.risk +
      "; routing rationale: " + route.rationale + ".",
  ];
  if (item.body) parts.push("Item description: " + item.body);
  if (opts && opts.extraContext) parts.push(opts.extraContext);
  return parts.join("\n");
}

// --- Brief composition ---------------------------------------------------------

// composeStaffing(item, route, opts) -> typed project-execution command fields
// (minus source, which only the live Coop session knows).
//   item:  normalized backlog item (lead-backlog)
//   route: routing decision (lead-routing) — required
//   opts.ownedPaths: string — the boundary the Lead grants; REQUIRED for
//     write work. Review-class items are forced read-only regardless.
//   opts.extraContext: string appended to context (e.g. prior attempts).
// Returns null when the item cannot be staffed. composeStaffingDecision keeps
// the typed attention reason for callers that need to persist/display it.
function composeStaffingDecision(item, route, opts) {
  if (!item || !route) return staffingAttention(item, "route_required");
  var ownedPaths = ownedPathsFor(item, opts);
  var isReadOnly = readOnlyItem(item);
  if (!ownedPaths) return staffingAttention(item, "owned_paths_required");
  var target = staffingRoute(item, opts);
  if (!target.ok) return staffingAttention(item, target.reason);

  return Object.assign({
    ok: true,
    title: item.title.slice(0, 80),
    objective: (isReadOnly
      ? "Investigate and report on: "
      : "Implement and verify: ") + item.title +
      ". Stay strictly within the owned paths. Do not broaden scope; escalate per your worker contract instead.",
    context: staffingContext(item, route, opts),
    acceptanceCriteria: verificationCriteria(route.verificationDepth),
    ownedPaths: ownedPaths,
    provider: route.vendor,
    model: route.model,
    difficulty: route.tier >= 3 ? "strong" : "routine",
    routingAuthority: "typed_project_binding",
  }, target);
}

function composeStaffing(item, route, opts) {
  var decision = composeStaffingDecision(item, route, opts);
  return decision.ok ? decision : null;
}

module.exports = {
  composeStaffing: composeStaffing,
  composeStaffingDecision: composeStaffingDecision,
  verificationCriteria: verificationCriteria,
};
