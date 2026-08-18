// Tool-facing delegation split from the target execution runtime.
var taskGraph = require("./orchestration-task-graph");
var projectIdentity = require("./project-identity");
var bindings = require("./portfolio-execution-bindings");
var explicitImplementationDecision =
  require("./coop-thread-lifecycle").explicitImplementationDecision;
var readOnlyReviewAdmission = require("./coop-read-only-review-admission");
var controlRole = require("./coop-control-role");
var leadLedger = require("./lead-ledger");
var queueAuthorization = require("./coop-queue-authorization");
var itemApproval = require("./coop-item-approval");
var recoveredThreadAdmission = require("./coop-recovered-thread-admission");
var ownerRequestsModule = require("./coop-owner-requests");

function hasProjectExecutionInput(input) {
  return !!(input && (input.targetProject || input.targetProjectId ||
    input.portfolioTaskId || input.bindingRevision));
}

// hasProjectExecutionInput deliberately triggers on ANY project-execution
// field, but the typed binding needs all five together: normalizeRequest in
// portfolio-execution-bindings returns null unless targetProject,
// portfolioTaskId, idempotencyKey, mode and a valid bindingRevision are all
// present. A partial set therefore routed into project execution and failed as
// a bare "invalid_binding" that named nothing, which reads as a broken
// dispatch rather than an incomplete call.
//
// The MCP schema cannot express this: the same fields are genuinely optional
// for the local delegate path, which needs none of them. So this is the one
// place that can state the all-or-nothing rule, and it names what is missing.
function projectExecutionInputProblem(input) {
  var value = input || {};
  var missing = [];
  if (!requestedProject(value)) missing.push("targetProject.projectId");
  if (!String(value.portfolioTaskId || "").trim()) missing.push("portfolioTaskId");
  if (!String(value.idempotencyKey || "").trim()) missing.push("idempotencyKey");
  if (value.mode !== "project_coordinator" && value.mode !== "direct_leaf") {
    missing.push("mode (project_coordinator or direct_leaf)");
  }
  var revision = Number(value.bindingRevision);
  if (!(Number.isInteger(revision) && revision >= 1)) {
    missing.push("bindingRevision (integer 1 or greater)");
  }
  if (!missing.length) return null;
  return "project execution needs targetProject, portfolioTaskId, idempotencyKey, " +
    "mode and bindingRevision together; missing or invalid: " + missing.join(", ") +
    ". Omit all five to delegate a local worker task instead.";
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

function latestOwnerIngressIndex(items) {
  for (var i = items.length - 1; i >= 0; i--) {
    if (items[i] && items[i].type === "user_message" && items[i].coopIngressId) return i;
  }
  return -1;
}

function isUnscopedMainImplementation(item, index, latestIndex) {
  var scope = item && item.coopComposerScope;
  return index === latestIndex && !item.coopTopicRef &&
    (scope === "main" || scope === "canonical") && isImplementationIngress(item);
}

function leadEventsFor(ctx) {
  try {
    return typeof ctx.readLeadEvents === "function" ? ctx.readLeadEvents() : leadLedger.readEvents();
  } catch (e) { return []; }
}

function queueExecutionRoute(ctx, source, input) {
  var history = source && Array.isArray(source.history) ? source.history : [];
  var authorization = queueAuthorization.latestAuthorizationEvent(history);
  if (!authorization || !authorization.coopIngressId || typeof authorization._ts !== "number") return {};
  var snapshot = queueAuthorization.snapshotAt(leadEventsFor(ctx), authorization._ts);
  var task = queueAuthorization.taskInSnapshot(snapshot, input);
  if (!task) return {};
  var original = queueAuthorization.originalTaskEvent(history, input, task.queuedAt);
  if (!original || !original.coopIngressId) return {};
  return {
    coopIngressId: original.coopIngressId,
    coopAuthorizationIngressId: authorization.coopIngressId,
  };
}

// The named-approval sibling of queueExecutionRoute. Derived server-side from
// the canonical session history for the same reason: a caller must never be able
// to hand us the linkage it wants believed. coopApprovalIngressId is therefore
// not an MCP input, exactly like coopAuthorizationIngressId.
//
// The approval turn also supplies the Thread. Approved backlog work has no owner
// ingress of its own to hang one on, and the admission gate cannot proceed
// without a TopicRef, so the Thread is minted deterministically against the
// approval turn -- the owner turn that authorized this exact work. A retry
// resolves to the same Thread rather than a second container.
function approvalExecutionRoute(ctx, source, input) {
  var history = source && Array.isArray(source.history) ? source.history : [];
  var approval = itemApproval.latestApprovalEvent(history);
  if (!approval || !approval.coopIngressId || typeof approval._ts !== "number") return {};
  var recognized = itemApproval.explicitItemApproval(approval.text);
  if (!recognized) return {};
  var snapshot = itemApproval.pendingApprovalSnapshotAt(leadEventsFor(ctx), approval._ts);
  if (!snapshot.ok) return {};
  var resolved = itemApproval.resolveApprovedTask(snapshot, recognized.subject);
  if (!resolved.ok) return {};
  // Route only the task the owner actually named. The gate re-derives all of
  // this independently; this check keeps us from minting a Thread for work the
  // approval never covered.
  if (String(resolved.task.portfolioTaskId) !== String(input && input.portfolioTaskId) ||
      Number(resolved.task.bindingRevision) !== Number(input && input.bindingRevision)) {
    return {};
  }
  var route = { coopApprovalIngressId: approval.coopIngressId };
  if (input && input.coopTopicRef) return route;
  var projectRef = requestedProject(input);
  if (!projectRef || typeof ctx.ensureOwnerThread !== "function") return route;
  var thread = ctx.ensureOwnerThread({
    ingressId: approval.coopIngressId,
    projectRef: projectRef,
    title: input && input.title,
  });
  if (thread && thread.ok && thread.topicRef) route.coopTopicRef = thread.topicRef;
  return route;
}

// A foreground owner turn may be classified after it was written to history.
// In that case the durable owner-request record is the authority on its
// implementation decision, while the original event remains the authority on
// who said it. Do not accept a caller-provided ingress: recover it only when
// the requested Thread has exactly one executable record whose canonical event
// belongs to this source session.
function ledgerImplementationRoute(ctx, source, input) {
  var topicRef = input && input.coopTopicRef;
  var ledger = ctx.ownerRequests || ownerRequestsModule.getDefaultOwnerRequests();
  if (!topicRef || !ledger || typeof ledger.forTopic !== "function") return {};
  var entries;
  try { entries = ledger.forTopic(topicRef); }
  catch (e) { return {}; }
  var history = source && Array.isArray(source.history) ? source.history : [];
  var sourceId = String(source && (source.storageId || source.sessionStorageId) || "");
  var projectId = typeof ctx.projectId === "function" ? ctx.projectId() : "";
  var matched = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var sessionRef = entry && entry.sessionRef;
    var requestRef = entry && entry.requestRef;
    var event = requestRef && history[requestRef.eventIndex];
    if (!entry || entry.expectsExecution !== true || !entry.implementationDecision ||
        !sessionRef || !requestRef || sessionRef.projectId !== projectId ||
        sessionRef.sessionStorageId !== sourceId || requestRef.projectId !== projectId ||
        requestRef.sessionStorageId !== sourceId || !event ||
        event.type !== "user_message" || event.coopIngressId !== entry.ingressId) continue;
    matched.push(entry);
  }
  if (matched.length !== 1) return {};
  return { coopTopicRef: topicRef, coopIngressId: matched[0].ingressId };
}

