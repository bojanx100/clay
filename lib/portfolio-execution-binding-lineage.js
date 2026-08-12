// Resolves a canonical portfolio binding through server-owned Clay compaction
// lineage without changing the binding's original SessionRef.
var projectIdentity = require("./project-identity");
var sessionLineage = require("./coop-session-lineage");

function sameSessionRef(left, right) {
  return !!left && !!right && left.projectId === right.projectId &&
    left.sessionStorageId === right.sessionStorageId;
}

function sessionByRef(sm, ref, projectId) {
  var normalized = projectIdentity.normalizeSessionRef(ref);
  if (!normalized || normalized.projectId !== projectId || !sm || !sm.sessions ||
      typeof sm.sessions.forEach !== "function") return null;
  var found = null;
  sm.sessions.forEach(function (session) {
    var storageId = session && (session.storageId || session.cliSessionId) || "";
    if (!found && storageId === normalized.sessionStorageId) found = session;
  });
  return found;
}

function basicExecutionMatch(session, binding, getMetadata) {
  var metadata = getMetadata(session);
  return !!(metadata && binding &&
    metadata.portfolioTaskId === binding.portfolioTaskId &&
    metadata.bindingRevision === binding.bindingRevision &&
    metadata.mode === binding.mode);
}

function transferredExecutionMatch(session, binding, getMetadata) {
  if (!basicExecutionMatch(session, binding, getMetadata)) return false;
  var metadata = getMetadata(session);
  if (metadata.idempotencyKey !== binding.idempotencyKey) return false;
  return !binding.source || sameSessionRef(metadata.source, binding.source);
}

function bindingRef(binding) {
  if (!binding || (binding.mode !== "project_coordinator" && binding.mode !== "direct_leaf")) {
    return null;
  }
  var refName = binding.mode === "project_coordinator" ? "coordinator" : "worker";
  return projectIdentity.normalizeSessionRef(binding[refName]);
}

function executionSessionForBinding(sm, binding, getMetadata) {
  var ref = bindingRef(binding);
  var projectId = binding && binding.targetProject && binding.targetProject.projectId || "";
  if (!ref || ref.projectId !== projectId || !sm || !sm.sessions ||
      typeof sm.sessions.forEach !== "function") return null;
  var exact = sessionByRef(sm, ref, projectId);
  var indexed = sessionLineage.indexSessions(sm.sessions);
  var found = basicExecutionMatch(exact, binding, getMetadata) ? exact : null;
  var foundDistance = found ? 0 : -1;
  sm.sessions.forEach(function (session) {
    if (!transferredExecutionMatch(session, binding, getMetadata)) return;
    var distance = sessionLineage.distanceFrom(session, ref.sessionStorageId, indexed);
    if (distance === null || distance <= foundDistance) return;
    found = session;
    foundDistance = distance;
  });
  return found;
}

function sourceContinuesBinding(sm, binding, sourceRef, getMetadata) {
  var source = projectIdentity.normalizeSessionRef(sourceRef);
  var projectId = binding && binding.targetProject && binding.targetProject.projectId || "";
  var bound = bindingRef(binding);
  if (!source || !bound || source.projectId !== projectId || bound.projectId !== projectId) return false;
  var session = sessionByRef(sm, source, projectId);
  if (!transferredExecutionMatch(session, binding, getMetadata)) return false;
  var indexed = sessionLineage.indexSessions(sm && sm.sessions);
  var distance = sessionLineage.distanceFrom(session, bound.sessionStorageId, indexed);
  return distance !== null && distance > 0;
}

module.exports = {
  executionSessionForBinding: executionSessionForBinding,
  sourceContinuesBinding: sourceContinuesBinding,
};
