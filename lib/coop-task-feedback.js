// Resolve report scope from the durable execution binding and actual worker
// ancestry. Report prose and model-supplied TopicRefs cannot choose a Thread.
var identity = require("./project-identity");
var topic = require("./coop-topic-ref");

function same(a, b) {
  return !!(a && b && a.projectId === b.projectId && a.sessionStorageId === b.sessionStorageId);
}

function normalized(value) {
  if (value && value.kind === "review") {
    var review = require("./coop-proactive-review").feedbackRef(value.review);
    return review && review.eventId === value.eventId ? review : null;
  }
  var ref = value && topic.normalizeTopicRefInput(value.coopTopicRef);
  if (value && value.kind === "planning") {
    var planningRef = identity.normalizeSessionRef(value.planningRef);
    if (!ref || !planningRef || planningRef.projectId !== identity.LEAD_PROJECT_ID ||
        !Number.isSafeInteger(value.runVersion) || value.runVersion < 1 ||
        value.eventId !== "planning:" + planningRef.sessionStorageId + ":" + value.runVersion) return null;
    return { kind: "planning", eventId: value.eventId, coopTopicRef: ref,
      planningRef: planningRef, runVersion: value.runVersion };
  }
  var project = value && identity.normalizeProjectRef(value.projectRef);
  var source = value && identity.normalizeSessionRef(value.source);
  if (!ref || !project || !source || typeof value.eventId !== "string" || !value.eventId ||
      value.eventId.length > 256 || typeof value.portfolioTaskId !== "string" ||
      !value.portfolioTaskId || value.portfolioTaskId.length > 256 ||
      !Number.isSafeInteger(value.bindingRevision) || value.bindingRevision < 1) return null;
  return { eventId: value.eventId, portfolioTaskId: value.portfolioTaskId,
    bindingRevision: value.bindingRevision, coopTopicRef: ref, projectRef: project, source: source };
}

function sessionByStorage(manager, id) {
  var found = null;
  if (manager && manager.sessions) manager.sessions.forEach(function (session) {
    if ((session.storageId || session.cliSessionId) === id) found = session;
  });
  return found;
}

function sourceChain(router, source) {
  var result = [source];
  var contexts = router.projectContextsById ? router.projectContextsById(source.projectId) : [];
  var managers = contexts.map(function (context) {
    return context.getSessionManager ? context.getSessionManager() : context.sm;
  }).filter(function (manager, index, all) {
    return manager && all.indexOf(manager) === index && sessionByStorage(manager, source.sessionStorageId);
  });
  if (managers.length !== 1) return { refs: result, manager: null };
  var manager = managers[0];
  var current = sessionByStorage(manager, source.sessionStorageId);
  var seen = Object.create(null);
  while (current && result.length < 64) {
    var parentRef = current.orchestrationParent;
    var parent = parentRef && sessionByStorage(manager, parentRef.sessionStorageId);
    var id = parent && (parent.storageId || parent.cliSessionId);
    if (!id || seen[id]) break;
    seen[id] = true;
    var task = (parent.orchestrationTasks || []).find(function (item) {
      return item.taskId === parentRef.taskId;
    });
    var worker = task && (identity.normalizeSessionRef(task.workerSessionRef) ||
      { projectId: source.projectId, sessionStorageId: task.workerStorageId });
    if (!same(worker, result[result.length - 1])) break;
    result.push({ projectId: source.projectId, sessionStorageId: id });
    current = parent;
  }
  return { refs: result, manager: manager };
}

function resolve(router, envelope) {
  var source = identity.normalizeSessionRef(envelope && envelope.source);
  var destination = identity.normalizeSessionRef(envelope && envelope.destination);
  if (!source || !destination || destination.projectId !== identity.LEAD_PROJECT_ID ||
      !router || !router.getExecutionBindings) return null;
  var bindings = router.getExecutionBindings();
  var chain = sourceChain(router, source);
  var payload = envelope.payload || {};
  for (var i = 0; i < chain.refs.length; i++) {
    var matches = bindings.filter(function (binding) {
      if (payload.portfolioTaskId && (binding.portfolioTaskId !== payload.portfolioTaskId ||
          binding.bindingRevision !== payload.bindingRevision)) return false;
      return (same(binding.worker, chain.refs[i]) || same(binding.coordinator, chain.refs[i]) ||
        chain.manager && require("./portfolio-execution-bindings").sourceContinuesBinding(
          chain.manager, binding, chain.refs[i])) &&
        (same(binding.source, destination) || same(binding.projectCoordinator, destination));
    });
    if (matches.length > 1) return null;
    if (matches.length === 1) return normalized({ eventId: envelope.eventId,
      portfolioTaskId: matches[0].portfolioTaskId, bindingRevision: matches[0].bindingRevision,
      coopTopicRef: matches[0].coopTopicRef, projectRef: matches[0].targetProject, source: source });
  }
  return null;
}

module.exports = { normalized: normalized, resolve: resolve };
