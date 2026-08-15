// Evidence-bound cleanup for a restart-only failed Coop task whose objective
// was later completed and independently verified by exact typed executions.
//
// This is intentionally not a general "hide failed work" policy. Every rule
// names the failed binding, its controller, every successor binding, and the
// reviewed commits. Any missing or contradictory record leaves the failure
// visible with an exact blocker.
var projectIdentity = require("./project-identity");
var normalizeControlledBy = require("./coop-control-provenance").normalizeControlledBy;

var MAX_SUCCESSORS = 16;
var COMMIT_RE = /^[0-9a-f]{10,40}$/;
var CODE_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
var UNSAFE_TASK_STATUSES = {
  queued: true, ready: true, running: true, reviewing: true,
  blocked: true, failed: true, needs_input: true, waiting_user: true,
};

var PRODUCTION_RESTART_SUPERSESSIONS = [{
  ruleId: "clay_restart_activation_reconciled_by_revisions_5_8",
  targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
  controllerSessionStorageId: "457f9fa1-7024-40cc-acee-2cef6b2b8445",
  failed: {
    portfolioTaskId: "clay-authorized-daemon-restart-activation-2026-08-14",
    bindingRevision: 1,
    coordinator: {
      projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "ea632d36-f673-4fb8-953d-892bf010e2d6",
    },
  },
  successors: [{
    portfolioTaskId: "clay-project-coordinator-visibility-session-cleanup-2026-08-15",
    bindingRevision: 5,
    coordinator: {
      projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "d2d87200-4781-47c5-a887-e218f2407dec",
    },
    projectCoordinator: {
      projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "585c5ab9-8526-498a-8a88-7fc105a290ac",
    },
  }, {
    portfolioTaskId: "clay-project-coordinator-visibility-session-cleanup-2026-08-15",
    bindingRevision: 6,
    coordinator: {
      projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "714e7e7f-7879-470e-a38c-88f677d1ab01",
    },
    projectCoordinator: {
      projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "585c5ab9-8526-498a-8a88-7fc105a290ac",
    },
  }, {
    portfolioTaskId: "clay-project-coordinator-visibility-session-cleanup-2026-08-15",
    bindingRevision: 7,
    coordinator: {
      projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "3455dc58-b6f3-45f1-9ca8-5075e30fdf36",
    },
    projectCoordinator: {
      projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "585c5ab9-8526-498a-8a88-7fc105a290ac",
    },
  }, {
    portfolioTaskId: "clay-project-coordinator-visibility-session-cleanup-2026-08-15",
    bindingRevision: 8,
    coordinator: {
      projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "b03c5b1a-5079-4199-8307-30456358967f",
    },
    projectCoordinator: {
      projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "585c5ab9-8526-498a-8a88-7fc105a290ac",
    },
  }],
  verifiedCommits: [
    "c24865ed8a394e90158540c40ba4222778a0f8e6",
    "6f4cf56e5edf23c54b109e5e0b9dc98a73f6ee31",
    "1fa9ed0f6dcf70529736844c43ed9ebd7d7cf7dd",
    "cbe920dc4b0fbb5c92fb27e119a77ede25f735c9",
  ],
}];

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sameRef(left, right) {
  var a = projectIdentity.normalizeSessionRef(left);
  var b = projectIdentity.normalizeSessionRef(right);
  return !!a && !!b && a.projectId === b.projectId &&
    a.sessionStorageId === b.sessionStorageId;
}

function cleanTaskId(value) {
  var taskId = String(value || "").trim();
  return projectIdentity.isTaskId(taskId) ? taskId : "";
}

