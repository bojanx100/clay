// A coordinator may finish a task after its worker attempt ended. This typed
// resolution changes the portfolio outcome; it never resumes or rewrites the
// execution kernel's attempt. Generic worker completion remains immutable.
var identity = require("./project-identity");
var sameRef = require("./server-cross-project-shared").sameSessionRef;
var accepted = require("./project-owner-acceptance").isAccepted;

function normalize(value) {
  var input = value || {};
  var coordinator = identity.normalizeSessionRef(input.coordinator);
  var worker = identity.normalizeSessionRef(input.worker);
  var previous = input.previousOutcome || {};
  if (!coordinator || !worker || !input.taskId || !input.summary || !input.verification ||
      !Number.isFinite(input.resolvedAt) || input.resolvedAt <= 0 ||
      ["failed", "needs_input"].indexOf(previous.status) === -1) return null;
  return { taskId: String(input.taskId).slice(0, 256), coordinator: coordinator, worker: worker,
    summary: String(input.summary).slice(0, 4000), verification: String(input.verification).slice(0, 4000),
    resolvedAt: input.resolvedAt, previousOutcome: {
      status: previous.status, reason: String(previous.reason || "").slice(0, 1000),
      completedAt: Number(previous.completedAt) || null,
      completionEventId: String(previous.completionEventId || "").slice(0, 256) } };
}

function createApi(ctx) {
  return function resolveByCoordinator(taskId, revision, evidence) {
    if (ctx.getLoadError()) return { ok: false, reason: ctx.getLoadError() };
    var index = ctx.bindingIndex(ctx.state.bindings, ctx.cleanId(taskId), revision);
    var record = ctx.state.bindings[index];
    if (!record) return { ok: false, reason: "binding_not_found" };
    var input = evidence || {};
    if (record.mode !== "project_coordinator" ||
        !sameRef(record.projectCoordinator, input.coordinator) || !sameRef(record.coordinator, input.worker)) {
      return { ok: false, reason: "resolution_identity_mismatch" };
    }
    if (record.coordinatorResolution) {
      return record.coordinatorResolution.taskId === input.taskId ?
        { ok: true, duplicate: true, binding: ctx.clone(record) } :
        { ok: false, reason: "resolution_conflict" };
    }
    if (record.ownerAcceptanceRequired && !accepted(record.ownerAcceptance)) {
      return { ok: false, reason: "owner_acceptance_pending" };
    }
    if (record.status !== input.expectedStatus ||
        String(record.completionEventId || "") !== String(input.expectedCompletionEventId || "")) {
      return { ok: false, reason: "resolution_conflict" };
    }
    var resolution = normalize(Object.assign({}, input, { previousOutcome: {
      status: record.status, reason: record.statusReason, completedAt: record.completedAt,
      completionEventId: record.completionEventId } }));
    if (!resolution) return { ok: false, reason: "invalid_coordinator_resolution" };
    var previous = ctx.clone(record);
    record.coordinatorResolution = resolution;
    record.status = "completed";
    record.completedAt = resolution.resolvedAt;
    record.updatedAt = Math.max(record.updatedAt || 0, resolution.resolvedAt);
    delete record.statusReason;
    delete record.failureCode;
    delete record.failureDetails;
    delete record.attentionAt;
    var written = ctx.save();
    if (!written.ok) { ctx.state.bindings[index] = previous; return written; }
    return { ok: true, duplicate: false, binding: ctx.clone(record) };
  };
}

module.exports = { normalize: normalize, createApi: createApi };
