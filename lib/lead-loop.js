// Lead loop tick (CTO orchestrator brick 8 — Phase 2, roadmap §3.2).
//
// The Lead's heartbeat as a PURE decision function: given the current
// portfolio, what's in flight, failure history and the autonomy dial,
// decide what to do next. The daemon wiring executes decisions; this
// module never performs I/O, so every tick is replayable — the Lead can
// always answer "why did you do that?" with its inputs.
//
// Decisions returned (array, possibly empty):
//   { action: "staff",           item, route, needsApproval }  — start work
//   { action: "give_up",         item, reason }                — out of retries -> needs-you
//   { action: "reconcile_history", records }                  — historical work first
//   { action: "reconcile_scope", bindings }                   — exact owner-scoped continuation
//   { action: "compose_standup" }                              — daily digest due
//   { action: "wait",            reason }                      — explicit idle (capacity/empty/unroutable)
//
// Autonomy dial (roadmap §6, "propose & approve" while trust calibrates):
// big items (high risk, frontier tier, or design/security class) get
// needsApproval: true — the executor posts a proposal and waits. Small
// low-risk work flows without asking.

var projectIdentity = require("./project-identity");
var ownerRequestBatching = require("./coop-owner-request-batching");

var MAX_FAILURES = 3;
var DEFAULT_PARALLEL_CAPACITY = 3;
var MAX_PARALLEL_CAPACITY = 10;
var STANDUP_INTERVAL_MS = 24 * 3600000;
var TERMINAL_BINDING_STATUSES = {
  completed: true,
  failed: true,
  superseded: true,
  cancelled: true,
  deleted: true,
  unrouted: true,
};

// `needs_input` is only terminal when the binding has recorded the delivered
// terminal outcome. A bare `needs_input` can still be a live coordinator
// blocked on a human decision, so it remains capacity-consuming until that
// evidence exists. This keeps a malformed or partially reconciled record
// fail-closed without making completed owner-attention bookkeeping look live.
function hasTerminalNeedsInput(binding) {
  return binding && binding.status === "needs_input" &&
    typeof binding.completedAt === "number" && Number.isFinite(binding.completedAt) &&
    binding.completedAt > 0 && typeof binding.completionEventId === "string" &&
    binding.completionEventId.trim().length > 0;
}

function isBigItem(item, route) {
  var risk = item.classification && item.classification.risk;
  var cls = item.classification && item.classification.taskClass;
  return risk === "high" || (route && route.tier >= 4) || cls === "design" || cls === "security";
}

// Owner requests Coop can still answer, oldest first. A request whose state is
// needs_input or attention is waiting on the OWNER, not on Coop, so it is not
// answerable here however long it has been outstanding.
var OWNER_BLOCKED_STATES = { needs_input: true, attention: true };

function answerableRequests(requests) {
  var list = Array.isArray(requests) ? requests : [];
  var answerable = [];
  for (var i = 0; i < list.length; i++) {
    var request = list[i];
    if (!request || OWNER_BLOCKED_STATES[request.state]) continue;
    answerable.push(request);
  }
  return answerable.sort(function (left, right) {
    return (left.ingressSequence || 0) - (right.ingressSequence || 0);
  });
}

// The link payload for an answer_owner decision, pre-split into batches the
// Coop control gate will actually accept.
//
// This used to emit ONE flat `requests` array holding every answerable
// request. The gate caps a single link_owner_response call at
// MAX_OWNER_REQUEST_BATCH, so once the backlog passed that cap the Lead's
// highest-priority decision became structurally unlinkable: the whole call
// was refused with a typed `too_big`, nothing drained, and the backlog grew.
// Measured on live state at 20 unanswered requests against a cap of 16.
//
// `batches` is therefore the contract, not `requests`. Every answerable
// request appears in exactly one batch, in the same oldest-first order, so
// the caller makes ceil(n / cap) accepted calls instead of one refused one.
// Nothing is truncated: an owner question that cannot fit in this call is
// carried into the next one, never dropped.
//
// The flat `requests` key is deliberately GONE rather than kept as a
// first-batch alias. A caller still passing `responseLink.requests` now sends
// undefined and is refused loudly by the gate's own schema, which is the
// failure we want -- silently linking only the first 16 and reporting success
// would leave the remainder unanswered with nothing anywhere recording it.
function ownerResponseLink(requests) {
  var links = requests.map(function (request) {
    return { ingressId: request.ingressId, requestRef: request.requestRef };
  });
  return {
    version: 2,
    maxRequestsPerCall: ownerRequestBatching.MAX_OWNER_REQUEST_BATCH,
    totalRequests: links.length,
    batches: ownerRequestBatching.batchOwnerRequests(links),
  };
}