function cleanRevision(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeSuccessor(value) {
  var item = value || {};
  var taskId = cleanTaskId(item.portfolioTaskId);
  var revision = cleanRevision(item.bindingRevision);
  var coordinator = projectIdentity.normalizeSessionRef(item.coordinator);
  var projectCoordinator = projectIdentity.normalizeSessionRef(item.projectCoordinator);
  var completedAt = finiteNumber(item.completedAt);
  if (!taskId || !revision || !coordinator || !projectCoordinator || completedAt === null) return null;
  var normalized = {
    portfolioTaskId: taskId,
    bindingRevision: revision,
    coordinator: coordinator,
    completedAt: completedAt,
  };
  normalized.projectCoordinator = projectCoordinator;
  if (typeof item.resultEventId === "string" && item.resultEventId) {
    normalized.resultEventId = item.resultEventId.slice(0, 256);
  }
  return normalized;
}

function normalizeRestartSupersessionEvidence(value) {
  var input = value || {};
  var ruleId = String(input.ruleId || "").trim();
  var failed = input.failed || {};
  var failedTaskId = cleanTaskId(failed.portfolioTaskId);
  var failedRevision = cleanRevision(failed.bindingRevision);
  var failedCoordinator = projectIdentity.normalizeSessionRef(failed.coordinator);
  var failedCompletedAt = finiteNumber(failed.completedAt);
  var reconciledAt = finiteNumber(input.reconciledAt);
  var controllerSessionStorageId = String(input.controllerSessionStorageId || "").trim();
  var successors = Array.isArray(input.successors) ? input.successors : [];
  var commits = Array.isArray(input.verifiedCommits) ? input.verifiedCommits : [];
  if (!CODE_RE.test(ruleId) || !CODE_RE.test(controllerSessionStorageId) ||
      !failedTaskId || !failedRevision || !failedCoordinator ||
      failedCompletedAt === null || reconciledAt === null || successors.length === 0 ||
      successors.length > MAX_SUCCESSORS || commits.length === 0 || commits.length > MAX_SUCCESSORS) {
    return null;
  }
  var normalizedSuccessors = [];
  for (var i = 0; i < successors.length; i++) {
    var successor = normalizeSuccessor(successors[i]);
    if (!successor) return null;
    normalizedSuccessors.push(successor);
  }
  var normalizedCommits = [];
  for (var ci = 0; ci < commits.length; ci++) {
    var commit = String(commits[ci] || "").trim().toLowerCase();
    if (!COMMIT_RE.test(commit)) return null;
    normalizedCommits.push(commit);
  }
  return {
    schemaVersion: 1,
    ruleId: ruleId,
    reason: "verified_restart_successor",
    reconciledAt: reconciledAt,
    controllerSessionStorageId: controllerSessionStorageId,
    failed: {
      portfolioTaskId: failedTaskId,
      bindingRevision: failedRevision,
      coordinator: failedCoordinator,
      failureReason: "restart_recovery",
      completedAt: failedCompletedAt,
    },
    successors: normalizedSuccessors,
    verifiedCommits: normalizedCommits,
  };
}

function bindingFor(bindings, taskId, revision) {
  var list = Array.isArray(bindings) ? bindings : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].portfolioTaskId === taskId &&
        list[i].bindingRevision === revision) return list[i];
  }
  return null;
}

function block(rule, reason, details) {
  return Object.assign({ ruleId: rule && rule.ruleId || "unknown", reason: reason }, details || {});
}

function executionFor(session) {
  return session && session.orchestrationPolicy &&
    session.orchestrationPolicy.portfolioExecution || null;
}

function unresolvedSessionReason(session, isActiveSession) {
  if (typeof isActiveSession === "function" && isActiveSession(session)) return "active_session";
  if (session.isProcessing || session.queryInstance || session.scheduledMessage) return "runtime_active";
  if (session.unread === true || Number(session.unread || session.unreadCount || 0) > 0) {
    return "unread_activity";
  }
  if (session.needsAttention || session.attention || Number(session.attentionCount || 0) > 0) {
    return "attention_flag";
  }
  var tasks = Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i] && UNSAFE_TASK_STATUSES[tasks[i].status]) return "unresolved_child_task";
  }
  return "";
}

