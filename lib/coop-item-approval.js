// Bounded owner approval of ONE pending staffing item.
//
// The counterpart to coop-queue-authorization. That module admits a queue-wide
// instruction ("run everything unblocked") and deliberately excludes items
// flagged requiresSpecificOwnerApproval. This module is the missing other half:
// the owner approving one specific pending item by name.
//
// Same referential model, stated there and reused here: the approval turn is
// NOT the task's identity. It authorizes an exact portfolioTaskId:bindingRevision
// that was ALREADY waiting for the owner when they spoke. The task keeps its own
// ingress, ThreadRef and ProjectRef; the approval is a separate reference.
//
// This is why "approve eligibility fix" must not be read as a free-standing
// implementation directive. Approval is inherently referential -- it means "yes
// to that" -- so the authority comes from the pending item Coop already
// recorded, never from the wording. The wording only has to identify which
// pending item, and if it cannot do so unambiguously this fails closed.
//
// The small helpers below are intentionally duplicated from
// coop-queue-authorization rather than shared. This is a fail-closed authority
// gate: an explicit local copy is safer to audit than a parameterized helper
// whose behaviour changes for two different callers.

var projectIdentity = require("./project-identity");
var relevance = require("./coop-topic-relevance");

var MAX_PENDING_ITEMS = 32;
// The attention types that count as "already waiting on the owner". Kept in step
// with lead-ledger.appendAttention, which mints exactly these two.
var PENDING_ATTENTION_TYPES = { staffing_attention: true, cutover_attention: true };

// Generic words that identify no particular item. "approve the fix" must not
// resolve just because some pending item happens to contain "fix".
var SUBJECT_STOPWORDS = {
  fix: true, fixes: true, work: true, task: true, tasks: true, item: true,
  items: true, issue: true, issues: true, change: true, changes: true,
  repair: true, thing: true, one: true, please: true, now: true, it: true,
  this: true, that: true, the: true, a: true, an: true, and: true, for: true,
  to: true, of: true, plan: true, patch: true, update: true,
};

function normalizedText(value) {
  return String(value || "").trim().toLowerCase()
    .replace(/[.!…]+$/g, "").replace(/\s+/g, " ");
}

