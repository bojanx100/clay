// Daemon-level cross-project router.
//
// `deliver()` is the Slice 3 text compatibility adapter. New callers use the
// durable typed envelope API, which resolves ProjectRef/SessionRef identity
// rather than a mutable slug or runtime local id.
var crypto = require("crypto");
var path = require("path");
var recoveryLog = require("./recovery-log");
var createDurableDelivery = require("./cross-project-delivery").createDurableDelivery;
var projectIdentity = require("./project-identity");
var serverLead = require("./server-lead");
var portfolioBindings = require("./portfolio-execution-bindings");
var createPortfolioExecutionBindings = portfolioBindings.createPortfolioExecutionBindings;
var coopSessionLedgerModule = require("./coop-session-ledger");
var attachCoopSessionLedger = coopSessionLedgerModule.attachCoopSessionLedger;
var createCrossProjectProviderSwitch =
  require("./server-cross-project-provider-switch").createCrossProjectProviderSwitch;

var EXECUTION_SCHEMA = "clay.project_execution_command";
var EXECUTION_VERSION = 1;

function createCrossProjectRouter(opts) {
  var options = opts || {};
  var getProjectContext = options.getProjectContext || function () { return null; };
  var getProjectContextById = options.getProjectContextById || function (projectId) {
    return getProjectContext(projectId);
  };
  var recordRecoveryEvent = typeof options.recordRecoveryEvent === "function"
    ? options.recordRecoveryEvent : recoveryLog.recordCrossProjectDeadLetter;
  var bindingStore = options.bindingStore || createPortfolioExecutionBindings({
    file: options.bindingFile,
    fs: options.fs,
    now: options.now,
  });
  var sessionLedgerFile = options.sessionLedgerFile || (options.bindingFile ?
    path.join(path.dirname(options.bindingFile), "coop-session-ledger.json") : null);
  var sessionLedger = options.sessionLedger || attachCoopSessionLedger({
    file: sessionLedgerFile,
    fs: options.fs,
    now: options.now,
  });
  // The owner-request ledger owns one-canonical-coordinator-per-(topic,
  // project). Injected like the stores above; absent means the rule is not
  // enforced here, which is the pre-existing behaviour for callers that carry
  // no TopicRef at all.
  var ownerRequests = options.ownerRequests || null;
  var sessionLedgerTopicLinks = [];
  var registeredProjectResolvers = [];

  function resolveProjectContextById(projectId) {
    var resolved = getProjectContextById(projectId);
    if (resolved) return resolved;
    for (var i = 0; i < registeredProjectResolvers.length; i++) {
      var candidate = registeredProjectResolvers[i];
      if (candidate.getProjectId() === projectId) return candidate;
    }
    return null;
  }

  function registerProjectResolver(resolver) {
    if (!resolver || typeof resolver.getProjectId !== "function") return function () {};
    registeredProjectResolvers.push(resolver);
    reconcileStrandedCompletions();
    reconcileSessionLedger();
    return function () {
      var removedProjectId = resolver.getProjectId();
      var index = registeredProjectResolvers.indexOf(resolver);
      if (index !== -1) registeredProjectResolvers.splice(index, 1);
      if (projectIdentity.isProjectId(removedProjectId)) {
        reconcileSessionLedger({ absentProjectRefs: [{ projectId: removedProjectId }] });
      }
    };
  }

  function sessionManagerForContext(context) {
    if (!context) return null;
    return typeof context.getSessionManager === "function" ? context.getSessionManager() : context.sm || null;
  }

  function sessionForBinding(binding) {
    var record = binding || {};
    var context = record.targetProject && resolveProjectContextById(record.targetProject.projectId);
    var manager = sessionManagerForContext(context);
    return portfolioBindings.executionSessionForBinding(manager, record);
  }

  function saveBindingSession(binding, session) {
    var record = binding || {};
    var context = record.targetProject && resolveProjectContextById(record.targetProject.projectId);
    var manager = sessionManagerForContext(context);
    if (manager && typeof manager.saveSessionFile === "function") manager.saveSessionFile(session);
  }

  // The binding store is initialized before projects finish restoring their
  // sessions. Re-run its existing reconciliation whenever a project becomes
  // resolvable, so an active projection cannot outlive a hidden completed
  // coordinator after daemon restart.
  function reconcileStrandedCompletions() {
    if (!bindingStore || typeof bindingStore.reconcileStrandedCompletions !== "function") return;
    bindingStore.reconcileStrandedCompletions({
      sessionForBinding: sessionForBinding,
      saveSession: saveBindingSession,
    });
  }

  function sessionLedgerProjects() {
    var projects = [];
    var seen = {};
    for (var i = 0; i < registeredProjectResolvers.length; i++) {
      var resolver = registeredProjectResolvers[i];
      var projectId = resolver && resolver.getProjectId();
      var manager = sessionManagerForContext(resolver);
      if (!projectIdentity.isProjectId(projectId) || seen[projectId] || !manager) continue;
      seen[projectId] = true;
      projects.push({
        projectRef: { projectId: projectId },
        sessions: manager.sessions,
      });
    }
    return projects;
  }

  // Reconciliation is safe at every lifecycle edge: its output is derived
  // solely from binding records, restored live sessions, and reference-only
  // Topic links, and the registry writes only when that normalized output
  // changes. Historical bindings therefore backfill automatically at boot.
  function reconcileSessionLedger(input) {
    var details = input || {};
    if (Object.prototype.hasOwnProperty.call(details, "topicLinks")) {
      sessionLedgerTopicLinks = Array.isArray(details.topicLinks) ? details.topicLinks.slice() : [];
    }
    var projects = sessionLedgerProjects();
    var absent = Array.isArray(details.absentProjectRefs) ? details.absentProjectRefs : [];
    for (var i = 0; i < absent.length; i++) {
      var absentRef = projectIdentity.normalizeProjectRef(absent[i]);
      if (absentRef) projects.push({ projectRef: absentRef, sessions: [] });
    }
    return sessionLedger.reconcile({
      bindings: bindingStore.list(),
      projects: projects,
      topicLinks: sessionLedgerTopicLinks,
    });
  }

  function queryCoopSessions(input) {
    var query = input || {};
    var reconciled = reconcileSessionLedger(query);
    if (!reconciled.ok) return { ok: false, reason: reconciled.reason, sessions: [] };
    return {
      ok: true,
      sessions: sessionLedger.list({
        projectRefs: query.projectRefs,
        includeHidden: query.includeHidden === true,
        includeMissing: query.includeMissing === true,
        topLevelOnly: query.topLevelOnly !== false,
      }),
    };
  }

  function topicSessionEvidence(topicRef, metadata, input) {
    var reconciled = reconcileSessionLedger(input);
    return reconciled.ok ? sessionLedger.topicEvidence(topicRef, metadata) : [];
  }

  function topicCleanupCandidates(topicRef, input) {
    var reconciled = reconcileSessionLedger(input);
    return reconciled.ok ? sessionLedger.cleanupCandidates(topicRef) : [];
  }

  // The CANONICAL LIVE Coop SessionRef, or null.
  //
  // Admission must be attributed to the real Coop conversation so the resulting
  // execution joins Coop's task graph and gets normal visible fan-in and
  // closure. A synthetic Lead ref would type-check and produce orphaned
  // bindings, so this returns null rather than inventing one — and it lives
  // here because the router is the only thing that can see across projects; a
  // project-local controller cannot and must not resolve Coop's identity.
  function coopSessionRef() {
    var lead = resolveProjectContextById(projectIdentity.LEAD_PROJECT_ID);
    var sm = lead && (typeof lead.getSessionManager === "function" ?
      lead.getSessionManager() : lead.sm);
    if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return null;
    var found = null;
    sm.sessions.forEach(function (session) {
      if (found || !session || session.coopHome !== true) return;
      var ref = projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, session);
      if (ref) found = ref;
    });
    return found;
  }

  function executionTarget(request) {
    var context = resolveProjectContextById(request.targetProject.projectId);
    if (!context) return { ok: false, reason: "project_unavailable" };
    if (typeof context.deliverCrossProjectEnvelope !== "function") {
      return { ok: false, reason: "target_not_capable" };
    }
    return { ok: true, context: context };
  }

  function authorizedExecution(input, request, context) {
    var source = projectIdentity.normalizeSessionRef(input && input.source);
    if (!source || source.projectId !== projectIdentity.LEAD_PROJECT_ID ||
        request.targetProject.projectId === projectIdentity.LEAD_PROJECT_ID) return false;
    if (typeof options.canCreateExecution === "function") {
      try { return options.canCreateExecution(input.actor || null, context, request) === true; }
      catch (e) { return false; }
    }
    return true;
  }

  function executionEnvelope(input, request, type, destinationRef) {
    var payload = Object.assign({}, input, request, { type: type });
    delete payload.actor;
    delete payload.source;
    delete payload._promotionReady;
    return {
      schema: EXECUTION_SCHEMA,
      schemaVersion: EXECUTION_VERSION,
      eventId: request.idempotencyKey,
      source: projectIdentity.normalizeSessionRef(input.source),
      destination: destinationRef || {
        projectId: request.targetProject.projectId,
        sessionStorageId: "project-execution-control",
      },
      bindingRevision: request.bindingRevision,
      createdAt: typeof input.createdAt === "number" ? input.createdAt :
        (options.now || Date.now)(),
      payload: payload,
    };
  }

  function deliverExecutionCommand(target, envelope) {
    try {
      var result = target.deliverCrossProjectEnvelope(envelope);
      if (result === true) return { ok: true };
      return result && typeof result === "object" ? result :
        { ok: false, reason: "delivery_error" };
    } catch (e) {
      return { ok: false, reason: "delivery_error", error: e && e.message || "execution delivery failed" };
    }
  }

  function executionResult(binding, created, targetResult) {
    var ref = binding.mode === "project_coordinator" ? binding.coordinator : binding.worker;
    var result = {
      ok: true,
      skipped: !created,
      reused: !created,
      created: !!created,
      binding: binding,
      mode: binding.mode,
      sessionRef: ref || null,
      sessionStorageId: ref && ref.sessionStorageId || null,
      localSessionId: targetResult && targetResult.localSessionId || null,
    };
    if (binding.mode === "project_coordinator") {
      result.coordinatorSessionId = result.sessionStorageId;
      result.coordinatorRef = ref || null;
    } else {
      result.workerStorageId = result.sessionStorageId;
      result.workerRef = ref || null;
    }
    return result;
  }

  // A binding whose status is terminal-by-failure is not a successful prior
