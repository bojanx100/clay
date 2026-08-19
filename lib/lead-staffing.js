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
var workIdentity = require("./work-identity");

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

var GITHUB_ITEM_KEY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#([1-9][0-9]*)$/;

function githubIssueNumber(candidate, project) {
  var values = [];
  if (Object.prototype.hasOwnProperty.call(candidate, "number")) {
    if (!Number.isSafeInteger(candidate.number) || candidate.number < 1) return null;
    values.push(candidate.number);
  }
  if (candidate.itemKey != null) {
    var itemMatch = String(candidate.itemKey).match(GITHUB_ITEM_KEY_RE);
    if (!itemMatch) return null;
    values.push(Number(itemMatch[1]));
  }
  if (candidate.id != null) {
    var prefix = project + "#";
    var suffix = String(candidate.id).indexOf(prefix) === 0 ? String(candidate.id).slice(prefix.length) : "";
    if (!/^[1-9][0-9]*$/.test(suffix)) return null;
    values.push(Number(suffix));
  }
  if (!values.length || !Number.isSafeInteger(values[0])) return null;
  for (var i = 1; i < values.length; i++) if (values[i] !== values[0]) return null;
  return values[0];
}

// One exact identity path for both pre-scoring binding checks and staffing.
function portfolioTaskIdForCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
      candidate.source !== "github") return "";
  var project = typeof candidate.project === "string" ? candidate.project.trim() : "";
  var number = project ? githubIssueNumber(candidate, project) : null;
  return number ? stableId(project + "#" + number, "portfolio-") : "";
}

// Resolves an item to the identity of the WORK, so the same job reaches the
// binding store under one string no matter which path staffed it. The paths
// disagree on spelling -- automation carries a candidateKey
// ("launch:trialview/v2#2522"), the GitHub backlog carries a url plus a
// project-scoped id ("webapp#2522") -- and left unreconciled the same issue
// would take two identities and walk straight past the duplicate guard, which
// is the exact failure this exists to prevent. Repo coordinates win wherever
// they can be recovered, being unambiguous across projects.
function workIdentityForItem(item) {
  if (!item || typeof item !== "object") return "";
  var candidateKey = workIdentity.normalizeWorkIdentity(item.candidateKey);
  if (candidateKey) return candidateKey;
  var fromUrl = workIdentity.issueUrlIdentity(item.url);
  if (fromUrl) return fromUrl;
  var project = typeof item.project === "string" ? item.project.trim() : "";
  var number = project ? githubIssueNumber(item, project) : null;
  return number ? workIdentity.repoIssueIdentity(project, number) : "";
}

function staffingRoute(item, opts) {
  var options = opts || {};
  var targetProject = projectIdentity.normalizeProjectRef(options.targetProject);
  if (!targetProject) return { ok: false, reason: "target_project_required" };
  if (targetProject.projectId === projectIdentity.LEAD_PROJECT_ID) {
    return { ok: false, reason: "lead_execution_forbidden" };
  }
  var defaultTaskId = item && item.source === "github" ?
    portfolioTaskIdForCandidate(item) : stableId(item && item.id, "portfolio-");
  var portfolioTaskId = options.portfolioTaskId || defaultTaskId;
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
    // The stable identity of the work itself, carried so the binding store can
    // recognise a job it has already staffed under a different attempt name.
    // portfolioTaskId alone could not do this: callers may supply an ad-hoc one,
    // and each fresh id started a new binding family for the same issue.
    workIdentity: workIdentityForItem(item),
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
  portfolioTaskIdForCandidate: portfolioTaskIdForCandidate,
  verificationCriteria: verificationCriteria,
};
