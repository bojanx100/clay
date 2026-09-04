// Deterministic merge of canonical owner-work components into display rows.

var workIdentity = require("./coop-owner-work-identity");
var sidebarReconciliation = require("./coop-owner-sidebar-reconciliation");

var ACTIVE = { running: true, reviewing: true };
var QUEUED = { pending: true, queued: true, ready: true, active: true };
var ATTENTION = { needs_input: true, waiting_user: true, blocked: true,
  unavailable: true, unrouted: true };
var FAILED = { failed: true };
var DISMISSED = { dismissed: true, cancelled: true, superseded: true, deleted: true };

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value, fallback) {
  var result = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  return result || fallback || "";
}

function isControlSession(entry) {
  var role = text(entry && (entry.controlRole || entry.role), "").toLowerCase();
  return role === "triage" || role === "council";
}

function isAccepted(value) {
  return !!(value && value.status === "accepted" && !value.withdrawnAt);
}

function bindingsHave(bindings, predicate) {
  for (var i = 0; i < bindings.length; i++) if (predicate(bindings[i] || {})) return true;
  return false;
}

function sessionsHave(sessions, predicate) {
  for (var i = 0; i < sessions.length; i++) {
    var entry = sessions[i] || {};
    if (!isControlSession(entry) && predicate(entry)) return true;
  }
  return false;
}

function hasConcreteVerification(value) {
  var verification = text(value, "");
  return !!verification && !/^(?:none|n\/a|not applicable|not run|not tested|not verified|pending|skipped|unavailable)[.!]?$/i.test(verification);
}
function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function bindingCompletionEvidence(binding) {
  var value = binding || {};
  if (bindingStatus(value) !== "completed") return null;
  if (positive(value.implementationCompletedAt)) {
    return { at: value.implementationCompletedAt,
      evidence: "Implementation completion recorded" };
  }
  if (text(value.completionEventId, "")) {
    return { at: positive(value.completedAt) ? value.completedAt : 0,
      evidence: "Completion event recorded: " + text(value.completionEventId, "") };
  }
  if (positive(value.completedAt)) {
    return { at: value.completedAt, evidence: "Binding completion recorded" };
  }
  return null;
}

function topicIds(session) {
  var value = session || {};
  var refs = Array.isArray(value.coopTopicRefs) ? value.coopTopicRefs : [];
  if (refs.length || !value.coopTopicRef) return refs;
  return [value.coopTopicRef];
}
function sameBinding(left, right) {
  var a = left || {};
  var b = right || {};
  var aTask = text(a.portfolioTaskId, "");
  var bTask = text(b.portfolioTaskId, "");
  if (!aTask || aTask !== bTask) return false;
  var aProject = a.targetProject && a.targetProject.projectId || a.projectId || "";
  var bProject = b.targetProject && b.targetProject.projectId || b.projectId || "";
  if (aProject && bProject && aProject !== bProject) return false;
  return (Number(a.bindingRevision) || 0) === (Number(b.bindingRevision) || 0);
}
function sessionProvesBinding(session, completedBindings) {
  var value = session || {};
  var sessionBindings = Array.isArray(value.portfolioBindings) ? value.portfolioBindings : [];
  if (sessionBindings.length) {
    for (var si = 0; si < sessionBindings.length; si++) {
      for (var bi = 0; bi < completedBindings.length; bi++) {
        if (sameBinding(sessionBindings[si], completedBindings[bi])) return true;
      }
    }
    return false;
  }
  var matches = 0;
  var sessionTopics = topicIds(value);
  for (var i = 0; i < completedBindings.length; i++) {
    var bindingTopics = topicIds({ coopTopicRef: completedBindings[i] && completedBindings[i].coopTopicRef });
    var matched = !bindingTopics.length;
    for (var ti = 0; ti < sessionTopics.length && !matched; ti++) {
      for (var bi2 = 0; bi2 < bindingTopics.length; bi2++) {
        if (sessionTopics[ti] && bindingTopics[bi2] &&
            sessionTopics[ti].topicId === bindingTopics[bi2].topicId) matched = true;
      }
    }
    if (matched) matches++;
  }
  return matches === 1;
}
function completionEvidence(sessions, bindings) {
  var completedBindings = (bindings || []).filter(function (binding) {
    return bindingStatus(binding) === "completed";
  });
  if (!completedBindings.length) return { verified: false, reason: "a terminal execution binding" };
  var best = null;
  for (var bi = 0; bi < completedBindings.length; bi++) {
    var bindingEvidence = bindingCompletionEvidence(completedBindings[bi]);
    if (bindingEvidence && (!best || bindingEvidence.at >= finite(best.at))) {
      best = bindingEvidence;
    }
  }
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i] || {};
    var outcome = session.terminalOutcome || {};
    if (isControlSession(session) || text(outcome.status, "").toLowerCase() !== "completed" ||
        !hasConcreteVerification(outcome.verification) || !sessionProvesBinding(session, completedBindings)) continue;
    if (!best || finite(outcome.at) >= finite(best.at)) best = outcome;
  }
  if (!best) return { verified: false, reason: "concrete verification evidence" };
  if (best.evidence) return { verified: true, evidence: best.evidence };
  var summary = text(best.summary, "");
  var verification = text(best.verification, "");
  return {
    verified: true,
    evidence: (summary ? "Landed: " + summary : "") +
      (summary && verification ? " · " : "") +
      (verification ? "Verification: " + verification : ""),
  };
}
function outcomeStatus(record) {
  return text(record && record.outcome && record.outcome.status, "").toLowerCase();
}

