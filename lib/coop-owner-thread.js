// Canonical deterministic Thread creation for an owner request that carries a
// ProjectRef but no ThreadRef.
//
// The sibling of coop-automation-thread. That module mints a project-scoped
// Thread for typed automation, whose deterministic ThreadRef comes from the
// candidate key. Owner requests had no equivalent, which is what the Lead
// ledger kept recording as "current API cannot create a project Thread without
// an existing ThreadRef; no Lead-local fallback".
//
// Deliberately a PRE-DISPATCH lever, not something the admission gate does as a
// side effect. Admission decides; it must not mutate durable owner state while
// deciding. The automation path works the same way: the Thread exists before the
// execution is admitted.
//
// The ThreadRef is derived from immutable evidence -- the owner ingress id plus
// the ProjectRef -- so the same approved request always resolves to the same
// Thread and a retry is a no-op rather than a second container for one request.

var crypto = require("crypto");
var projectIdentity = require("./project-identity");

var PROVENANCE_SCHEMA = "clay.owner_request_thread_provenance";
var PROVENANCE_VERSION = 1;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cleanTitle(value, fallback) {
  var cleaned = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  return (cleaned || String(fallback || "Owner requested work")).slice(0, 160);
}

// Deterministic and collision-resistant: one ingress id under one ProjectRef
// always yields one thread id, and no other input can produce it.
function threadIdFor(ingressId, projectRef) {
  var digest = crypto.createHash("sha256")
    .update(String(ingressId) + "\u0000" + String(projectRef.projectId))
    .digest("hex").slice(0, 24);
  return "owner-" + digest;
}

function provenanceFor(ingressId, projectRef) {
  return {
    schema: PROVENANCE_SCHEMA,
    version: PROVENANCE_VERSION,
    projectRef: clone(projectRef),
    ingressId: String(ingressId),
  };
}

function sameProvenance(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function normalizeInput(input) {
  var value = input || {};
  var ingressId = String(value.ingressId || "").trim();
  var projectRef = projectIdentity.normalizeProjectRef(value.projectRef);
  if (!ingressId || !projectRef) return null;
  // Lead is the staffing side, never the execution target, so a Thread bound to
  // it would describe work that cannot exist.
  if (projectRef.projectId === projectIdentity.LEAD_PROJECT_ID) return null;
  return { ingressId: ingressId, projectRef: projectRef, title: value.title };
}

function ensure(seam, input) {
  var normalized = normalizeInput(input);
  if (!normalized) return { ok: false, code: "owner_thread_request_malformed" };
  if (!seam || typeof seam.load !== "function" || typeof seam.save !== "function" ||
      typeof seam.makeTopic !== "function") {
    return { ok: false, code: "owner_thread_store_unavailable" };
  }
  var state = seam.load();
  if (!state || !state.topics || typeof state.topics !== "object") {
    return { ok: false, code: "owner_thread_store_unavailable" };
  }
  var id = threadIdFor(normalized.ingressId, normalized.projectRef);
  var expected = provenanceFor(normalized.ingressId, normalized.projectRef);
  var existing = state.topics[id];
  if (existing) {
    var group = existing.group || {};
    var groupProject = group.projectRef || {};
    if (existing.source !== "owner_request" || group.kind !== "project" ||
        groupProject.projectId !== normalized.projectRef.projectId ||
        !sameProvenance(existing.ownerProvenance, expected) ||
        !existing.topicRef || existing.topicRef.topicId !== id ||
        !existing.threadRef || existing.threadRef.threadId !== id) {
      return { ok: false, code: "owner_thread_identity_conflict" };
    }
    if (existing.status !== "open" || existing.status === "merged" ||
        existing.threadState === "closed") {
      return { ok: false, code: "owner_thread_closed" };
    }
    return { ok: true, created: false, unchanged: true,
      topicRef: { topicId: id }, threadRef: { threadId: id }, topic: clone(existing) };
  }
  var timestamp = typeof seam.now === "function" ? seam.now() : Date.now();
  var topic = seam.makeTopic(id, cleanTitle(normalized.title, normalized.ingressId), {
    kind: "project",
    projectRef: clone(normalized.projectRef),
  }, "owner_request", timestamp, []);
  topic.ownerProvenance = expected;
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
  threadIdFor: threadIdFor,
};
