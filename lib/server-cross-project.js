// Daemon-level cross-project router.
//
// `deliver()` is the Slice 3 text compatibility adapter. New callers use the
// durable typed envelope API, which resolves ProjectRef/SessionRef identity
// rather than a mutable slug or runtime local id.
var crypto = require("crypto");
var path = require("path");
var continuity = require("./coop-control-continuity");
var executionFence = require("./coop-control-fence");
var recoveryLog = require("./recovery-log");
var createDurableDelivery = require("./cross-project-delivery").createDurableDelivery;
var startDeliveryRetry = require("./cross-project-delivery-retry").startDeliveryRetry;
var projectIdentity = require("./project-identity");
var serverLead = require("./server-lead");
var portfolioBindings = require("./portfolio-execution-bindings");
var createPortfolioExecutionBindings = portfolioBindings.createPortfolioExecutionBindings;
var coopSessionLedgerModule = require("./coop-session-ledger");
var attachCoopSessionLedger = coopSessionLedgerModule.attachCoopSessionLedger;
var implementationIntent = require("./coop-thread-implementation-intent");
var ownerEventResolution = require("./coop-owner-event-resolution");
var readOnlyReviewAdmission = require("./coop-read-only-review-admission");
var queueAuthorization = require("./coop-queue-authorization");
var itemApproval = require("./coop-item-approval");
var automationAuthorization = require("./project-automation-execution-authorization");
var pendingQuestion = require("./coop-pending-question-admission");
var ownerRequestRecords = require("./coop-owner-request-records");
var leadLedger = require("./lead-ledger");
var createCrossProjectProviderSwitch =
  require("./server-cross-project-provider-switch").createCrossProjectProviderSwitch;
var createControlPlaneBindingMigration =
  require("./server-cross-project-control-plane-migration").createControlPlaneBindingMigration;
var attachExecutionReaperRuntime =
  require("./coop-execution-reaper-runtime").attachExecutionReaperRuntime;
var coopControlPlane = require("./coop-control-plane");
var createControlRoleContext = require("./coop-control-role-context").createControlRoleContext;
var createProjectIntake = require("./coop-project-intake").createProjectIntake;
var coordinatorHierarchy = require("./project-coordinator-hierarchy");
var executionTargetControl = require("./coop-control-execution-target");
var restartSupersession = require("./coop-restart-supersession");
var coopTopicIndex = require("./coop-topic-index");
var createAutomationImplementationAdmission =
  require("./server-cross-project-automation-admission")
    .createAutomationImplementationAdmission;
var sameSessionRef = require("./server-cross-project-shared").sameSessionRef;

var EXECUTION_SCHEMA = "clay.project_execution_command";
var EXECUTION_VERSION = 1;