// Intentionally narrow, mirroring explicitQueueAuthorization. Questions,
// negations and anything deferred stay off this path entirely.
function explicitItemApproval(text) {
  var value = normalizedText(text).replace(/’/g, "'");
  if (!value || value.indexOf("?") !== -1) return null;
  if (/\b(?:do not|don't|dont|not yet|later|tomorrow|stop|pause|hold|wait|unless|maybe|perhaps|might|should|could|would|if|when|whether|almost|nearly)\b/.test(value)) {
    return null;
  }
  var command = value.replace(/^(?:ok(?:ay)?|yes|sure)[,\s]+/, "").replace(/^please\s+/, "");
  // Must OPEN with the approval verb. "i will approve x" and "did you approve x"
  // do not match, which is the point.
  var match = command.match(/^approved?\b(.*)$/);
  if (!match) return null;
  var remainder = String(match[1] || "").trim()
    .replace(/^(?:of|for)\s+/, "")
    .replace(/^(?:the|this|that|it)\b\s*/, "")
    .trim();
  return { subject: remainder };
}

function tokensOf(value) {
  return String(value || "").toLowerCase().split(/[^a-z0-9]+/)
    .filter(function (token) { return !!token; });
}

function significantTokens(value) {
  return tokensOf(value).filter(function (token) {
    return !SUBJECT_STOPWORDS[token] && token.length > 2;
  });
}

function taskKey(value) {
  var id = String(value && value.portfolioTaskId || "").trim();
  var revision = Number(value && value.bindingRevision);
  if (!projectIdentity.isTaskId(id) || !Number.isInteger(revision) || revision < 1) return "";
  return id + ":" + revision;
}

// Gates that a NAMED owner approval still cannot override. Unlike the
// queue-wide gate this deliberately does NOT exclude
// requiresSpecificOwnerApproval or queueEligible:false -- those mean "needs the
// owner to name it", which is exactly what happened here. Spend, budget and
// destructive work keep needing their own separate approval.
function excludedFromNamedApproval(value) {
  var source = value || {};
  return source.blocked === true || source.destructive === true ||
    source.spendRequired === true || source.budgetException === true;
}

function attentionKeyFor(event) {
  var explicit = String(event && event.attentionKey || "").trim();
  return explicit || taskKey(event);
}

// Replays the append-only Lead ledger only as far as the approval timestamp, so
// an item that started waiting AFTER the owner spoke can never be swept in by a
// retry days later. Same rule as the queue snapshot.
function pendingApprovalSnapshotAt(events, approvalAt) {
  if (typeof approvalAt !== "number" || !Number.isFinite(approvalAt)) {
    return { ok: false, reason: "owner_approval_time_required", tasks: [] };
  }
  var list = Array.isArray(events) ? events.slice() : [];
  list.sort(function (left, right) {
    return (Number(left && left.seq) || 0) - (Number(right && right.seq) || 0) ||
      (Number(left && left.at) || 0) - (Number(right && right.at) || 0);
  });
  var open = {};
  for (var i = 0; i < list.length; i++) {
    var event = list[i] || {};
    // A non-positive `at` is missing ordering evidence, not "very early". Live
    // state contains exactly such a record (a staffing_attention written with
    // at: 0), and treating 0 as a real timestamp made it satisfy the
    // was-already-waiting rule against ANY approval, including approvals that
    // predate the item. That silently defeats the only guarantee this snapshot
    // exists to provide, so it fails closed instead.
    if (typeof event.at !== "number" || !Number.isFinite(event.at) || event.at <= 0 ||
        event.at >= approvalAt) continue;
    var key = attentionKeyFor(event);
    if (!key) continue;
    if (event.type === "attention_resolved") {
      delete open[key];
      continue;
    }
    // Both attention types mean the same thing here: the item was already
    // waiting on the owner when the approval landed. lead-ledger records them as
    // interchangeable (appendAttention mints either, unresolvedAttention accepts
    // both); only this snapshot narrowed to staffing_attention. That gap made a
    // cross-project cutover item unapprovable by name, so it could never mint an
    // owner Thread and every dispatch failed thread_ref_required instead.
    if (!PENDING_ATTENTION_TYPES[event.type]) continue;
    var task = taskKey(event);
    if (!task || excludedFromNamedApproval(event)) continue;
    open[key] = {
      portfolioTaskId: String(event.portfolioTaskId),
      bindingRevision: Number(event.bindingRevision),
      attentionKey: key,
      itemId: String(event.itemId || ""),
      queuedAt: event.at,
    };
  }
  var keys = Object.keys(open);
  if (keys.length > MAX_PENDING_ITEMS) {
    return { ok: false, reason: "owner_approval_scope_too_large", tasks: [] };
  }
  var tasks = keys.map(function (key) { return open[key]; });
  tasks.sort(function (left, right) {
    return left.queuedAt - right.queuedAt ||
      String(left.attentionKey).localeCompare(String(right.attentionKey));
  });
  return { ok: true, tasks: tasks };
}

function candidateTokens(task) {
  return tokensOf(String(task.portfolioTaskId || "") + " " + String(task.itemId || ""));
}

// Resolve which pending item an approval named. Exactly one match, or nothing:
// an ambiguous approval must never pick a winner, because picking wrong staffs
// work the owner did not authorize.
function resolveApprovedTask(snapshot, subject) {
  if (!snapshot || snapshot.ok !== true) {
    return { ok: false, reason: "owner_implementation_decision_required" };
  }
  var tasks = snapshot.tasks;
  if (!tasks.length) return { ok: false, reason: "owner_approval_no_pending_item" };
  var wanted = significantTokens(subject);
  if (!wanted.length) {
    // A bare "approved" is only unambiguous when one item is waiting.
    if (tasks.length !== 1) return { ok: false, reason: "owner_approval_ambiguous" };
    return { ok: true, task: tasks[0] };
  }
  var best = [];
  var bestScore = 0;
  for (var i = 0; i < tasks.length; i++) {
    var available = candidateTokens(tasks[i]);
    var score = 0;
    for (var j = 0; j < wanted.length; j++) {
      if (available.indexOf(wanted[j]) !== -1) score++;
    }
    if (!score || score < bestScore) continue;
    if (score > bestScore) { bestScore = score; best = []; }
    best.push(tasks[i]);
  }
  if (!best.length) return { ok: false, reason: "owner_approval_unmatched_item" };
  if (best.length > 1) return { ok: false, reason: "owner_approval_ambiguous" };
  return { ok: true, task: best[0] };
}

function ownerRequestByIngress(ownerRequests, ingressId) {
  if (!ownerRequests || !ingressId) return null;
  try {
    if (typeof ownerRequests.get === "function") return ownerRequests.get(ingressId);
    var list = typeof ownerRequests.list === "function" ? ownerRequests.list() : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].ingressId === ingressId) return list[i];
    }
  } catch (e) {}
  return null;
}