function currentExecutionRoute(ctx, source, input) {
  var items = source && Array.isArray(source.history) ? source.history : [];
  var requested = input && input.coopTopicRef && input.coopTopicRef.topicId;
  // A task-scoped ledger record is durable, exact evidence that the owner
  // admitted this binding. Resolve it before looking at the transient latest
  // Main command: an unscoped follow-up in Main must not overwrite the ingress
  // of independent work that was already admitted for another Thread.
  var ledgerRoute = ledgerImplementationRoute(ctx, source, input);
  if (ledgerRoute && ledgerRoute.coopIngressId) return ledgerRoute;
  var latestIndex = latestOwnerIngressIndex(items);
  for (var i = items.length - 1; i >= 0; i--) {
    var item = items[i];
    var topicId = item && item.coopTopicRef && item.coopTopicRef.topicId;
    var unscopedMain = isUnscopedMainImplementation(item, i, latestIndex);
    var recoveredRoute = recoveredThreadAdmission.matchesRecoveredRoute(
      source, item, i, requested);
    if (!isImplementationIngress(item) && !isReadOnlyReviewIngress(item, input) &&
        !recoveredRoute) continue;
    if (requested && topicId !== requested &&
        !recoveredRoute && !unscopedMain) continue;
    return { coopTopicRef: input.coopTopicRef || item.coopTopicRef,
      coopIngressId: item.coopIngressId || null };
  }
  // Queue-wide authorization first: it needs the task's own ingress and Thread,
  // so where no exact ledger record applies it is the more specific route. A
  // named approval covers work that has neither.
  var queued = queueExecutionRoute(ctx, source, input);
  if (queued && queued.coopIngressId) return queued;
  return approvalExecutionRoute(ctx, source, input);
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
  // Checked here, after the local-project-coordinator branch above: that path
  // is legitimately reached with a partial field set and must not be refused.
  // From this point a typed cross-project binding is unavoidable.
  var problem = projectExecutionInputProblem(input);
  if (problem) return { ok: false, error: problem };
  var classified = Object.assign({}, input);
  var role = controlRole.forExecution(input);
  if (controlRole.isPeer(role)) classified.controlRole = role;
  if (readOnlyReviewAdmission.isReadOnlyPlanningReview(input)) classified.reviewOnly = true;
  return ctx.createProjectExecution(Object.assign({}, classified,
    currentExecutionRoute(ctx, source, classified), {
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
  projectExecutionInputProblem: projectExecutionInputProblem,
};
