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
var ownerRequestsModule = require("./coop-owner-requests");
var ownerEventResolution = require("./coop-owner-event-resolution");
var autonomyGrant = require("./coop-autonomy-grant");

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

// Mints the owner Thread an authorizing owner turn needs to be dispatchable.
//
// Two routes reach the admission gate with execution authority but no container
// to record it against: a named backlog approval, and an implementation command
// typed straight into Main. The gate cannot proceed without a TopicRef, so the
// Thread is minted deterministically against the owner turn that authorized the
// work -- a retry resolves the same Thread rather than a second container.
//
// This grants no authority of its own. The gate re-derives the owner decision
// independently on both paths; the Thread is only the container that decision is
// recorded against. Minting stays pre-dispatch on purpose, because admission must
// not mutate durable owner state while it is still deciding.
//
// Returns { topicRef } on success, or { code } naming why the Thread could not be
// minted. The refusal code is worth carrying: ensureOwnerThread declines a Thread
// the owner has closed (owner_thread_closed) and one whose derived id is already
// occupied by something else (owner_thread_identity_conflict), and swallowing that
// reported the generic thread_ref_required instead -- the same misdiagnosis class
// that already sent an operator hunting a Thread-minting gap for two days.
function ownerThreadRefFor(ctx, input, ingressId) {
  var projectRef = requestedProject(input);
  if (!ingressId || !projectRef || typeof ctx.ensureOwnerThread !== "function") return {};
  var thread = ctx.ensureOwnerThread({
    ingressId: ingressId,
    projectRef: projectRef,
    title: input && input.title,
  });
  if (thread && thread.ok && thread.topicRef) return { topicRef: thread.topicRef };
  return { code: thread && thread.code ? String(thread.code) : "owner_thread_unavailable" };
}

// The named-approval sibling of queueExecutionRoute. Derived server-side from
// the canonical session history for the same reason: a caller must never be able
// to hand us the linkage it wants believed. coopApprovalIngressId is therefore
// not an MCP input, exactly like coopAuthorizationIngressId.
//
// The approval turn also supplies the Thread, via ownerThreadRefFor above:
// approved backlog work has no owner ingress of its own to hang one on.
function approvalExecutionRoute(ctx, source, input) {
  var history = source && Array.isArray(source.history) ? source.history : [];
  var matched = itemApproval.approvalEventForTask(history, input, leadEventsFor(ctx));
  var approval = matched && matched.event;
  if (!approval || !approval.coopIngressId) return {};
  var route = { coopApprovalIngressId: approval.coopIngressId };
  if (input && input.coopTopicRef) return route;
  var minted = ownerThreadRefFor(ctx, input, approval.coopIngressId);
  if (minted.topicRef) route.coopTopicRef = minted.topicRef;
  else if (minted.code) route.coopThreadMintRefusal = minted.code;
  return route;
}

// A foreground owner turn may be classified after it was written to history.
// In that case the durable owner-request record is the authority on its
// implementation decision, while the original event remains the authority on
// who said it. Do not accept a caller-provided ingress: recover it only when
// the requested Thread has exactly one executable record whose canonical event
// belongs to this source session AND whose durable scope covers the typed
// project/task/revision. A Thread may legitimately contain several approvals;
// counting before scope filtering hid every one of them.
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
  var candidates = [];
  var matched = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var sessionRef = entry && entry.sessionRef;
    var requestRef = entry && entry.requestRef;
    if (!entry || entry.expectsExecution !== true || !entry.implementationDecision ||
        !sessionRef || !requestRef || sessionRef.projectId !== projectId ||
        sessionRef.sessionStorageId !== sourceId || requestRef.projectId !== projectId ||
        requestRef.sessionStorageId !== sourceId) continue;
    var event = Number.isInteger(requestRef.eventIndex) && requestRef.eventIndex >= 0 ?
      history[requestRef.eventIndex] : null;
    if (!event || event.type !== "user_message" ||
        event.coopIngressId !== entry.ingressId) {
      event = ownerEventResolution.resolveByIngressId(history, entry.ingressId);
    }
    if (!event || event.type !== "user_message" ||
        event.coopIngressId !== entry.ingressId) continue;
    candidates.push(entry);
    var coveringScope = scopeCoveringInput(ownerRequestsModule.implementationScopesFor(entry), input);
    if (coveringScope) matched.push({ entry: entry, scope: coveringScope });
  }
  if (matched.length === 1) {
    return { coopTopicRef: topicRef || matched[0].scope.topicRef,
      coopIngressId: matched[0].entry.ingressId };
  }
  if (matched.length > 1) return {};
  // First-dispatch classifications have no implementationScope yet. Preserve
  // that path only when the Thread contains exactly one executable candidate;
  // once there are several, choosing an unscoped record would be arbitrary.
  if (candidates.length === 1 && !ownerRequestsModule.implementationScopesFor(candidates[0]).length) {
    return { coopTopicRef: topicRef, coopIngressId: candidates[0].ingressId };
  }
  return {};
}