function bindingStatus(binding) {
  return text(binding && binding.status, "").toLowerCase();
}
function sessionStatus(session) {
  return text(session && session.lifecycleState, "idle").toLowerCase();
}

function hasBindingStatus(bindings, statuses) {
  return bindingsHave(bindings, function (binding) { return !!statuses[bindingStatus(binding)]; });
}

function hasSessionStatus(sessions, statuses) {
  return sessionsHave(sessions, function (session) { return !!statuses[sessionStatus(session)]; });
}

function hasBlockedState(record, sessions, bindings) {
  var blocked = { blocked: true, unavailable: true, unrouted: true };
  return !!blocked[outcomeStatus(record)] || hasSessionStatus(sessions, blocked) ||
    hasBindingStatus(bindings, blocked);
}

function hasOwnerAttention(record, sessions, bindings) {
  var recordState = record && record.state;
  if (recordState === "needs_input" || recordState === "attention") return true;
  var outcome = outcomeStatus(record);
  if (outcome === "needs_input" || outcome === "waiting_user") return true;
  return hasSessionStatus(sessions, ATTENTION) || hasBindingStatus(bindings, ATTENTION);
}

function immediateStatus(record, sessions, bindings, completionVerified) {
  // A typed implementation completion outranks stale session lifecycle
  // metadata. Explicit failure/blocker records in the current binding set do
  // not get masked, since they may describe a separate unfinished task.
  if (FAILED[outcomeStatus(record)] && !completionVerified) return "failed";
  if (hasBindingStatus(bindings, FAILED)) return "failed";
  if (!completionVerified && hasSessionStatus(sessions, FAILED)) return "failed";
  if (hasBindingStatus(bindings, { blocked: true, unavailable: true, unrouted: true })) {
    return "blocked";
  }
  if (!completionVerified && hasBlockedState(record, sessions, bindings)) return "blocked";
  if (!completionVerified && hasOwnerAttention(record, sessions, bindings)) return "needs_owner";
  return "";
}

function isRejected(value) {
  return !!(value && value.status === "rejected");
}

// A rejection is a decision the owner already made. Treating it as "not
// accepted" and therefore still awaiting them is how a rejected item kept
// asking for the acceptance it had just been refused.
function isAwaitingOwnerAcceptance(binding) {
  var value = binding || {};
  return bindingStatus(value) === "completed" && value.ownerAcceptanceRequired === true &&
    !isAccepted(value.ownerAcceptance) && !isRejected(value.ownerAcceptance);
}

function hasAwaitingAcceptance(bindings) {
  return bindingsHave(bindings, isAwaitingOwnerAcceptance);
}

function hasRejectedAcceptance(bindings) {
  return bindingsHave(bindings, function (binding) {
    return bindingStatus(binding) === "completed" && isRejected(binding.ownerAcceptance);
  });
}

