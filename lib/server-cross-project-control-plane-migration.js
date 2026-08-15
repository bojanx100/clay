// Typed control-plane migration for legacy project-coordinator bindings.
//
// Coop's dispatch and steering guards refuse a project_coordinator binding
// whose durable authority is not a Coop-resident control-plane session
// (`projectId: system-lead`). Legacy bindings created before the control plane
// existed -- and pre-task records stranded by a failed staffing attempt --
// therefore fail with control_plane_migration_required while nothing could
// repair them. This module is that repair: a canonical, typed, fail-closed
// operation that converts ONE exact verified binding revision to a
// Coop-resident control-plane binding without duplicating coordinators,
// tasks, claims, sessions, or fan-in events, and without rewriting immutable
// terminal history.
var projectIdentity = require("./project-identity");
var portfolioBindings = require("./portfolio-execution-bindings");
var coopControlPlane = require("./coop-control-plane");
var isCoopControlled = require("./coop-control-provenance").isCoopControlled;

// Statuses a migration may convert. Everything else is immutable history
// (completed/failed/superseded/cancelled) or has no governed session left
// (deleted) and is refused, never rewritten.
var MIGRATABLE_STATUS = { pending: true, active: true, unavailable: true, unrouted: true };

function sameRef(left, right) {
  return portfolioBindings.sameSessionRef(
    projectIdentity.normalizeSessionRef(left),
    projectIdentity.normalizeSessionRef(right));
}

