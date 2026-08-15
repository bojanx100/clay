// Delivers verified project-coordinator completion through the same durable
// cross-project transport used by direct leaves. The Lead binding is closed by
// the destination router, never by mutating its file from the target project.
var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var sessionExecutionBinding = require("./portfolio-execution-bindings").sessionExecutionBinding;
var controlRole = require("./coop-control-role");

function deliverTerminal(sm, crossProject, session, details) {
  var metadata = sessionExecutionBinding(session);
  var input = details || {};
  if (!metadata || metadata.mode !== "project_coordinator" ||
      metadata.status !== input.terminalStatus || !metadata.source || !crossProject ||
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
      completedAt: metadata.completedAt || input.completedAt || metadata.updatedAt || Date.now(),
      resultEventId: metadata.projectCompletionResultEventId,
      terminalStatus: input.terminalStatus,
      ownerNotification: input.ownerNotification === true,
      controlRole: input.controlRole || undefined,
      reviewOnly: input.reviewOnly === true,
      resultSummary: String(input.summary || "Project execution finished.").slice(0, 60000),
      text: String(input.summary || "Project execution finished.").slice(0, 60000),
    },
  }));
}

function deliverProjectCompletion(sm, crossProject, session, completion) {
  if (!completion || completion.status !== "completed") return null;
  return deliverTerminal(sm, crossProject, session, {
    terminalStatus: "completed",
    completedAt: completion.completedAt,
    summary: completion.summary || "Verified project completion.",
    ownerNotification: false,
  });
}

function deliverProjectAttention(sm, crossProject, session, summary) {
  var metadata = sessionExecutionBinding(session);
  var role = controlRole.forSession(session, null, metadata);
  if (!metadata || metadata.status !== "needs_input" ||
      metadata.reviewOnly !== true && !controlRole.isPeer(role)) return null;
  return deliverTerminal(sm, crossProject, session, {
    terminalStatus: "needs_input",
    completedAt: metadata.updatedAt,
    summary: summary || "Read-only verification returned actionable attention.",
    ownerNotification: true,
    controlRole: role,
    reviewOnly: true,
  });
}

module.exports = {
  deliverProjectAttention: deliverProjectAttention,
  deliverProjectCompletion: deliverProjectCompletion,
};