function verifyFailed(rule, bindings, options) {
  var expected = rule.failed || {};
  var binding = bindingFor(bindings, expected.portfolioTaskId, expected.bindingRevision);
  if (!binding) return { blocker: block(rule, "failed_binding_missing", {
    portfolioTaskId: expected.portfolioTaskId, bindingRevision: expected.bindingRevision,
  }) };
  if (binding.status !== "failed" && binding.status !== "superseded") {
    return { blocker: block(rule, "failed_binding_status_mismatch", { status: binding.status }) };
  }
  if (!binding.targetProject || !rule.targetProject ||
      binding.targetProject.projectId !== rule.targetProject.projectId) {
    return { blocker: block(rule, "failed_project_mismatch", {
      projectId: binding.targetProject && binding.targetProject.projectId || null,
    }) };
  }
  if (!sameRef(binding.coordinator, expected.coordinator)) {
    return { blocker: block(rule, "failed_coordinator_mismatch", {
      sessionStorageId: binding.coordinator && binding.coordinator.sessionStorageId || null,
    }) };
  }
  var session = options.sessionForRef(expected.coordinator);
  if (!session) return { blocker: block(rule, "failed_session_missing", {
    sessionStorageId: expected.coordinator && expected.coordinator.sessionStorageId || null,
  }) };
  var controlledBy = normalizeControlledBy(session.coopControlledBy);
  if (!controlledBy || controlledBy.coopSessionStorageId !== rule.controllerSessionStorageId) {
    return { blocker: block(rule, "controller_mismatch", { sessionStorageId: session.storageId || null }) };
  }
  if (session.coordinationRole !== "task_coordinator") {
    return { blocker: block(rule, "failed_role_mismatch", { role: session.coordinationRole || null }) };
  }
  var execution = executionFor(session);
  var failureReason = execution && (execution.restartRecoveryFailureReason || execution.reason);
  if (!execution || execution.portfolioTaskId !== expected.portfolioTaskId ||
      execution.bindingRevision !== expected.bindingRevision || failureReason !== "restart_recovery" ||
      execution.status !== "failed" && execution.status !== "superseded") {
    return { blocker: block(rule, "restart_failure_evidence_mismatch", {
      sessionStorageId: session.storageId || null,
    }) };
  }
  var attention = unresolvedSessionReason(session, options.isActiveSession);
  if (attention) return { blocker: block(rule, attention, { sessionStorageId: session.storageId || null }) };
  var completedAt = finiteNumber(binding.completedAt || execution.terminalAt || execution.completedAt);
  if (completedAt === null) {
    return { blocker: block(rule, "failed_completion_time_missing", { sessionStorageId: session.storageId || null }) };
  }
  return { binding: binding, session: session, execution: execution, completedAt: completedAt };
}

