var projectIdentity = require("./project-identity");
var controlRole = require("./coop-control-role");

// Completion here is WORKER-terminal only. This module deliberately never
// writes a topic status, a disposition, or an acceptance: a worker returning
// "completed" is an implementation milestone, and owner acceptance stays an
// explicit, separate, revocable act (see coop-topic-state). All this does with
// the topic is carry the binding's existing reference forward so the delivery
// layer can attribute the result to the right lens.
function topicRefOf(ctx, record) {
  return record && record.coopTopicRef ? ctx.clone(record.coopTopicRef) : null;
}

function createBindingCompletionApi(ctx) {
  var state = ctx.state;
  var now = ctx.now;

  function recordFor(taskId, revision) {
    var index = ctx.bindingIndex(state.bindings, ctx.cleanId(taskId), revision);
    return index === -1 ? null : { index: index, record: state.bindings[index] };
  }

  function complete(taskId, revision, details) {
    if (ctx.getLoadError()) return { ok: false, reason: ctx.getLoadError() };
    var input = details && typeof details === "object" ? details : {};
    var eventId = String(input.eventId || "").trim();
    var found = recordFor(taskId, revision);
    var requestedStatus = String(input.terminalStatus || "completed");
    var requestedTerminal = requestedStatus === "completed" || requestedStatus === "failed" ||
      requestedStatus === "needs_input";
    if (!eventId) return { ok: false, reason: "invalid_completion" };
    if (!requestedTerminal) return { ok: false, reason: "invalid_completion" };
    if (!found) return { ok: false, reason: "binding_not_found" };
    var record = found.record;
    if (record.mode !== "direct_leaf" && record.mode !== "project_coordinator") {
      return { ok: false, reason: "invalid_execution_mode" };
    }
    var legacyReviewAttention = input.reviewOnly === true &&
      controlRole.isPeer(input.controlRole);
    var terminalStatus = requestedStatus === "completed" ? "completed" :
      (requestedStatus === "needs_input" && record.mode === "project_coordinator" &&
        (record.reviewOnly === true || legacyReviewAttention) ? "needs_input" : "failed");
    if (input.executionMode && input.executionMode !== record.mode) {
      return { ok: false, reason: "binding_mismatch" };
    }
    if (record.status === "completed" || record.status === "failed" ||
        record.status === "needs_input") {
      if (record.completionEventId !== eventId) return { ok: false, reason: "completion_conflict" };
      return { ok: true, duplicate: true, binding: ctx.clone(record),
        coopTopicRef: topicRefOf(ctx, record),
        ownerNotification: record.completionOwnerNotification === true,
        ownerNotificationDelivered: record.completionOwnerDelivered === true };
    }
    if (!ctx.currentStatuses[record.status]) return { ok: false, reason: "binding_terminal" };
    var previous = ctx.clone(record);
    if (terminalStatus === "needs_input" && legacyReviewAttention) {
      record.controlRole = controlRole.normalize(input.controlRole);
      record.reviewOnly = true;
    }
    record.status = terminalStatus;
    record.completedAt = typeof input.completedAt === "number" && Number.isFinite(input.completedAt) ?
      input.completedAt : now();
    record.completionEventId = eventId.slice(0, 256);
    if (input.resultEventId) record.resultEventId = String(input.resultEventId).slice(0, 256);
    record.completionOwnerNotification = input.ownerNotification === true;
    record.completionOwnerDelivered = false;
    record.updatedAt = now();
    delete record.statusReason;
    delete record.attentionAt;
    var written = ctx.save();
    if (!written.ok) state.bindings[found.index] = previous;
    return written.ok ? { ok: true, binding: ctx.clone(record),
      coopTopicRef: topicRefOf(ctx, record),
      ownerNotification: record.completionOwnerNotification, ownerNotificationDelivered: false } : written;
  }

  function acknowledgeCompletion(taskId, revision, eventId) {
    if (ctx.getLoadError()) return { ok: false, reason: ctx.getLoadError() };
    var found = recordFor(taskId, revision);
    if (!found) return { ok: false, reason: "binding_not_found" };
    var record = found.record;
    if ((record.status !== "completed" && record.status !== "failed" &&
        record.status !== "needs_input") ||
        record.completionEventId !== String(eventId || "")) {
      return { ok: false, reason: "completion_not_found" };
    }
    if (record.completionOwnerDelivered) return { ok: true, duplicate: true, binding: ctx.clone(record) };
    var previous = ctx.clone(record);
    record.completionOwnerDelivered = true;
    record.updatedAt = now();
    var written = ctx.save();
    if (!written.ok) state.bindings[found.index] = previous;
    return written.ok ? { ok: true, binding: ctx.clone(record) } : written;
  }

  function findDirectLeafByWorker(workerRef, revision) {
    var worker = projectIdentity.normalizeSessionRef(workerRef);
    if (!worker || !Number.isInteger(revision) || revision < 1) return null;
    for (var i = 0; i < state.bindings.length; i++) {
      var record = state.bindings[i];
      if (record.mode === "direct_leaf" && record.bindingRevision === revision && record.worker &&
          record.worker.projectId === worker.projectId &&
          record.worker.sessionStorageId === worker.sessionStorageId) return ctx.clone(record);
    }
    return null;
  }

  return { acknowledgeCompletion: acknowledgeCompletion, complete: complete,
    findDirectLeafByWorker: findDirectLeafByWorker };
}

module.exports = { createBindingCompletionApi: createBindingCompletionApi };