function createControlPlaneBindingMigration(deps) {
  var bindingStore = deps.bindingStore;
  var ownerRequests = deps.ownerRequests || null;

  function latestBindingRevision(portfolioTaskId) {
    var list = bindingStore.list();
    var latest = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].portfolioTaskId === portfolioTaskId &&
          list[i].bindingRevision > latest) latest = list[i].bindingRevision;
    }
    return latest;
  }

  // The prior binding identity this migration replaces. A routed legacy
  // binding names its own project-local coordinator authority; a pre-task
  // record (unrouted reservation that never produced a task) inherits the
  // latest earlier revision that ever carried one; a task with no routed
  // history has no prior at all. The caller must declare EXACTLY this value.
  function derivedPriorCoordinator(binding) {
    if (binding.projectCoordinator) {
      return projectIdentity.normalizeSessionRef(binding.projectCoordinator);
    }
    var list = bindingStore.list();
    var prior = null;
    for (var i = 0; i < list.length; i++) {
      var candidate = list[i];
      if (candidate.portfolioTaskId !== binding.portfolioTaskId ||
          candidate.bindingRevision >= binding.bindingRevision ||
          !candidate.projectCoordinator) continue;
      if (!prior || candidate.bindingRevision > prior.bindingRevision) prior = candidate;
    }
    return prior ? projectIdentity.normalizeSessionRef(prior.projectCoordinator) : null;
  }

  function claimInfrastructureMissing(binding) {
    if (!binding.coopTopicRef) return false;
    return !ownerRequests ||
      typeof ownerRequests.canonicalCoordinator !== "function" ||
      typeof ownerRequests.canonicalProjectCoordinator !== "function" ||
      typeof ownerRequests.transferCoordinator !== "function";
  }

  // One canonical coordinator per (topic, project) and per project. A claim
  // held by anything that is neither the declared prior nor the control-plane
  // root means a rival coordinator is active; converting the binding under it
  // would create the second coordinator the claim table exists to prevent.
  function ambiguousCoordinatorClaim(binding, prior, rootRef) {
    if (!ownerRequests) return null;
    var claims = [];
    try {
      if (binding.coopTopicRef && typeof ownerRequests.canonicalCoordinator === "function") {
        claims.push(ownerRequests.canonicalCoordinator(binding.coopTopicRef, binding.targetProject));
      }
      if (typeof ownerRequests.canonicalProjectCoordinator === "function") {
        claims.push(ownerRequests.canonicalProjectCoordinator(binding.targetProject));
      }
    } catch (e) {
      return { ok: false, reason: "coordinator_claim_unavailable" };
    }
    for (var i = 0; i < claims.length; i++) {
      var claim = projectIdentity.normalizeSessionRef(claims[i]);
      if (!claim) continue;
      if ((rootRef && sameRef(claim, rootRef)) || (prior && sameRef(claim, prior))) continue;
      return { ok: false, reason: "ambiguous_active_coordinator", coordinator: claim };
    }
    return null;
  }

  // Sessions the owner opened directly are direct owner sessions. A migration
  // must never adopt, reroute, or place one under Coop, so any live session
  // this binding would govern has to prove Coop provenance first.
  function ownerDirectSession(binding, prior, targetManager) {
    if (prior && prior.projectId === binding.targetProject.projectId) {
      var priorSession = portfolioBindings.sessionByRef(targetManager, prior,
        binding.targetProject.projectId);
      if (priorSession && !isCoopControlled(priorSession)) return true;
    }
    if (!binding.coordinator) return false;
    var session = portfolioBindings.sessionByRef(targetManager, binding.coordinator,
      binding.targetProject.projectId);
    if (!session) return false;
    var metadata = portfolioBindings.sessionExecutionBinding(session);
    var boundHere = !!metadata && metadata.portfolioTaskId === binding.portfolioTaskId &&
      metadata.bindingRevision === binding.bindingRevision;
    return !boundHere && !isCoopControlled(session);
  }

  // The claim moves BEFORE the binding is rewritten so a persistence failure
  // afterwards leaves a retryable state: the retry sees the claim already at
  // the root, skips the transfer, and re-attempts only the binding write.
  function transferClaimToRoot(binding, prior, rootRef) {
    if (!binding.coopTopicRef || !prior || sameRef(prior, rootRef)) return { ok: true };
    var current;
    try {
      current = projectIdentity.normalizeSessionRef(
        ownerRequests.canonicalCoordinator(binding.coopTopicRef, binding.targetProject));
    } catch (e) {
      return { ok: false, reason: "coordinator_claim_unavailable" };
    }
    if (!current || sameRef(current, rootRef)) return { ok: true };
    var transferred = ownerRequests.transferCoordinator({
      topicRef: binding.coopTopicRef,
      projectRef: binding.targetProject,
      from: prior,
      to: rootRef,
      reason: "control_plane_binding_migration",
    });
    if (!transferred || transferred.ok !== true) {
      return { ok: false, reason: transferred && transferred.reason || "coordinator_transfer_failed" };
    }
    return { ok: true };
  }

  // Links a routed legacy binding into the control-plane root's task graph
  // and repoints the live task coordinator session, all idempotently: the
  // task is found by its stable clientRef, bindTask runs only when the task
  // is not already bound to this exact session, and session fields are only
  // written when they actually change. A retry therefore appends no second
  // task, session, or fan-in event.
  function linkControlPlaneTask(leadManager, root, rootRef, binding, targetManager) {
    if (!binding.coordinator) return { ok: true };
    var task = coopControlPlane.taskForRequest(root, binding);
    if (!task) {
      task = coopControlPlane.prepareTask(leadManager, root, binding, {
        title: binding.portfolioTaskId,
        objective: "Migrated legacy project-coordinator execution",
        context: "",
      });
    }
    if (!task) return { ok: false, reason: "control_plane_task_link_failed" };
    if (!sameRef(task.workerSessionRef, binding.coordinator) &&
        !coopControlPlane.bindTask(leadManager, root, task, binding.coordinator)) {
      return { ok: false, reason: "control_plane_task_link_failed" };
    }
    var child = portfolioBindings.sessionByRef(targetManager, binding.coordinator,
      binding.targetProject.projectId);
    if (child) {
      var changed = false;
      if (!sameRef(child.projectCoordinatorRef, rootRef)) {
        child.projectCoordinatorRef = rootRef;
        changed = true;
      }
      var execution = child.orchestrationPolicy && child.orchestrationPolicy.portfolioExecution;
      if (execution && !sameRef(execution.source, rootRef)) {
        execution.source = rootRef;
        changed = true;
      }
      if (changed && typeof targetManager.saveSessionFile === "function") {
        targetManager.saveSessionFile(child, { durable: true });
      }
    }
    return { ok: true };
  }

  function successResult(binding, rootRef, prior) {
    return {
      ok: true,
      migrated: true,
      portfolioTaskId: binding.portfolioTaskId,
      bindingRevision: binding.bindingRevision,
      projectCoordinatorRef: rootRef,
      priorProjectCoordinator: prior || null,
      binding: binding,
    };
  }

  return function migrateControlPlaneBinding(input) {
    var request = input || {};
    var source = projectIdentity.normalizeSessionRef(request.source);
    var targetProject = projectIdentity.normalizeProjectRef(request.targetProject);
    var portfolioTaskId = String(request.portfolioTaskId || "").trim();
    var bindingRevision = Number(request.bindingRevision);
    var idempotencyKey = String(request.idempotencyKey || "").trim();
    var declaredPrior = request.priorProjectCoordinator === undefined ||
      request.priorProjectCoordinator === null ? null :
      projectIdentity.normalizeSessionRef(request.priorProjectCoordinator);
    if (request.priorProjectCoordinator && !declaredPrior) {
      return { ok: false, reason: "invalid_prior_binding_identity" };
    }
    if (!source || !targetProject ||
        targetProject.projectId === projectIdentity.LEAD_PROJECT_ID ||
        !portfolioTaskId || !Number.isInteger(bindingRevision) || bindingRevision < 1 ||
        !idempotencyKey) {
      return { ok: false, reason: "invalid_migration" };
    }
    var canonical = deps.coopSessionRef();
    if (!canonical || !sameRef(source, canonical)) {
      return { ok: false, reason: "canonical_coop_required" };
    }
    var binding = bindingStore.get(portfolioTaskId, bindingRevision);
    if (!binding) return { ok: false, reason: "binding_not_found" };
    if (binding.mode !== "project_coordinator") return { ok: false, reason: "invalid_migration" };
    if (binding.targetProject.projectId !== targetProject.projectId) {
      return { ok: false, reason: "binding_target_mismatch" };
    }
    var targetContext = deps.resolveProjectContextById(targetProject.projectId);
    var targetManager = deps.sessionManagerForContext(targetContext);
    if (!targetContext || !targetManager) return { ok: false, reason: "project_unavailable" };
    if (typeof deps.canCreateExecution === "function") {
      var admitted = false;
      try { admitted = deps.canCreateExecution(request.actor || null, targetContext, binding) === true; }
      catch (e) { admitted = false; }
      if (!admitted) return { ok: false, reason: "access_denied" };
    }
    if (bindingRevision < latestBindingRevision(portfolioTaskId)) {
      return { ok: false, reason: "stale_binding_revision" };
    }
    // Byte-stable replay: the binding is already Coop-resident. The exact
    // operation that converted it may repeat freely -- even after the binding
    // later reached a terminal state -- because a replay writes nothing.
    // Anything else conflicts.
    if (binding.projectCoordinator &&
        binding.projectCoordinator.projectId === projectIdentity.LEAD_PROJECT_ID) {
      var evidence = binding.controlPlaneMigration || null;
      if (!evidence) {
        return Object.assign(successResult(binding,
          projectIdentity.normalizeSessionRef(binding.projectCoordinator), null), {
          migrated: false,
          alreadyControlPlane: true,
        });
      }
      if (evidence.idempotencyKey !== idempotencyKey) {
        return { ok: false, reason: "idempotency_conflict" };
      }
      if (!!declaredPrior !== !!evidence.from ||
          (declaredPrior && !sameRef(declaredPrior, evidence.from))) {
        return { ok: false, reason: "prior_binding_mismatch" };
      }
      return successResult(binding,
        projectIdentity.normalizeSessionRef(binding.projectCoordinator), evidence.from);
    }
    if (!MIGRATABLE_STATUS[String(binding.status || "")]) {
      return { ok: false, reason: "binding_terminal" };
    }
    var prior = derivedPriorCoordinator(binding);
    if (!!declaredPrior !== !!prior || (declaredPrior && !sameRef(declaredPrior, prior))) {
      return { ok: false, reason: "prior_binding_mismatch", expected: prior };
    }
    if (claimInfrastructureMissing(binding)) {
      return { ok: false, reason: "coordinator_claim_unavailable" };
    }
    var lead = deps.resolveProjectContextById(projectIdentity.LEAD_PROJECT_ID);
    var leadManager = deps.sessionManagerForContext(lead);
    var coopSession = deps.canonicalCoopSession();
    if (!leadManager || !coopSession) {
      return { ok: false, reason: "coop_control_plane_unavailable" };
    }
    // Ambiguity is judged BEFORE any write, against the root that already
    // exists. A missing root is unambiguous: it will be created fresh.
    var existingRoot = coopControlPlane.projectCoordinatorFor(leadManager, targetProject);
    var existingRootRef = projectIdentity.sessionRef(
      { projectId: projectIdentity.LEAD_PROJECT_ID }, existingRoot);
    var ambiguous = ambiguousCoordinatorClaim(binding, prior, existingRootRef);
    if (ambiguous) return ambiguous;
    if (ownerDirectSession(binding, prior, targetManager)) {
      return { ok: false, reason: "owner_direct_session" };
    }
    var root = coopControlPlane.ensureProjectCoordinator(leadManager, targetProject,
      deps.projectTitle(targetContext), canonical);
    var rootRef = projectIdentity.sessionRef(
      { projectId: projectIdentity.LEAD_PROJECT_ID }, root);
    var policy = coopControlPlane.projectCoordinatorPolicy(root);
    if (!rootRef || !policy || !policy.projectRef ||
        policy.projectRef.projectId !== targetProject.projectId) {
      return { ok: false, reason: "project_coordinator_authority_mismatch" };
    }
    var transferred = transferClaimToRoot(binding, prior, rootRef);
    if (!transferred.ok) return transferred;
    var linked = linkControlPlaneTask(leadManager, root, rootRef, binding, targetManager);
    if (!linked.ok) return linked;
    var adopted = bindingStore.adoptControlPlaneCoordinator(portfolioTaskId, bindingRevision, {
      to: rootRef,
      from: prior,
      idempotencyKey: idempotencyKey,
    });
    if (!adopted.ok) return adopted;
    if (typeof deps.reconcileSessionLedger === "function") deps.reconcileSessionLedger();
    return successResult(adopted.binding, rootRef, prior);
  };
}

module.exports = {
  createControlPlaneBindingMigration: createControlPlaneBindingMigration,
};