// The cutover moved project work out of the Lead workspace, so the legacy
// ledger is no longer the complete in-flight premise. A valid ProjectRef
// binding is authoritative for project execution: every non-terminal binding
// consumes a slot, including a worker waiting for owner input. Only a durable
// terminal/released binding can free capacity.
function validTypedBinding(binding) {
  if (!binding || typeof binding !== "object") return false;
  var targetProject = projectIdentity.normalizeProjectRef(binding.targetProject);
  if (!projectIdentity.isTaskId(binding.portfolioTaskId) ||
      !Number.isInteger(binding.bindingRevision) || binding.bindingRevision < 1 ||
      !targetProject || targetProject.projectId === projectIdentity.LEAD_PROJECT_ID ||
      (binding.mode !== "project_coordinator" && binding.mode !== "direct_leaf")) return false;
  return true;
}

function bindingConsumesCapacity(binding) {
  if (!validTypedBinding(binding)) return false;
  return !TERMINAL_BINDING_STATUSES[binding.status] && !hasTerminalNeedsInput(binding);
}

function latestTypedBindings(bindings) {
  var list = Array.isArray(bindings) ? bindings : [];
  var latest = {};
  for (var i = 0; i < list.length; i++) {
    var binding = list[i];
    if (!validTypedBinding(binding)) continue;
    var prior = latest[binding.portfolioTaskId];
    if (!prior || binding.bindingRevision > prior.bindingRevision) {
      latest[binding.portfolioTaskId] = binding;
    }
  }
  return latest;
}

function bindingBlocksRestaff(binding) {
  if (!validTypedBinding(binding)) return false;
  return binding.status === "completed" || binding.status === "superseded" ||
    binding.status === "cancelled" || binding.status === "deleted" ||
    hasTerminalNeedsInput(binding);
}

function normalizeParallelCapacity(value) {
  var parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  parsed = Math.floor(parsed);
  if (parsed < 1) return 1;
  return Math.min(MAX_PARALLEL_CAPACITY, parsed);
}

// inFlightForTick(input) returns the exact state that governs both capacity and
// the stale-premise check. Legacy ledger entries stay until their historical
// drain completes; typed ProjectRef bindings cover all post-cutover execution.
function inFlightForTick(input) {
  var legacy = Array.isArray(input && input.inFlight) ? input.inFlight : [];
  var typed = latestTypedBindings(input && input.portfolioBindings);
  var result = [];
  for (var i = 0; i < legacy.length; i++) {
    var itemId = legacy[i] && legacy[i].item && legacy[i].item.id;
    if (itemId && typed[itemId]) continue;
    result.push(legacy[i]);
  }
  var taskIds = Object.keys(typed).sort();
  for (var ti = 0; ti < taskIds.length; ti++) {
    if (bindingConsumesCapacity(typed[taskIds[ti]])) {
      result.push({ binding: typed[taskIds[ti]] });
    }
  }
  return result;
}

// Lead defaults to the same safe parallelism the generic task orchestrator uses
// (3), not a bespoke serial rule. Typed/legacy occupancy then floors that
// number so the policy never pretends fewer coordinators are active than the
// durable state already proves.
function safeParallelCapacity(input, occupiedCount) {
  var occupied = Number.isInteger(occupiedCount) ? occupiedCount :
    inFlightForTick(input).length;
  var explicit = normalizeParallelCapacity(input && input.capacity);
  var baseline = explicit || DEFAULT_PARALLEL_CAPACITY;
  return Math.max(occupied, baseline);
}

function matchesHistoricalBinding(record, binding) {
  if (!record || !binding) return false;
  if (String(record.portfolioTaskId || "") !== String(binding.portfolioTaskId || "")) return false;
  if (Number(record.bindingRevision) !== Number(binding.bindingRevision)) return false;
  if (record.mode && binding.mode && record.mode !== binding.mode) return false;
  var expectedProject = record.projectRef && record.projectRef.projectId;
  var actualProject = binding.targetProject && binding.targetProject.projectId;
  return !expectedProject || !actualProject || expectedProject === actualProject;
}

function historicalReconciliationPlan(records, bindings) {
  var source = Array.isArray(records) ? records : [];
  if (!Array.isArray(bindings)) return { actionable: source.slice(), blocked: [] };
  var actionable = [];
  var blocked = [];
  for (var i = 0; i < source.length; i++) {
    var record = source[i];
    if (!record || !record.portfolioTaskId || !Number(record.bindingRevision)) {
      actionable.push(record);
      continue;
    }
    var found = false;
    for (var j = 0; j < bindings.length; j++) {
      if (matchesHistoricalBinding(record, bindings[j])) {
        found = true;
        break;
      }
    }
    if (found) {
      actionable.push(record);
      continue;
    }
    blocked.push(Object.assign({}, record, {
      durableBlocker: {
        code: "canonical_binding_missing",
        portfolioTaskId: record.portfolioTaskId,
        bindingRevision: record.bindingRevision,
        mode: record.mode || null,
        projectRef: record.projectRef || null,
        reason: "The exact typed binding is absent from the current binding generation; steering remains fail-closed.",
      },
    }));
  }
  return { actionable: actionable, blocked: blocked };
}

