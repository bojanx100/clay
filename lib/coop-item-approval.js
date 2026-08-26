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
// implementation directive. A fuzzy approval is inherently referential -- it
// means "yes to that" -- so its authority comes from the pending item Coop
// already recorded. The bounded exception is an owner spelling the complete
// stable portfolioTaskId AND revision. That pair is itself the exact reference;
// it needs no fuzzy candidate lookup, but it still cannot widen project, task,
// revision, spend, budget, destructive, or blocked gates.
//
// The small helpers below are intentionally duplicated from
// coop-queue-authorization rather than shared. This is a fail-closed authority
// gate: an explicit local copy is safer to audit than a parameterized helper
// whose behaviour changes for two different callers.

var projectIdentity = require("./project-identity");
var relevance = require("./coop-topic-relevance");
var autonomyGrant = require("./coop-autonomy-grant");

// MAX_PENDING_ITEMS was copied from coop-queue-authorization's
// MAX_AUTHORIZED_TASKS, but that rationale does not transfer. A queue-wide
// authorization staffs EVERY task in its snapshot, so bounding the set bounds
// the blast radius. A named approval staffs exactly ONE item however many are
// waiting, and resolveApprovedTask below already fails closed unless the wording
// matches exactly one candidate -- a larger candidate set makes an unambiguous
// match strictly harder to achieve, never easier. So set size carried no
// authorization meaning here; it only created a cliff.
//
// Live state crossed that cliff: 38 unresolved attention items against a cap of
// 32, measured 2026-08-19. Every named approval failed
// owner_approval_scope_too_large, permanently and with no way to self-heal,
// because the unresolved backlog only ever grows.
//
// Truncating the set to fit a cap would be the genuinely fail-open move --
// dropping a rival candidate can turn an ambiguous approval into a false unique
// match -- so the set is never truncated. What remains is a memory guard against
// pathological input, and it still fails closed.
var MAX_PENDING_ITEMS = 4096;
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
function approvalCommand(text) {
  var raw = String(text || "").trim().replace(/’/g, "'");
  var value = normalizedText(raw);
  if (!value || value.indexOf("?") !== -1) return null;
  if (/\b(?:do not|don't|dont|not yet|later|tomorrow|stop|pause|hold|wait|unless|maybe|perhaps|might|if|when|whether|almost|nearly)\b/.test(value)) {
    return null;
  }
  var command = raw.replace(/^(?:ok(?:ay)?|yes|sure)[,\s]+/i, "")
    .replace(/^please\s+/i, "");
  // Must OPEN with the approval verb. "i will approve x" and "did you approve x"
  // do not match, which is the point.
  var match = command.match(/^approved?\b([\s\S]*)$/i);
  if (!match) return null;
  return String(match[1] || "").trim()
    .replace(/^(?:of|for)\s+/, "")
    .replace(/^(?:the|this|that|it)\b\s*/, "")
    .trim();
}

// Markdown fences mark quoted/literal context, not another owner command. The
// composer can append a copied assistant fragment after an exact approval with
// an opening fence (live ingress 605 did exactly this). Let the fully qualified
// command before that boundary stand on its own; the fuzzy path still evaluates
// the complete turn, and ordinary unfenced prose still invalidates the exact
// grammar below.
function exactApprovalCommandText(text) {
  var raw = String(text || "");
  var fence = raw.search(/\n[ \t]*```/);
  return fence === -1 ? raw : raw.slice(0, fence);
}

// Strict grammar for one or more fully qualified item approvals. It exists next
// to the old fuzzy subject parser rather than replacing it: a conversational
// "approve the fix" still needs its pre-existing attention snapshot, while a
// complete task/revision (and optional exact ProjectRef) can be replayed without
// guessing which pending item the owner meant.
//
// Every statement after the first must repeat the approval verb. That small
// redundancy is deliberate: it lets one owner turn authorize several exact
// tasks without treating prose joined by "and" as a second authorization.
//
// Statements are separated by ANY newline. Splitting on a blank line was the
// original rule and it silently cost the owner a whole turn: ingress 578 listed
// four fully qualified approvals on four consecutive lines, the blank-line split
// yielded ONE statement spanning all four, the anchored grammar below could not
// match it, and the turn degraded to the fuzzy path where only the first line
// survived -- so all four dispatches were refused and the owner had to resend
// them one message at a time. Single newlines are how a person types a list.
//
// This widens only the EXACT path and cannot fail open: each statement must
// still match the anchored grammar whole, with a valid task id and a revision,
// and any statement that does not abandons the entire turn to the fuzzy parser.
// Blank lines between approvals are formatting, so they are dropped rather than
// treated as an empty (malformed) statement.
function exactApprovalStatements(text) {
  var remainder = approvalCommand(exactApprovalCommandText(text));
  if (remainder === null) return null;
  var statements = remainder.split(/\n/).map(function (line) {
    return String(line || "").trim();
  }).filter(function (line) { return !!line; });
  var approvals = [];
  for (var i = 0; i < statements.length; i++) {
    var statement = statements[i];
    if (i > 0) {
      var repeated = statement.match(/^approved?\b\s*([\s\S]*)$/i);
      if (!repeated) return null;
      statement = String(repeated[1] || "").trim();
    }
    var match = statement.match(new RegExp(
      "^([A-Za-z0-9][A-Za-z0-9_-]{0,159})\\s+" +
      "(?:rev(?:ision)?|r)\\s*#?\\s*([0-9]{1,9})(?:\\s+implementation)?" +
      "(?:\\s+for\\s+projectref\\s+([A-Za-z0-9._-]{1,160}))?\\.?$", "i"));
    var taskId = match && String(match[1] || "").toLowerCase();
    var revision = match && Number(match[2]);
    var projectId = match && match[3] ? String(match[3]).replace(/\.$/, "") : "";
    var projectRef = projectId ?
      projectIdentity.normalizeProjectRef({ projectId: projectId }) : null;
    if (!match || !projectIdentity.isTaskId(taskId) ||
        !Number.isInteger(revision) || revision < 1 ||
        (projectId && !projectRef)) return null;
    approvals.push({
      subject: taskId + " rev" + revision,
      portfolioTaskId: taskId,
      bindingRevision: revision,
      projectRef: projectRef,
    });
  }
  return approvals.length ? approvals : null;
}

function explicitItemApproval(text) {
  var exact = exactApprovalStatements(text);
  if (exact) return { subject: exact[0].subject };
  var remainder = approvalCommand(text);
  if (remainder === null) return null;
  // The first clause names the approved item. A trailing clause may supply
  // execution context (ingress 508: "the MCP Clay extension should be there")
  // or a separate handoff request (ingress 533). Neither may pollute task
  // identity. Questions and actual deferrals still fail above for the whole
  // turn.
  return { subject: normalizedText(remainder.split(/\n+|,|;|\.(?=\s|$)/)[0]) };
}

function tokensOf(value) {
  return String(value || "").toLowerCase().split(/[^a-z0-9]+/)
    .filter(function (token) { return !!token; });
}

function significantTokens(value) {
  return tokensOf(value).filter(function (token) {
    return !SUBJECT_STOPWORDS[token] && token !== "rev" && token !== "revision" &&
      !/^(?:rev(?:ision)?|r)[0-9]+$/.test(token) && token.length > 2;
  });
}

function revisionHint(value) {
  var pattern = /\b(?:rev(?:ision)?|r)\s*#?\s*([0-9]{1,9})\b/g;
  var revision = null;
  var match;
  while ((match = pattern.exec(String(value || "").toLowerCase()))) {
    var parsed = Number(match[1]);
    if (!Number.isInteger(parsed) || parsed < 1) continue;
    if (revision !== null && revision !== parsed) return { ok: false };
    revision = parsed;
  }
  return { ok: true, revision: revision };
}

// A complete task id plus one explicit revision is a self-contained reference.
// Anything less keeps using the pending-attention snapshot below. Requiring one
// revision token also keeps narrative or conflicting strings out of this path.
function exactApprovalReference(subject) {
  var value = normalizedText(subject).replace(/[`"'“”]/g, "");
  var hint = revisionHint(value);
  if (!hint.ok || hint.revision === null) return null;
  var count = 0;
  var id = value.replace(/\b(?:rev(?:ision)?|r)\s*#?\s*[0-9]{1,9}\b/g,
    function () { count++; return " "; }).replace(/\s+/g, " ").trim();
  if (count !== 1 || !projectIdentity.isTaskId(id)) return null;
  return { portfolioTaskId: id, bindingRevision: hint.revision };
}

function explicitItemApprovals(text) {
  var exact = exactApprovalStatements(text);
  if (exact) return exact;
  var approval = explicitItemApproval(text);
  if (!approval) return [];
  var reference = exactApprovalReference(approval.subject);
  if (!reference) return [{
    subject: approval.subject,
    portfolioTaskId: "",
    bindingRevision: null,
    projectRef: null,
  }];
  return [{
    subject: approval.subject,
    portfolioTaskId: reference.portfolioTaskId,
    bindingRevision: reference.bindingRevision,
    projectRef: null,
  }];
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
  var revision = revisionHint(subject);
  if (!revision.ok) return { ok: false, reason: "owner_approval_ambiguous" };
  if (revision.revision !== null) {
    tasks = tasks.filter(function (task) {
      return Number(task && task.bindingRevision) === revision.revision;
    });
    if (!tasks.length) return { ok: false, reason: "owner_approval_unmatched_item" };
  }
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

function resolveApprovalTask(snapshot, subject, request) {
  var exact = exactApprovalReference(subject);
  if (exact && taskKey(request) && taskKey(exact) === taskKey(request)) {
    if (excludedFromNamedApproval(request)) {
      return { ok: false, reason: "owner_approval_disallowed_item" };
    }
    return {
      ok: true,
      reference: "exact_task_revision",
      task: {
        portfolioTaskId: exact.portfolioTaskId,
        bindingRevision: exact.bindingRevision,
        attentionKey: null,
        queuedAt: null,
      },
    };
  }
  // A hyphenated stable id is an exact reference to different work, not a
  // fuzzy nickname. Short labels such as "voice rev2" still fall through to
  // the pending snapshot, where they can resolve one previously recorded item.
  if (exact && exact.portfolioTaskId.indexOf("-") !== -1) {
    return { ok: false, reason: "owner_approval_task_mismatch" };
  }
  var resolved = resolveApprovedTask(snapshot, subject);
  if (resolved.ok && taskKey(request) && taskKey(resolved.task) !== taskKey(request)) {
    return { ok: false, reason: "owner_approval_task_mismatch" };
  }
  if (resolved.ok) resolved.reference = "pending_attention";
  return resolved;
}

function approvalProjectMatches(approval, request) {
  if (!approval || !approval.projectRef) return true;
  var target = projectIdentity.normalizeProjectRef(request && request.targetProject);
  return !!(target && target.projectId === approval.projectRef.projectId);
}

function matchingApproval(approvals, snapshot, request) {
  var list = Array.isArray(approvals) ? approvals : [];
  var projectMismatch = false;
  var denied = "";
  var failure = "";
  for (var i = 0; i < list.length; i++) {
    var resolved = resolveApprovalTask(snapshot, list[i].subject, request);
    if (!resolved.ok) {
      if (resolved.reason === "owner_approval_disallowed_item") denied = resolved.reason;
      if (!failure) failure = resolved.reason;
      continue;
    }
    if (!approvalProjectMatches(list[i], request)) {
      projectMismatch = true;
      continue;
    }
    return { ok: true, approval: list[i], resolved: resolved };
  }
  return projectMismatch ? { ok: false, reason: "owner_implementation_project_mismatch" } :
    { ok: false, reason: denied || failure || "owner_approval_task_mismatch" };
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

// Finds the newest approval that covers THIS task, rather than letting a later
// approval of unrelated work shadow it. The execution gate independently
// replays the same evidence; this only chooses which canonical ingress to cite.
function approvalEventForTask(history, request, events) {
  var items = Array.isArray(history) ? history : [];
  for (var i = items.length - 1; i >= 0; i--) {
    var event = items[i];
    if (!ownerApprovalEvent(event) || typeof event._ts !== "number") continue;
    var approvals = explicitItemApprovals(event.text);
    if (!approvals.length) continue;
    var snapshot = pendingApprovalSnapshotAt(events, event._ts);
    var matched = matchingApproval(approvals, snapshot, request);
    if (matched.ok) {
      return { event: event, approval: matched.approval, resolved: matched.resolved };
    }
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
  // No approval ingress was cited, so this gate has refused nothing and there
  // is no refusal for a standing grant to route around. That gap is the only
  // place the widened grant may speak. It returns null while its switch is off,
  // which leaves this `return null` -- and the caller's fail-closed default --
  // exactly as they were.
  if (!approvalIngressId) return autonomyGrant.standingAdmission(input, request, options);
  if (!ownerRequests || typeof canonicalOwnerEvent !== "function") {
    return { ok: false, reason: "owner_implementation_decision_unavailable" };
  }
  var entry = ownerRequestByIngress(ownerRequests, approvalIngressId);
  var event = canonicalOwnerEvent(entry, canonical, approvalIngressId);
  var withdrawn = !!(entry && entry.response && entry.response.state === "superseded");
  var approvals = event ? explicitItemApprovals(event.text) : [];
  if (!event || withdrawn || !approvals.length) {
    return { ok: false, reason: "owner_implementation_decision_required" };
  }
  var approvalAt = typeof event._ts === "number" ? event._ts
    : entry && typeof entry.receivedAt === "number" ? entry.receivedAt : null;
  var snapshot = pendingApprovalSnapshotAt(leadEvents(options), approvalAt);
  if (!snapshot.ok) return { ok: false, reason: snapshot.reason };
  var matched = matchingApproval(approvals, snapshot,
    Object.assign({}, input || {}, request || {}));
  if (!matched.ok) return { ok: false, reason: matched.reason };
  var approval = matched.approval;
  var resolved = matched.resolved;
  // The approval authorizes exactly the revision that was pending. A different
  // task or a bumped revision is outside what the owner said yes to.
  if (!taskKey(request) || taskKey(resolved.task) !== taskKey(request)) {
    return { ok: false, reason: "owner_approval_task_mismatch" };
  }
  // A named plural approval retains its first scope as the legacy projection.
  // That project is evidence for the first exact item, not a restriction that
  // erases a later exact item from the same owner turn. The line-level matcher
  // above still rejects an approval that explicitly names another ProjectRef;
  // a new scope is written only after its task and revision independently match.
  var priorNamedApproval = !!(entry.implementationDecision &&
    entry.implementationDecision.source === "explicit_item_approval");
  if (!projectMatchesEntry(entry, request.targetProject.projectId) &&
      !priorNamedApproval) {
    return { ok: false, reason: "owner_implementation_project_mismatch" };
  }
  // Approval wording is referential, so it becomes an implementation decision
  // only after the pending snapshot has resolved one exact task revision and
  // the independently normalized dispatch names its ProjectRef and Thread.
  // scopeImplementation validates everything before one durable write, keeping
  // a malformed request from leaving a broad decision behind without a scope.
  if (typeof ownerRequests.scopeImplementation !== "function") {
    return { ok: false, reason: "owner_implementation_scope_unavailable" };
  }
  var scoped = ownerRequests.scopeImplementation(approvalIngressId, {
    projectRef: request.targetProject,
    topicRef: request.coopTopicRef,
    portfolioTaskId: request.portfolioTaskId,
    bindingRevision: request.bindingRevision,
    idempotencyKey: request.idempotencyKey,
    implementationDecision: {
      intent: "implement",
      source: "explicit_item_approval",
      at: approvalAt,
    },
  });
  if (!scoped || scoped.ok !== true) {
    return { ok: false, reason: scoped && scoped.reason ||
      "owner_implementation_scope_unavailable" };
  }
  return {
    ok: true,
    request: scoped.request,
    itemApproval: {
      ingressId: approvalIngressId,
      attentionKey: resolved.task.attentionKey,
      queuedAt: resolved.task.queuedAt,
      subject: approval.subject,
      reference: resolved.reference,
    },
  };
}

module.exports = {
  MAX_PENDING_ITEMS: MAX_PENDING_ITEMS,
  approvalEventForTask: approvalEventForTask,
  approvalProjectMatches: approvalProjectMatches,
  executionAdmission: executionAdmission,
  exactApprovalStatements: exactApprovalStatements,
  exactApprovalReference: exactApprovalReference,
  explicitItemApproval: explicitItemApproval,
  explicitItemApprovals: explicitItemApprovals,
  latestApprovalEvent: latestApprovalEvent,
  pendingApprovalSnapshotAt: pendingApprovalSnapshotAt,
  matchingApproval: matchingApproval,
  resolveApprovalTask: resolveApprovalTask,
  resolveApprovedTask: resolveApprovedTask,
};
