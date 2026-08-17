// Persistent sessions that belong to Coop's control plane.
//
// Project coordinators live in the Lead project while retaining authority for
// one explicit ProjectRef. Council and Triage are persistent peers. Project
// execution sessions never live here.
var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var taskGraph = require("./orchestration-task-graph");
var recoveryLog = require("./recovery-log");

var CONTROL_PLANE_VERSION = 1;

// One canary line per stuck legacy binding per process: migrateLegacyHierarchy
// runs on every projection build, so an unconditional record would flood the
// bounded recovery log and evict genuine history.
var reportedBindingMigrationSkips = {};
function recordSkippedBindingMigration(legacyRef, rebound) {
  var key = (legacyRef && legacyRef.projectId || "") + " " +
    (legacyRef && legacyRef.sessionStorageId || "");
  if (reportedBindingMigrationSkips[key]) return;
  reportedBindingMigrationSkips[key] = true;
  recoveryLog.recordRecoveryEvent({
    kind: "startup_failure", stage: "control_plane_binding_migration", ok: false,
    detail: { legacyRef: legacyRef || null,
      reason: rebound && (rebound.reason || rebound.code) || "unavailable" },
  });
}
var LIVE_TASK_STATUS = { queued: true, ready: true, running: true, reviewing: true,
  blocked: true, failed: true, needs_input: true, waiting_user: true };

function storageId(session) {
  return session && (session.storageId || session.cliSessionId) || "";
}

function canonicalCoop(sm) {
  var found = null;
  if (!sm || !sm.sessions) return null;
  sm.sessions.forEach(function (session) {
    if (!found && session && session.coopHome === true && !session._deleted) found = session;
  });
  return found;
}

function controlPolicy(session) {
  return session && session.orchestrationPolicy &&
    session.orchestrationPolicy.coopControlPlane || null;
}

function projectCoordinatorPolicy(session) {
  var policy = controlPolicy(session);
  return policy && policy.role === "project_coordinator" ? policy : null;
}

function projectCoordinatorFor(sm, projectRef) {
  var target = projectIdentity.normalizeProjectRef(projectRef);
  var found = null;
  if (!target || !sm || !sm.sessions) return null;
  sm.sessions.forEach(function (session) {
    var policy = projectCoordinatorPolicy(session);
    if (!found && policy && policy.projectRef &&
        policy.projectRef.projectId === target.projectId && !session._deleted) found = session;
  });
  return found;
}

function peerFor(sm, role) {
  var found = null;
  if (!sm || !sm.sessions) return null;
  sm.sessions.forEach(function (session) {
    var policy = controlPolicy(session);
    if (!found && policy && policy.role === role && !session._deleted) found = session;
  });
  return found;
}

function controlledBy(coopRef, existing) {
  if (!coopRef) return existing || null;
  return {
    coopSessionStorageId: coopRef.sessionStorageId,
    since: existing && existing.since || Date.now(),
  };
}

function persistSession(sm, session) {
  sm.saveSessionFile(session, { durable: true });
  return session;
}

function createControlSession(sm, title, role, coopRef, projectRef) {
  var session = sm.createSessionRaw({
    storageId: crypto.randomUUID(),
    coordinationMode: role === "project_coordinator",
    coopControlledBy: controlledBy(coopRef, null),
  });
  session.title = title;
  session.titleManuallySet = true;
  session.hidden = false;
  session.closedAt = null;
  session.coordinationRole = role === "project_coordinator" ? "project_coordinator" : "coop_control_plane";
  session.orchestrationTasks = [];
  session.orchestrationEvents = [];
  session.orchestrationPolicy = Object.assign({}, session.orchestrationPolicy || {}, {
    coopControlPlane: {
      version: CONTROL_PLANE_VERSION,
      role: role,
      projectRef: projectRef || null,
      createdAt: Date.now(),
    },
  });
  return persistSession(sm, session);
}

