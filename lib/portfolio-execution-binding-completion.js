var projectIdentity = require("./project-identity");
var controlRole = require("./coop-control-role");
var acceptanceEvents = require("./coop-owner-acceptance-events");

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
    var ownerAcceptance = ctx.normalizeOwnerAcceptance(input.ownerAcceptance);
    var accepted = ownerAcceptance && ownerAcceptance.status === "accepted" &&
      ownerAcceptance.withdrawnAt == null;
    if (record.mode !== "direct_leaf" && record.mode !== "project_coordinator") {
      return { ok: false, reason: "invalid_execution_mode" };
    }
    var legacyReviewAttention = input.reviewOnly === true &&
      controlRole.isPeer(input.controlRole);
    var ownerAcceptanceAttention = requestedStatus === "needs_input" &&
      record.mode === "project_coordinator" && input.ownerAcceptanceRequired === true;
    var visualCanaryAttention = requestedStatus === "needs_input" &&
      record.mode === "project_coordinator" && input.visualCanaryUnavailable === true;
    var terminalStatus = requestedStatus === "completed" ? "completed" :
      (requestedStatus === "needs_input" && record.mode === "project_coordinator" &&
        (record.reviewOnly === true || legacyReviewAttention || ownerAcceptanceAttention ||
          visualCanaryAttention) ?
        "needs_input" : "failed");
    if (input.executionMode && input.executionMode !== record.mode) {
      return { ok: false, reason: "binding_mismatch" };
    }
    if (record.status === "completed" || record.status === "failed" ||
        record.status === "needs_input") {
      var acceptanceTransition = record.status === "needs_input" &&
        record.ownerAcceptanceRequired === true && terminalStatus === "completed" && accepted &&
        typeof input.implementationCompletedAt === "number" &&
        input.implementationCompletedAt === record.implementationCompletedAt &&
        Number(input.implementationCompletionRevision) ===
          Number(record.implementationCompletionRevision) &&
        String(input.implementationGraphDigest || "") ===
          String(record.implementationGraphDigest || "");
      if (acceptanceTransition) {
        // Continue below. This is the exact same implementation completion
        // receiving its separately authenticated owner acceptance, not a
        // second execution or a generic terminal rewrite.
      } else {
        if (record.completionEventId !== eventId) {
          return { ok: false, reason: "completion_conflict" };
        }
        return { ok: true, duplicate: true, binding: ctx.clone(record),
          coopTopicRef: topicRefOf(ctx, record),
          ownerNotification: record.completionOwnerNotification === true,
          ownerNotificationDelivered: record.completionOwnerDelivered === true };
      }
    }
    if (!ctx.currentStatuses[record.status] && record.status !== "needs_input") {
      return { ok: false, reason: "binding_terminal" };
    }
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
    if (input.ownerAcceptanceRequired === true || record.ownerAcceptanceRequired === true) {
      record.ownerAcceptanceRequired = true;
      record.ownerAcceptance = ownerAcceptance || record.ownerAcceptance || {
        status: "pending", source: "project_local_instructions",
      };
      // The ordered transitions behind that single verdict. Carried forward
      // rather than replaced, so an acceptance arriving after a rejection
      // cannot erase the fact that the owner once refused this work.
      var mergedEvents = acceptanceEvents.normalizeEvents(record.ownerAcceptanceEvents);
      var suppliedEvents = acceptanceEvents.normalizeEvents(input.ownerAcceptanceEvents);
      for (var e = 0; e < suppliedEvents.length; e++) {
        mergedEvents = acceptanceEvents.appendEvent(mergedEvents, suppliedEvents[e]);
      }
      if (mergedEvents.length) record.ownerAcceptanceEvents = mergedEvents;
    }
    if (typeof input.implementationCompletedAt === "number" &&
        Number.isFinite(input.implementationCompletedAt)) {
      record.implementationCompletedAt = input.implementationCompletedAt;
    }
    if (typeof input.implementationCompletionRevision === "number" &&
        Number.isFinite(input.implementationCompletionRevision)) {
      record.implementationCompletionRevision = input.implementationCompletionRevision;
    }
    if (typeof input.implementationGraphDigest === "string" && input.implementationGraphDigest) {
      record.implementationGraphDigest = input.implementationGraphDigest.slice(0, 256);
    }
    record.updatedAt = now();
    // Only a verified completion has nothing left to explain. A terminal
    // failure previously landed here and had its reason deleted unconditionally,
    // which is how sweep-terminalized orphans became indistinguishable from
    // genuine task failures: same status, same shape, no provenance. Keep the
    // reason, and prefer an explicit failureCode from the completion payload
    // over whatever the pre-terminal status had recorded.
    if (terminalStatus === "completed") {
      delete record.statusReason;
      delete record.failureCode;
    } else {
      var suppliedFailureCode = typeof input.failureCode === "string" ?
        input.failureCode.trim().slice(0, 128) : "";
      // Falls back to the pre-terminal statusReason only when nothing better
      // exists: it is the last thing known about this binding, so it beats
      // discarding provenance entirely. An explicit code always wins over it,
      // because the pre-terminal reason describes why the binding stalled, not
      // why it ended -- a stranded coordinator reads "session_archived" on the
      // way in and "restart_recovery" on the way out.
      if (suppliedFailureCode) record.failureCode = suppliedFailureCode;
      else if (!record.failureCode) record.failureCode = record.statusReason || "unspecified";
      // Mirrored so the two can never disagree about why this ended.
      record.statusReason = record.failureCode;
    }
    delete record.attentionAt;
    var written = ctx.save();
    if (!written.ok) state.bindings[found.index] = previous;
    return written.ok ? { ok: true, binding: ctx.clone(record),
      coopTopicRef: topicRefOf(ctx, record),
      ownerNotification: record.completionOwnerNotification, ownerNotificationDelivered: false } : written;
  }

  function requireOwnerAcceptance(taskId, revision, evidence) {
    if (ctx.getLoadError()) return { ok: false, reason: ctx.getLoadError() };
    var found = recordFor(taskId, revision);
    if (!found) return { ok: false, reason: "binding_not_found" };
    var record = found.record;
    var input = evidence && typeof evidence === "object" ? evidence : {};
    var eventId = String(input.correctionEventId || "").trim();
    if (record.mode !== "project_coordinator" || record.status !== "completed" || !eventId ||
        input.completionEventId && input.completionEventId !== record.completionEventId ||
        input.resultEventId && input.resultEventId !== record.resultEventId) {
      return { ok: false, reason: "owner_acceptance_repair_mismatch" };
    }
    if (record.ownerAcceptanceRequired === true) {
      return { ok: true, duplicate: true, binding: ctx.clone(record) };
    }
    var previous = ctx.clone(record);
    var repairedAt = typeof input.repairedAt === "number" && Number.isFinite(input.repairedAt) ?
      input.repairedAt : ctx.now();
    record.ownerAcceptanceRequired = true;
    record.ownerAcceptance = { status: "pending", source: "owner_acceptance_repair" };
    record.ownerAcceptanceRepair = {
      schema: "clay.owner_acceptance_repair",
      version: 1,
      repairedAt: repairedAt,
      correctionEventId: eventId.slice(0, 256),
      previousProjection: "done",
      reason: "owner_acceptance_missing",
    };
    record.updatedAt = repairedAt;
    var written = ctx.save();
    if (!written.ok) ctx.state.bindings[found.index] = previous;
    return written.ok ? { ok: true, binding: ctx.clone(record) } : written;
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
    requireOwnerAcceptance: requireOwnerAcceptance,
    findDirectLeafByWorker: findDirectLeafByWorker };
}

module.exports = { createBindingCompletionApi: createBindingCompletionApi };