function ownerRequestScopes(ctx, ingressId) {
  var ledger = ctx.ownerRequests || ownerRequestsModule.getDefaultOwnerRequests();
  if (!ingressId || !ledger || typeof ledger.get !== "function") return null;
  var entry;
  try { entry = ledger.get(ingressId); }
  catch (e) { return null; }
  return entry ? ownerRequestsModule.implementationScopesFor(entry) : [];
}

function scopeCoveringInput(scopes, input) {
  var projectRef = requestedProject(input);
  if (!projectRef) return null;
  var list = Array.isArray(scopes) ? scopes : [scopes];
  for (var i = 0; i < list.length; i++) {
    var scope = list[i];
    if (!scope) continue;
    var requestedScope = {
      projectRef: projectRef,
      // An unscoped router candidate proposes its own durable Thread; admission
      // still rechecks that exact TopicRef and the lower ledger writer refuses a
      // cross-Thread mutation. A caller-supplied Thread remains authoritative.
      topicRef: input && input.coopTopicRef || scope.topicRef,
      portfolioTaskId: String(input && input.portfolioTaskId || ""),
      bindingRevision: Number(input && input.bindingRevision),
    };
    var exact = !!(scope.projectRef &&
      scope.projectRef.projectId === requestedScope.projectRef.projectId &&
      String(scope.portfolioTaskId) === requestedScope.portfolioTaskId &&
      Number(scope.bindingRevision) === requestedScope.bindingRevision);
    if (exact || ownerRequestsModule.carryForwardEligible(scope, requestedScope)) return scope;
  }
  return null;
}

function scopeCoversInput(scopes, input) {
  return !!scopeCoveringInput(scopes, input);
}