function sameScopedBinding(scope, binding) {
  return validTypedBinding(scope) && validTypedBinding(binding) &&
    scope.portfolioTaskId === binding.portfolioTaskId &&
    scope.bindingRevision === binding.bindingRevision &&
    scope.mode === binding.mode &&
    scope.targetProject.projectId === binding.targetProject.projectId;
}

// An explicit owner scope is a closed set of existing typed bindings, not a
// backlog filter. Missing or malformed members therefore fail closed instead
// of letting the ordinary staffing loop fill the newly apparent capacity.
function ownerContinuationPlan(scope, bindings) {
  var requested = Array.isArray(scope) ? scope : [];
  var current = Array.isArray(bindings) ? bindings : [];
  var selected = [];
  var blockers = [];
  var seen = {};
  if (!requested.length) {
    blockers.push({ code: "owner_continuation_scope_invalid" });
  }
  for (var i = 0; i < requested.length; i++) {
    var item = requested[i];
    if (!validTypedBinding(item)) {
      blockers.push({
        code: "owner_continuation_scope_invalid",
        portfolioTaskId: item && item.portfolioTaskId || null,
      });
      continue;
    }
    var key = item.targetProject.projectId + "\u0000" + item.portfolioTaskId + "\u0000" +
      item.bindingRevision + "\u0000" + item.mode;
    if (seen[key]) continue;
    seen[key] = true;
    var found = null;
    for (var j = 0; j < current.length; j++) {
      if (sameScopedBinding(item, current[j])) {
        found = current[j];
        break;
      }
    }
    if (found) selected.push(found);
    else blockers.push({
      code: "canonical_binding_missing",
      portfolioTaskId: item.portfolioTaskId,
      bindingRevision: item.bindingRevision,
      mode: item.mode,
      projectRef: item.targetProject,
    });
  }
  return { bindings: selected, blockers: blockers };
}

