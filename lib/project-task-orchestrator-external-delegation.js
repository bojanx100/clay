// Tool-facing delegation split from the target execution runtime.
var taskGraph = require("./orchestration-task-graph");
var projectIdentity = require("./project-identity");
var bindings = require("./portfolio-execution-bindings");
var explicitImplementationDecision =
  require("./coop-thread-lifecycle").explicitImplementationDecision;
var readOnlyReviewAdmission = require("./coop-read-only-review-admission");
var controlRole = require("./coop-control-role");

function hasProjectExecutionInput(input) {
  return !!(input && (input.targetProject || input.targetProjectId ||
    input.portfolioTaskId || input.bindingRevision));
}

function executionMetadata(session) {
  return bindings.sessionExecutionBinding(session);
}

function requestedProject(input) {
  if (input && input.targetProject) return projectIdentity.normalizeProjectRef(input.targetProject);
  if (input && input.targetProjectId) {
    return projectIdentity.normalizeProjectRef({ projectId: input.targetProjectId });
  }
  return null;
}

function isTerminalExecution(execution) {
  var status = execution && execution.status;
  return status === "completed" || status === "failed" || status === "superseded" ||
    status === "cancelled";
}

function isLocalProjectCoordinator(ctx, source, input) {
  var execution = executionMetadata(source);
  if (!execution || execution.mode !== "project_coordinator" || isTerminalExecution(execution)) return false;
  var coordinator = ctx.coordinatorForInput({ coordinatorSessionId: input.coordinatorSessionId });
  if (!coordinator || coordinator !== source) return false;
  var localProject = projectIdentity.normalizeProjectRef({ projectId: ctx.projectId() });
  var executionProject = projectIdentity.normalizeProjectRef(execution.targetProject);
  var targetProject = requestedProject(input);
  if (!localProject) return false;
  if ((input.targetProject || input.targetProjectId) && !targetProject) return false;
  if (executionProject && executionProject.projectId !== localProject.projectId) return false;
  if (targetProject && targetProject.projectId !== localProject.projectId) return false;
  if (input.portfolioTaskId && String(input.portfolioTaskId) !== String(execution.portfolioTaskId)) return false;
  if (input.bindingRevision != null && Number(input.bindingRevision) !== Number(execution.bindingRevision)) return false;
  return true;
}

function isImplementationIngress(item) {
  return item && item.type === "user_message" &&
    (item.coopImplementationDecision || explicitImplementationDecision(item.text));
}

function isReadOnlyReviewIngress(item, input) {
  return item && item.type === "user_message" &&
    readOnlyReviewAdmission.isReadOnlyPlanningReview(input) &&
    readOnlyReviewAdmission.explicitReadOnlyReviewAuthorization(item.text);
}

function currentExecutionRoute(source, input) {
  var items = source && Array.isArray(source.history) ? source.history : [];
  var requested = input && input.coopTopicRef && input.coopTopicRef.topicId;
  for (var i = items.length - 1; i >= 0; i--) {
    var item = items[i];
    var topicId = item && item.coopTopicRef && item.coopTopicRef.topicId;
    if (!isImplementationIngress(item) && !isReadOnlyReviewIngress(item, input)) continue;
    if (requested && topicId !== requested) continue;
    return { coopTopicRef: input.coopTopicRef || item.coopTopicRef,
      coopIngressId: item.coopIngressId || null };
  }
  return {};
}

function coordinateProjectExecution(ctx, input) {
  if (!ctx.createProjectExecution) return { ok: false, error: "Cross-project execution is unavailable" };
  var source = ctx.sessionForInput({ coordinatorSessionId: input.coordinatorSessionId });
  if (source && isLocalProjectCoordinator(ctx, source, input)) {
    return coordinateLocalExternalTask(ctx, input);
  }
  if (!source || source.orchestrationParent || executionMetadata(source)) {
    return { ok: false, error: "Source Coop session is unavailable" };
  }
  var classified = Object.assign({}, input);
  var role = controlRole.forExecution(input);
  if (controlRole.isPeer(role)) classified.controlRole = role;
  if (readOnlyReviewAdmission.isReadOnlyPlanningReview(input)) classified.reviewOnly = true;
  return ctx.createProjectExecution(Object.assign({}, classified,
    currentExecutionRoute(source, classified), {
    source: projectIdentity.sessionRef({ projectId: ctx.projectId() }, source),
  }));
}

function taskResult(coordinator, task, skipped) {
  return {
    ok: true,
    skipped: !!skipped,
    coordinatorSessionId: coordinator.storageId || coordinator.localId,
    coordinatorLocalSessionId: coordinator.localId,
    orchestrationTaskId: task.taskId,
    workerSessionId: task.workerSessionId || null,
    workerStorageId: task.workerStorageId || null,
    workerColor: task.workerColor || null,
    title: task.title,
  };
}

function coordinateLocalExternalTask(ctx, input) {
  var resolver = input.promoteCoordinator && ctx.ensureCoordinatorForInput ?
    ctx.ensureCoordinatorForInput : ctx.coordinatorForInput;
  var coordinator = resolver({ coordinatorSessionId: input.coordinatorSessionId });
  if (!coordinator) {
    return { ok: false, error: "Coordinator session not found or is not a coordinator" };
  }
  var clientRef = input.clientRef || input.idempotencyKey;
  clientRef = clientRef ? String(clientRef) : "";
  var tasks = Array.isArray(coordinator.orchestrationTasks) ? coordinator.orchestrationTasks : [];
  if (clientRef) {
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].clientRef === clientRef) return taskResult(coordinator, tasks[i], true);
    }
  }
  var task = taskGraph.createTask(coordinator, {
    title: input.title,
    objective: input.objective,
    context: input.context,
    acceptanceCriteria: input.acceptanceCriteria,
    ownedPaths: input.ownedPaths,
    imageRefs: input.imageRefs,
    clientRef: clientRef || null,
    provider: input.provider || null,
    model: input.model || null,
    providerPinned: !!String(input.provider || "").trim(),
    modelPinned: !!String(input.model || "").trim(),
    difficulty: input.difficulty || null,
  });
  ctx.schedule(coordinator);
  ctx.sm.saveSessionFile(coordinator);
  return taskResult(coordinator, task, false);
}

function createExternalTaskCoordinator(ctx) {
  return function coordinateExternalTask(input) {
    if (hasProjectExecutionInput(input)) return coordinateProjectExecution(ctx, input);
    return coordinateLocalExternalTask(ctx, input);
  };
}

module.exports = {
  createExternalTaskCoordinator: createExternalTaskCoordinator,
  hasProjectExecutionInput: hasProjectExecutionInput,
};
