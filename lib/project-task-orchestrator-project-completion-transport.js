// Delivers verified project-coordinator completion through the same durable
// cross-project transport used by direct leaves. The Lead binding is closed by
// the destination router, never by mutating its file from the target project.
var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var sessionExecutionBinding = require("./portfolio-execution-bindings").sessionExecutionBinding;

function deliverProjectCompletion(sm, crossProject, session, completion) {
  var metadata = sessionExecutionBinding(session);
  if (!metadata || metadata.mode !== "project_coordinator" || metadata.status !== "completed" ||
      !metadata.source || !completion || completion.status !== "completed" || !crossProject ||
      typeof crossProject.createEnvelope !== "function" ||
      typeof crossProject.deliverEnvelope !== "function") return null;
  if (!metadata.projectCompletionResultEventId) {
    metadata.projectCompletionResultEventId = "project-coordinator-" + crypto.randomUUID();
  }
  if (!metadata.projectCompletionDeliveryEventId) {
    metadata.projectCompletionDeliveryEventId = "project-terminal-v1-" +
      metadata.projectCompletionResultEventId;
  }
  var source = projectIdentity.sessionRef({
    projectId: sm && typeof sm.getProjectId === "function" ? sm.getProjectId() : null,
  }, session);
  if (!source) return null;
  if (sm && typeof sm.saveSessionFile === "function") sm.saveSessionFile(session);
  return crossProject.deliverEnvelope(crossProject.createEnvelope({
    eventId: metadata.projectCompletionDeliveryEventId,
    source: source,
    destination: metadata.source,
    bindingRevision: metadata.bindingRevision,
    payload: {
      type: "portfolio_execution_completed",
      executionMode: "project_coordinator",
      portfolioTaskId: metadata.portfolioTaskId,
      bindingRevision: metadata.bindingRevision,
      completedAt: metadata.completedAt || completion.completedAt || Date.now(),
      resultEventId: metadata.projectCompletionResultEventId,
      terminalStatus: "completed",
      ownerNotification: false,
      text: String(completion.summary || "Verified project completion.").slice(0, 60000),
    },
  }));
}

module.exports = { deliverProjectCompletion: deliverProjectCompletion };