// A dispatch that names no Thread used to adopt whatever implementation ingress
// sat latest in history, because the topic filter in the scan below is guarded
// by `requested` and simply switches off when nothing was requested.
//
// Measured against live state on 2026-08-19: a dispatch of
// webapp-automation-policy-board-exclusions rev2 into project b0c9b7a0 adopted
// owner ingress 482 ("FIX!"), a turn about project 5332aafc whose owner-request
// record was already scoped to clay-thread-followup-resolution-fix rev1. That
// event carries no TopicRef, so the admission gate answered thread_ref_required
// and an operator spent two days hunting a Thread-minting gap. Worse, because
// the scan returns as soon as it matches, the hijack shadowed
// queueExecutionRoute and approvalExecutionRoute -- the only routes that can
// supply a Thread for approved backlog work -- so the minting path was
// unreachable for every unscoped dispatch.
//
// An unscoped dispatch may therefore only adopt an owner turn that provably
// covers the requested work: either the owner's most recent turn (they just
// spoke, and admitUnscopedMainImplementation re-derives that independently), or
// a turn whose durable owner-request scope names this exact project and task, at
// next binding revision after one it can carry forward from. When the
// scope covers the work, its TopicRef is the Thread the owner's own turn already
// owns, so route it rather than dropping it -- nothing is minted here.
//
// Against the pre-narrowing behaviour this is tighter in every dimension EXCEPT
// the binding revision, where it is deliberately WIDER: a scope pinned to
// revision R also covers the same project's same task at revision R + 1. An
// earlier version of this comment claimed the whole function
// was "strictly narrower ... it can only reduce what the router proposes". That
// is no longer true and must not be relied on.
//
// The widening is what makes the approval carry-forward reachable at all. An
// approval is spent on a task AT A REVISION, so a retry after a failure arrives
// with a bumped revision. Under exact revision equality the router produced an
// EMPTY route for that retry, and implementationAdmission bailed on the missing
// Thread long before reaching approvalCarriesForward -- so the rule shipped in
// a8500b9a3a was correct logic behind a gate that never opened. Measured live on
// 2026-08-19 with that commit already landed: a real board-exclusions rev2
// dispatch still failed `owner_implementation_decision_required`.
//
// Why widening HERE is nonetheless safe, precisely:
//
//   The router only PROPOSES. It hands admission an ingress and a Thread to look
//   at; it grants nothing. implementationAdmission re-derives every authorization
//   independently -- from the durable owner-request record, the canonical Coop
//   event and the binding store -- and it owns the carry-forward decision
//   outright, including the two conditions this module cannot see: that the
//   exact approved binding failed, and that no matching scope completed at or
//   after the approval. A route the carry-forward has not earned is still refused
//   there with `owner_implementation_scope_mismatch`.
//
//   So the widening changes which owner turn admission is asked ABOUT, never
//   whether the answer is yes. It cannot widen authority; it can only stop the
//   router from hiding a candidate admission was already equipped to judge and
//   refuse. The proof is a routed dispatch that is still refused, which is
//   asserted in test/coop-owner-approval-carry-forward-admission.test.js: the router
//   proposes an ever-completed task's owner turn and admission kills it.
//
//   Do NOT reach for the live pair as that proof. On live state board-exclusions
//   rev1 `failed` carries forward to rev2 through here, but clay-voice rev3 is
//   refused EARLIER and never reaches this check at all -- its owner turn `:479`
//   is a question, carries no coopImplementationDecision, and so fails
//   isImplementationIngress at every revision. The live pair shows the fix works;
//   it does not exercise the timestamped same-scope completion guard.
//
// The identity-and-monotonicity half of the rule is NOT reimplemented here. It is
// `ownerRequestsModule.carryForwardEligible` -- the same next-revision predicate
// `scopeImplementation` enforces before it will replace a durable scope -- so the
// router and the ledger cannot drift apart on what "the same work, later" means.
function unscopedIngressCoverage(ctx, item, input, index, latestIndex) {
  if (index === latestIndex) return { ok: true, topicRef: null };
  var scope = scopeCoveringInput(ownerRequestScopes(ctx, item && item.coopIngressId), input);
  if (!scopeCoversInput(scope, input)) {
    return { ok: false, topicRef: null };
  }
  return { ok: true, topicRef: scope.topicRef || null };
}

