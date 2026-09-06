// Resolve from the resident's actual durable task graph, never a caller's
// claimed completion. Exact task revision and both SessionRefs are required.
var plane = require("./coop-control-plane");
var sameRef = require("./server-cross-project-shared").sameSessionRef;
var verified = require("./orchestration-task-state").isVerifiedCompletion;

function createResolver(ctx) {
  function resolve(input) {
    var manager = ctx.getLeadManager();
    var source = input && input.source;
    if (!manager || !source || source.projectId !== "system-lead") return { ok: false, reason: "coordinator_unavailable" };
    var root;
    manager.sessions.forEach(function (session) {
      if (session.storageId === source.sessionStorageId) root = session;
    });
    var policy = plane.projectCoordinatorPolicy(root);
    if (!policy || plane.projectCoordinatorFor(manager, policy.projectRef) !== root) {
      return { ok: false, reason: "not_resident_coordinator" };
    }
    var tasks = root.orchestrationTasks || [];
    var task = tasks.find(function (candidate) { return candidate.taskId === input.taskId; });
    if (!task || task.externalTaskCoordinator !== true || task.status !== "completed" ||
        !task.resolvedByCoordinator || !task.resolvedAt ||
        !verified(task.resultSummary, task.verification, "no")) return { ok: false, reason: "unverified_coordinator_task" };
    var ref = String(task.clientRef || "").match(/^portfolio:(.+):([0-9]+)$/);
    var binding = ref && ctx.bindingStore.get(ref[1], Number(ref[2]));
    if (!binding || binding.mode !== "project_coordinator" ||
        binding.targetProject.projectId !== policy.projectRef.projectId ||
        !sameRef(binding.projectCoordinator, source) || !sameRef(binding.coordinator, task.workerSessionRef)) {
      return { ok: false, reason: "resolution_binding_mismatch" };
    }
    if (binding.ownerAcceptanceRequired && !require("./project-owner-acceptance").isAccepted(binding.ownerAcceptance)) {
      return { ok: false, reason: "owner_acceptance_pending" };
    }
    if (binding.status === "completed") return { ok: true, duplicate: true, binding: binding };
    var worker = ctx.sessionForBinding(binding);
    var execution = worker && worker.orchestrationPolicy && worker.orchestrationPolicy.portfolioExecution;
    if (!worker || worker.isProcessing || worker.queryInstance || !execution ||
        execution.portfolioTaskId !== binding.portfolioTaskId || execution.bindingRevision !== binding.bindingRevision ||
        ["failed", "needs_input"].indexOf(execution.status) === -1) return { ok: false, reason: "worker_not_settled" };
    try {
      if (manager.saveSessionFile(root, { durable: true }) === false) throw new Error("save failed");
    } catch (error) { return { ok: false, reason: "coordinator_resolution_not_durable" }; }
    return ctx.bindingStore.resolveByCoordinator(binding.portfolioTaskId, binding.bindingRevision, {
      taskId: task.taskId, coordinator: source, worker: task.workerSessionRef,
      summary: task.resultSummary, verification: task.verification, resolvedAt: task.resolvedAt,
      expectedStatus: binding.status, expectedCompletionEventId: binding.completionEventId,
    });
  }

  function reconcile() {
    var manager = ctx.getLeadManager();
    var results = [];
    if (!manager) return results;
    manager.sessions.forEach(function (root) {
      if (!plane.projectCoordinatorPolicy(root)) return;
      (root.orchestrationTasks || []).forEach(function (task) {
        if (!task.externalTaskCoordinator || !task.resolvedByCoordinator || task.status !== "completed") return;
        results.push(resolve({ source: { projectId: "system-lead", sessionStorageId: root.storageId }, taskId: task.taskId }));
      });
    });
    return results;
  }
  return { resolve: resolve, reconcile: reconcile };
}

module.exports = { createResolver: createResolver };
