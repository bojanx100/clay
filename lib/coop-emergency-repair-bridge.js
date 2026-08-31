// The only normal-flow call site allowed to enter EmergencyRepairPolicy v1.
// It translates the already-authorized action-decision context into immutable
// references; no user-supplied policy, recipe, project, or failure code is
// accepted here.

var schema = require("./coop-emergency-repair-schema");

function taskRef(projectRef, session, task) {
  return {
    projectId: projectRef.projectId,
    coordinatorSessionStorageId: String(session &&
      (session.sessionStorageId || session.storageId || session.cliSessionId) || ""),
    taskId: String(task && task.taskId || ""),
  };
}

function startRepair(options) {
  var opts = options || {};
  var policy = opts.policy;
  if (!policy || typeof policy.escrowOwnerDecision !== "function" ||
      typeof policy.binding !== "function") return null;
  var binding = policy.binding();
  var decision = opts.decision;
  var task = opts.task || {};
  var ownerDecision = task.ownerDecision || {};
  if (!binding || ownerDecision.decisionRef !== binding.ownerDecisionRef ||
      ownerDecision.status !== "unanswered" || ownerDecision.state !== "unanswered" ||
      !opts.projectRef || !opts.session || !opts.actorId) return null;
  var actualTaskRef = taskRef(opts.projectRef, opts.session, task);
  if (actualTaskRef.projectId !== binding.taskRef.projectId ||
      actualTaskRef.coordinatorSessionStorageId !== binding.taskRef.coordinatorSessionStorageId ||
      actualTaskRef.taskId !== binding.taskRef.taskId) return null;
  return policy.escrowOwnerDecision({
    recipe: schema.RECIPE,
    binding: binding,
    actorId: opts.actorId,
    ownerIngressId: binding.ownerIngressId,
    ownerDecisionRef: binding.ownerDecisionRef,
    taskState: task.status,
    action: {
      decision: decision.decision,
      note: decision.note || "",
      directiveDigest: schema.sha256(decision.directive),
    },
    failure: {
      code: "orchestrator_unavailable",
      observedAt: opts.observedAt,
      observer: "coop-action-decision",
    },
  });
}

module.exports = { startRepair: startRepair };
