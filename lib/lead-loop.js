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
//   { action: "compose_standup" }                              — daily digest due
//   { action: "wait",            reason }                      — explicit idle (capacity/empty/unroutable)
//
// Autonomy dial (roadmap §6, "propose & approve" while trust calibrates):
// big items (high risk, frontier tier, or design/security class) get
// needsApproval: true — the executor posts a proposal and waits. Small
// low-risk work flows without asking.

var projectIdentity = require("./project-identity");

var MAX_FAILURES = 3;
var STANDUP_INTERVAL_MS = 24 * 3600000;
var TERMINAL_BINDING_STATUSES = {
  completed: true,
  failed: true,
  superseded: true,
  cancelled: true,
  deleted: true,
  unrouted: true,
};

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

function ownerResponseLink(requests) {
  return {
    version: 1,
    requests: requests.map(function (request) {
      return { ingressId: request.ingressId, requestRef: request.requestRef };
    }),
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
  return !TERMINAL_BINDING_STATUSES[binding.status];
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
    binding.status === "cancelled" || binding.status === "deleted";
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

// leadTick(input) -> decisions[]
//   input.portfolio: lead-backlog.buildPortfolio output
//   input.inFlight: legacy lead-ledger.inFlight output ([{item,...}])
//   input.portfolioBindings: typed portfolio-execution-bindings list()
//   input.failureCounts: { itemId: n } (lead-ledger.failureCount per candidate)
//   input.capacity: max concurrent staffed items (default 1 — Phase 2 starts serial)
//   input.lastStandupAt: ms of last standup_composed event (0 if never)
//   input.now: injected clock
//   input.routeFn: (classification, opts) -> route  (inject lead-routing.routeWorkItem)
function leadTick(input) {
  var decisions = [];
  var portfolio = (input && input.portfolio) || { items: [] };
  var inFlight = inFlightForTick(input);
  var failureCounts = (input && input.failureCounts) || {};
  var capacity = (input && typeof input.capacity === "number") ? input.capacity : 1;
  var lastStandupAt = (input && input.lastStandupAt) || 0;
  var now = (input && input.now) || 0;
  var routeFn = input && input.routeFn;

  // 0. The owner is waiting. Nothing routine outranks that.
  //
  // Standups and backlog staffing run on Lead's own schedule; an owner who
  // asked something and has not been answered is the highest-priority signal
  // Coop has, so it preempts both and returns immediately -- including at
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
    return decisions;
  }

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
      decisions.push({
        action: "reconcile_history",
        records: unresolvedHistory,
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
  inFlightForTick: inFlightForTick,
  leadTick: leadTick,
  ownerResponseLink: ownerResponseLink,
  MAX_FAILURES: MAX_FAILURES,
  STANDUP_INTERVAL_MS: STANDUP_INTERVAL_MS,
};