// attempt. attentionAt is deliberately NOT disqualifying on its own: a healthy
// committed execution can legitimately carry an attention mark, and treating
// that as unreplayable broke ordinary promotion replay after a restart.
var REPLAYABLE_STATUS = { active: true, running: true, reviewing: true, completed: true };

function sameCommittedRequest(existing, request) {
  return !!existing && existing.mode === request.mode &&
    existing.idempotencyKey === request.idempotencyKey &&
    existing.targetProject.projectId === request.targetProject.projectId;
}

function matchingCommittedBinding(existing, request) {
  if (!sameCommittedRequest(existing, request)) return null;
  var ref = existing.mode === "project_coordinator" ? existing.coordinator : existing.worker;
  if (!ref || !REPLAYABLE_STATUS[String(existing.status || "")]) return null;
  // A project coordinator's binding is only a valid replay while that
  // coordinator still HOLDS the topic claim it depends on. After a lost race,
  // or a cleanup that could not persist, the binding can look active while the
  // claim went elsewhere -- replaying it then returned ok:true without
  // re-claiming and silently reused the losing coordinator.
  if (!holdsTopicClaim(existing, request)) return null;
  return executionResult(existing, false, null);
}

  function holdsTopicClaim(binding, request) {
    if (binding.mode !== "project_coordinator") return true;
    var topicRef = binding.coopTopicRef || request.coopTopicRef;
    if (!topicRef) return true;
    if (!ownerRequests || typeof ownerRequests.canonicalCoordinator !== "function") return false;
    var canonical;
    try { canonical = ownerRequests.canonicalCoordinator(topicRef, request.targetProject); }
    catch (e) { return false; }
    if (!canonical) return false;
    return canonical.projectId === binding.coordinator.projectId &&
      canonical.sessionStorageId === binding.coordinator.sessionStorageId;
  }

  function claimInfrastructureAvailable(request) {
    if (request.mode !== "project_coordinator" || !request.coopTopicRef) return true;
    return !!ownerRequests && typeof ownerRequests.claimCoordinator === "function" &&
      typeof ownerRequests.canonicalCoordinator === "function";
  }

  function isScopePromotion(input, request, current) {
    if (!current || input._promotionReady || current.mode !== "direct_leaf" ||
        request.mode !== "project_coordinator") return false;
    return input.reason === "scope_expansion" || input.scopeExpansion === true;
  }

  function latestPriorBinding(portfolioTaskId, bindingRevision) {
    if (!bindingStore || typeof bindingStore.list !== "function") return null;
    var list = bindingStore.list();
    var latest = null;
    for (var i = 0; i < list.length; i++) {
      var candidate = list[i];
      if (!candidate || candidate.portfolioTaskId !== portfolioTaskId ||
          candidate.bindingRevision >= bindingRevision) continue;
      if (!latest || candidate.bindingRevision > latest.bindingRevision) latest = candidate;
    }
    return latest;
  }

  function topicCoordinatorConflict(input, request) {
    if (!ownerRequests || request.mode !== "project_coordinator") return null;
    var topicRef = input && (input.coopTopicRef || input.topicRef);
    if (!topicRef) return null;
    var canonical;
    try { canonical = ownerRequests.canonicalCoordinator(topicRef, request.targetProject); }
    catch (e) { return null; }
    if (!canonical) return null;
    // Same work continuing is not a rival. Two shapes of that:
    //   - this exact binding replayed, and
    //   - a later revision of the SAME portfolio task (a scope expansion or
    //     promotion), whose predecessor is the coordinator already claimed.
    // Without the second case the guard wedged every revision after the first:
    // a task widening its own scope on its own topic was refused as if some
    // other work had taken the topic.
    if (claimedBySameTask(request.portfolioTaskId, canonical)) return null;
    return { ok: false, reason: "coordinator_exists", coordinator: canonical };
  }

  // Is the coordinator already claimed for this topic one that THIS portfolio
  // task previously committed? Then the arriving request is the same work,
  // not a competitor for the topic.
  function claimedBySameTask(portfolioTaskId, canonical) {
    var bindings = bindingStore.list();
    for (var i = 0; i < bindings.length; i++) {
      var binding = bindings[i];
      if (binding.portfolioTaskId !== portfolioTaskId) continue;
      var ref = binding.mode === "project_coordinator" ? binding.coordinator : binding.worker;
      if (ref && ref.sessionStorageId === canonical.sessionStorageId) return true;
    }
    return false;
  }

  // Returns the claim verdict rather than swallowing it. The caller has to be
  // able to refuse an execution whose claim never reached disk -- a fire-and
  // -forget claim is indistinguishable from no claim after a restart.
  function claimTopicCoordinator(input, request, sessionRef) {
    if (request.mode !== "project_coordinator") return null;
    var topicRef = request.coopTopicRef;
    if (!topicRef) return null;
    if (!ownerRequests || typeof ownerRequests.claimCoordinator !== "function") {
      return { ok: false, reason: "coordinator_claim_unavailable" };
    }
    try {
      return ownerRequests.claimCoordinator({
        topicRef: topicRef,
        projectRef: request.targetProject,
        coordinator: sessionRef,
        ingressId: input && input.coopIngressId,
      });
    } catch (e) { return { ok: false, reason: "persistence_failed" }; }
  }

  function verifiedTopicClaim(input, request, sessionRef) {
    var claimed = claimTopicCoordinator(input, request, sessionRef);
    if (!claimed || claimed.ok !== true) return claimed;
    if (!holdsTopicClaim({
      mode: "project_coordinator",
      coordinator: sessionRef,
      coopTopicRef: request.coopTopicRef,
    }, request)) {
      return { ok: false, reason: "coordinator_claim_unverified" };
    }
    return claimed;
  }

  function containFailedClaim(request, claimed, extra) {
    var reason = claimed && claimed.reason === "coordinator_exists"
      ? "coordinator_exists" : "coordinator_claim_not_durable";
    var cleanup = typeof bindingStore.markUnavailable === "function"
      ? bindingStore.markUnavailable(request.portfolioTaskId, request.bindingRevision, reason)
      : { ok: false, reason: "binding_cleanup_unavailable" };
    if (!cleanup || cleanup.ok !== true) {
      return bindingAttention(request, reason + ":cleanup_not_durable",
        Object.assign({}, extra || {}, { pending: true }));
    }
    return Object.assign({
      ok: false,
      retryable: true,
      reason: reason,
      coordinator: claimed && claimed.coordinator || null,
    }, extra || {});
  }

  function recoverCommittedCoordinatorClaim(input, request, existing) {
    if (!sameCommittedRequest(existing, request) ||
        existing.mode !== "project_coordinator" ||
        !existing.coordinator || !REPLAYABLE_STATUS[String(existing.status || "")]) return null;
    var claimed = verifiedTopicClaim(input, request, existing.coordinator);
    if (!claimed || claimed.ok !== true) return containFailedClaim(request, claimed);
    return executionResult(existing, false, null);
  }

  function createAndCommitExecution(input, request, target) {
    var reserved = bindingStore.reserve(request);
    if (!reserved.ok) return reserved;
    var envelope = executionEnvelope(input, request, "portfolio_execution_create");
    var delivered = deliverExecutionCommand(target.context, envelope);
    if (!delivered || delivered.ok !== true || !delivered.sessionRef) {
      // Nothing was created, so the reservation must not survive. Leaving it
      // stranded a ghost `pending` binding that blocked every later revision
      // with active_binding_exists while being impossible to terminalize --
      // pending is a current status, and changeStatus refuses a ref-less
      // record. Only release a reservation THIS call created or re-armed; a
      // concurrent caller that merely observed an existing one must never
      // release work it does not own.
      var released = null;
      if (reserved.created && typeof bindingStore.releaseReservation === "function") {
        released = bindingStore.releaseReservation(request.portfolioTaskId,
          request.bindingRevision, routingFailureReason(delivered));
      }
      return Object.assign({ ok: false, pending: false, retryable: true },
        delivered || { reason: "delivery_error" },
        { binding: released && released.ok ? released.binding : null });
    }
    var committed = bindingStore.commit(request.portfolioTaskId,
      request.bindingRevision, delivered.sessionRef);
    if (!committed.ok) return committed;
    // The claim is what makes one-coordinator-per-(topic, project) durable, so
    // an execution must not stand on a claim that never reached disk: after a
    // restart the pair would read as unclaimed and a different task could take
    // it, producing the two coordinators the table exists to prevent.
    var claimed = verifiedTopicClaim(input, request, delivered.sessionRef);
    // ANY failed verdict, not just a write failure. The precheck runs before
    // delivery, so a rival can win the pair in between; treating only
    // persistence_failed as fatal left that loser's binding active and
    // reported ok:true -- two coordinators for one line of work, which is
    // precisely what the claim table exists to prevent.
    if (claimed && claimed.ok !== true) return containFailedClaim(request, claimed);
    reconcileSessionLedger();
    return executionResult(committed.binding, !!reserved.created && !!delivered.created, delivered);
  }

  // Durable evidence of WHY no task was created, kept on the released record so
  // the failure is diagnosable later without re-reading logs.
  function routingFailureReason(delivered) {
    var reason = delivered && (delivered.reason || delivered.error || delivered.rationale);
    return "pre_task_failure: " + String(reason || "delivery_error").trim().slice(0, 200);
  }

  function bindingAttention(request, reason, extra) {
    var marked = typeof bindingStore.markAttention === "function" ?
      bindingStore.markAttention(request.portfolioTaskId, request.bindingRevision, reason) : null;
    return Object.assign({
      ok: false,
      reason: reason,
      attention: true,
      binding: marked && marked.binding || bindingStore.get(request.portfolioTaskId, request.bindingRevision),
    }, extra || {});
  }

  function createProjectExecution(input) {
    var request = portfolioBindings.normalizeRequest(input);
    if (!request) return { ok: false, reason: "invalid_binding" };
    // Sweep reservations stranded before releaseReservation existed, or by a
    // crash between reserve and commit. Bounded by age inside the store, so a
    // binding that is legitimately mid-start is never cancelled.
    if (typeof bindingStore.reconcileStrandedReservations === "function") {
      bindingStore.reconcileStrandedReservations({ reason: "stranded_reservation_reconciled" });
    }
    var target = executionTarget(request);
    if (!target.ok) return target;
    if (!authorizedExecution(input, request, target.context)) {
      return { ok: false, reason: "access_denied" };
    }
    var existing = bindingStore.get(request.portfolioTaskId, request.bindingRevision);
    if (!existing && !claimInfrastructureAvailable(request)) {
      return { ok: false, reason: "coordinator_claim_unavailable" };
    }
    var replay = matchingCommittedBinding(existing, request);
    if (replay) return replay;
    var recovered = recoverCommittedCoordinatorClaim(input, request, existing);
    if (recovered) return recovered;
    // A prior attempt at THIS exact revision that ended re-armable -- unrouted,
    // or unavailable after a lost coordinator claim or a failed cleanup -- is a
    // retry, not a stale revision. Treating it as current made the retry return
    // stale_binding_revision before it ever reached reserve(), so recovery from
    // a lost claim could never converge: not replayable, not restartable.
    var retryable = existing && (existing.status === "unrouted" || existing.status === "unavailable");
    var current = retryable ? null : bindingStore.get(request.portfolioTaskId);
    // A direct leaf that asks for scope expansion terminalizes before its owner
    // can promote it. Its binding is therefore no longer current, but it is
    // still the exact predecessor the promotion must stop and supersede.
    if (!current && !input._promotionReady && request.mode === "project_coordinator" &&
        (input.reason === "scope_expansion" || input.scopeExpansion === true)) {
      current = latestPriorBinding(request.portfolioTaskId, request.bindingRevision);
    }
    // One canonical coordinator per (TopicRef, ProjectRef). The binding store
    // only guarantees one active binding per portfolio TASK, so a follow-up
    // under a new task id could otherwise staff a rival coordinator for work
    // already in flight on the same topic. The refusal names the canonical
    // coordinator so the caller routes there instead.
    var rival = topicCoordinatorConflict(input, request);
    if (rival) return rival;
    if (isScopePromotion(input, request, current)) {
      return promoteProjectExecution(Object.assign({}, input, {
        fromBindingRevision: current.bindingRevision,
      }));
    }
    return createAndCommitExecution(input, request, target);
  }

  function validPromotion(request, previous) {
    return !!previous && previous.mode === "direct_leaf" &&
      request.bindingRevision > previous.bindingRevision &&
      request.targetProject.projectId === previous.targetProject.projectId;
  }

  function stopPreviousExecution(input, request, previous, target) {
    if (previous.status === "superseded") return { ok: true };
    var previousRequest = {
      portfolioTaskId: previous.portfolioTaskId,
      targetProject: previous.targetProject,
      bindingRevision: previous.bindingRevision,
      idempotencyKey: request.idempotencyKey,
      mode: previous.mode,
    };
    var envelope = executionEnvelope(input, previousRequest,
      "portfolio_execution_stop", previous.worker);
    var stopped = deliverExecutionCommand(target.context, envelope);
    if (!stopped || stopped.ok !== true || stopped.terminal !== true) {
      return Object.assign({ ok: false }, stopped || { reason: "delivery_error" });
    }
    // A terminal needs-input leaf is already closed in the canonical binding
    // store. Stop its project session for the replacement, but do not rewrite
    // the immutable terminal binding outcome just to model the later promotion.
    if (previous.status === "completed" || previous.status === "failed") return { ok: true };
    return bindingStore.supersede(previous.portfolioTaskId,
      previous.bindingRevision, "scope_expansion");
  }

  function promoteProjectExecution(input) {
    var request = portfolioBindings.normalizeRequest(input);
    if (!request || request.mode !== "project_coordinator") {
      return { ok: false, reason: "invalid_binding" };
    }
    var current = bindingStore.get(request.portfolioTaskId);
    var fromRevision = Number(input.fromBindingRevision || current && current.bindingRevision);
    var previous = bindingStore.get(request.portfolioTaskId, fromRevision);
    if (!validPromotion(request, previous)) {
      return { ok: false, reason: "scope_expansion_conflict" };
    }
    var target = executionTarget({ targetProject: previous.targetProject });
    if (!target.ok) return target;
    if (!authorizedExecution(input, request, target.context)) {
      return { ok: false, reason: "access_denied" };
    }
    var stopped = stopPreviousExecution(input, request, previous, target);
    if (!stopped.ok) return stopped;
    return createProjectExecution(Object.assign({}, input, {
      _promotionReady: true,
      mode: "project_coordinator",
    }));
  }

  function legacyLeadContext() {
    return getProjectContext(serverLead.LEAD_SLUG) ||
      resolveProjectContextById(projectIdentity.LEAD_PROJECT_ID);
  }

  function migrationRequest(input) {
    var request = portfolioBindings.normalizeRequest(input);
    if (!request || !request.legacyReference ||
        request.targetProject.projectId === projectIdentity.LEAD_PROJECT_ID) return null;
    var source = projectIdentity.normalizeSessionRef(input && input.source);
    return source && source.projectId === projectIdentity.LEAD_PROJECT_ID ? request : null;
  }

  function reserveMigration(request) {
    var reserved = bindingStore.reserve(request);
    if (!reserved.ok) return reserved;
    return { ok: true, reserved: reserved };
  }

  function inspectMigration(input, request, target) {
    if (target.ok && !authorizedExecution(input, request, target.context)) {
      return { ok: false, reason: "access_denied" };
    }
    var legacy = serverLead.inspectLegacyExecution(legacyLeadContext(), request.legacyReference);
    if (!legacy.ok) return legacy;
    if (legacy.activeProcess && input.controlledCutover !== true) {
      return { ok: false, reason: "legacy_execution_active", draining: true };
    }
    return { ok: true, legacy: legacy };
  }

  function previousLegacyBinding(request) {
    var current = bindingStore.get(request.portfolioTaskId);
    if (!current || current.bindingRevision >= request.bindingRevision) return null;
    return current.targetProject && current.targetProject.projectId === projectIdentity.LEAD_PROJECT_ID ?
      current : null;
  }

  function reserveAfterLegacyBinding(request, previous) {
    if (previous) {
      var changed = bindingStore.supersede(previous.portfolioTaskId,
        previous.bindingRevision, "migrated_to_target_project");
      if (!changed.ok) return changed;
    }
    return reserveMigration(request);
  }

  function attentionWithoutTarget(request, previous, reason) {
    if (previous && typeof bindingStore.markAttention === "function") {
      bindingStore.markAttention(previous.portfolioTaskId, previous.bindingRevision, reason);
      return { ok: false, reason: reason, attention: true, binding: previous };
    }
    var reservation = reserveMigration(request);
    if (!reservation.ok) return reservation;
    return bindingAttention(request, reason);
  }

  function startMigratedExecution(input, request, target, reservation, superseded) {
    var envelope = executionEnvelope(input, request, "portfolio_execution_create");
    var delivered = deliverExecutionCommand(target.context, envelope);
    if (!delivered || delivered.ok !== true || !delivered.sessionRef) {
      return bindingAttention(request, delivered && delivered.reason || "delivery_error", {
        pending: true,
      });
    }
    var committed = bindingStore.commit(request.portfolioTaskId,
      request.bindingRevision, delivered.sessionRef);
    if (!committed.ok) return bindingAttention(request, committed.reason);
    // A migrated project coordinator is still a project coordinator: it must
    // hold the same durable claim. This path committed an active binding and
    // reported success without claiming at all, so a migration could quietly
    // create a second coordinator for a pair already owned.
    var migratedClaim = verifiedTopicClaim(input, request, delivered.sessionRef);
    if (migratedClaim && migratedClaim.ok !== true) {
      return containFailedClaim(request, migratedClaim, { migrated: true });
    }
    return Object.assign(executionResult(committed.binding,
      !!reservation.reserved.created && !!delivered.created, delivered), {
      migrated: true,
      legacySuperseded: !!superseded.persisted,
    });
  }

  function migrateLegacyExecution(input) {
    var request = migrationRequest(input);
    if (!request) return { ok: false, reason: "invalid_legacy_migration" };
    var existing = bindingStore.get(request.portfolioTaskId, request.bindingRevision);
    if (!existing && !claimInfrastructureAvailable(request)) {
      return { ok: false, reason: "coordinator_claim_unavailable", migrated: true };
    }
    var replay = matchingCommittedBinding(existing, request);
    if (replay) return Object.assign(replay, { migrated: true });
    var recovered = recoverCommittedCoordinatorClaim(input, request, existing);
    if (recovered) return Object.assign(recovered, { migrated: true });
    var target = executionTarget(request);
    var inspected = inspectMigration(input, request, target);
    if (!inspected.ok && inspected.draining) return inspected;
    var previous = previousLegacyBinding(request);
    if (!target.ok) return attentionWithoutTarget(request, previous, target.reason);
    if (!inspected.ok) return attentionWithoutTarget(request, previous, inspected.reason);
    var superseded = serverLead.persistLegacySupersession(inspected.legacy, request, {
      controlledCutover: input.controlledCutover === true,
      now: options.now,
    });
    if (!superseded.ok) return attentionWithoutTarget(request, previous, superseded.reason);
    var reservation = reserveAfterLegacyBinding(request, previous);
    if (!reservation.ok) return reservation;
    return startMigratedExecution(input, request, target, reservation, superseded);
  }

  function messageProjectExecution(input) {
    var portfolioTaskId = String(input && input.portfolioTaskId || "");
    var binding = bindingStore.get(portfolioTaskId, Number(input && input.bindingRevision)) ||
      bindingStore.get(portfolioTaskId);
    if (!binding) return { ok: false, reason: "binding_not_found" };
    var requestedProject = projectIdentity.normalizeProjectRef(input && input.targetProject);
    var requestedCoordinator = projectIdentity.normalizeSessionRef(input && input.targetCoordinator);
    var bindingCoordinator = binding.mode === "project_coordinator" ? binding.coordinator : null;
    var typedCoordinatorSteer = !!(input && (input.targetProject || input.targetCoordinator));
    if (typedCoordinatorSteer && (!requestedProject || requestedProject.projectId !== binding.targetProject.projectId)) {
      return bindingAttention(binding, "binding_target_mismatch");
    }
    if (typedCoordinatorSteer && (binding.mode !== "project_coordinator" || !bindingCoordinator ||
        !requestedCoordinator || requestedCoordinator.projectId !== bindingCoordinator.projectId ||
        requestedCoordinator.sessionStorageId !== bindingCoordinator.sessionStorageId)) {
      return bindingAttention(binding, "coordinator_ref_mismatch");
    }
    var request = {
      portfolioTaskId: binding.portfolioTaskId,
      targetProject: binding.targetProject,
      bindingRevision: binding.bindingRevision,
      idempotencyKey: String(input.idempotencyKey || input.messageId || "message-" + crypto.randomUUID()),
      mode: binding.mode,
    };
    var target = executionTarget(request);
    if (!target.ok) return bindingAttention(request, target.reason);
    if (!authorizedExecution(Object.assign({}, input, { source: input.source }), request, target.context)) {
      return { ok: false, reason: "access_denied" };
    }
    var ref = typedCoordinatorSteer ? bindingCoordinator :
      (binding.mode === "project_coordinator" ? binding.coordinator : binding.worker);
    if (!ref) return { ok: false, reason: "binding_pending" };
    var delivered = deliverExecutionCommand(target.context, executionEnvelope(Object.assign({}, input, {
      text: String(input.text || input.message || "").trim(),
    }), request, "portfolio_execution_message", ref));
    if (!delivered || delivered.ok !== true) {
      return bindingAttention(request, delivered && delivered.reason || "delivery_error", {
        pending: true,
      });
    }
    return delivered;
  }

  function sameSessionRef(left, right) { return !!left && !!right && left.projectId === right.projectId && left.sessionStorageId === right.sessionStorageId; }

  function completionSourceMatches(binding, source, refName) {
    if (sameSessionRef(binding && binding[refName], source)) return true;
    var context = binding && binding.targetProject &&
      resolveProjectContextById(binding.targetProject.projectId);
    var manager = sessionManagerForContext(context);
    return portfolioBindings.sourceContinuesBinding(manager, binding, source);
  }

  function completePortfolioExecution(envelope, mode) {
    var payload = envelope && envelope.payload || {};
    var source = projectIdentity.normalizeSessionRef(envelope && envelope.source);
    var destination = projectIdentity.normalizeSessionRef(envelope && envelope.destination);
    var taskId = String(payload.portfolioTaskId || "");
    var revision = Number(payload.bindingRevision);
    if (payload.type !== "portfolio_execution_completed" || payload.executionMode &&
        payload.executionMode !== mode || !source || !destination ||
        destination.projectId !== projectIdentity.LEAD_PROJECT_ID || !taskId ||
        !Number.isInteger(revision) || revision < 1 ||
        revision !== Number(envelope && envelope.bindingRevision) || !envelope.eventId) {
      return { ok: false, reason: "invalid_completion" };
    }
    var binding = bindingStore.get(taskId, revision);
    var refName = mode === "project_coordinator" ? "coordinator" : "worker";
    if (!binding || binding.mode !== mode || !completionSourceMatches(binding, source, refName) ||
        binding.source && !sameSessionRef(binding.source, destination)) {
      return { ok: false, reason: "binding_mismatch" };
    }
    var completed = bindingStore.complete(taskId, revision, {
      eventId: envelope.eventId,
      completedAt: payload.completedAt,
      ownerNotification: payload.ownerNotification === true,
      resultEventId: payload.resultEventId,
      terminalStatus: payload.terminalStatus,
      executionMode: mode,
    });
    if (completed.ok) reconcileSessionLedger();
    return completed;
  }

  function completeDirectLeafExecution(envelope) { return completePortfolioExecution(envelope, "direct_leaf"); }
  function completeProjectCoordinatorExecution(envelope) { return completePortfolioExecution(envelope, "project_coordinator"); }

  function acknowledgeDirectLeafCompletion(envelope) {
    var payload = envelope && envelope.payload || {};
    if (payload.type !== "portfolio_execution_completed") {
      return { ok: false, reason: "invalid_completion" };
    }
    return bindingStore.acknowledgeCompletion(String(payload.portfolioTaskId || ""),
      Number(payload.bindingRevision), envelope.eventId);
  }

  function completedDirectLeafUpdate(envelope) {
    var payload = envelope && envelope.payload;
    var source = projectIdentity.normalizeSessionRef(envelope && envelope.source);
    var destination = projectIdentity.normalizeSessionRef(envelope && envelope.destination);
    if (!payload || payload.type !== "coordinator_update" || !source || !destination ||
        destination.projectId !== projectIdentity.LEAD_PROJECT_ID) return null;
    var binding = bindingStore.findDirectLeafByWorker(source, Number(envelope.bindingRevision));
    if (!binding || (binding.status !== "completed" && binding.status !== "failed") ||
        binding.source && !sameSessionRef(binding.source, destination)) return null;
    return binding;
  }

  var durable = createDurableDelivery({
    getProjectContextById: resolveProjectContextById,
    canDeliverEnvelope: options.canDeliverEnvelope,
    recordRecoveryEvent: recordRecoveryEvent,
    deliveryFile: options.deliveryFile,
    now: options.now,
    maxAttempts: options.maxAttempts,
    retryBaseMs: options.retryBaseMs,
    retryMaxMs: options.retryMaxMs,
  });

  function deadLetter(targetSlug, sessionStorageId, reason) {
    try {
      recordRecoveryEvent({
        kind: "cross_project_dead_letter",
        targetSlug: targetSlug || null,
        sessionStorageId: sessionStorageId || null,
        reason: reason,
      });
    } catch (e) {}
    return { ok: false, reason: reason, authoritative: false, attention: true };
  }

  // Compatibility notifications only. This adapter cannot create, migrate,
  // supersede, or complete execution bindings; typed state remains authority.
  function deliver(targetSlug, sessionStorageId, text) {
    if (!targetSlug || !sessionStorageId) return deadLetter(targetSlug, sessionStorageId, "missing-target");
    var ctx = getProjectContext(targetSlug);
    if (!ctx) return deadLetter(targetSlug, sessionStorageId, "unknown-project");
    if (typeof ctx.deliverCoordinatorUpdate !== "function") {
      return deadLetter(targetSlug, sessionStorageId, "target-not-capable");
    }
    try {
      if (!ctx.deliverCoordinatorUpdate(sessionStorageId, text)) {
        return deadLetter(targetSlug, sessionStorageId, "session-not-found");
      }
    } catch (e) {
      return deadLetter(targetSlug, sessionStorageId, "delivery-error: " + e.message);
    }
    return { ok: true, authoritative: false, compatibility: true };
  }

  var switchProjectExecutionProvider = createCrossProjectProviderSwitch({
    bindingStore: bindingStore,
    resolveProjectContextById: resolveProjectContextById,
  });

  return {
    deliver: deliver,
    legacyTextAuthoritative: false,
    createEnvelope: durable.createEnvelope,
    deliverEnvelope: durable.deliverEnvelope,
    retryPending: durable.retryPending,
    getPendingEventIds: durable.getPendingEventIds,
    getDeadLetters: durable.getDeadLetters,
    getDeliveryState: durable.getState,
    bindingStore: bindingStore,
    sessionLedger: sessionLedger,
    createExecution: createProjectExecution,
    createProjectExecution: createProjectExecution,
    completeDirectLeafExecution: completeDirectLeafExecution,
    completeProjectCoordinatorExecution: completeProjectCoordinatorExecution,
    acknowledgeDirectLeafCompletion: acknowledgeDirectLeafCompletion,
    completedDirectLeafUpdate: completedDirectLeafUpdate,
    coopSessionRef: coopSessionRef,
    getBinding: bindingStore.get,
    getExecutionBinding: bindingStore.get,
    getExecutionBindings: bindingStore.list,
    queryCoopSessions: queryCoopSessions,
    reconcileSessionLedger: reconcileSessionLedger,
    topicSessionEvidence: topicSessionEvidence,
    topicCleanupCandidates: topicCleanupCandidates,
    markExecutionDeleted: bindingStore.markDeleted,
    markExecutionUnavailable: bindingStore.markUnavailable,
    migrateLegacyExecution: migrateLegacyExecution,
    migrateLegacyLeadExecution: migrateLegacyExecution,
    messageExecution: messageProjectExecution,
    messageProjectExecution: messageProjectExecution,
    promoteExecution: promoteProjectExecution,
    promoteProjectExecution: promoteProjectExecution,
    reconcileStrandedCompletions: reconcileStrandedCompletions,
    registerProjectResolver: registerProjectResolver,
    switchProjectExecutionProvider: switchProjectExecutionProvider,
  };
}

module.exports = { createCrossProjectRouter: createCrossProjectRouter };
