// Lead staffing adapter (CTO orchestrator brick 4 — roadmap §4.2).
//
// Turns a routed backlog item into a fully specified delegation for
// clay-orchestration/delegate_task. The heavy lifting (visible durable
// workers, provider pinning, coordinator promotion) already exists in the
// orchestration layer; this module owns WHAT the Lead asks for:
//   - a complete worker brief (objective, context, ownership boundaries)
//   - acceptance criteria derived from the route's verification depth,
//     encoding the audit doctrine: agent prose is not evidence — done means
//     observable proof.
//
// Pure module, unwired (§1.1): the Lead loop will call composeStaffing and
// hand the result to delegate_task.

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

// --- Brief composition ---------------------------------------------------------

// composeStaffing(item, route, opts) -> delegate_task args (minus
// coordinatorSessionId, which only the live Lead session knows).
//   item:  normalized backlog item (lead-backlog)
//   route: routing decision (lead-routing) — required
//   opts.ownedPaths: string — the boundary the Lead grants; REQUIRED for
//     write work. Review-class items are forced read-only regardless.
//   opts.extraContext: string appended to context (e.g. prior attempts).
// Returns null when the item cannot be staffed (no route).
function composeStaffing(item, route, opts) {
  if (!item || !route) return null;
  var ownedPaths = (opts && opts.ownedPaths) || "";
  var isReadOnly = item.classification && (item.classification.taskClass === "review" || item.classification.taskClass === "research");
  if (isReadOnly && ownedPaths.indexOf("read-only:") !== 0) {
    ownedPaths = "read-only:" + (ownedPaths || "entire repository");
  }
  if (!ownedPaths) return null; // a worker without boundaries is not a delegation

  var contextParts = [
    "Source: " + item.source + (item.url ? " (" + item.url + ")" : "") + ", project: " + item.project + ".",
    "Classified " + item.classification.taskClass + "/" + item.classification.risk +
      "; routing rationale: " + route.rationale + ".",
  ];
  if (item.body) contextParts.push("Item description: " + item.body);
  if (opts && opts.extraContext) contextParts.push(opts.extraContext);

  return {
    title: item.title.slice(0, 80),
    objective: (isReadOnly
      ? "Investigate and report on: "
      : "Implement and verify: ") + item.title +
      ". Stay strictly within the owned paths. Do not broaden scope; escalate per your worker contract instead.",
    context: contextParts.join("\n"),
    acceptanceCriteria: verificationCriteria(route.verificationDepth),
    ownedPaths: ownedPaths,
    provider: route.vendor,
    model: route.model,
    difficulty: route.tier >= 3 ? "strong" : "routine",
  };
}

module.exports = {
  composeStaffing: composeStaffing,
  verificationCriteria: verificationCriteria,
};