function hasClaimedCompletion(record, bindings) {
  return outcomeStatus(record) === "completed" || record && record.state === "done" ||
    hasBindingStatus(bindings, { completed: true });
}

function liveStatus(record, sessions, bindings) {
  if (sessionsHave(sessions, function (session) {
    return session.sessionPresent !== false && !session.hidden && ACTIVE[sessionStatus(session)];
  })) return "working";
  if (sessionsHave(sessions, function (session) {
    return session.sessionPresent !== false && !session.hidden && QUEUED[sessionStatus(session)];
  }) || hasBindingStatus(bindings, QUEUED) || record && record.state === "working") return "queued";
  return "";
}

function isDismissed(record, sessions, bindings) {
  var outcome = outcomeStatus(record);
  var response = record && record.response || {};
  if (outcome === "completed") return false;
  return response.state === "superseded" || !!DISMISSED[outcome] ||
    hasSessionStatus(sessions, DISMISSED) || hasBindingStatus(bindings, DISMISSED);
}

function answeredNonExecutionRequest(record) {
  var response = record && record.response || {};
  return record && record.expectsExecution !== true && response.state === "answered" &&
    finite(response.answeredAt) > finite(record.receivedAt);
}

function statusFor(record, sessions, bindings) {
  var completion = completionEvidence(sessions, bindings);
  var reconciled = sidebarReconciliation.historicalReconciled(record, sessions, bindings,
    answeredNonExecutionRequest(record));
  // A verified binding is the newest typed completion proof. A later recovery
  // action on the coordinator session is stale execution metadata and must not
  // downgrade the completed work back to owner attention. Current failed or
  // blocked bindings still win, because they represent a different unfinished
  // task in the same owner row.
  var immediate = immediateStatus(record, sessions, bindings, completion.verified);
  if (immediate) {
    return sidebarReconciliation.stateFor(immediate, reconciled, {
      disposition: immediate === "failed" ? "actionable_failure" : "actionable_blocker",
    });
  }
  var awaitingAcceptance = hasAwaitingAcceptance(bindings);
  // Ranked above the awaiting/completed branches: the owner has already ruled
  // on this work, so it must not read as either still-pending or done.
  if (hasRejectedAcceptance(bindings)) {
    return sidebarReconciliation.stateFor("acceptance_rejected", reconciled,
      { evidence: completion.evidence, disposition: "owner_rework_required" });
  }
  if (awaitingAcceptance && completion.verified) {
    return sidebarReconciliation.stateFor("verified_awaiting_acceptance", reconciled,
      { evidence: completion.evidence, disposition: "owner_acceptance_required" });
  }
  if (completion.verified) {
    return sidebarReconciliation.stateFor("completed", reconciled,
      { evidence: completion.evidence, disposition: "reconciled" });
  }
  if (awaitingAcceptance || hasClaimedCompletion(record, bindings)) {
    return sidebarReconciliation.stateFor("needs_owner", reconciled,
      { verificationRequired: completion.reason, disposition: "verification_required" });
  }
  var live = liveStatus(record, sessions, bindings);
  if (live) return sidebarReconciliation.stateFor(live, reconciled);
  if (isDismissed(record, sessions, bindings)) {
    return sidebarReconciliation.stateFor("dismissed", reconciled, { disposition: "retired" });
  }
  if (answeredNonExecutionRequest(record)) {
    return sidebarReconciliation.stateFor("completed", reconciled, { disposition: "reconciled" });
  }
  return sidebarReconciliation.stateFor("planned", reconciled);
}

function reasonFor(record, state, bindings) {
  if (state.verificationRequired) {
    return "Needs " + state.verificationRequired + " before this can be marked done";
  }
  var outcome = record && record.outcome || null;
  if (outcome && outcome.summary) return text(outcome.summary, "");
  for (var i = 0; i < bindings.length; i++) {
    if (bindings[i] && bindings[i].statusReason) return text(bindings[i].statusReason, "");
  }
  var reasons = {
    needs_owner: "Needs your decision", planned: "Recorded owner request", queued: "Queued for execution",
    working: "Execution is active", blocked: "Execution is blocked", failed: "Execution failed",
    verified_awaiting_acceptance: "Verified work is awaiting your acceptance",
    acceptance_rejected: "You rejected this; the coordinator is reworking it",
    completed: "Completed", dismissed: "Dismissed",
  };
  return reasons[state.status] || "Recorded owner request";
}