function projectMatchesEntry(entry, targetId) {
  var projects = Array.isArray(entry && entry.projectRefs) ? entry.projectRefs : [];
  if (!projects.length) return true;
  for (var i = 0; i < projects.length; i++) {
    if (projects[i] && projects[i].projectId === targetId) return true;
  }
  return false;
}

function leadEvents(deps) {
  try {
    return deps && typeof deps.readLeadEvents === "function" ? deps.readLeadEvents() : [];
  } catch (e) { return []; }
}

function ownerApprovalEvent(event) {
  return !!(event && event.type === "user_message" && event.coopIngressId &&
    !relevance.isInternalHistoryItem(event) && relevance.hasOwnerProvenance(event));
}

// Finds the most recent owner turn that is a named approval. Used by the route
// helper so a caller can discover the approval it should cite.
function latestApprovalEvent(history) {
  var items = Array.isArray(history) ? history : [];
  for (var i = items.length - 1; i >= 0; i--) {
    if (ownerApprovalEvent(items[i]) && explicitItemApproval(items[i].text)) return items[i];
  }
  return null;
}

// Server-side verification. Like the queue module, the tool-facing route is only
// a convenience: this independently replays the owner ledger, the canonical
// owner event and the Lead ledger, so a caller cannot forge either side of the
// approval link.
function executionAdmission(input, request, canonical, deps) {
  var options = deps || {};
  var ownerRequests = options.ownerRequests;
  var canonicalOwnerEvent = options.canonicalOwnerEvent;
  var approvalIngressId = String(input && input.coopApprovalIngressId || "");
  if (!approvalIngressId) return null;
  if (!ownerRequests || typeof canonicalOwnerEvent !== "function") {
    return { ok: false, reason: "owner_implementation_decision_unavailable" };
  }
  var entry = ownerRequestByIngress(ownerRequests, approvalIngressId);
  var event = canonicalOwnerEvent(entry, canonical, approvalIngressId);
  var withdrawn = !!(entry && entry.response && entry.response.state === "superseded");
  var approval = event ? explicitItemApproval(event.text) : null;
  if (!event || withdrawn || !approval) {
    return { ok: false, reason: "owner_implementation_decision_required" };
  }
  var approvalAt = typeof event._ts === "number" ? event._ts
    : entry && typeof entry.receivedAt === "number" ? entry.receivedAt : null;
  var snapshot = pendingApprovalSnapshotAt(leadEvents(options), approvalAt);
  if (!snapshot.ok) return { ok: false, reason: snapshot.reason };
  var resolved = resolveApprovedTask(snapshot, approval.subject);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  // The approval authorizes exactly the revision that was pending. A different
  // task or a bumped revision is outside what the owner said yes to.
  if (!taskKey(request) || taskKey(resolved.task) !== taskKey(request)) {
    return { ok: false, reason: "owner_approval_task_mismatch" };
  }
  if (!projectMatchesEntry(entry, request.targetProject.projectId)) {
    return { ok: false, reason: "owner_implementation_project_mismatch" };
  }
  return {
    ok: true,
    request: entry,
    itemApproval: {
      ingressId: approvalIngressId,
      attentionKey: resolved.task.attentionKey,
      queuedAt: resolved.task.queuedAt,
      subject: approval.subject,
    },
  };
}

module.exports = {
  MAX_PENDING_ITEMS: MAX_PENDING_ITEMS,
  executionAdmission: executionAdmission,
  explicitItemApproval: explicitItemApproval,
  latestApprovalEvent: latestApprovalEvent,
  pendingApprovalSnapshotAt: pendingApprovalSnapshotAt,
  resolveApprovedTask: resolveApprovedTask,
};