function reactivate(sm, session, title, role, coopRef, projectRef) {
  var before = JSON.stringify({
    hidden: session.hidden,
    closedAt: session.closedAt,
    title: session.title,
    titleManuallySet: session.titleManuallySet,
    coordinationMode: session.coordinationMode,
    coordinationRole: session.coordinationRole,
    coopControlledBy: session.coopControlledBy,
    orchestrationPolicy: session.orchestrationPolicy,
  });
  var policy = controlPolicy(session) || {};
  session.hidden = false;
  session.closedAt = null;
  session.title = title;
  session.titleManuallySet = true;
  session.coordinationMode = role === "project_coordinator";
  session.coordinationRole = role === "project_coordinator" ? "project_coordinator" : "coop_control_plane";
  session.coopControlledBy = controlledBy(coopRef, session.coopControlledBy);
  if (!Array.isArray(session.orchestrationTasks)) session.orchestrationTasks = [];
  if (!Array.isArray(session.orchestrationEvents)) session.orchestrationEvents = [];
  session.orchestrationPolicy = Object.assign({}, session.orchestrationPolicy || {}, {
    coopControlPlane: Object.assign({}, policy, {
      version: CONTROL_PLANE_VERSION,
      role: role,
      projectRef: projectRef || null,
    }),
  });
  var after = JSON.stringify({
    hidden: session.hidden,
    closedAt: session.closedAt,
    title: session.title,
    titleManuallySet: session.titleManuallySet,
    coordinationMode: session.coordinationMode,
    coordinationRole: session.coordinationRole,
    coopControlledBy: session.coopControlledBy,
    orchestrationPolicy: session.orchestrationPolicy,
  });
  if (before !== after) persistSession(sm, session);
  return session;
}

function ensureProjectCoordinator(sm, projectRef, projectTitle, coopRef) {
  var target = projectIdentity.normalizeProjectRef(projectRef);
  if (!target) return null;
  var title = String(projectTitle || "Project").trim() + " coordinator";
  var existing = projectCoordinatorFor(sm, target);
  return existing ? reactivate(sm, existing, title, "project_coordinator", coopRef, target) :
    createControlSession(sm, title, "project_coordinator", coopRef, target);
}

function ensurePeer(sm, role, title, coopRef) {
  var existing = peerFor(sm, role);
  return existing ? reactivate(sm, existing, title, role, coopRef, null) :
    createControlSession(sm, title, role, coopRef, null);
}

function sessionByStorageId(sm, wanted) {
  var found = null;
  if (!sm || !sm.sessions || !wanted) return null;
  sm.sessions.forEach(function (session) {
    if (!found && storageId(session) === wanted) found = session;
  });
  return found;
}

function migrateTaskWorkers(targetManager, child, rootRef) {
  var changed = [];
  var tasks = Array.isArray(child && child.orchestrationTasks) ? child.orchestrationTasks : [];
  for (var i = 0; i < tasks.length; i++) {
    var task = tasks[i] || {};
    var wanted = task.workerStorageId || task.workerSessionStorageId;
    var worker = sessionByStorageId(targetManager, wanted);
    var parent = worker && worker.orchestrationParent;
    if (!worker || !parent || parent.sessionStorageId !== storageId(child) ||
        parent.taskId !== task.taskId) continue;
    var existing = worker.coopControlledBy && worker.coopControlledBy.coopSessionStorageId;
    if (existing === rootRef.sessionStorageId) continue;
    worker.coopControlledBy = controlledBy(rootRef, worker.coopControlledBy);
    targetManager.saveSessionFile(worker, { durable: true });
    changed.push(storageId(worker));
  }
  return changed;
}