function sessionKey(ref) {
  return ref && ref.projectId && ref.sessionStorageId ?
    ref.projectId + ":" + ref.sessionStorageId : "";
}

function taskKey(ref) {
  return ref && ref.projectId && ref.taskId ? ref.projectId + ":" + ref.taskId : "";
}

function appendUnique(list, value, key) {
  if (!value) return;
  var wanted = key(value);
  if (!wanted) return;
  for (var i = 0; i < list.length; i++) if (key(list[i]) === wanted) return;
  list.push(value);
}
function entryTime(entry) {
  return Math.max(finite(entry && entry.updatedAt), finite(entry && entry.receivedAt));
}

function entryRevision(entry) {
  var bindings = Array.isArray(entry && entry.bindings) ? entry.bindings : [];
  var highest = 0;
  for (var i = 0; i < bindings.length; i++) {
    highest = Math.max(highest, Number(bindings[i] && bindings[i].bindingRevision) || 0);
  }
  return highest;
}

function statusRank(status) {
  return {
    failed: 8, blocked: 7, needs_owner: 6, verified_awaiting_acceptance: 5,
    // Below the states that still need the owner: a rejection has already been
    // answered and is now the coordinator's move. Ranked above plain work so it
    // stays visible while the rework happens.
    acceptance_rejected: 5, working: 4, queued: 3, planned: 2, completed: 1,
    dismissed: 0,
  }[status] || -1;
}

// An anchor-only component keeps the row on the ledger but never becomes its
// principal record, because the row's entryId is a durable owner-facing
// handle: visibility and detail requests are addressed to it. Letting a Thread
// anchor take that handle would silently rename existing rows.
function primaryEntry(entries) {
  return entries.slice().sort(function (left, right) {
    var principal = (left.anchorOnly === true ? 1 : 0) - (right.anchorOnly === true ? 1 : 0);
    if (principal) return principal;
    var hasIngress = (right.ingressId ? 1 : 0) - (left.ingressId ? 1 : 0);
    if (hasIngress) return hasIngress;
    var received = finite(left.receivedAt) - finite(right.receivedAt);
    if (received) return received;
    var sequence = (Number(left.ingressSequence) || Number.MAX_SAFE_INTEGER) -
      (Number(right.ingressSequence) || Number.MAX_SAFE_INTEGER);
    if (sequence) return sequence;
    return String(left.entryId).localeCompare(String(right.entryId));
  })[0];
}

function freshestEntry(entries) {
  return entries.slice().sort(function (left, right) {
    var revision = entryRevision(right) - entryRevision(left);
    if (revision) return revision;
    var changed = entryTime(right) - entryTime(left);
    if (changed) return changed;
    var rank = statusRank(right.status) - statusRank(left.status);
    if (rank) return rank;
    return String(left.entryId).localeCompare(String(right.entryId));
  })[0];
}

function titleEntry(entries) {
  var rank = { topic: 3, request: 2, action: 1, unavailable: 0 };
  return entries.slice().sort(function (left, right) {
    var source = (rank[right.titleSource] || 0) - (rank[left.titleSource] || 0);
    if (source) return source;
    var changed = entryTime(right) - entryTime(left);
    if (changed) return changed;
    return String(left.entryId).localeCompare(String(right.entryId));
  })[0];
}

function appendMany(target, values, key) {
  var source = Array.isArray(values) ? values : [];
  for (var i = 0; i < source.length; i++) appendUnique(target, source[i], key);
}

function sessionEntryKey(item) {
  return sessionKey(item && item.sessionRef);
}

function bindingEntryKey(item) {
  var key = workIdentity.taskIdentity(item && item.targetProject, item && item.portfolioTaskId);
  return key || (item && item.portfolioTaskId ? "unscoped-task:" + text(item.portfolioTaskId, "") : "");
}

function projectEntryKey(item) {
  return item && item.projectRef && item.projectRef.projectId;
}

function projectRefKey(item) {
  return item && item.projectId;
}

