// Routes typed project-execution completions before ordinary coordinator text.
// A completed direct-leaf binding is durable state, not another owner turn.
function createCrossProjectEnvelopeHandler(ctx) {
  var crossProject = ctx.crossProject || null;
  var followup = ctx.followup;
  var portfolioExecutionTarget = ctx.portfolioExecutionTarget;
  var commandSchema = ctx.commandSchema;

  function handleCompletion(envelope) {
    var payload = envelope && envelope.payload;
    if (!payload || payload.type !== "portfolio_execution_completed") return null;
    var mode = payload.executionMode === "project_coordinator" ? "project_coordinator" : "direct_leaf";
    var complete = mode === "project_coordinator" ?
      crossProject && crossProject.completeProjectCoordinatorExecution :
      crossProject && crossProject.completeDirectLeafExecution;
    if (typeof complete !== "function") {
      return { ok: false, reason: "target_not_capable" };
    }
    var completed = complete(envelope);
    if (!completed || !completed.ok) return completed || { ok: false, reason: "delivery_error" };
    if (!completed.ownerNotification || completed.ownerNotificationDelivered) {
      return { ok: true, duplicate: !!completed.duplicate, acknowledged: true };
    }
    var update = followup.deliverCrossProjectEnvelope(Object.assign({}, envelope, {
      payload: { type: "coordinator_update", text: payload.text },
    }));
    if (!update || !update.ok) return update || { ok: false, reason: "delivery_error" };
    var acknowledged = crossProject.acknowledgeDirectLeafCompletion(envelope);
    if (!acknowledged || !acknowledged.ok) {
      return acknowledged || { ok: false, reason: "delivery_error" };
    }
    return { ok: true, duplicate: !!completed.duplicate || !!update.duplicate, acknowledged: true };
  }

  function deliver(envelope) {
    if (envelope && envelope.schema === commandSchema) {
      return portfolioExecutionTarget.handleEnvelope(envelope);
    }
    var completion = handleCompletion(envelope);
    if (completion) return completion;
    if (crossProject && typeof crossProject.completedDirectLeafUpdate === "function" &&
        crossProject.completedDirectLeafUpdate(envelope)) {
      return { ok: true, duplicate: true, suppressed: true, acknowledged: true };
    }
    return followup.deliverCrossProjectEnvelope(envelope);
  }

  return { deliver: deliver };
}

module.exports = { createCrossProjectEnvelopeHandler: createCrossProjectEnvelopeHandler };
