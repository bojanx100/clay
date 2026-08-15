// Tool-facing delegation split from the target execution runtime.
var taskGraph = require("./orchestration-task-graph");
var projectIdentity = require("./project-identity");
var bindings = require("./portfolio-execution-bindings");
var explicitImplementationDecision =
  require("./coop-thread-lifecycle").explicitImplementationDecision;

function hasProjectExecutionInput(input) {
  return !!(input && (input.targetProject || input.targetProjectId ||
    input.portfolioTaskId || input.bindingRevision));
}

function executionMetadata(session) {
  return bindings.sessionExecutionBinding(session);
}

function isImplementationIngress(item) {
  return item && item.type === "user_message" &&
    (item.coopImplementationDecision || explicitImplementationDecision(item.text));
}

function currentImplementationRoute(source, input) {
  var items = source && Array.isArray(source.history) ? source.history : [];
  var requested = input && input.coopTopicRef && input.coopTopicRef.topicId;
  for (var i = items.length - 1; i >= 0; i--) {
    var item = items[i];
    var topicId = item && item.coopTopicRef && item.coopTopicRef.topicId;
    if (!isImplementationIngress(item)) continue;
    if (requested && topicId !== requested) continue;
    return { coopTopicRef: input.coopTopicRef || item.coopTopicRef,
      coopIngressId: item.coopIngressId || null };
  }
  return {};
}

function coordinateProjectExecution(ctx, input) {
  if (!ctx.createProjectExecution) return { ok: false, error: "Cross-project execution is unavailable" };
  var source = ctx.sessionForInput({ coordinatorSessionId: input.coordinatorSessionId });
  if (!source || source.orchestrationParent || executionMetadata(source)) {
    return { ok: false, error: "Source Coop session is unavailable" };
  }
  return ctx.createProjectExecution(Object.assign({}, input,
    currentImplementationRoute(source, input), {
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
  var clientRef = input.clientRef ? String(input.clientRef) : "";
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