function verifySuccessor(rule, expected, failedAt, bindings, options) {
  var binding = bindingFor(bindings, expected.portfolioTaskId, expected.bindingRevision);
  if (!binding) return { blocker: block(rule, "successor_binding_missing", {
    portfolioTaskId: expected.portfolioTaskId, bindingRevision: expected.bindingRevision,
  }) };
  if (binding.status !== "completed") return { blocker: block(rule, "successor_not_completed", {
    portfolioTaskId: expected.portfolioTaskId, bindingRevision: expected.bindingRevision,
    status: binding.status || null,
  }) };
  if (!binding.targetProject || !rule.targetProject ||
      binding.targetProject.projectId !== rule.targetProject.projectId) {
    return { blocker: block(rule, "successor_project_mismatch", {
      portfolioTaskId: expected.portfolioTaskId, bindingRevision: expected.bindingRevision,
    }) };
  }
  if (!sameRef(binding.coordinator, expected.coordinator) ||
      !sameRef(binding.projectCoordinator, expected.projectCoordinator)) {
    return { blocker: block(rule, "successor_reference_mismatch", {
      portfolioTaskId: expected.portfolioTaskId, bindingRevision: expected.bindingRevision,
    }) };
  }
  var session = options.sessionForRef(expected.coordinator);
  var execution = executionFor(session);
  var completion = session && session.orchestrationProjectCompletion;
  if (!session || !execution || !completion || execution.status !== "completed" ||
      execution.portfolioTaskId !== expected.portfolioTaskId ||
      execution.bindingRevision !== expected.bindingRevision || completion.status !== "completed" ||
      completion.portfolioTaskId !== expected.portfolioTaskId ||
      completion.bindingRevision !== expected.bindingRevision ||
      completion.integrationVerification !== "yes" || completion.escalationRequired !== "no" ||
      !String(completion.summary || "").trim() || !String(completion.verification || "").trim()) {
    return { blocker: block(rule, "successor_completion_evidence_mismatch", {
      portfolioTaskId: expected.portfolioTaskId, bindingRevision: expected.bindingRevision,
      sessionStorageId: expected.coordinator && expected.coordinator.sessionStorageId || null,
    }) };
  }
  var completedAt = finiteNumber(binding.completedAt || completion.completedAt || execution.completedAt);
  if (completedAt === null || completedAt <= failedAt) {
    return { blocker: block(rule, "successor_not_later", {
      portfolioTaskId: expected.portfolioTaskId, bindingRevision: expected.bindingRevision,
      completedAt: completedAt,
    }) };
  }
  return { evidence: {
    portfolioTaskId: expected.portfolioTaskId,
    bindingRevision: expected.bindingRevision,
    coordinator: clone(expected.coordinator),
    projectCoordinator: clone(expected.projectCoordinator),
    completedAt: completedAt,
    resultEventId: execution.projectCompletionResultEventId || "",
  } };
}

function buildEvidence(rule, failed, successors, nowValue) {
  return normalizeRestartSupersessionEvidence({
    ruleId: rule.ruleId,
    reconciledAt: nowValue,
    controllerSessionStorageId: rule.controllerSessionStorageId,
    failed: {
      portfolioTaskId: rule.failed.portfolioTaskId,
      bindingRevision: rule.failed.bindingRevision,
      coordinator: rule.failed.coordinator,
      completedAt: failed.completedAt,
    },
    successors: successors,
    verifiedCommits: rule.verifiedCommits,
  });
}

function applySupersession(rule, failed, evidence, options) {
  var result;
  if (failed.binding.status === "failed") {
    result = options.bindingStore.supersedeRestartRecovery(
      rule.failed.portfolioTaskId, rule.failed.bindingRevision, evidence);
    if (!result || !result.ok) return { blocker: block(rule, result && result.reason ||
      "binding_supersession_failed") };
  }
  var execution = failed.execution;
  var changed = execution.status !== "superseded" || !failed.session.hidden;
  execution.restartRecoveryFailureReason = "restart_recovery";
  execution.status = "superseded";
  execution.statusReason = "restart_recovery_superseded";
  execution.supersededAt = evidence.reconciledAt;
  execution.restartSupersession = clone(evidence);
  if (!failed.session.hidden) {
    if (typeof options.hideSession !== "function" || !options.hideSession(failed.session, evidence)) {
      return { blocker: block(rule, "session_hide_failed", {
        sessionStorageId: failed.session.storageId || null,
      }) };
    }
  } else if (changed && typeof options.saveSession === "function") {
    options.saveSession(failed.session);
  }
  return { reconciled: {
    ruleId: rule.ruleId,
    sessionStorageId: failed.session.storageId || null,
    outcome: changed ? "superseded_and_hidden" : "already_reconciled",
    evidence: evidence,
  } };
}

function reconcileRule(rule, bindings, options, nowValue) {
  var failed = verifyFailed(rule, bindings, options);
  if (failed.blocker) return failed;
  var successors = [];
  for (var i = 0; i < rule.successors.length; i++) {
    var verified = verifySuccessor(rule, rule.successors[i], failed.completedAt, bindings, options);
    if (verified.blocker) return verified;
    successors.push(verified.evidence);
  }
  var evidence = buildEvidence(rule, failed, successors, nowValue);
  if (!evidence) return { blocker: block(rule, "supersession_evidence_invalid") };
  return applySupersession(rule, failed, evidence, options);
}

