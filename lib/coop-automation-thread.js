// Canonical deterministic Thread creation for typed project automation.
// These Threads are system-provenance work containers, not owner turns.

var authorizationModule = require("./project-automation-execution-authorization");

var PROVENANCE_SCHEMA = "clay.project_automation_thread_provenance";
var PROVENANCE_VERSION = 1;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function title(value, itemKey) {
  var cleaned = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  return (cleaned || String(itemKey || "Autonomous project work")).slice(0, 160);
}

function provenanceFor(authorization) {
  return {
    schema: PROVENANCE_SCHEMA,
    version: PROVENANCE_VERSION,
    projectRef: clone(authorization.projectRef),
    candidateKey: authorization.candidateKey,
    itemKey: authorization.itemKey,
    portfolioTaskId: authorization.scope.portfolioTaskId,
  };
}

function sameProvenance(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function ensure(seam, input) {
  var authorization = authorizationModule.normalizeAuthorization(
    input && input.authorization);
  if (!authorization) return { ok: false, code: "automation_authorization_malformed" };
  if (!seam || typeof seam.load !== "function" || typeof seam.save !== "function" ||
      typeof seam.makeTopic !== "function") {
    return { ok: false, code: "automation_thread_store_unavailable" };
  }
  var state = seam.load();
  if (!state || !state.topics || typeof state.topics !== "object") {
    return { ok: false, code: "automation_thread_store_unavailable" };
  }
  var id = authorization.threadRef.threadId;
  var expected = provenanceFor(authorization);
  var existing = state.topics[id];
  if (existing) {
    var group = existing.group || {};
    var groupProject = group.projectRef || {};
    if (existing.source !== "project_automation" || group.kind !== "project" ||
        groupProject.projectId !== authorization.projectRef.projectId ||
        !sameProvenance(existing.automationProvenance, expected) ||
        !existing.topicRef || existing.topicRef.topicId !== id ||
        !existing.threadRef || existing.threadRef.threadId !== id) {
      return { ok: false, code: "automation_thread_identity_conflict" };
    }
    if (existing.status !== "open" || existing.threadState === "closed" ||
        existing.status === "merged") {
      return { ok: false, code: "automation_thread_closed" };
    }
    return { ok: true, created: false, unchanged: true,
      topicRef: { topicId: id }, threadRef: { threadId: id }, topic: clone(existing) };
  }
  var timestamp = typeof seam.now === "function" ? seam.now() : Date.now();
  var topic = seam.makeTopic(id, title(input && input.title, authorization.itemKey), {
    kind: "project",
    projectRef: clone(authorization.projectRef),
  }, "project_automation", timestamp, []);
  topic.automationProvenance = expected;
  state.topics[id] = topic;
  seam.save();
  return { ok: true, created: true, topicRef: { topicId: id },
    threadRef: { threadId: id }, topic: clone(topic) };
}

module.exports = {
  PROVENANCE_SCHEMA: PROVENANCE_SCHEMA,
  PROVENANCE_VERSION: PROVENANCE_VERSION,
  ensure: ensure,
  provenanceFor: provenanceFor,
};
