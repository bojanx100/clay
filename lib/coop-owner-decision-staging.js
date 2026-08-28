// Durable, non-scheduling owner decisions for explicit plan choices in Coop.
//
// A decision is never inferred from a model response. The coordinator must
// call the typed staging path with the exact plan identity it wants the owner
// to decide. That creates one non-runnable task whose immutable scope is the
// provenance for the popup, answer, supersession, and transcript projection.

var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var topicRef = require("./coop-topic-ref");

var MAX_QUESTION = 4000;
var MAX_REASON = 1000;
var DIGEST_RE = /^[a-f0-9]{16,128}$/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value, limit) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function normalizeScope(value) {
  var source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  var projectRef = projectIdentity.normalizeProjectRef(source.targetProject);
  var portfolioTaskId = String(source.portfolioTaskId || "").trim();
  var bindingRevision = Number(source.bindingRevision);
  var planRevision = Number(source.planRevision);
  var planDigest = String(source.planDigest || "").trim().toLowerCase();
  var coopTopicRef = topicRef.normalizeTopicRefInput(source.coopTopicRef);
  if (!projectRef || !projectIdentity.isTaskId(portfolioTaskId) ||
      !Number.isInteger(bindingRevision) || bindingRevision < 1 ||
      !Number.isInteger(planRevision) || planRevision < 1 ||
      !DIGEST_RE.test(planDigest) || !coopTopicRef) return null;
  return {
    targetProject: { projectId: projectRef.projectId },
    portfolioTaskId: portfolioTaskId,
    bindingRevision: bindingRevision,
    planRevision: planRevision,
    planDigest: planDigest,
    coopTopicRef: { topicId: coopTopicRef.topicId },
  };
}

function scopeKey(scope) {
  return scope.targetProject.projectId + "|" + scope.portfolioTaskId + "|" +
    scope.bindingRevision + "|" + scope.planRevision + "|" + scope.planDigest + "|" +
    scope.coopTopicRef.topicId;
}

// A semantic plan revision belongs to one target task. A later explicitly
// staged revision for that same work withdraws the prior unresolved choice.
function planKey(scope) {
  return scope.targetProject.projectId + "|" + scope.portfolioTaskId;
}

function decisionRefFor(value) {
  var scope = normalizeScope(value);
  if (!scope) return "";
  return "owner-decision-" + crypto.createHash("sha256").update(scopeKey(scope))
    .digest("hex").slice(0, 24);
}

function taskTitle(scope) {
  return "Owner decision: " + scope.portfolioTaskId + " plan revision " + scope.planRevision;
}

function clientRefFor(scope) {
  return "owner-decision:" + decisionRefFor(scope);
}

function responseTurnFor(session) {
  var history = session && Array.isArray(session.history) ? session.history : [];
  var storageId = session && (session.storageId || session.cliSessionId) || "";
  if (!storageId || !session || !session.isProcessing) return null;
  for (var i = history.length - 1; i >= 0; i--) {
    var item = history[i];
    if (!item || item.type !== "user_message") continue;
    // Only an automated tick lacks a routed owner message. This explicit link
    // lets its owner-facing decision survive the topic filter without making
    // arbitrary synthetic turns visible.
    if (!item.synthetic || !item.autoAction) return null;
    return {
      projectId: projectIdentity.LEAD_PROJECT_ID,
      sessionStorageId: storageId,
      // Capture the append boundary at the typed tool call. A status sentence
      // emitted before staging is not evidence for this decision, while the
      // answer the coordinator emits afterwards is.
      startEventIndex: history.length,
    };
  }
  return null;
}

function validDecision(value) {
  var source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  var scope = normalizeScope(source.scope);
  var decisionRef = String(source.decisionRef || "");
  var state = String(source.status || source.state || "");
  if (!scope || decisionRef !== decisionRefFor(scope) ||
      (state !== "unanswered" && state !== "answered" && state !== "superseded" &&
       state !== "withdrawn")) return null;
  return {
    version: 1,
    decisionRef: decisionRef,
    scope: scope,
    status: state,
    state: state,
    createdAt: Number(source.createdAt) || 0,
    responseTurn: normalizeResponseTurn(source.responseTurn),
  };
}

function normalizeResponseTurn(value) {
  var source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  var projectId = String(source.projectId || "");
  var storageId = String(source.sessionStorageId || "");
  var start = Number(source.startEventIndex);
  if (projectId !== projectIdentity.LEAD_PROJECT_ID || !storageId ||
      !Number.isInteger(start) || start < 0) return null;
  return { projectId: projectId, sessionStorageId: storageId, startEventIndex: start };
}

function activeDecisionTasks(session) {
  var tasks = session && Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
  var result = [];
  for (var i = 0; i < tasks.length; i++) {
    var decision = validDecision(tasks[i] && tasks[i].ownerDecision);
    if (decision) result.push({ task: tasks[i], decision: decision });
  }
  return result;
}

