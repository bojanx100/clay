// Bounded construction of one durable Coop session-ledger row.

var controlRole = require("./coop-control-role");
var normalizeControlledBy = require("./coop-control-provenance").normalizeControlledBy;
var normalizeTopicRef = require("./coop-topic-ref").normalizeTopicRefInput;
var lifecycle = require("./coop-session-lifecycle");
var terminalEvidence = require("./coop-session-terminal-evidence");

var cleanText = lifecycle.cleanText;
var finite = lifecycle.finite;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function storageId(session) {
  return session && (session.storageId || session.cliSessionId) || "";
}

function compareBindings(left, right) {
  return (finite(left.updatedAt) - finite(right.updatedAt)) ||
    ((Number(left.bindingRevision) || 0) - (Number(right.bindingRevision) || 0)) ||
    String(left.portfolioTaskId || "").localeCompare(String(right.portfolioTaskId || ""));
}

function acceptanceFields(summary, record) {
  if (record.ownerAcceptanceRequired === true) summary.ownerAcceptanceRequired = true;
  if (record.ownerAcceptance) summary.ownerAcceptance = clone(record.ownerAcceptance);
  if (record.ownerAcceptanceRepair) summary.ownerAcceptanceRepair = clone(record.ownerAcceptanceRepair);
}

function completionFields(summary, record) {
  if (record.implementationCompletedAt) {
    summary.implementationCompletedAt = finite(record.implementationCompletedAt) || null;
  }
}

function bindingSummary(binding) {
  var record = binding || {};
  var summary = {
    portfolioTaskId: cleanText(record.portfolioTaskId, 256),
    bindingRevision: Number(record.bindingRevision) || 0,
    idempotencyKey: cleanText(record.idempotencyKey, 256),
    mode: record.mode === "project_coordinator" ? "project_coordinator" : "direct_leaf",
    status: cleanText(record.status, 40) || "unknown",
    createdAt: finite(record.createdAt) || null,
    updatedAt: finite(record.updatedAt) || null,
    completedAt: finite(record.completedAt) || null,
    statusReason: cleanText(record.statusReason, 500),
  };
  if (record.controlRole) summary.controlRole = cleanText(record.controlRole, 40);
  if (record.reviewOnly === true) summary.reviewOnly = true;
  acceptanceFields(summary, record);
  completionFields(summary, record);
  if (record.coordinatorResolution) summary.coordinatorResolution = clone(record.coordinatorResolution);
  var topicRef = normalizeTopicRef(record.coopTopicRef);
  if (topicRef) summary.coopTopicRef = topicRef;
  return summary;
}

function uniqueTopicRefs(values) {
  var byId = {};
  var list = Array.isArray(values) ? values : [];
  for (var i = 0; i < list.length; i++) {
    var ref = normalizeTopicRef(list[i]);
    if (ref) byId[ref.topicId] = ref;
  }
  return Object.keys(byId).sort().map(function (id) { return byId[id]; });
}

function actionCandidate(type, at, report) {
  return at ? { type: type, at: at, report: cleanText(report, 1000) } : null;
}

function latestAction(candidates) {
  var list = candidates.filter(function (item) { return !!item; });
  list.sort(function (left, right) {
    return (left.at - right.at) || String(left.type).localeCompare(String(right.type));
  });
  return list.length ? list[list.length - 1] : null;
}

function roleFor(session, binding, parent) {
  if (session && session.coordinationRole === "project_coordinator") return "project_coordinator";
  if (session && session.coordinationRole === "task_coordinator") return "task_coordinator";
  if (parent) return "worker";
  var execution = session && session.orchestrationPolicy &&
    session.orchestrationPolicy.portfolioExecution;
  var mode = execution && execution.mode || binding && binding.mode;
  if (mode === "project_coordinator" || session && session.coordinationMode) {
    return "project_coordinator";
  }
  if (mode === "direct_leaf") return "direct_leaf";
  return "top_level_session";
}

function executionFor(session) {
  return session && session.orchestrationPolicy &&
    session.orchestrationPolicy.portfolioExecution || {};
}

function hasExactBinding(bindings, execution) {
  return bindings.some(function (item) {
    return item.portfolioTaskId === execution.portfolioTaskId &&
      Number(item.bindingRevision) === Number(execution.bindingRevision);
  });
}

function bindingsFor(input, execution) {
  var bindings = (input.bindings || []).slice();
  if (execution.portfolioTaskId && Number(execution.bindingRevision) &&
      !hasExactBinding(bindings, execution)) bindings.push(execution);
  bindings.sort(compareBindings);
  return bindings;
}

function lastBinding(bindings) {
  return bindings.length ? bindings[bindings.length - 1] : null;
}

function topicRefsFor(input, bindings, task) {
  var topics = input.topicRefs.slice();
  for (var i = 0; i < bindings.length; i++) topics.push(bindings[i].coopTopicRef);
  if (task) topics.push(task.coopTopicRef);
  return uniqueTopicRefs(topics);
}

function timingFor(session, execution, task, binding, completion, adoption, controlled) {
  var createdAt = finite(session && session.createdAt) || finite(binding && binding.createdAt) ||
    finite(controlled && controlled.since) || null;
  var closedAt = finite(session && session.closedAt);
  var updatedAt = Math.max(finite(session && session.lastActivity), finite(execution.updatedAt),
    finite(task && task.updatedAt), finite(binding && binding.updatedAt),
    finite(completion && completion.completedAt), finite(adoption && (adoption.decidedAt || adoption.proposedAt)),
    finite(createdAt), closedAt);
  return { createdAt: createdAt, closedAt: closedAt, updatedAt: updatedAt };
}