function migrateLegacyHierarchy(leadManager, targetManager, root, projectRef, coopRef, migrateBinding) {
  var migrated = [];
  var rootRef = projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, root);
  if (!targetManager || !targetManager.sessions || !rootRef) return migrated;
  targetManager.sessions.forEach(function (legacyRoot) {
    if (!legacyRoot || legacyRoot.coordinationRole !== "project_coordinator" ||
        legacyRoot.orchestrationParent || !legacyRoot.coopControlledBy ||
        legacyRoot.coopControlledBy.coopSessionStorageId !== coopRef.sessionStorageId) return;
    var legacyRef = projectIdentity.sessionRef(projectRef, legacyRoot);
    if (typeof migrateBinding === "function") {
      var rebound = migrateBinding(legacyRef, rootRef);
      if (!rebound || rebound.ok !== true) {
        // This runs on every projection build. A deterministic failure here
        // used to skip the legacy hierarchy silently, forever -- a wedged
        // one-time migration with zero evidence anywhere. Record it once per
        // legacy root per process so the canary sees it without flooding.
        recordSkippedBindingMigration(legacyRef, rebound);
        return;
      }
    }
    var tasks = Array.isArray(legacyRoot.orchestrationTasks) ? legacyRoot.orchestrationTasks : [];
    for (var i = 0; i < tasks.length; i++) {
      var oldTask = tasks[i] || {};
      if (!oldTask.externalTaskCoordinator || !LIVE_TASK_STATUS[oldTask.status]) continue;
      var child = sessionByStorageId(targetManager,
        oldTask.workerStorageId || oldTask.workerSessionStorageId);
      if (!child || child.coordinationRole !== "task_coordinator") continue;
      var existingRoot = projectIdentity.normalizeSessionRef(child.projectCoordinatorRef);
      if (existingRoot && existingRoot.projectId === rootRef.projectId &&
          existingRoot.sessionStorageId === rootRef.sessionStorageId) {
        migrateTaskWorkers(targetManager, child, rootRef);
        continue;
      }
      var request = {
        portfolioTaskId: String(oldTask.clientRef || "").replace(/^portfolio:/, "").replace(/:[0-9]+$/, ""),
        bindingRevision: Number(String(oldTask.clientRef || "").match(/:([0-9]+)$/) &&
          String(oldTask.clientRef || "").match(/:([0-9]+)$/)[1]),
      };
      var task = request.portfolioTaskId && request.bindingRevision ? taskForRequest(root, request) : null;
      if (!task) {
        for (var ri = 0; ri < root.orchestrationTasks.length; ri++) {
          if (root.orchestrationTasks[ri] && root.orchestrationTasks[ri].taskId === oldTask.taskId) {
            task = root.orchestrationTasks[ri];
            break;
          }
        }
      }
      if (!task) {
        task = JSON.parse(JSON.stringify(oldTask));
        task.legacyControlPlaneMigration = true;
        root.orchestrationTasks.push(task);
      }
      var childRef = projectIdentity.sessionRef(projectRef, child);
      task.workerSessionRef = childRef;
      task.workerStorageId = childRef.sessionStorageId;
      child.projectCoordinatorRef = rootRef;
      child.projectCoordinatorProjectRef = projectRef;
      child.controlPlaneParent = { taskId: task.taskId, projectCoordinatorRef: rootRef };
      child.coopControlledBy = controlledBy(rootRef, child.coopControlledBy);
      var execution = child.orchestrationPolicy && child.orchestrationPolicy.portfolioExecution;
      if (execution) execution.source = rootRef;
      delete child.orchestrationParent;
      targetManager.saveSessionFile(child, { durable: true });
      migrated.push({ from: legacyRef, to: rootRef, taskCoordinatorRef: childRef,
        workerStorageIds: migrateTaskWorkers(targetManager, child, rootRef) });
    }
  });
  if (migrated.length) persistSession(leadManager, root);
  return migrated;
}

function ensureControlPlane(sm, projects) {
  var coop = canonicalCoop(sm);
  var coopRef = projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, coop);
  if (!coopRef) return { ok: false, reason: "canonical_coop_required", changed: false };
  var before = [];
  sm.sessions.forEach(function (session) {
    if (controlPolicy(session)) before.push(JSON.stringify({
      id: storageId(session), title: session.title, hidden: session.hidden,
      role: session.coordinationRole, policy: controlPolicy(session),
    }));
  });
  before.sort();
  var coordinators = [];
  var migrations = [];
  var list = Array.isArray(projects) ? projects : [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i] || {};
    var coordinator = ensureProjectCoordinator(sm, item.projectRef, item.title, coopRef);
    if (coordinator) {
      coordinators.push(coordinator);
      migrations = migrations.concat(migrateLegacyHierarchy(sm, item.manager,
        coordinator, item.projectRef, coopRef, item.migrateBinding));
    }
  }
  var council = ensurePeer(sm, "council", "Council", coopRef);
  var triage = ensurePeer(sm, "triage", "Triage", coopRef);
  var after = [];
  sm.sessions.forEach(function (session) {
    if (controlPolicy(session)) after.push(JSON.stringify({
      id: storageId(session), title: session.title, hidden: session.hidden,
      role: session.coordinationRole, policy: controlPolicy(session),
    }));
  });
  after.sort();
  return {
    ok: true,
    changed: JSON.stringify(before) !== JSON.stringify(after),
    coordinators: coordinators,
    council: council,
    triage: triage,
    migrations: migrations,
  };
}

function taskClientRef(request) {
  return "portfolio:" + request.portfolioTaskId + ":" + request.bindingRevision;
}