// The last route, and the only one with no owner turn behind it at all.
//
// A standing grant in scoped-autonomy-policy.json authorizes a CATEGORY of work
// in named projects ahead of time, so by construction there is no ingress to
// hang a Thread on. But implementationAdmission demands a Thread on its first
// line and only reaches autonomyGrant.standingAdmission much later, through the
// deliberate gap in itemApproval.executionAdmission -- and the only thing that
// ever mints a Thread is an owner turn that parses as an implementation
// decision. So the grant was unreachable for precisely the dispatches it was
// written for. Measured live on 2026-08-22: three read-only diagnosis dispatches
// into an allowlisted project were refused owner_implementation_decision_required
// while standingAdmission, asked directly with the same inputs, answered ok.
//
// Two properties keep this from widening authority:
//
//   The Thread is a CONTAINER, not authority. This function proposes one; it
//   grants nothing. implementationAdmission re-derives the grant independently
//   from the same policy file, so a route proposed here is still refused there
//   unless the policy really covers the dispatch -- the same propose/decide
//   split every route above relies on.
//
//   OFF stays byte-identical to no module at all, which is property 1 of
//   coop-autonomy-grant. Switch off, project not allowlisted, or shape not
//   read-only all return null from standingAdmission, and then this returns the
//   empty route the caller already had. A `{ ok: false }` gated-action refusal is
//   also treated as no route: reporting it from the router would let a policy
//   read speak before admission has been consulted at all.
//
// Only read_only_diagnosis can ever route here, and that is structural rather
// than a choice: approved_revision_bump resolves its prior scope by TopicRef,
// and the whole point of this branch is that no TopicRef exists yet.
function standingGrantExecutionRoute(ctx, input) {
  var projectRef = requestedProject(input);
  var taskId = String(input && input.portfolioTaskId || "").trim();
  if (!projectRef || !taskId) return {};
  var admitted;
  try {
    admitted = autonomyGrant.standingAdmission(input, {
      targetProject: projectRef,
      portfolioTaskId: taskId,
      bindingRevision: Number(input && input.bindingRevision),
      coopTopicRef: null,
    }, {
      ownerRequests: ctx.ownerRequests || ownerRequestsModule.getDefaultOwnerRequests(),
      // Undefined in production, where the grant reads its own repo-root file.
      // Present only so a test can point this seam and the admission seam at
      // the same temporary policy without mutating the shipped switch.
      autonomyPolicyFile: ctx.autonomyPolicyFile,
    });
  } catch (error) {
    return {};
  }
  if (!admitted || admitted.ok !== true) return {};
  // Keyed on the task, not on a turn: a standing grant has no turn, and a
  // per-turn key would mint a fresh container on every retry of the same work.
  // The "grant:" prefix cannot collide with a "coop:"-prefixed owner ingress, and
  // it is what the Thread's provenance record stores, so an auditor reading the
  // Thread can see it was minted by policy rather than by an owner turn.
  var minted = ownerThreadRefFor(ctx, input, "grant:" + taskId);
  if (minted.topicRef) return { coopTopicRef: minted.topicRef };
  return minted.code ? { coopThreadMintRefusal: minted.code } : {};
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
    if (!isImplementationIngress(item) && !isReadOnlyReviewIngress(item, input)) continue;
    if (requested && topicId !== requested && !unscopedMain) continue;
    var coverage = null;
    if (!requested && isImplementationIngress(item)) {
      coverage = unscopedIngressCoverage(ctx, item, input, i, latestIndex);
      if (!coverage.ok) continue;
    }
    var routedTopicRef = input.coopTopicRef || item.coopTopicRef;
    if (!routedTopicRef && coverage && coverage.topicRef) {
      routedTopicRef = coverage.topicRef;
    }
    // Narrowing the scan above unshadowed approvalExecutionRoute for approved
    // backlog work, but one shape still reaches here with authority and no
    // container: an implementation command typed straight into Main. Its own turn
    // carries no TopicRef and, on a first dispatch, there is no durable scope to
    // borrow one from -- so coverage returns ok with a null Thread, the route
    // reports the ingress alone, and the gate answers thread_ref_required
    // forever. admitUnscopedMainImplementation exists for exactly this case but
    // needs a TopicRef the owner's Main turn cannot supply. Mint it here.
    //
    // Deliberately not gated on isUnscopedMainImplementation. That predicate also
    // requires the command to still be the newest owner turn, which would make
    // the Thread evaporate as soon as the owner typed anything else and send the
    // same work straight back to thread_ref_required. The coverage check above is
    // the real guard: an item that does not provably cover this work never gets
    // here. Minting is deterministic per (ingress, project), so a later dispatch
    // of the same work resolves the same Thread instead of a second container.
    //
    // This widens no authority. The gate re-derives the owner decision from the
    // durable record and the canonical event and refuses on its own terms.
    var composerScope = item && item.coopComposerScope;
    var mintRefusal = null;
    if (!routedTopicRef && item.coopIngressId && isImplementationIngress(item) &&
        (composerScope === "main" || composerScope === "canonical")) {
      var minted = ownerThreadRefFor(ctx, input, item.coopIngressId);
      if (minted.topicRef) routedTopicRef = minted.topicRef;
      else mintRefusal = minted.code || null;
    }
    var route = { coopTopicRef: routedTopicRef,
      coopIngressId: item.coopIngressId || null };
    // Only present when a mint was actually attempted and refused. Always
    // emitting the key would overwrite a caller's value with null on this branch
    // while leaving it alone on the queued and approval branches.
    if (mintRefusal) route.coopThreadMintRefusal = mintRefusal;
    return route;
  }
  // Queue-wide authorization first: it needs the task's own ingress and Thread,
  // so where no exact ledger record applies it is the more specific route. A
  // named approval covers work that has neither.
  var queued = queueExecutionRoute(ctx, source, input);
  if (queued && queued.coopIngressId) return queued;
  var approved = approvalExecutionRoute(ctx, source, input);
  if (approved && (approved.coopApprovalIngressId || approved.coopTopicRef)) return approved;
  return standingGrantExecutionRoute(ctx, input);
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
