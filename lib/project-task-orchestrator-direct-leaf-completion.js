// Durable typed terminal delivery for direct portfolio leaves.
// The terminal event closes the source-side execution binding before any
// optional Coop notification is enqueued, so a recovered terminal leaf cannot
// be treated as active work again.
var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var taskState = require("./orchestration-task-state");
var sessionExecutionBinding = require("./portfolio-execution-bindings").sessionExecutionBinding;

function attachDirectLeafCompletionTransport(ctx) {
  var sm = ctx.sm;
  var crossProject = ctx.crossProject || null;
  var projectIdForManager = ctx.projectIdForManager;

  function completionText(metadata, result) {
    var label = metadata.status === "needs_input" ? "update" : metadata.status;
    return [
      "[Clay direct-leaf " + label + "]",
      "Portfolio task: " + metadata.portfolioTaskId,
      "Binding revision: " + metadata.bindingRevision,
      "",
      String(result || "(The direct leaf returned no written result.)").slice(0, 60000),
    ].join("\n");
  }

  function terminalWorkerRef(session, metadata) {
    var direct = projectIdentity.sessionRef({ projectId: projectIdForManager(sm) }, session);
    if (direct) return direct;
    // During adapter shutdown, a target manager can already be detached even
    // though its durable binding still has the canonical worker SessionRef.
    var binding = crossProject && typeof crossProject.getExecutionBinding === "function" ?
      crossProject.getExecutionBinding(metadata.portfolioTaskId, metadata.bindingRevision) : null;
    return binding && binding.worker ? binding.worker : null;
  }

  function prepareCompletion(session, ownerNotification) {
    var metadata = sessionExecutionBinding(session);
    if (!metadata || metadata.mode !== "direct_leaf" ||
        (metadata.status !== "completed" && metadata.status !== "failed" &&
         metadata.status !== "needs_input")) return null;
    if (!metadata.resultEventId) metadata.resultEventId = "direct-leaf-" + crypto.randomUUID();
    if (!metadata.completionEventId) {
      metadata.completionEventId = "direct-completion-" + metadata.resultEventId;
      metadata.completionOwnerNotification = ownerNotification === true;
    }
    if (!metadata.completionDeliveryEventId) {
      // v2 avoids retrying the invalid source-less envelope emitted while an
      // adapter was already shutting down; old dead letters stay historical.
      metadata.completionDeliveryEventId = "direct-terminal-v2-" + metadata.resultEventId;
    }
    if (typeof metadata.completionOwnerNotification !== "boolean") {
      metadata.completionOwnerNotification = ownerNotification === true;
    }
    if (!metadata.completedAt) metadata.completedAt = Date.now();
    sm.saveSessionFile(session);
    return metadata;
  }

  function deliver(session, result, ownerNotification) {
    var metadata = prepareCompletion(session, ownerNotification);
    var worker = metadata && terminalWorkerRef(session, metadata);
    if (!metadata || !metadata.source || !crossProject ||
        typeof crossProject.createEnvelope !== "function" ||
        typeof crossProject.deliverEnvelope !== "function" || !worker) return null;
    var envelope = crossProject.createEnvelope({
      eventId: metadata.completionDeliveryEventId,
      source: worker,
      destination: metadata.source,
      bindingRevision: metadata.bindingRevision,
      payload: {
        type: "portfolio_execution_completed",
        executionMode: "direct_leaf",
        portfolioTaskId: metadata.portfolioTaskId,
        bindingRevision: metadata.bindingRevision,
        completedAt: metadata.completedAt,
        resultEventId: metadata.resultEventId,
        terminalStatus: metadata.status,
        ownerNotification: metadata.completionOwnerNotification === true,
        text: completionText(metadata, result),
      },
    });
    return crossProject.deliverEnvelope(envelope);
  }

  function reconcile(session) {
    var metadata = sessionExecutionBinding(session);
    if (!metadata || metadata.mode !== "direct_leaf" ||
        (metadata.status !== "completed" && metadata.status !== "failed" &&
         metadata.status !== "needs_input")) return null;
    // Existing terminal leaves are repaired through the typed transport, but
    // their historical completion text is not replayed into the owner lane.
    return deliver(session, taskState.workerResultText(session), false);
  }

  return { deliver: deliver, reconcile: reconcile };
}

module.exports = { attachDirectLeafCompletionTransport: attachDirectLeafCompletionTransport };