function taskForRequest(root, request) {
  var tasks = root && Array.isArray(root.orchestrationTasks) ? root.orchestrationTasks : [];
  var clientRef = taskClientRef(request);
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i] && tasks[i].clientRef === clientRef) return tasks[i];
  }
  return null;
}

function controlPlaneDependencies(root, value) {
  if (!Array.isArray(value)) return [];
  var rootStorageId = storageId(root);
  var result = [];
  for (var i = 0; i < value.length; i++) {
    var id = typeof value[i] === "string" ? value[i].trim() : "";
    if (!id) {
      var ref = projectIdentity.normalizeTaskRef(value[i]);
      if (!ref || ref.projectId !== projectIdentity.LEAD_PROJECT_ID ||
          ref.coordinatorSessionStorageId !== rootStorageId) return null;
      id = ref.taskId;
    }
    if (id && result.indexOf(id) === -1) result.push(id);
  }
  return result;
}

function prepareTask(sm, root, request, brief) {
  var task = taskForRequest(root, request);
  if (!task) {
    var dependencies = controlPlaneDependencies(root, brief.dependencies);
    if (!dependencies) return null;
    task = taskGraph.createTask(root, {
      taskId: "task-" + crypto.randomUUID(),
      clientRef: taskClientRef(request),
      title: brief.title,
      objective: brief.objective,
      context: brief.context,
      acceptanceCriteria: brief.acceptanceCriteria,
      ownedPaths: brief.ownedPaths,
      dependencies: dependencies,
      provider: brief.provider,
      model: brief.model,
      controlRole: brief.controlRole || request.controlRole,
      reviewOnly: brief.reviewOnly === true || request.reviewOnly === true,
      coopTopicRef: request.coopTopicRef,
      coopProjectRef: request.targetProject,
    });
  }
  task.externalTaskCoordinator = true;
  task.status = "queued";
  task.currentActivity = "Waiting for the project task coordinator";
  task.updatedAt = Date.now();
  persistSession(sm, root);
  return task;
}

function bindTask(sm, root, task, sessionRef) {
  var ref = projectIdentity.normalizeSessionRef(sessionRef);
  if (!root || !task || !ref) return false;
  task.workerSessionRef = ref;
  task.workerStorageId = ref.sessionStorageId;
  task.status = "running";
  task.currentActivity = "Task coordinator is running";
  task.updatedAt = Date.now();
  taskGraph.appendEvent(root, "task_coordinator_started", task, {
    taskCoordinatorRef: ref,
  });
  persistSession(sm, root);
  return true;
}

function removePreparedTask(sm, root, task) {
  if (!root || !task || task.workerSessionRef || !Array.isArray(root.orchestrationTasks)) return false;
  root.orchestrationTasks = root.orchestrationTasks.filter(function (candidate) {
    return candidate && candidate.taskId !== task.taskId;
  });
  root.orchestrationEvents = (root.orchestrationEvents || []).filter(function (event) {
    return !event || event.taskId !== task.taskId;
  });
  persistSession(sm, root);
  return true;
}

function completeTask(sm, root, request, status, summary) {
  var task = taskForRequest(root, request);
  if (!task) return false;
  var next = status === "completed" ? "completed" :
    (status === "needs_input" ? "needs_input" : "failed");
  task.status = next;
  task.currentActivity = next === "completed" ? "Task coordinator completed" :
    (next === "needs_input" ? "Task coordinator needs owner input" : "Task coordinator failed");
  task.resultSummary = String(summary || "").trim().slice(0, 4000);
  task.updatedAt = Date.now();
  taskGraph.appendEvent(root, "task_coordinator_" + next, task, {
    taskCoordinatorRef: task.workerSessionRef || null,
  });
  persistSession(sm, root);
  return true;
}

module.exports = {
  CONTROL_PLANE_VERSION: CONTROL_PLANE_VERSION,
  bindTask: bindTask,
  canonicalCoop: canonicalCoop,
  controlPolicy: controlPolicy,
  completeTask: completeTask,
  ensureControlPlane: ensureControlPlane,
  ensureProjectCoordinator: ensureProjectCoordinator,
  prepareTask: prepareTask,
  projectCoordinatorFor: projectCoordinatorFor,
  projectCoordinatorPolicy: projectCoordinatorPolicy,
  removePreparedTask: removePreparedTask,
  storageId: storageId,
  taskForRequest: taskForRequest,
};