function reconcileRestartSupersessions(input) {
  var options = input || {};
  var rules = Array.isArray(options.rules) ? options.rules : PRODUCTION_RESTART_SUPERSESSIONS;
  var store = options.bindingStore;
  if (!store || typeof store.list !== "function" ||
      typeof store.supersedeRestartRecovery !== "function" ||
      typeof options.sessionForRef !== "function") {
    return { ok: false, reason: "restart_supersession_dependencies_missing", reconciled: [], blocked: [] };
  }
  var bindings = store.list();
  var nowValue = typeof options.now === "function" ? options.now() : Date.now();
  var result = { ok: true, reconciled: [], blocked: [] };
  for (var i = 0; i < rules.length; i++) {
    var outcome = reconcileRule(rules[i], bindings, options, nowValue);
    if (outcome.blocker) result.blocked.push(outcome.blocker);
    else if (outcome.reconciled) result.reconciled.push(outcome.reconciled);
  }
  return result;
}

// Keeps the cross-project router hook small. The router supplies only its
// existing project registry primitives; this adapter owns exact SessionRef
// lookup plus projection-only persistence for the audited transition.
function createProjectRestartSupersessionReconciler(input) {
  var options = input || {};
  var resolvers = options.resolvers || [];
  var resolveProject = options.resolveProjectContextById;
  var managerForContext = options.sessionManagerForContext;

  function sessionAndManagerForRef(value) {
    var ref = projectIdentity.normalizeSessionRef(value);
    if (!ref || typeof resolveProject !== "function" ||
        typeof managerForContext !== "function") return null;
    var manager = managerForContext(resolveProject(ref.projectId));
    if (!manager || !manager.sessions || typeof manager.sessions.forEach !== "function") return null;
    var found = null;
    manager.sessions.forEach(function (session) {
      if (!found && session && (session.storageId === ref.sessionStorageId ||
          session.cliSessionId === ref.sessionStorageId)) found = session;
    });
    return found ? { session: found, manager: manager } : null;
  }

  function isActiveSession(session) {
    for (var i = 0; i < resolvers.length; i++) {
      var manager = managerForContext(resolvers[i]);
      if (manager && typeof manager.getActiveSession === "function" &&
          manager.getActiveSession() === session) return true;
    }
    return false;
  }

  function hideSession(session, evidence) {
    var failedRef = evidence && evidence.failed && evidence.failed.coordinator;
    var resolved = failedRef && sessionAndManagerForRef(failedRef);
    var manager = resolved && resolved.manager;
    if (!manager || resolved.session !== session || typeof manager.hideSession !== "function") return false;
    manager.hideSession(session.localId, null, { projectionOnly: true });
    return session.hidden === true;
  }

  function saveSession(session) {
    var execution = executionFor(session);
    var evidence = execution && execution.restartSupersession;
    var resolved = evidence && sessionAndManagerForRef(evidence.failed.coordinator);
    if (resolved && resolved.session === session &&
        typeof resolved.manager.saveSessionFile === "function") {
      resolved.manager.saveSessionFile(session);
    }
  }

  return function () {
    return reconcileRestartSupersessions({
      rules: options.rules,
      bindingStore: options.bindingStore,
      sessionForRef: function (ref) {
        var resolved = sessionAndManagerForRef(ref);
        return resolved && resolved.session || null;
      },
      isActiveSession: isActiveSession,
      hideSession: hideSession,
      saveSession: saveSession,
      now: options.now,
    });
  };
}

module.exports = {
  PRODUCTION_RESTART_SUPERSESSIONS: PRODUCTION_RESTART_SUPERSESSIONS,
  createProjectRestartSupersessionReconciler: createProjectRestartSupersessionReconciler,
  normalizeRestartSupersessionEvidence: normalizeRestartSupersessionEvidence,
  reconcileRestartSupersessions: reconcileRestartSupersessions,
};