// leadTick(input) -> decisions[]
//   input.portfolio: lead-backlog.buildPortfolio output
//   input.inFlight: legacy lead-ledger.inFlight output ([{item,...}])
//   input.portfolioBindings: typed portfolio-execution-bindings list()
//   input.failureCounts: { itemId: n } (lead-ledger.failureCount per candidate)
//   input.capacity: optional explicit concurrent staffing cap; otherwise the
//     task-orchestration default (3) is used and floored by live occupancy
//   input.lastStandupAt: ms of last standup_composed event (0 if never)
//   input.now: injected clock
//   input.routeFn: (classification, opts) -> route  (inject lead-routing.routeWorkItem)
function leadTick(input) {
  var decisions = [];
  var portfolio = (input && input.portfolio) || { items: [] };
  var inFlight = inFlightForTick(input);
  var failureCounts = (input && input.failureCounts) || {};
  var capacity = safeParallelCapacity(input, inFlight.length);
  var lastStandupAt = (input && input.lastStandupAt) || 0;
  var now = (input && input.now) || 0;
  var routeFn = input && input.routeFn;

  // 0. The owner is waiting. Nothing routine outranks that.
  //
  // Standups and backlog staffing run on Lead's own schedule; an owner who
  // asked something and has not been answered is the highest-priority signal
  // Coop has, so the response decision is emitted first -- including at
  // capacity, because answering is not staffing and consumes no slot.
  //
  // Requests already blocked ON the owner (needs_input, attention) are
  // deliberately excluded: they are not Coop's to answer, and letting them
  // preempt would stall the backlog behind something only the owner can clear.
  var answerable = answerableRequests(input && input.unansweredRequests);
  if (answerable.length) {
    decisions.push({
      action: "answer_owner",
      requests: answerable,
      responseLink: ownerResponseLink(answerable),
    });
  }

  // A named owner continuation is closed-world: reconcile only those exact
  // ProjectRef-bound attempts, and never fall through to history or staffing.
  if (input && Object.prototype.hasOwnProperty.call(input, "ownerContinuationScope")) {
    var scoped = ownerContinuationPlan(input.ownerContinuationScope,
      input.portfolioBindings);
    if (scoped.blockers.length) {
      decisions.push({
        action: "wait",
        reason: "owner continuation scope has no exact typed binding",
        blockers: scoped.blockers,
      });
      return decisions;
    }
    decisions.push({ action: "reconcile_scope", bindings: scoped.bindings });
    return decisions;
  }

  // Managerial investigation uses no execution slot. Missing historical
  // bindings and full workers must not prevent unrelated bounded research.
  var proactiveReview = require("./coop-proactive-review").normalize(input && input.proactiveReview);
  if (proactiveReview) decisions.push({ action: "proactive_review", review: proactiveReview });

  // A compact runtime snapshot is not proof that the historical Coop ledger is
  // empty. Once the gatherer supplies that ledger, unresolved records outrank
  // standups and new staffing. A missing ledger fails closed for the same
  // reason: never turn an unreadable source into "backlog empty".
  if (input && Object.prototype.hasOwnProperty.call(input, "historicalLedger")) {
    var historical = input.historicalLedger;
    if (!historical) {
      decisions.push({ action: "wait", reason: "historical ledger unavailable" });
      return decisions;
    }
    var unresolvedHistory = Array.isArray(historical.unresolved) ? historical.unresolved : [];
    if (unresolvedHistory.length) {
      var historyPlan = historicalReconciliationPlan(unresolvedHistory,
        input && input.portfolioBindings);
      if (!historyPlan.actionable.length && historyPlan.blocked.length) {
        decisions.push({
          action: "wait",
          reason: "historical reconciliation blocked by missing typed binding",
          blockers: historyPlan.blocked,
          counts: historical.counts || {},
          scanned: historical.scanned || 0,
        });
        return decisions;
      }
      decisions.push({
        action: "reconcile_history",
        records: historyPlan.actionable,
        blockers: historyPlan.blocked,
        counts: historical.counts || {},
        scanned: historical.scanned || 0,
      });
      return decisions;
    }
  }

  // 1. Standup rhythm — independent of work state.
  if (now - lastStandupAt >= STANDUP_INTERVAL_MS) {
    decisions.push({ action: "compose_standup" });
  }

  // 2. Capacity check.
  if (inFlight.length >= capacity) {
    decisions.push({ action: "wait", reason: "at capacity (" + inFlight.length + "/" + capacity + ")" });
    return decisions;
  }

  // 3. Pick the next item: highest score, not in flight, retries respected.
  var inFlightIds = {};
  for (var i = 0; i < inFlight.length; i++) {
    if (inFlight[i].item) inFlightIds[inFlight[i].item.id] = true;
    if (inFlight[i].binding) inFlightIds[inFlight[i].binding.portfolioTaskId] = true;
  }
  var typedBindings = latestTypedBindings(input && input.portfolioBindings);
  var typedTaskIds = Object.keys(typedBindings);
  for (var bi = 0; bi < typedTaskIds.length; bi++) {
    var typedTaskId = typedTaskIds[bi];
    if (bindingBlocksRestaff(typedBindings[typedTaskId])) inFlightIds[typedTaskId] = true;
  }

  var slots = capacity - inFlight.length;
  var staffed = 0;
  for (var pi = 0; pi < portfolio.items.length && staffed < slots; pi++) {
    var item = portfolio.items[pi];
    if (inFlightIds[item.id]) continue;
    if (item.blockedBy) continue; // dependency declared unmet — never staff

    var failures = failureCounts[item.id] || 0;
    if (failures >= MAX_FAILURES) {
      decisions.push({ action: "give_up", item: item, reason: failures + " failed attempts — needs the boss" });
      continue;
    }

    // Re-route with escalation when there is failure history.
    var route = item.route;
    if (failures > 0 && routeFn && item.classification) {
      route = routeFn(item.classification, { escalated: failures });
    }
    if (!route) continue; // unroutable right now (provider health) — skip, not give up

    decisions.push({
      action: "staff",
      item: item,
      route: route,
      needsApproval: isBigItem(item, route),
    });
    staffed++;
  }

  if (!staffed && !decisions.length) {
    decisions.push({ action: "wait", reason: portfolio.items.length ? "no routable items" : "backlog empty" });
  }
  return decisions;
}

module.exports = {
  bindingConsumesCapacity: bindingConsumesCapacity,
  historicalReconciliationPlan: historicalReconciliationPlan,
  inFlightForTick: inFlightForTick,
  leadTick: leadTick,
  ownerContinuationPlan: ownerContinuationPlan,
  ownerResponseLink: ownerResponseLink,
  safeParallelCapacity: safeParallelCapacity,
  DEFAULT_PARALLEL_CAPACITY: DEFAULT_PARALLEL_CAPACITY,
  MAX_PARALLEL_CAPACITY: MAX_PARALLEL_CAPACITY,
  MAX_FAILURES: MAX_FAILURES,
  STANDUP_INTERVAL_MS: STANDUP_INTERVAL_MS,
};