function outcomeFor(status, role, completion, task, execution, binding) {
  var outcome = lifecycle.terminalOutcome(status, role, { completion: completion, task: task,
    execution: execution, binding: binding });
  return terminalEvidence.withVerification(outcome, completion, task);
}

function actionsFor(binding, execution, completion, task, adoption, controlled) {
  return latestAction([
    actionCandidate("execution_" + cleanText(binding && binding.status, 40),
      finite(binding && binding.updatedAt), binding && binding.statusReason),
    actionCandidate("execution_" + cleanText(execution.status, 40),
      finite(execution.updatedAt), execution.statusReason),
    actionCandidate("project_completed", finite(completion && completion.completedAt),
      completion && completion.summary),
    actionCandidate("task_" + cleanText(task && task.status, 40), finite(task && task.updatedAt),
      task && (task.resultSummary || task.resolutionSummary || task.currentActivity)),
    actionCandidate("session_" + cleanText(adoption && adoption.status, 40),
      finite(adoption && (adoption.decidedAt || adoption.proposedAt)), ""),
    actionCandidate("coop_controlled", finite(controlled && controlled.since), ""),
  ]);
}

function createdFor(binding, controlled, adoption, parent, parentBinding, parentControlled, parentAdoption) {
  return !!binding || (!!controlled && !adoption) || !!(parent && !adoption &&
    (parentBinding || parentControlled && !parentAdoption));
}

function providerFor(session, task) {
  return {
    vendor: session && session.vendor || task && task.provider || null,
    routeId: session && session.providerRouteId || task && task.providerRouteId || null,
    model: session && (session.verifiedModel || session.model) || task && task.model || null,
  };
}

function sessionFields(input, values) {
  var session = values.session;
  var parent = values.parent;
  return {
    projectRef: { projectId: input.projectId },
    sessionRef: { projectId: input.projectId, sessionStorageId: input.sessionStorageId },
    sessionStorageId: input.sessionStorageId,
    title: cleanText(session && session.title, 240) || "Project session",
    sessionPresent: !!session,
    coopCreated: values.created,
    coopTouched: true,
    coopControllerSessionStorageId: values.controlled && values.controlled.coopSessionStorageId || null,
    topLevel: !parent,
    role: values.role,
    controlRole: controlRole.forSession(session, values.task, values.binding) || null,
    parentSessionRef: parent ? { projectId: input.projectId, sessionStorageId: storageId(parent) } : null,
    parentTaskId: values.task && values.task.taskId || null,
  };
}

function bindingFields(values) {
  return {
    portfolioBinding: values.binding ? bindingSummary(values.binding) : null,
    portfolioBindings: values.bindings.map(bindingSummary),
    parentPortfolioBinding: values.parentBinding ? bindingSummary(values.parentBinding) : null,
    coopTopicRef: values.topicRefs[0] || null,
    coopTopicRefs: values.topicRefs,
  };
}

function lifecycleFields(values) {
  return {
    provider: providerFor(values.session, values.task),
    createdAt: values.timing.createdAt,
    updatedAt: values.timing.updatedAt || null,
    closedAt: values.timing.closedAt || values.outcome && values.outcome.at || null,
    hidden: !!(values.session && values.session.hidden),
    lifecycleState: values.status,
    workState: lifecycle.projectedWorkState(values.status, values.session, values.binding, values.execution),
    terminalOutcome: values.outcome,
    lastCoopAction: values.action,
  };
}

function valuesFor(input) {
  var session = input.session || null;
  var execution = executionFor(session);
  var bindings = bindingsFor(input, execution);
  var binding = lastBinding(bindings);
  var parentBindings = (input.parentBindings || []).slice().sort(compareBindings);
  var parentBinding = lastBinding(parentBindings);
  var parent = input.parent || null;
  var task = input.task || null;
  var role = roleFor(session, binding, parent);
  var status = lifecycle.lifecycleState(session, binding, task, role, input.taskBindings, input.sessions);
  var completion = session && session.orchestrationProjectCompletion || null;
  var adoption = session && session.orchestrationAdoption || null;
  var controlled = normalizeControlledBy(session && session.coopControlledBy);
  var parentAdoption = parent && parent.orchestrationAdoption || null;
  var parentControlled = normalizeControlledBy(parent && parent.coopControlledBy);
  var timing = timingFor(session, execution, task, binding, completion, adoption, controlled);
  return {
    session: session, execution: execution, bindings: bindings, binding: binding, parent: parent,
    task: task, role: role, status: status, controlled: controlled, parentBinding: parentBinding,
    topicRefs: topicRefsFor(input, bindings, task), timing: timing,
    outcome: outcomeFor(status, role, completion, task, execution, binding),
    action: actionsFor(binding, execution, completion, task, adoption, controlled),
    created: createdFor(binding, controlled, adoption, parent, parentBinding, parentControlled, parentAdoption),
  };
}

function buildEntry(input) {
  var values = valuesFor(input);
  return Object.assign({}, sessionFields(input, values), bindingFields(values), lifecycleFields(values));
}

module.exports = { buildEntry: buildEntry };
