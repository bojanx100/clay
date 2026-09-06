// Owner conversation survives a bounded worker. Route it to the existing
// resident task discussion without granting the closed worker a capability.
var crypto = require("crypto");
var plane = require("./coop-control-plane");
var same = require("./server-cross-project-shared").sameSessionRef;
var ENDED = ["completed", "failed", "needs_input", "cancelled", "superseded"];

function createRoute(ctx) {
  return function route(input) {
    var binding = ctx.bindingStore.get(input.portfolioTaskId, input.bindingRevision);
    if (!binding || !same(binding.coordinator, input.source) ||
        binding.mode !== "project_coordinator" || ENDED.indexOf(binding.status) === -1) {
      return { ok: false, reason: "settled_binding_mismatch" };
    }
    var manager = ctx.getLeadManager();
    var root = plane.projectCoordinatorFor(manager, binding.targetProject);
    var destination = root && { projectId: "system-lead", sessionStorageId: root.storageId };
    var task = root && (root.orchestrationTasks || []).find(function (item) {
      return item.clientRef === "portfolio:" + binding.portfolioTaskId + ":" + binding.bindingRevision &&
        item.externalTaskCoordinator && same(item.workerSessionRef, binding.coordinator);
    });
    if (!task || root.hidden || !same(destination, binding.projectCoordinator)) {
      return { ok: false, reason: "discussion_coordinator_unavailable" };
    }
    var requestId = String(input.clientMessageId || input.queueId || crypto.randomUUID());
    var eventId = "owner-discussion-" + crypto.createHash("sha256")
      .update(JSON.stringify([input.source, requestId])).digest("hex");
    var attachments = (input.images || []).map(function (item) { return item.savedPath; }).filter(Boolean);
    var text = "Owner follow-up on task " + task.taskId + ":\n\n" + input.text +
      (attachments.length ? "\n\nAttached images: " + attachments.join(", ") : "") +
      "\n\nThe worker attempt has ended. Continue this task's discussion here and report through its Coop Thread. " +
      "Answer status questions using the saved task, worker outcome, and verification. " +
      "A conversation is not evidence of reopened execution; admit any additional work through the normal task workflow.";
    var envelope = ctx.delivery.createEnvelope({ eventId: eventId, source: input.source,
      destination: destination, bindingRevision: binding.bindingRevision,
      payload: { type: "coordinator_update", text: text, portfolioTaskId: binding.portfolioTaskId,
        bindingRevision: binding.bindingRevision } });
    var delivered = ctx.delivery.deliverEnvelope(envelope);
    return Object.assign({}, delivered, { conversationRef: destination });
  };
}

function dispatch(session, args, deps) {
  var execution = session && session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution;
  if (!execution || !execution.control || execution.mode !== "project_coordinator" ||
      session.isProcessing || ENDED.indexOf(execution.status) === -1) return false;
  var router = deps.crossProject;
  var result;
  try {
    result = router && router.routeSettledDiscussion && router.routeSettledDiscussion({
      source: { projectId: deps.sm.getProjectId(), sessionStorageId: session.storageId },
      portfolioTaskId: execution.portfolioTaskId, bindingRevision: execution.bindingRevision,
      clientMessageId: args.clientMessageId, queueId: args.queueId,
      text: args.finalText || args.displayText || "", images: args.images,
    });
  } catch (error) { result = { ok: false, reason: "discussion_delivery_failed" }; }
  var event = result && result.ok ? { type: "info",
    text: "Your follow-up is saved for the project coordinator. Continue the discussion there or in its Coop Thread.",
    conversationRef: result.conversationRef } : { type: "error",
    text: "Your message is saved, but its coordinator could not receive it (" +
      (result && result.reason || "discussion_route_unavailable") + "). The closed worker was not restarted." };
  if (deps.sm.sendAndRecord) deps.sm.sendAndRecord(session, event);
  else deps.sendToSession(session.localId, event);
  deps.sendToSession(session.localId, { type: "done", code: result && result.ok ? 0 : 1 });
  return true;
}

module.exports = { createRoute: createRoute, dispatch: dispatch };