function openStage(session, scope, question) {
  var normalized = normalizeScope(scope);
  var asked = cleanText(question, MAX_QUESTION);
  if (!normalized || !asked) return { ok: false, reason: "invalid_owner_decision" };
  var ref = decisionRefFor(normalized);
  var records = activeDecisionTasks(session);
  for (var i = 0; i < records.length; i++) {
    var existing = records[i];
    if (existing.decision.decisionRef !== ref) continue;
    if (existing.task.userQuestion !== asked) return { ok: false, reason: "owner_decision_question_mismatch" };
    return { ok: true, existing: existing.task, decision: existing.decision };
  }
  // Different work can legitimately have different owner choices pending at
  // the same time. The caller later supersedes only the older unanswered
  // record with this exact plan key; no session-wide singleton silently drops
  // another explicit Council or Triage decision.
  return { ok: true, scope: normalized, decisionRef: ref };
}

function stagedTaskInput(scope, decision, question, reason) {
  return {
    clientRef: clientRefFor(scope),
    title: taskTitle(scope),
    objective: "Wait for the owner's explicit decision on this exact plan revision.",
    context: "No implementation authority is created by this owner-decision record.",
    acceptanceCriteria: "The owner explicitly answers, supersedes, or withdraws this plan decision.",
    ownedPaths: "owner-decision-only",
    coopTopicRef: scope.coopTopicRef,
    ownerDecision: clone(decision),
    userQuestion: question,
    waitingReason: reason,
  };
}

function newDecision(scope, session) {
  return {
    version: 1,
    decisionRef: decisionRefFor(scope),
    scope: clone(scope),
    status: "unanswered",
    state: "unanswered",
    createdAt: Date.now(),
    responseTurn: responseTurnFor(session),
  };
}

function supersessionUpdates(decision, successorRef, reason) {
  return {
    status: "dismissed",
    ownerDecision: Object.assign({}, decision, {
      status: "superseded",
      state: "superseded",
      supersededAt: Date.now(),
      supersededBy: successorRef,
    }),
    currentActivity: "Superseded by " + successorRef,
    resolutionReason: reason,
    resolutionSummary: reason,
    resolvedAt: Date.now(),
    userQuestion: "",
    waitingReason: "",
  };
}

function withdrawalUpdates(decision, reason) {
  return {
    ownerDecision: Object.assign({}, decision, {
      status: "withdrawn",
      state: "withdrawn",
      withdrawnAt: Date.now(),
    }),
    currentActivity: reason,
    resolutionReason: reason,
    resolutionSummary: reason,
    resolvedAt: Date.now(),
    userQuestion: "",
    waitingReason: "",
  };
}

// Returns history indexes belonging to explicitly linked automated decision
// turns. It uses only task provenance produced by this module, never message
// text or an inferred topic. The caller still applies the common owner-
// relevance filter, which preserves normal transcript ordering and dedupes
// event refs with the topic's ordinary membership.
function responseIndexesForTopic(historyView, session, wantedTopicRef) {
  var wanted = topicRef.normalizeTopicRefInput(wantedTopicRef);
  if (!wanted) return [];
  var records = activeDecisionTasks(session);
  var entries = historyView && Array.isArray(historyView.entries) ? historyView.entries : [];
  var history = historyView && Array.isArray(historyView.history) ? historyView.history : [];
  var values = [];
  var seen = {};
  function add(index) {
    if (!Number.isInteger(index) || index < 0 || index >= history.length || seen[index]) return;
    seen[index] = true;
    values.push(index);
  }
  for (var ri = 0; ri < records.length; ri++) {
    var decision = records[ri].decision;
    var scope = decision.scope;
    var turn = decision.responseTurn;
    if (!turn || scope.coopTopicRef.topicId !== wanted.topicId) continue;
    var open = -1;
    for (var ei = 0; ei < entries.length; ei++) {
      if (entries[ei].sessionStorageId === turn.sessionStorageId &&
          entries[ei].eventIndex === turn.startEventIndex) {
        open = ei;
        break;
      }
    }
    if (open < 0) continue;
    for (var hi = open; hi < history.length; hi++) {
      var entry = entries[hi];
      if (!entry || entry.sessionStorageId !== turn.sessionStorageId) break;
      var item = history[hi];
      if (item && item.type === "user_message" && hi > open) break;
      add(hi);
      if (item && item.type === "done") break;
    }
  }
  return values.sort(function (left, right) { return left - right; });
}

module.exports = {
  activeDecisionTasks: activeDecisionTasks,
  cleanText: cleanText,
  clientRefFor: clientRefFor,
  decisionRefFor: decisionRefFor,
  newDecision: newDecision,
  normalizeScope: normalizeScope,
  openStage: openStage,
  planKey: planKey,
  responseIndexesForTopic: responseIndexesForTopic,
  stagedTaskInput: stagedTaskInput,
  supersessionUpdates: supersessionUpdates,
  validDecision: validDecision,
  withdrawalUpdates: withdrawalUpdates,
};
