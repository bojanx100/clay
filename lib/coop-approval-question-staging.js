// Durable, non-scheduling approval questions for exact Coop portfolio work.
// The staged set is the authority: a later referential answer may cover these
// task/revision/ProjectRef triples and nothing else.

var crypto = require("crypto");
var projectIdentity = require("./project-identity");

var MAX_SCOPES = 16;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function scopeKey(scope) {
  return scope.targetProject.projectId + "|" + scope.portfolioTaskId + "|" +
    scope.bindingRevision;
}

function normalizeScopes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SCOPES) return null;
  var scopes = [];
  var seen = {};
  for (var i = 0; i < value.length; i++) {
    var source = value[i] || {};
    var taskId = String(source.portfolioTaskId || "").trim();
    var revision = Number(source.bindingRevision);
    var projectRef = projectIdentity.normalizeProjectRef(source.targetProject);
    if (!projectIdentity.isTaskId(taskId) || !Number.isInteger(revision) || revision < 1 ||
        !projectRef) return null;
    var scope = {
      portfolioTaskId: taskId,
      bindingRevision: revision,
      targetProject: { projectId: projectRef.projectId },
    };
    var key = scopeKey(scope);
    if (seen[key]) return null;
    seen[key] = true;
    scopes.push(scope);
  }
  return scopes;
}

function setIdFor(value) {
  var scopes = normalizeScopes(value);
  if (!scopes) return "";
  return "approval-set-" + crypto.createHash("sha256")
    .update(JSON.stringify(scopes.map(scopeKey)))
    .digest("hex").slice(0, 24);
}

function questionFor(value) {
  var scopes = normalizeScopes(value);
  if (!scopes) return "";
  if (scopes.length === 1) {
    return "Do you approve implementation of " + scopes[0].portfolioTaskId +
      " revision " + scopes[0].bindingRevision + " for ProjectRef " +
      scopes[0].targetProject.projectId + "?";
  }
  var lines = ["Do you approve implementation of this exact staged set?"];
  for (var i = 0; i < scopes.length; i++) {
    lines.push((i + 1) + ". " + scopes[i].portfolioTaskId + " revision " +
      scopes[i].bindingRevision + " for ProjectRef " +
      scopes[i].targetProject.projectId);
  }
  lines.push("A yes approves only this set.");
  return lines.join("\n");
}

function clientRefFor(scope) {
  return "portfolio:" + scope.portfolioTaskId + ":" + scope.bindingRevision;
}

function sameSet(left, right) {
  var leftScopes = normalizeScopes(left && left.scopes);
  var rightScopes = normalizeScopes(right && right.scopes);
  return !!(leftScopes && rightScopes && left.setId === right.setId &&
    left.setId === setIdFor(leftScopes) &&
    JSON.stringify(leftScopes) === JSON.stringify(rightScopes));
}

function openStage(session, scopes) {
  var tasks = session && Array.isArray(session.orchestrationTasks) ?
    session.orchestrationTasks : [];
  var wantedId = setIdFor(scopes);
  var matched = [];
  for (var i = 0; i < tasks.length; i++) {
    var task = tasks[i];
    if (!task || task.status !== "waiting_user") continue;
    if (!task.approvalSet) return { ok: false, reason: "user_decision_pending" };
    if (task.approvalSet.setId !== wantedId) return { ok: false, reason: "approval_set_pending" };
    matched.push(task);
  }
  if (!matched.length) return { ok: true, tasks: [] };
  if (matched.length !== scopes.length) return { ok: false, reason: "approval_set_incomplete" };
  var expected = { setId: wantedId, scopes: scopes };
  var refs = {};
  var stagedAt = null;
  for (var j = 0; j < matched.length; j++) {
    var taskStagedAt = Number(matched[j].approvalSet.stagedAt);
    if (!sameSet(matched[j].approvalSet, expected) ||
        matched[j].userQuestion !== questionFor(scopes) ||
        !Number.isFinite(taskStagedAt) || taskStagedAt <= 0 ||
        stagedAt !== null && taskStagedAt !== stagedAt) {
      return { ok: false, reason: "approval_set_mismatch" };
    }
    stagedAt = taskStagedAt;
    refs[matched[j].clientRef] = true;
  }
  for (var si = 0; si < scopes.length; si++) {
    if (!refs[clientRefFor(scopes[si])]) {
      return { ok: false, reason: "approval_set_incomplete" };
    }
  }
  return { ok: true, tasks: matched };
}

function selectedScopes(text, value) {
  var scopes = normalizeScopes(value);
  if (!scopes) return [];
  var head = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  var indexes = [];
  function include(number) {
    if (number >= 1 && number <= scopes.length && indexes.indexOf(number - 1) === -1) {
      indexes.push(number - 1);
    }
  }
  if (/\b(?:both|all|them)\b/.test(head)) {
    for (var ai = 0; ai < scopes.length; ai++) indexes.push(ai);
  } else {
    if (/\bthe first(?: one)?\b/.test(head)) include(1);
    if (/\bthe second(?: one)?\b/.test(head)) include(2);
    var option = head.match(/\boption\s+([0-9]+)\b/);
    if (option) include(Number(option[1]));
    var numbered = head.match(/\b[0-9]+\b/g) || [];
    for (var pi = 0; pi < numbered.length; pi++) include(Number(numbered[pi]));
  }
  // A plain yes/do-it/proceed names no subset, so it covers the exact staged
  // set. Explicit selections cover only the selected members.
  if (!indexes.length && !/\b(?:first|second|option|[0-9]+)\b/.test(head)) {
    for (var si = 0; si < scopes.length; si++) indexes.push(si);
  }
  indexes.sort(function (left, right) { return left - right; });
  return indexes.map(function (index) { return scopes[index]; });
}

function stagedTaskInput(scope, approvalSet, question, reason) {
  return {
    clientRef: clientRefFor(scope),
    title: "Approval: " + scope.portfolioTaskId + " revision " + scope.bindingRevision,
    objective: "Wait for the owner's decision on this exact portfolio revision.",
    context: "No worker may start before the staged approval question is answered.",
    acceptanceCriteria: "The owner explicitly approves or declines the staged set.",
    ownedPaths: "approval-only",
    approvalSet: clone(approvalSet),
    userQuestion: question,
    waitingReason: reason,
  };
}

module.exports = {
  MAX_SCOPES: MAX_SCOPES,
  clientRefFor: clientRefFor,
  normalizeScopes: normalizeScopes,
  openStage: openStage,
  questionFor: questionFor,
  selectedScopes: selectedScopes,
  sameSet: sameSet,
  setIdFor: setIdFor,
  stagedTaskInput: stagedTaskInput,
};
