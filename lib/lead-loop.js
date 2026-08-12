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
//   { action: "compose_standup" }                              — daily digest due
//   { action: "wait",            reason }                      — explicit idle (capacity/empty/unroutable)
//
// Autonomy dial (roadmap §6, "propose & approve" while trust calibrates):
// big items (high risk, frontier tier, or design/security class) get
// needsApproval: true — the executor posts a proposal and waits. Small
// low-risk work flows without asking.

var MAX_FAILURES = 3;
var STANDUP_INTERVAL_MS = 24 * 3600000;

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

// leadTick(input) -> decisions[]
//   input.portfolio: lead-backlog.buildPortfolio output
//   input.inFlight: lead-ledger.inFlight output ([{item,...}])
//   input.failureCounts: { itemId: n } (lead-ledger.failureCount per candidate)
//   input.capacity: max concurrent staffed items (default 1 — Phase 2 starts serial)
//   input.lastStandupAt: ms of last standup_composed event (0 if never)
//   input.now: injected clock
//   input.routeFn: (classification, opts) -> route  (inject lead-routing.routeWorkItem)
function leadTick(input) {
  var decisions = [];
  var portfolio = (input && input.portfolio) || { items: [] };
  var inFlight = (input && input.inFlight) || [];
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
    decisions.push({ action: "answer_owner", requests: answerable });
    return decisions;
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
  leadTick: leadTick,
  MAX_FAILURES: MAX_FAILURES,
  STANDUP_INTERVAL_MS: STANDUP_INTERVAL_MS,
};