function appendEntryReferences(merged, entry) {
  appendMany(merged.sessions, entry.sessions, sessionEntryKey);
  appendMany(merged.taskRefs, entry.taskRefs, taskKey);
  var bindings = Array.isArray(entry.bindings) ? entry.bindings : [];
  for (var bi = 0; bi < bindings.length; bi++) {
    var binding = bindings[bi];
    var key = bindingEntryKey(binding);
    var replaced = false;
    for (var existing = 0; existing < merged.bindings.length; existing++) {
      if (bindingEntryKey(merged.bindings[existing]) !== key) continue;
      replaced = true;
      if ((Number(binding && binding.bindingRevision) || 0) >
          (Number(merged.bindings[existing] && merged.bindings[existing].bindingRevision) || 0)) {
        merged.bindings[existing] = binding;
      }
      break;
    }
    if (!replaced && key) merged.bindings.push(binding);
  }
  appendMany(merged.ingressIds, entry.ingressIds, function (item) { return item; });
  appendMany(merged.requestRefs, entry.requestRefs, sessionKey);
  if (entry.sourceSessionRef) appendUnique(merged.sourceSessionRefs, entry.sourceSessionRef, sessionKey);
  appendMany(merged.sourceSessionRefs, entry.sourceSessionRefs, sessionKey);
  appendMany(merged.projects, entry.projects, projectEntryKey);
  appendMany(merged.projectRefs, entry.projectRefs, projectRefKey);
}

function actionFor(entries) {
  var candidates = entries.filter(function (entry) { return !!entry.action; });
  if (candidates.length === 0) return null;
  candidates.sort(function (left, right) {
    var changed = entryTime(right) - entryTime(left);
    if (changed) return changed;
    return String(left.action.itemId || "").localeCompare(String(right.action.itemId || ""));
  });
  return JSON.parse(JSON.stringify(candidates[0].action));
}

function evidenceFor(entries) {
  var candidates = entries.filter(function (entry) { return !!entry.evidence; });
  if (candidates.length === 0) return "";
  return text(freshestEntry(candidates).evidence, "");
}

// An anchor-only component holds a row on the ledger; it does not get to
// describe it. Whenever a recorded ask is present in the group, that ask owns
// the row's identity, title, status, reason and the owner's visibility
// decision -- otherwise a Thread's own timestamp could outrank a genuine
// failure reported by a session or binding and quietly restate the row as
// unstarted. Only when every component is an anchor does the Thread describe
// itself, which is the Thread-only row.
function principals(entries) {
  var voters = entries.filter(function (item) { return item.anchorOnly !== true; });
  return voters.length ? voters : entries;
}

function hiddenVote(entries) {
  var voting = principals(entries);
  for (var i = 0; i < voting.length; i++) {
    if (voting[i].hidden !== true) return false;
  }
  return true;
}

function mergeEntries(group) {
  var entries = group.items.map(function (item) { return item.entry; });
  var described = principals(entries);
  var primary = primaryEntry(described);
  var latest = freshestEntry(described);
  var titled = titleEntry(described);
  var merged = Object.assign({}, primary, {
    entryId: primary.ingressId || primary.entryId || group.key,
    canonicalKey: group.key || primary.canonicalKey || "",
    title: titled.title, titleSource: titled.titleSource, status: latest.status,
    reason: latest.reason, activity: latest.activity || latest.reason,
    disposition: latest.disposition, reconciled: latest.reconciled,
    historicalUnresolved: latest.historicalUnresolved,
    evidence: evidenceFor(entries), action: actionFor(entries), updatedAt: entryTime(latest),
    clearable: latest.status === "completed" || latest.status === "dismissed",
    sessions: [], taskRefs: [], bindings: [], ingressIds: [], requestRefs: [],
    sourceSessionRefs: [], projects: [], projectRefs: [],
  });
  for (var i = 0; i < entries.length; i++) appendEntryReferences(merged, entries[i]);
  merged.hidden = hiddenVote(entries);
  delete merged.anchorOnly;
  return merged;
}

module.exports = { isAwaitingOwnerAcceptance: isAwaitingOwnerAcceptance,
  mergeEntries: mergeEntries, reasonFor: reasonFor, statusFor: statusFor };