function createCrossProjectRouter(opts) {
  var options = opts || {};
  var governance = options.governanceLifecycle || require("./coop-governance-lifecycle").createLifecycle();
  var automationImplementationAdmission = createAutomationImplementationAdmission({
    getThreadIndex: function () {
      return options.automationThreadIndex || coopTopicIndex.getDefaultTopicIndex();
    },
  });
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
  var executionBindingSnapshot = null;
  var restartSupersessionRules = Array.isArray(options.restartSupersessionRules) ?
    options.restartSupersessionRules : restartSupersession.PRODUCTION_RESTART_SUPERSESSIONS;
  var coopExecutionControl = options.coopExecutionControl || null;
  var coopStartupRecovery = options.coopStartupRecovery || null;
  var controlledExecutionEnabled = !!(coopExecutionControl && coopExecutionControl.enabled &&
    coopStartupRecovery && coopStartupRecovery.enabled);
  var controlledIngress = controlledExecutionEnabled ? "bootstrapping" : "open";
  var onPortfolioExecutionTerminal = typeof options.onPortfolioExecutionTerminal === "function" ?
    options.onPortfolioExecutionTerminal : null;

  function getExecutionBindings() {
    return executionBindingSnapshot || bindingStore.list();
  }

  function hasExecutionBindingSnapshot() {
    return !!executionBindingSnapshot;
  }

  // Global Coop projection walks the same project/status graph many times in
  // one synchronous build. Give those read-only consumers one isolated store
  // snapshot instead of deep-cloning the complete binding ledger per lookup.
  function withExecutionBindingSnapshot(callback) {
    if (typeof callback !== "function") return null;
    if (executionBindingSnapshot) return callback(executionBindingSnapshot);
    executionBindingSnapshot = Object.freeze(bindingStore.list());
    try {
      return callback(executionBindingSnapshot);
    } finally {
      executionBindingSnapshot = null;
    }
  }

  function controlledError(code, message, cause) {
    var failure = new Error(message);
    failure.code = code;
    if (cause) failure.cause = cause;
    return failure;
  }

  function blockedControlledIngress() {
    if (controlledIngress === "open") return null;
    var reasons = {
      bootstrapping: "controlled_execution_recovery_pending",
      draining: "controlled_execution_shutdown",
      recovery_required: "controlled_execution_recovery_required",
    };
    return { ok: false, reason: reasons[controlledIngress] ||
      "controlled_execution_recovery_pending", retryable: false,
      recoveryRequired: controlledIngress === "recovery_required" };
  }

  function guardControlledIngress(operation) {
    return function () {
      var blocked = blockedControlledIngress();
      return blocked || operation.apply(null, arguments);
    };
  }

  function resolveProjectContextById(projectId) {
    var resolved = getProjectContextById(projectId);
    if (resolved) return resolved;
    for (var i = 0; i < registeredProjectResolvers.length; i++) {
      var candidate = registeredProjectResolvers[i];
      if (candidate.getProjectId() === projectId) return candidate;
    }
    return null;
  }

  function projectContextsById(projectId) {
    var contexts = [];
    var direct = getProjectContextById(projectId);
    if (direct) contexts.push(direct);
    for (var i = 0; i < registeredProjectResolvers.length; i++) {
      var candidate = registeredProjectResolvers[i];
      if (!candidate || candidate.getProjectId() !== projectId || contexts.indexOf(candidate) !== -1) {
        continue;
      }
      contexts.push(candidate);
    }
    return contexts;
  }

  function registerProjectResolver(resolver) {
    if (!resolver || typeof resolver.getProjectId !== "function") return function () {};
    registeredProjectResolvers.push(resolver);
    reconcileStrandedCompletions();
    reconcileRestartSupersessions();
    reconcileSessionLedger();
    durable.retryPending();
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

  function recoverReapedExecution(binding, session, context) {
    if (!binding || binding.failureCode !== "reaped_session_interrupted_before_runtime" ||
        !session || !context || typeof context.getTaskOrchestrator !== "function") {
      return { ok: false, reason: "reaped_execution_recovery_unavailable" };
    }
    var orchestrator = context.getTaskOrchestrator();
    if (!orchestrator || typeof orchestrator.recoverInfrastructureExecution !== "function") {
      return { ok: false, reason: "reaped_execution_recovery_unavailable" };
    }
    return orchestrator.recoverInfrastructureExecution(session, binding);
  }

  var executionReaperRuntime = attachExecutionReaperRuntime({
    bindings: bindingStore,
    resolveProjectContextById: resolveProjectContextById,
    sessionManagerForContext: sessionManagerForContext,
    onReaped: recoverReapedExecution,
    now: options.now,
  });

  function forEachRegisteredManager(visitor) {
    var seen = [];
    for (var i = 0; i < registeredProjectResolvers.length; i++) {
      var resolver = registeredProjectResolvers[i];
      var projectId = resolver && resolver.getProjectId();
      var manager = sessionManagerForContext(resolver);
      if (!projectIdentity.isProjectId(projectId) || !manager || seen.indexOf(manager) !== -1) continue;
      seen.push(manager);
      visitor(manager, projectId);
    }
  }

  function completeControlledStartup() {
    if (!controlledExecutionEnabled) return { enabled: false, state: "open" };
    if (controlledIngress === "open") return { enabled: true, state: "open" };
    if (controlledIngress === "recovery_required") {
      throw controlledError("COOP_CONTROL_RESTART_RECOVERY_REQUIRED",
        "Controlled execution startup requires explicit recovery.");
    }
    coopStartupRecovery.assertReady();
    forEachRegisteredManager(function (manager) {
      if (typeof manager.reconcileCoopControlSessions !== "function") return;
      var result = manager.reconcileCoopControlSessions();
      if (result && typeof result.then === "function") {
        throw controlledError("COOP_CONTROL_RECOVERY_RECONCILIATION_ASYNC",
          "Controlled execution startup reconciliation must complete before ingress opens.");
      }
    });
    controlledIngress = "open";
    return { enabled: true, state: controlledIngress };
  }

  function failControlledStartup(cause) {
    if (controlledExecutionEnabled) controlledIngress = "recovery_required";
    return cause;
  }

  function controlledSessionIndex() {
    var sessions = Object.create(null);
    forEachRegisteredManager(function (manager, projectId) {
      if (!manager.sessions || typeof manager.sessions.forEach !== "function") return;
      manager.sessions.forEach(function (session) {
        var metadata = session && session.orchestrationPolicy &&
          session.orchestrationPolicy.portfolioExecution;
        var control = metadata && metadata.control;
        if (!control || !control.executionId) return;
        if (sessions[control.executionId] && sessions[control.executionId].session !== session) {
          throw controlledError("COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED",
            "One controlled execution resolves to duplicate persisted sessions.");
        }
        sessions[control.executionId] = {
          manager: manager,
          metadata: metadata,
          projectId: projectId,
          session: session,
        };
      });
    });
    return sessions;
  }

  function taskBriefForBinding(binding, fallback) {
    var clientRef = "portfolio:" + binding.portfolioTaskId + ":" + binding.bindingRevision;
    var found = "";
    forEachRegisteredManager(function (manager) {
      if (found || !manager.sessions || typeof manager.sessions.forEach !== "function") return;
      manager.sessions.forEach(function (session) {
        if (found || !Array.isArray(session && session.orchestrationTasks)) return;
        for (var i = 0; i < session.orchestrationTasks.length; i++) {
          var task = session.orchestrationTasks[i];
          if (task && task.clientRef === clientRef) {
            found = String(task.objective || task.title || "").trim();
            break;
          }
        }
      });
    });
    var text = found || String(fallback && fallback.title || "").trim() ||
      "Resume controlled execution " + binding.portfolioTaskId;
    return text.slice(0, 12000);
  }

  function restartPacket(active, binding, session) {
    var durable = coopExecutionControl.inspect(active.execution_id);
    if (!durable || !durable.execution || !durable.authority || !durable.current) {
      throw controlledError("COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED",
        "An active controlled execution has no durable authority snapshot.");
    }
    var objectiveId = "objective:" + crypto.createHash("sha256")
      .update(binding.portfolioTaskId + "\u0000" + binding.bindingRevision, "utf8")
      .digest("hex").slice(0, 48);
    var packet = continuity.normalizeContinuityPacket({
      schemaVersion: continuity.SCHEMA_VERSION,
      objectives: [{ objectiveId: objectiveId, text: taskBriefForBinding(binding, session) }],
      decisions: [],
      ownerRequests: [],
      tasks: [{ taskId: binding.portfolioTaskId, objectiveId: objectiveId,
        status: durable.execution.status === "pending" ? "pending" : "running",
        owner: durable.current.sessionRef }],
      bindings: [{ portfolioTaskId: binding.portfolioTaskId,
        bindingRevision: binding.bindingRevision, targetProject: binding.targetProject,
        mode: binding.mode, status: binding.status }],
      authorities: [{ authorityId: durable.authority.authorityId,
        source: durable.authority.source, portfolioTaskId: durable.authority.portfolioTaskId,
        bindingRevision: durable.authority.bindingRevision,
        targetProject: durable.authority.targetProject, role: durable.authority.role,
        actionMask: durable.authority.actionMask }],
      executions: [{ executionId: durable.execution.executionId,
        authorityId: durable.authority.authorityId, source: durable.authority.source,
        portfolioTaskId: durable.execution.portfolioTaskId,
        bindingRevision: durable.execution.bindingRevision,
        targetProject: durable.execution.targetProject, mode: durable.execution.mode,
        role: durable.authority.role }],
      learningReferences: [],
    });
    return { packetDigest: continuity.packetDigest(packet),
      packetJson: continuity.canonicalPacketJson(packet) };
  }

  // A project coordinator may be waiting for the owner while its durable
  // execution lease remains active. That state is intentionally reusable by
  // messageExecution, so it is a live checkpoint target even though it is not
  // the provider's ordinary "running" label. Direct-leaf needs_input is a
  // terminal worker outcome and must remain fail-closed here.
  function checkpointableSessionStatus(metadata) {
    return metadata && (metadata.status === "running" || metadata.status === "pending" ||
      metadata.mode === "project_coordinator" && metadata.status === "needs_input");
  }

  function exactBindingForActive(active, entry) {
    var binding = bindingStore.get(active.portfolio_task_id, Number(active.binding_revision));
    var refName = active.mode === "project_coordinator" ? "coordinator" : "worker";
    var bound = binding && projectIdentity.normalizeSessionRef(binding[refName]);
    if (!binding || binding.targetProject.projectId !== active.target_project_id ||
        binding.mode !== active.mode || !bound || bound.projectId !== entry.projectId ||
        bound.sessionStorageId !== active.session_storage_id ||
        !Object.prototype.hasOwnProperty.call(continuity.BINDING_STATUSES, binding.status)) {
      throw controlledError("COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED",
        "An active controlled execution has no exact canonical binding checkpoint.");
    }
    return binding;
  }

  function restartPreflight(store) {
    if (!store || typeof store.listIncompleteExecutions !== "function" ||
        typeof store.prepareRestartHandoff !== "function") {
      throw controlledError("COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED",
        "Controlled execution checkpoint persistence is unavailable.");
    }
    var active = store.listIncompleteExecutions();
    var indexed = controlledSessionIndex();
    var handoffs = store.listHandoffs().filter(function (row) {
      return row.state === "prepared" || row.state === "cutover" || row.state === "replaying";
    });
    var covered = Object.create(null);
    for (var handoffIndex = 0; handoffIndex < handoffs.length; handoffIndex++) {
      if (covered[handoffs[handoffIndex].execution_id]) {
        throw controlledError("COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED",
          "A controlled execution has more than one active recovery handoff.");
      }
      store.getCheckpoint(handoffs[handoffIndex].handoff_id);
      covered[handoffs[handoffIndex].execution_id] = handoffs[handoffIndex];
    }
    var prepared = [];
    for (var activeIndex = 0; activeIndex < active.length; activeIndex++) {
      var current = active[activeIndex];
      if (covered[current.execution_id]) continue;
      var entry = indexed[current.execution_id];
      var ref = entry && projectIdentity.sessionRef({ projectId: entry.projectId }, entry.session);
      if (!entry || !ref || ref.projectId !== current.session_project_id ||
          ref.sessionStorageId !== current.session_storage_id ||
          !checkpointableSessionStatus(entry.metadata)) {
        throw controlledError("COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED",
          "An active controlled execution has no exact checkpointable target session.");
      }
      var fence;
      try { fence = executionFence.fenceFor(entry.session); }
      catch (cause) {
        throw controlledError("COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED",
          "An active controlled execution has no current runtime checkpoint capability.", cause);
      }
      if (!fence || !fence.isCurrent("callback")) {
        throw controlledError("COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED",
          "An active controlled execution runtime capability is stale.");
      }
      var binding = exactBindingForActive(current, entry);
      var checkpoint = restartPacket(current, binding, entry.session);
      prepared.push({ control: entry.metadata.control, packetDigest: checkpoint.packetDigest,
        packetJson: checkpoint.packetJson, sessionRef: ref });
    }
    return { activeCount: active.length, existingCount: handoffs.length, specs: prepared };
  }

  function restartCheckpointFailure(cause) {
    if (cause && cause.code === "COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED") return cause;
    return controlledError("COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED",
      "Graceful restart could not checkpoint every active controlled execution.", cause);
  }

  // Latching `recovery_required` is a one-way door: completeControlledStartup
  // refuses to reopen from it, and every operation behind guardControlledIngress
  // -- including migrateControlPlaneBinding, the sanctioned repair for a
  // mis-pinned binding -- is closed process-wide until the daemon restarts. It
  // therefore has to cost something durable.
  //
  // `restartPreflight` is READ-ONLY: it lists, indexes and inspects, and throws
  // before the first prepareRestartHandoff call, so a preflight refusal writes
  // nothing -- no handoff, no checkpoint, no epoch bump, no lease change.
  // Latching on it was unjustified, and it also destroyed the diagnosis: the
  // true reason surfaced exactly once, and every later attempt tripped the
  // ingress-state guard above and reported a startup-drain problem that was not
  // happening. Restore the exact prior state instead, so the refusal repeats
  // truthfully and the in-process repair tools stay reachable.
  //
  // A failure inside the prepareRestartHandoff loop is a different case: an
  // earlier spec may already have committed a handoff, a checkpoint and a
  // successor epoch, so partial durable restart state exists and the latch is
  // correct. That branch is unchanged.
  function prepareControlledRestart() {
    if (!controlledExecutionEnabled) {
      controlledIngress = "draining";
      return { enabled: false, preparedHandoffs: 0, state: controlledIngress };
    }
    if (controlledIngress !== "open" && controlledIngress !== "draining") {
      throw controlledError("COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED",
        "Controlled execution ingress cannot drain before startup recovery completes.");
    }
    var priorIngress = controlledIngress;
    controlledIngress = "draining";
    var store;
    var preflight;
    try {
      store = coopExecutionControl.getStore();
      preflight = restartPreflight(store);
    } catch (cause) {
      controlledIngress = priorIngress;
      throw restartCheckpointFailure(cause);
    }
    try {
      for (var i = 0; i < preflight.specs.length; i++) {
        store.prepareRestartHandoff(preflight.specs[i]);
      }
    } catch (cause) {
      controlledIngress = "recovery_required";
      throw restartCheckpointFailure(cause);
    }
    return { enabled: true, preparedHandoffs: preflight.activeCount,
      state: controlledIngress };
  }

  function sessionForBinding(binding) {
    var record = binding || {};
    var projectId = record.targetProject && record.targetProject.projectId;
    var contexts = projectContextsById(projectId);
    for (var i = 0; i < contexts.length; i++) {
      var manager = sessionManagerForContext(contexts[i]);
      var session = portfolioBindings.executionSessionForBinding(manager, record);
      if (session) return session;
    }
    return null;
  }

  function saveBindingSession(binding, session) {
    var record = binding || {};
    var projectId = record.targetProject && record.targetProject.projectId;
    var contexts = projectContextsById(projectId);
    for (var i = 0; i < contexts.length; i++) {
      var manager = sessionManagerForContext(contexts[i]);
      var sessions = manager && manager.sessions;
      var ownsSession = false;
      if (sessions && typeof sessions.forEach === "function") {
        sessions.forEach(function (candidate) {
          if (candidate === session) ownsSession = true;
        });
      }
      if (!ownsSession || typeof manager.saveSessionFile !== "function") continue;
      manager.saveSessionFile(session);
      return;
    }
  }

  var reconcileRestartSupersessions =
    restartSupersession.createProjectRestartSupersessionReconciler({
      rules: restartSupersessionRules,
      bindingStore: bindingStore,
      resolvers: registeredProjectResolvers,
      resolveProjectContextById: resolveProjectContextById,
      sessionManagerForContext: sessionManagerForContext,
      now: options.now,
    });

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
    var byProjectId = {};
    for (var i = 0; i < registeredProjectResolvers.length; i++) {
      var resolver = registeredProjectResolvers[i];
      var projectId = resolver && resolver.getProjectId();
      var manager = sessionManagerForContext(resolver);
      if (!projectIdentity.isProjectId(projectId) || !manager) continue;
      var project = byProjectId[projectId];
      if (!project) {
        project = { projectRef: { projectId: projectId }, sessions: [] };
        byProjectId[projectId] = project;
        projects.push(project);
      }
      if (manager.sessions && typeof manager.sessions.forEach === "function") {
        manager.sessions.forEach(function (session) { project.sessions.push(session); });
      }
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
      bindings: getExecutionBindings(),
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

  // Daemon maintenance and lifecycle mutations reconcile the ledger. Dashboard
  // readers use this snapshot without starting another durable write.
  function currentTopicSessionEvidence(topicRef, metadata) {
    return sessionLedger.topicEvidence(topicRef, metadata);
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
  function canonicalCoopSession() {
    var lead = resolveProjectContextById(projectIdentity.LEAD_PROJECT_ID);
    var sm = lead && (typeof lead.getSessionManager === "function" ?
      lead.getSessionManager() : lead.sm);
    if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return null;
    var found = null;
    sm.sessions.forEach(function (session) {
      if (found || !session || session.coopHome !== true) return;
      found = session;
    });
    return found;
  }

  function coopSessionRef() {
    return projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID },
      canonicalCoopSession());
  }

  function executionTarget(request) {
    var context = resolveProjectContextById(request.targetProject.projectId);
    if (!context) return { ok: false, reason: "project_unavailable" };
    if (typeof context.deliverCrossProjectEnvelope !== "function") {
      return { ok: false, reason: "target_not_capable" };
    }
    return { ok: true, context: context };
  }

  // Authorization is explicit in BOTH directions. The preconditions below are
  // structural and always apply: only a Lead-sourced command may create work,
  // and it may never target Lead itself. Beyond that, an absent
  // `canCreateExecution` used to fall through to `return true`, so a router
  // built without an ACL was silently wide open and nothing in the
  // construction site said so. The openness is now a named, greppable option
  // that a caller has to ask for.
  function authorizedExecution(input, request, context) {
    var source = projectIdentity.normalizeSessionRef(input && input.source);
    if (!source || source.projectId !== projectIdentity.LEAD_PROJECT_ID ||
        request.targetProject.projectId === projectIdentity.LEAD_PROJECT_ID) return false;
    if (typeof options.canCreateExecution === "function") {
      try { return options.canCreateExecution(input.actor || null, context, request) === true; }
      catch (e) { return false; }
    }
    return options.allowLeadSourcedExecution === true;
  }

  // "access_denied" stays exactly as it is: cross-project delivery switches on
  // it as a non-retryable reason. What was missing is WHY. A plain project
  // session calling delegate_task got a bare "access_denied" with nothing
  // saying that project execution is Lead-sourced, which reads as broken
  // dispatch rather than a refusal working as designed. The explanation rides
  // on `error`, which callers already prefer over `reason` when present.
  function authorizationDenialReason(input, request) {
    var source = projectIdentity.normalizeSessionRef(input && input.source);
    if (!source) {
      return "project execution requires a resolvable source SessionRef.";
    }
    if (source.projectId !== projectIdentity.LEAD_PROJECT_ID) {
      return "project execution must be staffed from a Coop/Lead session, but this " +
        "request came from project " + source.projectId + ". A plain project session " +
        "cannot staff project work: omit the project-execution fields to delegate a " +
        "local worker task, or make the request from Coop.";
    }
    if (request && request.targetProject &&
        request.targetProject.projectId === projectIdentity.LEAD_PROJECT_ID) {
      return "project execution may not target Lead itself.";
    }
    return "the execution authorization policy refused this request.";
  }

  function accessDenied(input, request) {
    return { ok: false, reason: "access_denied",
      error: "access_denied: " + authorizationDenialReason(input, request) };
  }

  function projectTitle(context) {
    var status = context && typeof context.getStatus === "function" ? context.getStatus() : {};
    var project = context && typeof context.getProject === "function" ? context.getProject() : {};
    return String(status && (status.title || status.project) ||
      project && (project.title || project.project || project.name) ||
      context && context.slug || "Project").trim();
  }

  function controlPlaneRoute(input, request, target, intakeTicket, stageAssignment) {
    var canonical = coopSessionRef();
    var source = projectIdentity.normalizeSessionRef(input && input.source);
    if (!canonical || !sameSessionRef(source, canonical)) {
      return { ok: false, reason: "canonical_coop_required" };
    }
    var lead = resolveProjectContextById(projectIdentity.LEAD_PROJECT_ID);
    var leadManager = sessionManagerForContext(lead);
    if (!leadManager) return { ok: false, reason: "coop_control_plane_unavailable" };
    var root;
    try { root = coopControlPlane.ensureProjectCoordinator(leadManager,
      request.targetProject, projectTitle(target.context), canonical); }
    catch (error) { return { ok: false, reason: "control_plane_persistence_failed" }; }
    var rootRef = projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, root);
    var policy = coopControlPlane.projectCoordinatorPolicy(root);
    if (!rootRef || !policy || !policy.projectRef ||
        policy.projectRef.projectId !== request.targetProject.projectId) {
      return { ok: false, reason: "project_coordinator_authority_mismatch" };
    }
    var previous = canonicalProjectCoordinator(request);
    if (previous && !sameSessionRef(previous, rootRef) && request.coopTopicRef &&
        ownerRequests && typeof ownerRequests.transferCoordinator === "function") {
      // transferCoordinator names one exact TopicRef as proof that `previous`
      // really owns this project. A brand-new Thread has no claim yet, even
      // though another Thread already proves the project-wide incumbent. Claim
      // the new pair under that incumbent first; the transfer can then atomically
      // move every project claim to the resident root without inventing history,
      // losing the exact ingress link, or failing with no_claim.
      var incumbentClaim = verifiedTopicClaim(input, request, previous);
      if (!incumbentClaim || incumbentClaim.ok !== true) {
        return { ok: false, reason: incumbentClaim && incumbentClaim.reason ||
          "coordinator_claim_not_durable" };
      }
      var transferred = ownerRequests.transferCoordinator({
        topicRef: request.coopTopicRef,
        projectRef: request.targetProject,
        from: previous,
        to: rootRef,
        reason: "coop_control_plane_migration",
      });
      if (!transferred || transferred.ok !== true) {
        return { ok: false, reason: transferred && transferred.reason || "coordinator_transfer_failed" };
      }
    }
    if (stageAssignment) {
      var claim = verifiedTopicClaim(input, request, rootRef);
      if (!claim || !claim.ok) return claim || { ok: false, reason: "coordinator_claim_unavailable" };
      return { ok: true, assignment: projectIntake.commission(leadManager, root, input, request) };
    }
    var brief = {
      title: String(input.title || input.objective || "Project task").trim(),
      objective: String(input.objective || "").trim(),
      context: String(input.context || "").trim(),
      acceptanceCriteria: input.acceptanceCriteria,
      ownedPaths: input.ownedPaths,
      dependencies: input.dependencies,
      provider: input.provider,
      model: input.model,
      controlRole: request.controlRole,
      reviewOnly: request.reviewOnly === true,
    };
    var task = intakeTicket && intakeTicket.root === root && intakeTicket.manager === leadManager &&
      coopControlPlane.taskForRequest(root, request) === intakeTicket.task ? intakeTicket.task :
      coopControlPlane.prepareTask(leadManager, root, request, brief);
    if (!task) return { ok: false, reason: "invalid_dependencies" };
    return {
      ok: true,
      input: Object.assign({}, input, {
        source: rootRef,
        targetProjectCoordinator: rootRef,
        controlPlaneTaskId: task.taskId,
        _controlPlaneManager: leadManager,
        _controlPlaneRoot: root,
        _controlPlaneTask: task,
      }),
    };
  }

  function sameTopic(left, right) {
    return !!(left && right && left.topicId && left.topicId === right.topicId);
  }

  // Stale requestRef.eventIndex values made every owner decision in live state
  // unadmittable. See coop-owner-event-resolution for the measurement, and for
  // why resolving by the immutable coopIngressId is equivalent-or-narrower in
  // authority than trusting the drifted index.
  //
  // Nothing is relaxed here: the record must still claim the canonical Coop
  // session, the resolved event must still be that session's own user_message
  // carrying this exact ingress, and every topic and classification check below
  // is unchanged. An ingress that resolves ambiguously fails closed.
  function canonicalOwnerEvent(entry, canonical, ingressId, allowCompactedApprovalLineage) {
    if (!entry || !canonical) return null;
    var ref = entry.requestRef;
    if (!ref || ref.projectId !== projectIdentity.LEAD_PROJECT_ID ||
        !Number.isInteger(ref.eventIndex) || ref.eventIndex < 0) return null;
    var evidenceSession = canonical;
    if (ref.sessionStorageId !== projectIdentity.sessionStorageId(canonical)) {
      // Existing implementation and queue paths remain resident-session only.
      // Named approval admission opts into this narrowly because it will next
      // prove the exact task, revision, ProjectRef, and pre-existing attention
      // snapshot. The lineage helper is bounded and fails closed on a missing
      // edge, duplicate storage id, or cycle.
      if (allowCompactedApprovalLineage !== true) return null;
      var lead = resolveProjectContextById(projectIdentity.LEAD_PROJECT_ID);
      var manager = lead && (typeof lead.getSessionManager === "function" ?
        lead.getSessionManager() : lead.sm);
      evidenceSession = itemApproval.compactedApprovalSessionFor(canonical,
        manager && manager.sessions, ref.sessionStorageId);
      if (!evidenceSession || evidenceSession.coopHome !== true) return null;
    }
    var history = Array.isArray(evidenceSession.history) ? evidenceSession.history : [];
    var event = history[ref.eventIndex];
    if (!event || event.type !== "user_message" || event.coopIngressId !== ingressId) {
      event = ownerEventResolution.resolveByIngressId(history, ingressId);
    }
    if (!event || event.type !== "user_message" || event.coopIngressId !== ingressId) return null;
    var composerScope = event.coopComposerScope;
    var unscopedMain = !event.coopTopicRef && !entry.topicRef &&
      (composerScope === "main" || composerScope === "canonical");
    // A Main turn can receive its Thread assignment after ingress. The durable
    // owner-request record is the only accepted bridge in that direction: it
    // still has to point back to this exact canonical event, and it must record
    // an executable existing-Thread classification. This covers owner text
    // such as "solve it" whose normalized decision was persisted after the raw
    // history item was written, without trusting a caller-supplied ingress.
    var classifiedMain = !event.coopTopicRef && !!entry.topicRef &&
      (composerScope === "main" || composerScope === "canonical") &&
      entry.classification && entry.classification.kind === "existing_topic" &&
      entry.expectsExecution === true && !!entry.implementationDecision;
    if (!sameTopic(event.coopTopicRef, entry.topicRef) && !unscopedMain &&
        !classifiedMain) return null;
    return event;
  }

  function hasExecutionEvidence(entry) {
    var links = entry && entry.links || {};
    return !!(entry && (entry.expectsExecution || entry.outcome || entry.state === "working" ||
      (Array.isArray(links.tasks) && links.tasks.length) ||
      (Array.isArray(links.sessions) && links.sessions.length) ||
      (Array.isArray(links.coordinators) && links.coordinators.length)));
  }

  function replayImplementationDecision(entry, canonical, ingressId) {
    if (!entry || entry.implementationDecision || !canonical ||
        hasExecutionEvidence(entry) || !ownerRequests ||
        typeof ownerRequests.classify !== "function") return entry;
    var event = canonicalOwnerEvent(entry, canonical, ingressId);
    if (!event) return entry;
    var decision = implementationIntent.implementationDecisionForEvent(event);
    if (!decision) return entry;
    var classification = entry.classification || {};
    return ownerRequests.classify(ingressId, {
      kind: classification.kind || "existing_topic",
      source: classification.source || "transcript_replay",
      at: classification.at || entry.receivedAt,
      topicRef: entry.topicRef,
      projectRefs: entry.projectRefs,
      implementationDecision: Object.assign({}, decision, {
        source: decision.source || "explicit_owner_turn",
        at: decision.at || event._ts || entry.receivedAt,
      }),
    }) || entry;
  }

  function projectMatchesEntry(entry, targetId) {
    var projects = Array.isArray(entry && entry.projectRefs) ? entry.projectRefs : [];
    if (!projects.length) return true;
    for (var i = 0; i < projects.length; i++) {
      if (projects[i] && projects[i].projectId === targetId) return true;
    }
    return false;
  }

  function implementationScopeFor(input, request) {
    return {
      projectRef: request.targetProject,
      topicRef: request.coopTopicRef,
      portfolioTaskId: request.portfolioTaskId,
      bindingRevision: request.bindingRevision,
      idempotencyKey: request.idempotencyKey,
    };
  }

  function implementationScopesFor(entry) {
    return ownerRequestRecords.implementationScopesFor(entry);
  }

  function sameImplementationScope(scope, expected) {
    return !!(expected.projectRef && expected.topicRef &&
      scope && scope.projectRef && scope.topicRef &&
      scope.projectRef.projectId === expected.projectRef.projectId &&
      scope.topicRef.topicId === expected.topicRef.topicId &&
      scope.portfolioTaskId === expected.portfolioTaskId &&
      scope.bindingRevision === expected.bindingRevision &&
      scope.idempotencyKey === expected.idempotencyKey);
  }

  function implementationScopeMatches(entry, input, request) {
    var scopes = implementationScopesFor(entry);
    if (!scopes.length) return true;
    var expected = implementationScopeFor(input, request);
    for (var i = 0; i < scopes.length; i++) {
      if (sameImplementationScope(scopes[i], expected)) return true;
    }
    return false;
  }

  // An owner approval is spent on a revision, not on a task, so a retry that
  // bumps the revision normally loses it -- correctly, because otherwise one
  // "yes" would authorize arbitrarily rewritten work. The owner asked for a
  // narrow exception: carry the approval forward onto a retry of work that
  // demonstrably did not get done.
  //
  // All conditions must hold. There is no partial credit, and each one is
  // load-bearing:
  //
  //   same project, Thread,
  //   task and binding identity the approval names the work; a different target
  //                             is different work, however similar the text.
  //   next revision             a carry-forward moves one revision forward.
  //                             Reusing an approval on the same, an earlier,
  //                             or a skipped revision is not a retry.
  //   timestamped exact failure the owner's "yes" was not consumed. A revision
  //                             still pending or active has not finished, and a
  //                             pre-approval failure is not evidence for this yes.
  //   no matching-scope
  //   completion after approval success CONSUMES the approval only once it
  //                             happens in this approved scope at or after the
  //                             owner's approval. An older completion cannot
  //                             consume a later, explicit approval; ambiguous
  //                             unscoped completion evidence fails closed.
  //
  // `cancelled`, `superseded`, `unrouted` and `deleted` are deliberately NOT
  // treated as terminal-unsuccessful. They mean the attempt was withdrawn,
  // replaced or never routed -- bookkeeping, not a failed attempt the owner
  // watched -- and admitting them would let routine binding churn manufacture
  // authorization.
  var CARRY_FORWARD_UNSUCCESSFUL = { failed: true };

  // Terminal reasons that record HOW an execution ended, not WHETHER the work
  // failed. An execution terminalized by restart recovery was killed together
  // with its daemon; that is silent about whether the work had already
  // finished, so it is not the "this attempt failed" evidence a carry-forward
  // needs. portfolio-execution-binding-completion already preserves this
  // provenance for exactly the stated reason -- otherwise "sweep-terminalized
  // orphans became indistinguishable from genuine task failures: same status,
  // same shape, no provenance" -- and this is the first consumer to depend on
  // the distinction.
  //
  // Measured live on 2026-08-22: eleven stranded controlled executions were
  // terminalized this way so startup recovery could run, and four of the five
  // resulting bindings described work that had actually SUCCEEDED -- a worker
  // that reported WORKER_STATUS: completed with 89/89, and three PRs already
  // pushed to origin. Counting those as approved failures makes finished work
  // retry-shaped, which is precisely the duplicate-work outcome the restart
  // checkpoint guard exists to prevent.
  //
  // Absent provenance stays determinate: 60 live failed bindings predate the
  // failureCode field, and treating a missing reason as indeterminate would
  // silently revoke carry-forward for every one of them.
  var INDETERMINATE_TERMINAL_REASON = {
    restart_recovery: true,
    restart_recovery_superseded: true,
    control_restart_recovery: true,
  };

  function indeterminateTerminalOutcome(binding) {
    var reason = binding && (binding.failureCode || binding.statusReason);
    return INDETERMINATE_TERMINAL_REASON[String(reason || "").trim()] === true;
  }

  function bindingRevisionsFor(portfolioTaskId) {
    var all;
    try { all = bindingStore.list(); }
    catch (e) { return null; }
    if (!Array.isArray(all)) return null;
    var matches = [];
    for (var i = 0; i < all.length; i++) {
      var candidate = all[i];
      if (!candidate || candidate.portfolioTaskId !== portfolioTaskId) continue;
      matches.push(candidate);
    }
    return matches;
  }

  function bindingMatchesApprovedScope(binding, scope) {
    return !!(binding && scope && scope.projectRef && scope.topicRef &&
      binding.targetProject && binding.coopTopicRef &&
      binding.targetProject.projectId === scope.projectRef.projectId &&
      binding.coopTopicRef.topicId === scope.topicRef.topicId &&
      binding.portfolioTaskId === scope.portfolioTaskId &&
      Number(binding.bindingRevision) === Number(scope.bindingRevision) &&
      binding.idempotencyKey === scope.idempotencyKey);
  }

  function bindingMatchesCompletionScope(binding, scope) {
    return !!(binding && scope && scope.projectRef && scope.topicRef &&
      binding.targetProject && binding.coopTopicRef &&
      binding.targetProject.projectId === scope.projectRef.projectId &&
      binding.coopTopicRef.topicId === scope.topicRef.topicId &&
      binding.portfolioTaskId === scope.portfolioTaskId);
  }

  function terminalTimestamp(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function approvalTimestamp(entry) {
    return terminalTimestamp(entry && entry.implementationDecision &&
      entry.implementationDecision.at);
  }

  function bindingHasExplicitScope(binding) {
    return !!(binding && binding.targetProject && binding.targetProject.projectId &&
      binding.coopTopicRef && binding.coopTopicRef.topicId);
  }

  function approvalCarriesForward(entry, input, request) {
    var expected = implementationScopeFor(input, request);
    if (!expected.projectRef || !expected.topicRef || !expected.portfolioTaskId) return false;
    var approvedAt = approvalTimestamp(entry);
    if (approvedAt === null) return false;
    // A store that cannot be read is not evidence that the approved revision
    // failed or that no later completion consumed the approval.
    var revisions = bindingRevisionsFor(expected.portfolioTaskId);
    if (!revisions) return false;
    var scopes = implementationScopesFor(entry);
    for (var s = 0; s < scopes.length; s++) {
      var scope = scopes[s];
      if (!scope || !scope.projectRef || !scope.topicRef ||
          scope.projectRef.projectId !== expected.projectRef.projectId ||
          scope.topicRef.topicId !== expected.topicRef.topicId ||
          scope.portfolioTaskId !== expected.portfolioTaskId) continue;
      var from = Number(scope.bindingRevision);
      var to = Number(expected.bindingRevision);
      if (!Number.isInteger(from) || !Number.isInteger(to) || to !== from + 1) continue;
      var approvedFailures = 0;
      var consumed = false;
      var indeterminate = false;
      for (var i = 0; i < revisions.length; i++) {
        var binding = revisions[i];
        var status = String(binding.status || "");
        if (status === "completed") {
          var completedAt = terminalTimestamp(binding.completedAt);
          if (completedAt === null) {
            consumed = true;
            break;
          }
          if (completedAt >= approvedAt &&
              (!bindingHasExplicitScope(binding) || bindingMatchesCompletionScope(binding, scope))) {
            consumed = true;
            break;
          }
        }
        if (bindingMatchesApprovedScope(binding, scope) &&
            CARRY_FORWARD_UNSUCCESSFUL[status] === true) {
          // Checked before the timestamp gate on purpose: a restart-recovery
          // terminalization carries a perfectly good completedAt, so it would
          // otherwise pass every remaining test and authorize a retry of work
          // whose outcome nobody has established.
          if (indeterminateTerminalOutcome(binding)) {
            indeterminate = true;
            break;
          }
          var failedAt = terminalTimestamp(binding.completedAt);
          if (failedAt === null || failedAt < approvedAt) {
            consumed = true;
            break;
          }
          approvedFailures++;
        }
      }
      if (!consumed && !indeterminate && approvedFailures === 1) return true;
    }
    return false;
  }

  function scopeDiffersOnlyByIdempotency(entry, input, request) {
    var expected = implementationScopeFor(input, request);
    var scopes = implementationScopesFor(entry);
    for (var i = 0; i < scopes.length; i++) {
      var scope = scopes[i];
      if (expected.projectRef && expected.topicRef && scope && scope.projectRef && scope.topicRef &&
          scope.projectRef.projectId === expected.projectRef.projectId &&
          scope.topicRef.topicId === expected.topicRef.topicId &&
          scope.portfolioTaskId === expected.portfolioTaskId &&
          scope.bindingRevision === expected.bindingRevision &&
          scope.idempotencyKey !== expected.idempotencyKey) return true;
    }
    return false;
  }

  function admitUnscopedMainImplementation(input, request, canonicalSession, ingressId) {
    if (!ingressId || !ownerRequests || typeof ownerRequests.get !== "function") return null;
    var entry;
    try { entry = ownerRequests.get(ingressId); }
    catch (e) { return { ok: false, reason: "owner_implementation_decision_unavailable" }; }
    if (!entry) return null;
    if (!entry.implementationDecision) {
      entry = replayImplementationDecision(entry, canonicalSession, ingressId);
    }
    var event = canonicalOwnerEvent(entry, canonicalSession, ingressId);
    var composerScope = event && event.coopComposerScope;
    var unscopedMain = !!(event && !event.coopTopicRef && !entry.topicRef &&
      (composerScope === "main" || composerScope === "canonical"));
    var withdrawn = !!(entry.response && entry.response.state === "superseded");
    if (!unscopedMain || withdrawn || entry.expectsExecution !== true ||
        !entry.implementationDecision) return null;
    // The same refusal the main loop applies. This branch omitted it, which was
    // harmless only while a Main turn always arrived with an empty projectRefs
    // list -- Main scope clears the route refs before the record is written. It
    // stops being harmless the moment anything populates them on a Thread-less
    // entry, and this branch is now the ordinary path for owner-directed Main
    // execution rather than a corner reachable only by a caller that already had
    // a Thread to supply, so it fails closed here too.
    if (!projectMatchesEntry(entry, request.targetProject.projectId)) {
      return { ok: false, reason: "owner_implementation_project_mismatch" };
    }
    if (typeof ownerRequests.scopeImplementation !== "function") {
      return { ok: false, reason: "owner_implementation_scope_unavailable" };
    }
    var scoped = ownerRequests.scopeImplementation(ingressId,
      implementationScopeFor(input, request));
    if (!scoped || scoped.ok !== true) {
      return { ok: false, reason: scoped && scoped.reason || "owner_implementation_scope_unavailable" };
    }
    return { ok: true, request: scoped.request };
  }

  function canonicalAutomationSource(input) {
    var source = projectIdentity.normalizeSessionRef(input && input.source);
    var canonical = projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID },
      canonicalCoopSession());
    return !!(source && canonical && source.projectId === canonical.projectId &&
      source.sessionStorageId === canonical.sessionStorageId);
  }

  // A missing ThreadRef was reported as "thread_ref_required" before anything
  // looked at whether the cited owner turn was implementable at all. That check
  // sits first, so an unimplementable request -- a question, a bug report, a
  // conversational turn -- was reported as a Thread problem. Live state has
  // three of them (ingresses 418, 430, 455), and the misdiagnosis sent an
  // operator hunting a Thread-creation gap for a day when every one of those
  // turns simply carried no owner implementation decision.
  //
  // Only say the ThreadRef is what is missing when a decision actually exists.
  // Then it is true, and coopTopicIndex.ensureOwnerThread is the lever that
  // resolves it.
  function missingThreadRefReason(input) {
    var ingressId = String(input && input.coopIngressId || "");
    // No ingress at all is not "a resolved owner turn is missing its Thread" --
    // it is "no owner turn was resolved for this dispatch". That is the same
    // misdiagnosis the comment above describes, wearing a different hat, and it
    // is the shape the router's unscoped hijack produced once that hijack was
    // narrowed: the scan stops proposing an unrelated ingress and the route
    // arrives empty. Name the real blocker; there is nothing a Thread could be
    // bound to yet.
    if (!ingressId) {
      // Truthful but dead-ended: it named the blocker and no remedy, so the
      // only strategy left was to retry the identical call. Live on 2026-08-22
      // that produced nine confirmed retries of one dispatch across four daemon
      // restarts, each one re-establishing the same true fact. Same defect class
      // as the bare `coordinator_ref_mismatch` string, and the same fix -- state
      // what would satisfy the gate. Nothing here widens authority; every route
      // named below is one that already exists and is still checked in full.
      return { ok: false, reason: "owner_implementation_decision_required",
        error: "owner_implementation_decision_required: no owner turn authorizes " +
          "this dispatch, so there is nothing a Thread could be bound to. " +
          "A missing ThreadRef is not the blocker here. Any ONE of these " +
          "authorizes it: (1) an owner turn stating the work as a decision, " +
          "e.g. \"Fix <the thing> in <project>\", which must be the newest owner " +
          "turn or already scoped to this task; (2) call request_task_input for " +
          "portfolioTaskId " + String(input && input.portfolioTaskId || "?") +
          " revision " + Number(input && input.bindingRevision) + ", then the " +
          "owner's next turn answering it affirmatively (\"yes\", \"do it\", " +
          "\"both\", \"do 1 and 2\"); (3) an owner turn naming this exact task " +
          "and revision as an approval. Read-only diagnosis in an allowlisted " +
          "project needs none of these. Retrying this identical call cannot " +
          "change the outcome." };
    }
    if (!ownerRequests || typeof ownerRequests.get !== "function") {
      return { ok: false, reason: "thread_ref_required" };
    }
    var entry;
    try { entry = ownerRequests.get(ingressId); }
    catch (e) { return { ok: false, reason: "thread_ref_required" }; }
    if (entry && entry.implementationDecision && entry.expectsExecution === true) {
      // The route tried to mint the Thread and was refused for a specific,
      // actionable reason -- the owner closed it, or its derived id is already
      // occupied. Reporting the generic thread_ref_required here would say "a
      // Thread is needed" when the truth is "the Thread cannot be created, and
      // here is why", which is the misdiagnosis shape this function exists to
      // avoid. Diagnostic only: the refusal never affects what is authorized.
      // Sanitized before it reaches an operator-facing message: the route sets
      // this, but it arrives merged into caller-supplied input, so treat it as
      // untrusted text rather than echoing an object or a newline-bearing blob.
      // Anything that is not a plain refusal code is dropped, not rendered.
      var refusal = String(input && input.coopThreadMintRefusal || "").trim();
      if (!/^[a-z0-9_]{1,64}$/i.test(refusal)) refusal = "";
      if (refusal) {
        return { ok: false, reason: "owner_thread_unavailable",
          error: "owner_thread_unavailable: ingress " + ingressId + " carries an owner " +
            "implementation decision, but its Thread could not be created (" + refusal +
            "). A missing ThreadRef is the symptom, not the blocker." };
      }
      return { ok: false, reason: "thread_ref_required" };
    }
    return { ok: false, reason: "owner_implementation_decision_required",
      error: "owner_implementation_decision_required: ingress " + ingressId +
        " carries no owner implementation decision" +
        (entry ? "" : " and is not in the owner-request ledger") +
        ", so no Thread can be bound to it. A missing ThreadRef is not the blocker here." };
  }

  function implementationAdmission(input, request, context) {
    if (options.requireOwnerImplementationDecision !== true) return { ok: true };
    var grantProblem = require("./project-task-orchestrator-external-delegation")
      .governanceGrantProblem({ governanceLifecycle: governance }, input);
    if (grantProblem) return { ok: false, reason: "implementation_grant_refused", error: grantProblem };
    if (Object.prototype.hasOwnProperty.call(input || {}, "automationAuthorization")) {
      if (!request.coopTopicRef) return { ok: false, reason: "thread_ref_required" };
      if (request.mode !== "project_coordinator") {
        return { ok: false, reason: "persistent_project_coordinator_required" };
      }
      if (!canonicalAutomationSource(input)) {
        return { ok: false, reason: "canonical_coop_required" };
      }
      return automationImplementationAdmission.admit(input, request, context);
    }
    var source = projectIdentity.normalizeSessionRef(input && input.source);
    var canonicalSession = canonicalCoopSession();
    var canonical = projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID },
      canonicalSession);
    var canonicalSource = !!(source && canonical && source.projectId === canonical.projectId &&
      source.sessionStorageId === canonical.sessionStorageId);
    // Standing autonomy is independent of an owner turn and may therefore be
    // evaluated before a Thread exists. Keeping this below the canonical Coop
    // check preserves the source boundary; keeping it above the Thread check is
    // what lets an enabled, bounded grant actually dispatch without fabricating
    // a literal owner ingress.
    if (!String(input && input.coopApprovalIngressId || "")) {
      var standing = itemApproval.executionAdmission(input, request, canonicalSession, {
        ownerRequests: ownerRequests,
        autonomyPolicyFile: options.autonomyPolicyFile,
        bindings: bindingStore,
      });
      if (standing) return canonicalSource ? standing :
        { ok: false, reason: "canonical_coop_required" };
    }
    // Check canonical ingress before any replay or scope write. Old backfills
    // may already have classified its text, so a stored decision cannot
    // override the unresolved target. Standing autonomy above is separate.
    var citedIngressId = String(input && input.coopIngressId || "");
    if (implementationIntent.hasUnresolvedProject(
        ownerEventResolution.resolveByIngressId(
          canonicalSession && canonicalSession.history, citedIngressId))) {
      return { ok: false, reason: "owner_project_clarification_required" };
    }
    if (!request.coopTopicRef) return missingThreadRefReason(input);
    if (request.mode !== "project_coordinator") {
      return { ok: false, reason: "persistent_project_coordinator_required" };
    }
    if (!canonicalSource) return { ok: false, reason: "canonical_coop_required" };
    if (!ownerRequests || typeof ownerRequests.forTopic !== "function") {
      return { ok: false, reason: "owner_implementation_decision_unavailable" };
    }
    var entries;
    try { entries = ownerRequests.forTopic(request.coopTopicRef); }
    catch (e) { return { ok: false, reason: "owner_implementation_decision_unavailable" }; }
    var ingressId = String(input && input.coopIngressId || "");
    var targetId = request.targetProject.projectId;
    var readOnlyPlanningReview =
      readOnlyReviewAdmission.isReadOnlyPlanningReview(input);
    for (var i = entries.length - 1; i >= 0; i--) {
      var entry = entries[i];
      if (entry && entry.ingressId === ingressId && !entry.implementationDecision) {
        entry = replayImplementationDecision(entry, canonicalSession, ingressId);
      }
      if (!entry || entry.ingressId !== ingressId) continue;
      var withdrawn = !!(entry.response && entry.response.state === "superseded");
      var canonicalEvent = canonicalOwnerEvent(entry, canonicalSession, ingressId);
      var ownerEvent = readOnlyPlanningReview ? canonicalEvent : null;
      var implementationAuthorized = entry.expectsExecution === true &&
        !!entry.implementationDecision && !withdrawn &&
        (!entry.requestRef || !!canonicalEvent);
      var reviewAuthorized = !!(!withdrawn && ownerEvent &&
        readOnlyReviewAdmission.explicitReadOnlyReviewAuthorization(ownerEvent.text));
      if (!implementationAuthorized && !reviewAuthorized) continue;
      if (!projectMatchesEntry(entry, targetId)) {
        return { ok: false, reason: "owner_implementation_project_mismatch" };
      }
      var carryForward = false;
      if (implementationAuthorized && !implementationScopeMatches(entry, input, request)) {
        // Once the exact binding exists, a rival idempotency key is a binding
        // conflict, not a new attempt to widen the owner's first scope. Keep
        // the stricter scope refusal for every other mismatch (project,
        // Thread, task, or revision), and never write either path.
        var existing = bindingStore.get(request.portfolioTaskId, request.bindingRevision);
        if (scopeDiffersOnlyByIdempotency(entry, input, request) && existing &&
            portfolioBindings.requestEquivalence(existing, request) === "conflict") {
          return { ok: false, reason: "idempotency_conflict" };
        }
        // The one sanctioned way past a revision mismatch. Checked only after
        // every other refusal above, so carry-forward can widen nothing else:
        // it decides a retry of already-failed work, and refuses on its own if
        // any of its four conditions is unmet.
        carryForward = approvalCarriesForward(entry, input, request);
        if (!carryForward) {
          return { ok: false, reason: "owner_implementation_scope_mismatch" };
        }
      }
      if (implementationAuthorized && typeof ownerRequests.scopeImplementation !== "function") {
        return { ok: false, reason: "owner_implementation_scope_unavailable" };
      }
      if (implementationAuthorized) {
        var scoped = ownerRequests.scopeImplementation(ingressId,
          Object.assign(implementationScopeFor(input, request),
            carryForward ? { carryForward: true } : null));
        if (!scoped || scoped.ok !== true) {
          return { ok: false, reason: scoped && scoped.reason ||
            "owner_implementation_scope_unavailable" };
        }
        return { ok: true, request: scoped.request };
      }
      // Record what this review turn covered. Until it did, review admission
      // returned ok and wrote nothing, so no later reader could tell which tasks
      // an owner review turn had actually authorized -- which is why the router's
      // coverage check could not be applied to review ingresses, leaving that
      // branch of the history scan unbounded. That is the defect that let turn
      // :595 ("Do both") claim the route for unrelated work on 2026-08-23.
      //
      // Best-effort by design: a failed write must not refuse a review the owner
      // did authorize. The cost of losing it is a later dispatch of this same
      // review falling back on the newest-turn rule, not a wrong admission. It is
      // deliberately NOT symmetric with scopeImplementation above, which does
      // refuse on a failed write, because that one is recording authority to
      // MUTATE and must not proceed unrecorded.
      if (typeof ownerRequests.scopeReview === "function") {
        try { ownerRequests.scopeReview(ingressId, implementationScopeFor(input, request)); }
        catch (e) { /* coverage is an optimization; admission already decided */ }
      }
      return { ok: true, request: entry, reviewOnly: true };
    }
    var mainAdmission = admitUnscopedMainImplementation(input, request,
      canonicalSession, ingressId);
    if (mainAdmission) return mainAdmission;
    var queueAdmission = queueAuthorization.executionAdmission(input, request,
      canonicalSession, {
        ownerRequests: ownerRequests,
        canonicalOwnerEvent: canonicalOwnerEvent,
        readLeadEvents: options.readLeadEvents || leadLedger.readEvents,
      });
    if (queueAdmission) return queueAdmission;
    // The named counterpart to the queue-wide sweep above: the owner approving
    // one specific pending item. Returns null unless the caller cites an
    // approval ingress, so the fail-closed default below is unchanged.
    var approvalAdmission = itemApproval.executionAdmission(input, request,
      canonicalSession, {
        ownerRequests: ownerRequests,
        canonicalOwnerEvent: function (entry, canonical, ingressId) {
          return canonicalOwnerEvent(entry, canonical, ingressId, true);
        },
        readLeadEvents: options.readLeadEvents || leadLedger.readEvents,
        // Undefined in production, where the standing grant reached through this
        // gate reads its own repo-root file. A test seam only, so a regression can
        // exercise the grant without mutating the shipped switch.
        autonomyPolicyFile: options.autonomyPolicyFile,
        // The standing grant proves a revision bump carries the brief the owner
        // approved by comparing it against the binding already written for the
        // approved revision. Without this handle it cannot obtain that proof and
        // refuses every bump.
        bindings: bindingStore,
      });
    if (approvalAdmission) return approvalAdmission;
    // Last, so it can only speak where every wording-based path has already
    // declined. An owner approval can be REFERENTIAL -- "do 1 and 2", "both",
    // "yes" -- and none of the parsers above can resolve that to a task, because
    // the only thing that ever bound those words to work was Coop's own
    // question. This gate consults that question. The pending `waiting_user`
    // record is the authority and predates the owner's turn, so affirmative
    // wording can identify work but never manufacture it.
    var answeredAdmission = pendingQuestion.executionAdmission(input, request,
      canonicalSession);
    if (answeredAdmission) return answeredAdmission;
    return { ok: false, reason: "owner_implementation_decision_required" };
  }

  function applyAutomationExecutionBoundary(input, admitted) {
    if (!admitted || admitted.automation !== true ||
        !String(admitted.externalActionBoundary || "").trim()) return null;
    var next = Object.assign({}, input);
    var context = String(next.context || "").trim();
    var acceptance = String(next.acceptanceCriteria || "").trim();
    next.context = (context ? context + "\n\n" : "") + admitted.externalActionBoundary;
    next.acceptanceCriteria = (acceptance ? acceptance + "\n" : "") +
      "Complete and verify the internal work through a local commit. Stop for the exact owner " +
      "approval required by the external-action boundary before mutating remote state.";
    // These fields cover the task payload. Recompute them after inserting the
    // validated boundary so the target receives one internally consistent
    // command rather than a stale digest over weaker instructions.
    delete next.controlPlaneProvenance;
    delete next.taskPayloadDigest;
    var request = portfolioBindings.normalizeRequest(next);
    return request ? { input: next, request: request } : null;
  }

  function executionEnvelope(input, request, type, destinationRef) {
    var payload = Object.assign({}, input, request, { type: type });
    delete payload.actor;
    delete payload.source;
    delete payload._promotionReady;
    delete payload._controlPlaneManager;
    delete payload._controlPlaneRoot;
    delete payload._controlPlaneTask;
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
      result.taskCoordinatorRef = ref || null;
      result.projectCoordinatorRef = binding.projectCoordinator ||
        targetResult && targetResult.projectCoordinatorRef || null;
    } else {
      result.workerStorageId = result.sessionStorageId;
      result.workerRef = ref || null;
    }
    return result;
  }

  function linkThreadHandoff(request, result) {
    if (!result || result.ok !== true || !request.coopTopicRef) return result;
    if (typeof options.onThreadHandedOff !== "function") {
      return options.requireOwnerImplementationDecision === true
        ? Object.assign({}, result, { ok: false, retryable: true,
          reason: "thread_handoff_link_unavailable" }) : result;
    }
    var linked;
    try {
      linked = options.onThreadHandedOff({ topicRef: request.coopTopicRef,
        projectRef: request.targetProject, sessionRef: result.sessionRef, taskRef: result.taskRef });
    } catch (e) { linked = null; }
    if (!linked || linked.ok !== true) {
      return Object.assign({}, result, { ok: false, retryable: true,
        reason: "thread_handoff_link_failed" });
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
    var holder = binding.projectCoordinator || binding.coordinator;
    return canonical.projectId === holder.projectId &&
      canonical.sessionStorageId === holder.sessionStorageId;
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

  function canonicalProjectCoordinator(request) {
    if (!ownerRequests || request.mode !== "project_coordinator" ||
        typeof ownerRequests.canonicalProjectCoordinator !== "function") return null;
    try { return ownerRequests.canonicalProjectCoordinator(request.targetProject); }
    catch (e) { return null; }
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
    var claimed = verifiedTopicClaim(input, request,
      existing.projectCoordinator || existing.coordinator);
    if (!claimed || claimed.ok !== true) return containFailedClaim(request, claimed);
    return executionResult(existing, false, null);
  }

  function primitiveAdoption(input, request) {
    var authorization = request && request.automationAuthorization;
    var primitive = authorization && authorization.kind === automationAuthorization.PRIMITIVE_KIND;
    var supplied = Object.prototype.hasOwnProperty.call(input || {}, "adoptSessionRef");
    if (!primitive && !supplied) return { ok: true, sessionRef: null };
    var sessionRef = projectIdentity.normalizeSessionRef(input && input.adoptSessionRef);
    if (!primitive || !supplied || !sessionRef ||
        sessionRef.projectId !== request.targetProject.projectId) {
      return { ok: false, reason: "primitive_adoption_mismatch" };
    }
    return { ok: true, sessionRef: sessionRef };
  }

  function removePreparedControlTask(input) {
    if (input._controlPlaneManager && input._controlPlaneRoot && input._controlPlaneTask &&
        !input._controlPlaneTask.workerSessionRef) {
      coopControlPlane.removePreparedTask(input._controlPlaneManager,
        input._controlPlaneRoot, input._controlPlaneTask);
    }
  }

  // The project launcher has already created and started this exact session.
  // This path adds control-plane ownership around it; it never delivers a
  // second generic execution command and therefore cannot replace or duplicate
  // the legacy issue/PR primitive.
  function createAndCommitAdoptedExecution(input, request, target, sessionRef) {
    var manager = sessionManagerForContext(target.context);
    var session = portfolioBindings.sessionByRef(manager, sessionRef,
      request.targetProject.projectId);
    var taskLauncher = session && session.taskLauncher;
    var itemKey = taskLauncher && (taskLauncher.automationClaimKey ||
      taskLauncher.itemKey || taskLauncher.prKey);
    if (!session || !taskLauncher || taskLauncher.autoLaunch !== true ||
        itemKey !== request.automationAuthorization.itemKey) {
      removePreparedControlTask(input);
      return { ok: false, reason: "primitive_session_not_adoptable" };
    }
    var metadata = portfolioBindings.sessionExecutionBinding(session);
    if (metadata && (metadata.portfolioTaskId !== request.portfolioTaskId ||
        metadata.bindingRevision !== request.bindingRevision ||
        metadata.idempotencyKey !== request.idempotencyKey)) {
      removePreparedControlTask(input);
      return { ok: false, reason: "primitive_session_binding_conflict" };
    }
    var reserved = bindingStore.reserve(request);
    if (!reserved.ok) {
      removePreparedControlTask(input);
      return reserved;
    }
    var rootRef = projectIdentity.normalizeSessionRef(input.targetProjectCoordinator);
    session.orchestrationPolicy = Object.assign({}, session.orchestrationPolicy || {}, {
      portfolioExecution: executionTargetControl.activeExecutionMetadata(metadata, request,
        projectIdentity.normalizeSessionRef(input.source)),
    });
    session.coopControlledBy = {
      coopSessionStorageId: rootRef && rootRef.sessionStorageId,
      since: session.coopControlledBy && session.coopControlledBy.since || (options.now || Date.now)(),
    };
    if (!rootRef || !coordinatorHierarchy.bindControlPlaneTaskCoordinator(manager, session, {
      request: request,
      projectCoordinatorRef: rootRef,
      taskId: input.controlPlaneTaskId,
    })) {
      return bindingAttention(request, "primitive_control_plane_link_failed", { pending: true });
    }
    if (input._controlPlaneManager && input._controlPlaneRoot && input._controlPlaneTask &&
        (!sameSessionRef(input._controlPlaneTask.workerSessionRef, sessionRef) &&
        !coopControlPlane.bindTask(input._controlPlaneManager, input._controlPlaneRoot,
          input._controlPlaneTask, sessionRef))) {
      return bindingAttention(request, "control_plane_task_link_failed", { pending: true });
    }
    var committed = bindingStore.commit(request.portfolioTaskId,
      request.bindingRevision, sessionRef, { projectCoordinatorRef: rootRef });
    if (!committed.ok) return committed;
    var claimed = verifiedTopicClaim(input, request, rootRef);
    if (claimed && claimed.ok !== true) return containFailedClaim(request, claimed);
    reconcileSessionLedger();
    return executionResult(committed.binding, !!reserved.created, {
      created: !!reserved.created,
      localSessionId: session.localId,
      projectCoordinatorRef: rootRef,
    });
  }

  function createAndCommitExecution(input, request, target) {
    var reserved = bindingStore.reserve(request);
    if (!reserved.ok) {
      if (input._controlPlaneManager && input._controlPlaneRoot && input._controlPlaneTask) {
        coopControlPlane.removePreparedTask(input._controlPlaneManager,
          input._controlPlaneRoot, input._controlPlaneTask);
      }
      return reserved;
    }
    var envelope = executionEnvelope(input, request, "portfolio_execution_create");
    var delivered = deliverExecutionCommand(target.context, envelope);
    if (!delivered || delivered.ok !== true || !delivered.sessionRef) {
      if (input._controlPlaneManager && input._controlPlaneRoot && input._controlPlaneTask) {
        coopControlPlane.removePreparedTask(input._controlPlaneManager,
          input._controlPlaneRoot, input._controlPlaneTask);
      }
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
    if (input._controlPlaneManager && input._controlPlaneRoot && input._controlPlaneTask &&
        !coopControlPlane.bindTask(input._controlPlaneManager, input._controlPlaneRoot,
          input._controlPlaneTask, delivered.sessionRef)) {
      return bindingAttention(request, "control_plane_task_link_failed", { pending: true });
    }
    var committed = bindingStore.commit(request.portfolioTaskId,
      request.bindingRevision, delivered.sessionRef, {
        projectCoordinatorRef: delivered.projectCoordinatorRef || input.targetProjectCoordinator,
      });
    if (!committed.ok) return committed;
    // The claim is what makes one-coordinator-per-(topic, project) durable, so
    // an execution must not stand on a claim that never reached disk: after a
    // restart the pair would read as unclaimed and a different task could take
    // it, producing the two coordinators the table exists to prevent.
    var claimed = verifiedTopicClaim(input, request,
      delivered.projectCoordinatorRef || input.targetProjectCoordinator || delivered.sessionRef);
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
    var code = delivered && (delivered.code || delivered.reason);
    return {
      code: String(code || "delivery_error").trim().slice(0, 128),
      message: "pre_task_failure: " + String(reason || "delivery_error").trim().slice(0, 200),
      details: delivered && delivered.details || null,
    };
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

  function approvalDispatchResult(result, admitted) {
    if (!result || result.ok !== true || !admitted || !admitted.answeredQuestion) return result;
    return Object.assign({}, result, {
      approvalTaskId: admitted.answeredQuestion.taskId,
      approvalSetId: admitted.answeredQuestion.approvalSetId,
    });
  }

  function createProjectExecution(input, intakeTicket) {
    var request = portfolioBindings.normalizeRequest(input);
    if (!request) return { ok: false, reason: "invalid_binding" };
    var adoption = primitiveAdoption(input, request);
    if (!adoption.ok) return adoption;
    // Sweep reservations stranded before releaseReservation existed, or by a
    // crash between reserve and commit. Bounded by age inside the store, so a
    // binding that is legitimately mid-start is never cancelled.
    if (typeof bindingStore.reconcileStrandedReservations === "function") {
      bindingStore.reconcileStrandedReservations({ reason: "stranded_reservation_reconciled" });
    }
    var target = executionTarget(request);
    if (!target.ok) return target;
    if (!authorizedExecution(input, request, target.context)) {
      return accessDenied(input, request);
    }
    var admitted = implementationAdmission(input, request, target.context);
    if (!admitted.ok) {
      // Internal dispatch receipt for commissioning recovery. Keep the public
      // admission response unchanged; the MCP wrapper exposes this separately.
      Object.defineProperty(admitted, "executionNotStarted", { value: true });
      return admitted;
    }
    if (admitted.standingGrant) {
      input = Object.assign({}, input, { standingGrant: admitted.standingGrant });
    }
    // Read-only admission is a property of the exact ProjectRef binding, not
    // only of the preflight result. Without carrying it forward, a Triage or
    // terminal-reconciliation evidence dispatch could pass its narrow
    // non-mutating admission and then create an ordinary implementation-shaped
    // envelope. Keep the marker on both values used below: `request` is stored
    // in the binding and `input` is used to build the target delivery payload.
    if (admitted.reviewOnly === true) {
      input = Object.assign({}, input, { reviewOnly: true });
      request = Object.assign({}, request, { reviewOnly: true });
    }
    if (admitted.automation === true) {
      var bounded = applyAutomationExecutionBoundary(input, admitted);
      if (!bounded) return { ok: false, reason: "automation_external_policy_unavailable" };
      input = bounded.input;
      request = bounded.request;
    }
    if (options.requireOwnerImplementationDecision === true && request.mode !== "project_coordinator") {
      return { ok: false, reason: "persistent_project_coordinator_required" };
    }
    var assignmentConflict = projectIntake.conflict(request);
    if (assignmentConflict) return assignmentConflict;
    var existing = bindingStore.get(request.portfolioTaskId, request.bindingRevision);
    var equivalence = existing ? portfolioBindings.requestEquivalence(existing, request) : null;
    if (equivalence === "conflict") {
      return { ok: false, reason: "idempotency_conflict" };
    }
    if (adoption.sessionRef && existing && existing.coordinator &&
        !sameSessionRef(existing.coordinator, adoption.sessionRef)) {
      return { ok: false, reason: "primitive_session_binding_conflict" };
    }
    if (!existing && !claimInfrastructureAvailable(request)) {
      return { ok: false, reason: "coordinator_claim_unavailable" };
    }
    if (options.requireOwnerImplementationDecision === true && existing &&
        equivalence === "legacy" && existing.mode === "project_coordinator" && (!existing.projectCoordinator ||
        existing.projectCoordinator.projectId !== projectIdentity.LEAD_PROJECT_ID)) {
      return { ok: false, reason: "control_plane_migration_required", attention: true,
        binding: existing };
    }
    var replay = matchingCommittedBinding(existing, request);
    if (replay) return approvalDispatchResult(linkThreadHandoff(request, replay), admitted);
    var recovered = recoverCommittedCoordinatorClaim(input, request, existing);
    if (recovered) return approvalDispatchResult(linkThreadHandoff(request, recovered), admitted);
    // A prior attempt at THIS exact revision that ended re-armable -- unrouted,
    // or unavailable after a lost coordinator claim or a failed cleanup -- is a
    // retry, not a stale revision. Treating it as current made the retry return
    // stale_binding_revision before it ever reached reserve(), so recovery from
    // a lost claim could never converge: not replayable, not restartable.
    var retryable = existing && (existing.status === "unrouted" || existing.status === "unavailable");
    var restaffRearm = !!(retryable && existing.automationAuthorization);
    var current = retryable ? null : bindingStore.get(request.portfolioTaskId);
    // A direct leaf that asks for scope expansion terminalizes before its owner
    // can promote it. Its binding is therefore no longer current, but it is
    // still the exact predecessor the promotion must stop and supersede.
    if (!current && !input._promotionReady && request.mode === "project_coordinator" &&
        (input.reason === "scope_expansion" || input.scopeExpansion === true)) {
      current = latestPriorBinding(request.portfolioTaskId, request.bindingRevision);
    }
    if (isScopePromotion(input, request, current)) {
      return promoteProjectExecution(Object.assign({}, input, {
        fromBindingRevision: current.bindingRevision,
      }));
    }
    if (options.requireOwnerImplementationDecision === true || adoption.sessionRef) {
      var stageAssignment = !intakeTicket && projectIntake.enabled() &&
        admitted.automation !== true && admitted.reviewOnly !== true && !adoption.sessionRef;
      var routed = controlPlaneRoute(input, request, target, intakeTicket, stageAssignment);
      if (!routed.ok) return routed;
      if (routed.assignment) return approvalDispatchResult(routed.assignment, admitted);
      input = routed.input;
    } else {
      var projectCoordinator = canonicalProjectCoordinator(request);
      if (projectCoordinator) input = Object.assign({}, input, {
        targetProjectCoordinator: projectCoordinator,
      });
    }
    if (adoption.sessionRef) {
      return approvalDispatchResult(linkThreadHandoff(request,
        createAndCommitAdoptedExecution(input, request, target, adoption.sessionRef)), admitted);
    }
    return approvalDispatchResult(linkThreadHandoff(request,
      createAndCommitExecution(restaffRearm ? Object.assign({}, input, {
        _restaffRearm: true,
      }) : input, request, target)), admitted);
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
      return accessDenied(input, request);
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
      return accessDenied(input, request);
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
      request.bindingRevision, delivered.sessionRef, {
        projectCoordinatorRef: delivered.projectCoordinatorRef,
      });
    if (!committed.ok) return bindingAttention(request, committed.reason);
    // A migrated project coordinator is still a project coordinator: it must
    // hold the same durable claim. This path committed an active binding and
    // reported success without claiming at all, so a migration could quietly
    // create a second coordinator for a pair already owned.
    var migratedClaim = verifiedTopicClaim(input, request,
      delivered.projectCoordinatorRef || delivered.sessionRef);
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

  function resumeResidentControlPlaneTask(leadManager, root, request, binding, delivered) {
    var targetRef = projectIdentity.normalizeSessionRef(delivered && delivered.sessionRef);
    var boundRef = projectIdentity.normalizeSessionRef(binding && binding.coordinator);
    if (!targetRef || !boundRef || !sameSessionRef(targetRef, boundRef)) {
      return { ok: false, reason: "target_reactivation_unverified" };
    }
    var task = coopControlPlane.taskForRequest(root, request);
    var taskRef = projectIdentity.normalizeSessionRef(task && (task.workerSessionRef || {
      projectId: request.targetProject.projectId,
      sessionStorageId: task.workerStorageId,
    }));
    if (!task || !task.externalTaskCoordinator || !taskRef || !sameSessionRef(taskRef, targetRef)) {
      return { ok: false, reason: "control_plane_task_projection_mismatch" };
    }
    if (task.status === "running") return { ok: true, duplicate: true };
    if (!coopControlPlane.bindTask(leadManager, root, task, targetRef)) {
      return { ok: false, reason: "control_plane_task_projection_failed" };
    }
    return { ok: true };
  }

  function messageProjectExecution(input) {
    var portfolioTaskId = String(input && input.portfolioTaskId || "");
    var binding = bindingStore.get(portfolioTaskId, Number(input && input.bindingRevision)) ||
      bindingStore.get(portfolioTaskId);
    if (!binding) return { ok: false, reason: "binding_not_found" };
    var requestedProject = projectIdentity.normalizeProjectRef(input && input.targetProject);
    var requestedCoordinator = projectIdentity.normalizeSessionRef(input && input.targetCoordinator);
    var bindingCoordinator = binding.mode === "project_coordinator" ? binding.coordinator : null;
    var bindingProjectCoordinator = binding.mode === "project_coordinator" ?
      projectIdentity.normalizeSessionRef(binding.projectCoordinator) : null;
    var typedCoordinatorSteer = !!(input && (input.targetProject || input.targetCoordinator));
    if (typedCoordinatorSteer && (!requestedProject || requestedProject.projectId !== binding.targetProject.projectId)) {
      return bindingAttention(binding, "binding_target_mismatch");
    }
    var controlPlaneBinding = bindingProjectCoordinator &&
      bindingProjectCoordinator.projectId === projectIdentity.LEAD_PROJECT_ID;
    if (options.requireOwnerImplementationDecision === true &&
        binding.mode === "project_coordinator" && !controlPlaneBinding) {
      return { ok: false, reason: "control_plane_migration_required", attention: true,
        binding: binding };
    }
    // A control-plane binding has two legal coordinator identities: the resident
    // Lead-side root that relays the command, and the project-owned coordinator
    // it relays to. The MCP front door already accepts either shape
    // (project-task-orchestrator-steering.js checks targetCoordinator.projectId
    // against LEAD_PROJECT_ID *or* targetProject), and the caller-supplied ref is
    // only an identity assertion: the binding was selected by
    // (portfolioTaskId, bindingRevision) above, and delivery below always uses
    // the binding's own refs, never this one. So honouring both shapes cannot
    // select different work, change the relay source, or widen authority --
    // while accepting only the Lead-side ref made the documented project-owned
    // shape unreachable for every migrated binding, which is every binding.
    var steeringRefMatches = controlPlaneBinding ?
      sameSessionRef(requestedCoordinator, bindingProjectCoordinator) ||
        sameSessionRef(requestedCoordinator, bindingCoordinator) :
      sameSessionRef(requestedCoordinator, bindingCoordinator);
    if (typedCoordinatorSteer && binding.mode === "project_coordinator" &&
        controlPlaneBinding && steeringRefMatches && !bindingCoordinator) {
      return { ok: false, reason: "binding_pending", retryable: true, binding: binding };
    }
    if (typedCoordinatorSteer && (binding.mode !== "project_coordinator" || !bindingCoordinator ||
        !steeringRefMatches)) {
      // A caller that guessed the ref cannot learn the right one from a bare
      // reason string, and no read tool returns a binding's coordinator refs.
      // Report the legal identities so a genuinely wrong ref self-corrects
      // instead of turning into another round of guessing.
      return bindingAttention(binding, "coordinator_ref_mismatch", {
        expectedCoordinators: [bindingProjectCoordinator, bindingCoordinator]
          .map(function (ref) { return projectIdentity.normalizeSessionRef(ref); })
          .filter(Boolean)
          .map(function (ref) {
            return { projectId: ref.projectId, sessionStorageId: ref.sessionStorageId };
          }),
      });
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
      return accessDenied(input, request);
    }
    // Resident control-plane roots are persistent authority, not disposable
    // transcript tabs. Steering reactivates an archived root before it relays
    // the exact command to the target-project task coordinator.
    var resident = null;
    var leadManager = null;
    if (binding.mode === "project_coordinator" && controlPlaneBinding) {
      var leadContext = resolveProjectContextById(projectIdentity.LEAD_PROJECT_ID);
      leadManager = sessionManagerForContext(leadContext);
      var canonical = coopSessionRef();
      resident = leadManager && canonical ? coopControlPlane.ensureProjectCoordinator(
        leadManager, binding.targetProject, projectTitle(target.context), canonical) : null;
      var residentRef = projectIdentity.sessionRef(
        { projectId: projectIdentity.LEAD_PROJECT_ID }, resident);
      if (!residentRef || !sameSessionRef(residentRef, bindingProjectCoordinator)) {
        return bindingAttention(request, "project_coordinator_recovery_failed");
      }
    }
    var ref = binding.mode === "project_coordinator" ? binding.coordinator : binding.worker;
    if (!ref) return { ok: false, reason: "binding_pending" };
    var relaySource = binding.mode === "project_coordinator" && controlPlaneBinding ?
      bindingProjectCoordinator :
      projectIdentity.normalizeSessionRef(input.source);
    if (binding.mode === "project_coordinator" && controlPlaneBinding &&
        (!relaySource || relaySource.projectId !== projectIdentity.LEAD_PROJECT_ID)) {
      return bindingAttention(request, "project_coordinator_authority_missing");
    }
    var delivered = deliverExecutionCommand(target.context, executionEnvelope(Object.assign({}, input, {
      source: relaySource,
      targetProjectCoordinator: controlPlaneBinding ? relaySource : bindingProjectCoordinator,
      text: String(input.text || input.message || "").trim(),
    }), request, "portfolio_execution_message", ref));
    if (!delivered || delivered.ok !== true) {
      return bindingAttention(request, delivered && delivered.reason || "delivery_error", {
        pending: true,
      });
    }
    if (binding.mode === "project_coordinator" && controlPlaneBinding) {
      var projected = resumeResidentControlPlaneTask(leadManager, resident, request, binding, delivered);
      if (!projected.ok) return bindingAttention(request, projected.reason);
    }
    // A rejected stale/wrong-ref steering attempt marks the binding for
    // attention. Once an exact subsequent command is durably accepted, that
    // attention is no longer truthful and must not keep the active execution
    // projected as waiting while it is visibly running.
    if (typeof bindingStore.markAvailable === "function") {
      var reactivate = binding.mode === "project_coordinator" &&
        binding.status === "needs_input" &&
        typeof bindingStore.markProjectCoordinatorAvailable === "function" ?
        bindingStore.markProjectCoordinatorAvailable : bindingStore.markAvailable;
      var available = reactivate.call(bindingStore, binding.portfolioTaskId,
        binding.bindingRevision, ref);
      if (!available || available.ok !== true) {
        return bindingAttention(request, available && available.reason || "binding_reactivation_failed");
      }
    }
    reconcileSessionLedger();
    return delivered;
  }

  function dismissProjectExecution(input) {
    var portfolioTaskId = String(input && input.portfolioTaskId || "").trim();
    var revision = Number(input && input.bindingRevision);
    var binding = bindingStore.get(portfolioTaskId, revision);
    var source = projectIdentity.normalizeSessionRef(input && input.source);
    var targetProject = projectIdentity.normalizeProjectRef(input && input.targetProject);
    var projectCoordinator = projectIdentity.normalizeSessionRef(binding && binding.projectCoordinator);
    if (!binding || binding.mode !== "project_coordinator" || !source ||
        !projectCoordinator || !sameSessionRef(source, projectCoordinator) ||
        !targetProject || targetProject.projectId !== binding.targetProject.projectId ||
        !binding.coordinator) return { ok: false, reason: "invalid_project_execution_dismissal" };
    var request = {
      portfolioTaskId: binding.portfolioTaskId,
      targetProject: binding.targetProject,
      bindingRevision: binding.bindingRevision,
      idempotencyKey: String(input.idempotencyKey || "dismiss-" + crypto.randomUUID()),
      mode: binding.mode,
    };
    var target = executionTarget(request);
    if (!target.ok) return { ok: false, reason: target.reason || "access_denied" };
    if (!authorizedExecution({ source: source }, request, target.context)) {
      return accessDenied({ source: source }, request);
    }
    var stopped = deliverExecutionCommand(target.context, executionEnvelope({
      source: source,
      targetProjectCoordinator: projectCoordinator,
      reason: String(input.reason || "dismissed").slice(0, 240),
    }, request, "portfolio_execution_stop", binding.coordinator));
    if (!stopped || stopped.ok !== true || stopped.terminal !== true) {
      return Object.assign({ ok: false }, stopped || { reason: "delivery_error" });
    }
    var immutable = binding.status === "completed" || binding.status === "failed" ||
      binding.status === "needs_input";
    var changed = immutable ? { ok: true, binding: binding } :
      bindingStore.supersede(binding.portfolioTaskId, binding.bindingRevision,
        String(input.reason || "source_task_dismissed").slice(0, 240));
    if (changed && changed.ok) reconcileSessionLedger();
    return changed;
  }

  function completionSourceMatches(binding, source, refName) {
    if (sameSessionRef(binding && binding[refName], source)) return true;
    var context = binding && binding.targetProject &&
      resolveProjectContextById(binding.targetProject.projectId);
    var manager = sessionManagerForContext(context);
    return portfolioBindings.sourceContinuesBinding(manager, binding, source);
  }

  function reportAutoLaunchExecution(input) {
    var report = input && typeof input === "object" ? input : {};
    var source = projectIdentity.normalizeSessionRef(report.sessionRef);
    var taskId = String(report.portfolioTaskId || "").trim();
    var revision = Number(report.bindingRevision);
    var status = report.status === "completed" ? "completed" :
      (report.status === "needs_input" ? "needs_input" : "");
    var eventId = String(report.eventId || "").trim();
    if (!source || !taskId || !Number.isInteger(revision) || revision < 1 ||
        !status || !eventId) return { ok: false, reason: "invalid_auto_launch_report" };
    var binding = bindingStore.get(taskId, revision);
    if (!binding || binding.mode !== "project_coordinator" ||
        !sameSessionRef(binding.coordinator, source) ||
        !binding.automationAuthorization ||
        binding.automationAuthorization.kind !== automationAuthorization.PRIMITIVE_KIND) {
      return { ok: false, reason: "auto_launch_binding_mismatch" };
    }
    var target = resolveProjectContextById(binding.targetProject.projectId);
    var manager = sessionManagerForContext(target);
    var session = portfolioBindings.sessionByRef(manager, source, source.projectId);
    var metadata = portfolioBindings.sessionExecutionBinding(session);
    if (!metadata || metadata.portfolioTaskId !== taskId ||
        metadata.bindingRevision !== revision ||
        metadata.idempotencyKey !== binding.idempotencyKey) {
      return { ok: false, reason: "auto_launch_session_mismatch" };
    }
    var lead = resolveProjectContextById(projectIdentity.LEAD_PROJECT_ID);
    var leadManager = sessionManagerForContext(lead);
    var root = coopControlPlane.projectCoordinatorFor(leadManager, binding.targetProject);
    var rootRef = projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, root);
    if (!root || !sameSessionRef(rootRef, binding.projectCoordinator)) {
      return { ok: false, reason: "auto_launch_project_coordinator_mismatch" };
    }
    if (status === "needs_input") {
      if (["completed", "failed", "superseded", "cancelled", "deleted"].indexOf(binding.status) !== -1) {
        return { ok: true, ignored: true, status: binding.status,
          reason: "auto_launch_binding_terminal" };
      }
      var raised = coopControlPlane.completeTask(leadManager, root, binding,
        "needs_input", report.summary || "");
      if (raised && leadManager && typeof leadManager.broadcastSessionList === "function") {
        leadManager.broadcastSessionList();
      }
      return raised ? { ok: true, status: status } :
        { ok: false, reason: "auto_launch_task_report_failed" };
    }
    var completed = bindingStore.complete(taskId, revision, {
      eventId: eventId,
      completedAt: typeof report.completedAt === "number" ? report.completedAt :
        (options.now || Date.now)(),
      terminalStatus: "completed",
      executionMode: "project_coordinator",
      ownerNotification: false,
    });
    if (completed.ok) {
      coopControlPlane.completeTask(leadManager, root, binding, "completed", report.summary || "");
      if (leadManager && typeof leadManager.broadcastSessionList === "function") {
        leadManager.broadcastSessionList();
      }
      reconcileSessionLedger();
      if (!completed.duplicate && onPortfolioExecutionTerminal) {
        try { onPortfolioExecutionTerminal(); } catch (e) {}
      }
    }
    return completed;
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
    var completionDestination = binding && binding.mode === "project_coordinator" &&
      binding.projectCoordinator && binding.projectCoordinator.projectId === projectIdentity.LEAD_PROJECT_ID ?
      binding.projectCoordinator : binding && binding.source;
    if (!binding || binding.mode !== mode || !completionSourceMatches(binding, source, refName) ||
        completionDestination && !sameSessionRef(completionDestination, destination)) {
      return { ok: false, reason: "binding_mismatch" };
    }
    var completed = bindingStore.complete(taskId, revision, {
      eventId: envelope.eventId,
      completedAt: payload.completedAt,
      ownerNotification: payload.ownerNotification === true,
      resultEventId: payload.resultEventId,
      terminalStatus: payload.terminalStatus,
      executionMode: mode,
      controlRole: payload.controlRole,
      reviewOnly: payload.reviewOnly === true,
      visualCanaryUnavailable: payload.visualCanaryUnavailable === true,
      ownerAcceptanceRequired: payload.ownerAcceptanceRequired === true,
      ownerAcceptance: payload.ownerAcceptance,
      implementationCompletedAt: payload.implementationCompletedAt,
      implementationCompletionRevision: payload.implementationCompletionRevision,
      implementationGraphDigest: payload.implementationGraphDigest,
    });
    if (completed.ok) {
      if (binding.mode === "project_coordinator" && binding.projectCoordinator &&
          binding.projectCoordinator.projectId === projectIdentity.LEAD_PROJECT_ID) {
        var lead = resolveProjectContextById(projectIdentity.LEAD_PROJECT_ID);
        var manager = sessionManagerForContext(lead);
        var root = coopControlPlane.projectCoordinatorFor(manager, binding.targetProject);
        var rootRef = projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, root);
        if (sameSessionRef(rootRef, binding.projectCoordinator)) {
          coopControlPlane.completeTask(manager, root, binding,
            payload.terminalStatus || "completed", payload.resultSummary || payload.summary || "");
          if (manager && typeof manager.broadcastSessionList === "function") {
            manager.broadcastSessionList();
          }
        }
      }
      reconcileSessionLedger();
    }
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
  function canRunCoordinatorUpdate(slug) {
    return controlledIngress === "open" && (slug !== "lead" || options.projectCoordinatorIntake !== true ||
      typeof options.isLeadModeEnabled === "function" && options.isLeadModeEnabled());
  }

  function retryCoordinatorUpdates() {
    if (controlledIngress !== "open") return;
    registeredProjectResolvers.forEach(function (context) {
      var manager = sessionManagerForContext(context);
      var api = context.getTaskOrchestrator && context.getTaskOrchestrator();
      if (!manager || !manager.sessions || !api || !api.flushCoordinatorUpdates) return;
      if (api.flushPlanningReports) api.flushPlanningReports();
      manager.sessions.forEach(function (session) { api.flushCoordinatorUpdates(session); });
    });
  }

  var stopDeliveryRetry = startDeliveryRetry({
    intervalMs: options.deliveryRetryIntervalMs,
    isReady: function () { return controlledIngress === "open"; },
    retryPending: function () {
      durable.retryPending();
      retryCoordinatorUpdates();
      if (controlledIngress === "open") projectIntake.retryPending();
    },
    recordRecoveryEvent: recordRecoveryEvent,
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

  var migrateControlPlaneBinding = createControlPlaneBindingMigration({
    bindingStore: bindingStore,
    ownerRequests: ownerRequests,
    resolveProjectContextById: resolveProjectContextById,
    sessionManagerForContext: sessionManagerForContext,
    coopSessionRef: coopSessionRef,
    canonicalCoopSession: canonicalCoopSession,
    projectTitle: projectTitle,
    canCreateExecution: options.canCreateExecution,
    reconcileSessionLedger: reconcileSessionLedger,
  });

  var getControlSessionContext = createControlRoleContext({
    projectContextsById: projectContextsById,
    sessionManagerForContext: sessionManagerForContext,
  });

  var projectIntake = createProjectIntake({
    enabled: options.projectCoordinatorIntake === true && options.requireOwnerImplementationDecision === true,
    now: options.now,
    isLeadModeEnabled: options.isLeadModeEnabled || function () { return false; },
    getControlSessionContext: getControlSessionContext,
    leadManager: function () {
      return sessionManagerForContext(resolveProjectContextById(projectIdentity.LEAD_PROJECT_ID));
    },
    linkThread: linkThreadHandoff,
    dispatch: createProjectExecution,
    canCancel: function (payload) {
      var binding = bindingStore.get(payload.portfolioTaskId, payload.bindingRevision);
      if (binding && (binding.status !== "unrouted" || binding.coordinator || binding.worker)) return false;
      var manager = sessionManagerForContext(resolveProjectContextById(payload.targetProject.projectId));
      return !!(manager && !portfolioBindings.findExecutionSession(manager,
        payload.portfolioTaskId, payload.bindingRevision));
    },
    existingExecution: function (payload, root) {
      var request = portfolioBindings.normalizeRequest(payload);
      var binding = request && bindingStore.get(request.portfolioTaskId, request.bindingRevision);
      var rootRef = projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, root);
      if (!binding || !binding.coordinator || portfolioBindings.requestEquivalence(binding, request) !== "same" ||
          !sameSessionRef(binding.projectCoordinator, rootRef)) return null;
      return Object.assign(executionResult(binding, false, null), { phase: "execution_recorded" });
    },
    notifyCoordinator: function (root, text) {
      var lead = resolveProjectContextById(projectIdentity.LEAD_PROJECT_ID);
      return !!(lead && typeof lead.deliverCoordinatorUpdate === "function" &&
        lead.deliverCoordinatorUpdate(projectIdentity.sessionStorageId(root), text));
    },
    createAttention: function (root, task) {
      var destination = coopSessionRef();
      if (!destination) return null;
      return durable.queueEnvelope({
        eventId: "assignment-attention-" + task.taskId +
          (task.projectAssignment.attentionGeneration ? "-" + task.projectAssignment.attentionGeneration : ""),
        source: projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, root),
        destination: destination,
        bindingRevision: task.projectAssignment.payload.bindingRevision,
        payload: { type: "coordinator_update", text: "Project assignment still needs coordinator acceptance: " +
          JSON.stringify(task.projectAssignment.taskRef) + ". Inspect its pending scope and provider status." },
      });
    },
    deliverAttention: durable.deliverEnvelope,
  });

  return {
    getControlSessionContext: getControlSessionContext,
    deliver: deliver,
    legacyTextAuthoritative: false,
    createEnvelope: durable.createEnvelope,
    deliverEnvelope: durable.deliverEnvelope,
    retryPending: durable.retryPending,
    canRunCoordinatorUpdate: canRunCoordinatorUpdate,
    retryCoordinatorUpdates: retryCoordinatorUpdates,
    stopDeliveryRetry: stopDeliveryRetry,
    getPendingEventIds: durable.getPendingEventIds,
    getDeadLetters: durable.getDeadLetters,
    getDeliveryState: durable.getState,
    bindingStore: bindingStore,
    sessionLedger: sessionLedger,
    createExecution: guardControlledIngress(function (input) { return createProjectExecution(input); }),
    createProjectExecution: guardControlledIngress(function (input) { return createProjectExecution(input); }),
    acceptProjectAssignment: guardControlledIngress(projectIntake.accept),
    cancelPendingProjectAssignment: guardControlledIngress(projectIntake.cancel),
    retryProjectAssignments: guardControlledIngress(function () {
      retryCoordinatorUpdates();
      return projectIntake.retryPending();
    }),
    completeDirectLeafExecution: guardControlledIngress(completeDirectLeafExecution),
    completeProjectCoordinatorExecution: guardControlledIngress(completeProjectCoordinatorExecution),
    reportAutoLaunchExecution: guardControlledIngress(reportAutoLaunchExecution),
    dismissProjectExecution: guardControlledIngress(dismissProjectExecution),
    acknowledgeDirectLeafCompletion: guardControlledIngress(acknowledgeDirectLeafCompletion),
    completedDirectLeafUpdate: completedDirectLeafUpdate,
    completeControlledStartup: completeControlledStartup,
    controlledExecutionEnabled: function () { return controlledExecutionEnabled; },
    controlledIngressState: function () { return controlledIngress; },
    coopSessionRef: coopSessionRef,
    getBinding: bindingStore.get,
    getExecutionBinding: bindingStore.get,
    getExecutionBindings: getExecutionBindings,
    hasExecutionBindingSnapshot: hasExecutionBindingSnapshot,
    withExecutionBindingSnapshot: withExecutionBindingSnapshot,
    queryCoopSessions: queryCoopSessions,
    reconcileSessionLedger: reconcileSessionLedger,
    rebindProjectCoordinator: bindingStore.rebindProjectCoordinator,
    currentTopicSessionEvidence: currentTopicSessionEvidence,
    topicSessionEvidence: topicSessionEvidence,
    topicCleanupCandidates: topicCleanupCandidates,
    markExecutionDeleted: bindingStore.markDeleted,
    markExecutionUnavailable: bindingStore.markUnavailable,
    retireExecutionBinding: bindingStore.retireForDisqualification,
    failControlledStartup: failControlledStartup,
    migrateControlPlaneBinding: guardControlledIngress(migrateControlPlaneBinding),
    migrateLegacyExecution: guardControlledIngress(migrateLegacyExecution),
    migrateLegacyLeadExecution: guardControlledIngress(migrateLegacyExecution),
    messageExecution: guardControlledIngress(messageProjectExecution),
    messageProjectExecution: guardControlledIngress(messageProjectExecution),
    prepareControlledRestart: prepareControlledRestart,
    promoteExecution: guardControlledIngress(promoteProjectExecution),
    promoteProjectExecution: guardControlledIngress(promoteProjectExecution),
    reconcileStrandedCompletions: reconcileStrandedCompletions,
    reconcileRestartSupersessions: reconcileRestartSupersessions,
    runExecutionReaper: executionReaperRuntime.run,
    registerProjectResolver: registerProjectResolver,
    switchProjectExecutionProvider: guardControlledIngress(switchProjectExecutionProvider),
  };
}

module.exports = { createCrossProjectRouter: createCrossProjectRouter };
