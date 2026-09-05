// Durable assignment records live with the resident coordinator's task graph.
// Their immutable admitted payload is separate from editable task presentation.
var crypto = require("crypto");
var identity = require("./project-identity");
var bindings = require("./portfolio-execution-bindings");
var graph = require("./orchestration-task-graph");
var plane = require("./coop-control-plane");

var SCHEMA = "clay.project_assignment";
var INACTIVE = { cancelled: true, dismissed: true, superseded: true, completed: true, failed: true };
var PHASES = { pending: true, accepting: true, accepted: true, attention: true, cancelled: true };
var INPUT_FIELDS = ["title", "objective", "context", "acceptanceCriteria", "ownedPaths",
  "dependencies", "imageRefs", "difficulty", "maxAttempts", "coopIngressId",
  "coopApprovalIngressId", "implementationGrantRef", "providerRouteId", "standingGrant",
  "actor", "reason", "scopeExpansion"];
var GRAPH_FIELDS = ["orchestrationTasks", "orchestrationEvents", "orchestrationGraphId",
  "orchestrationProjectCompletion"];

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  var result = {};
  Object.keys(value).sort().forEach(function (key) { result[key] = canonical(value[key]); });
  return result;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function admittedPayload(input, request) {
  var payload = {};
  INPUT_FIELDS.forEach(function (name) {
    if (input[name] !== undefined) payload[name] = clone(input[name]);
  });
  return Object.assign(payload, clone(request));
}

function persist(sm, root) {
  if (sm.saveSessionFile(root, { durable: true }) === false) {
    throw new Error("Project assignment was not saved");
  }
}

function commitGraph(sm, root, candidate) {
  var previous = {};
  GRAPH_FIELDS.forEach(function (name) {
    previous[name] = root[name];
    if (candidate[name] === undefined) delete root[name];
    else root[name] = candidate[name];
  });
  try { persist(sm, root); }
  catch (error) {
    GRAPH_FIELDS.forEach(function (name) {
      if (previous[name] === undefined) delete root[name];
      else root[name] = previous[name];
    });
    return { ok: false, reason: "assignment_persistence_failed" };
  }
  return { ok: true };
}

function taskRef(root, task) {
  return identity.taskRef({ projectId: identity.LEAD_PROJECT_ID }, root, task);
}

function valid(root, task) {
  var record = task && task.projectAssignment;
  var policy = plane.projectCoordinatorPolicy(root);
  if (!record || !record.payload || record.schema !== SCHEMA || record.version !== 1 ||
      !PHASES[record.phase] || !Number.isSafeInteger(record.notificationAttempts) ||
      record.notificationAttempts < 0 || !policy || !policy.projectRef ||
      record.digest !== digest(record.payload) ||
      JSON.stringify(record.taskRef) !== JSON.stringify(taskRef(root, task))) return false;
  var request = bindings.normalizeRequest(record.payload);
  return !!(request && request.mode === "project_coordinator" &&
    request.targetProject.projectId === policy.projectRef.projectId &&
    task.clientRef === plane.taskClientRef(request));
}

function closed(task) {
  return !!(task && (INACTIVE[task.status] || INACTIVE[task.projectAssignment && task.projectAssignment.phase]));
}

function stage(sm, root, input, request, now) {
  var payload = admittedPayload(input, request);
  var existing = plane.taskForRequest(root, request);
  if (existing) {
    if (closed(existing)) return { ok: false, reason: "assignment_closed" };
    if (!valid(root, existing) || existing.projectAssignment.digest !== digest(payload)) {
      return { ok: false, reason: "assignment_idempotency_conflict" };
    }
    return { ok: true, reused: true, task: existing };
  }
  var dependencies = plane.controlPlaneDependencies(root, input.dependencies);
  if (!dependencies) return { ok: false, reason: "invalid_dependencies" };
  var candidate = Object.assign({}, root, {
    orchestrationTasks: (root.orchestrationTasks || []).slice(),
    orchestrationEvents: (root.orchestrationEvents || []).slice(),
    orchestrationProjectCompletion: clone(root.orchestrationProjectCompletion),
  });
  var task = graph.createTask(candidate, Object.assign({}, input, {
    clientRef: plane.taskClientRef(request), dependencies: dependencies,
    coopTopicRef: request.coopTopicRef, coopProjectRef: request.targetProject,
  }));
  task.externalTaskCoordinator = true;
  task.currentActivity = "Awaiting project coordinator acceptance";
  task.projectAssignment = { schema: SCHEMA, version: 1, phase: "pending",
    taskRef: taskRef(root, task), payload: payload, digest: digest(payload),
    createdAt: now, notificationAttempts: 0, nextNotificationAt: now };
  var saved = commitGraph(sm, root, candidate);
  return saved.ok ? { ok: true, reused: false, task: task } : saved;
}

function update(sm, root, task, patch, presentation) {
  var previous = Object.assign({}, task);
  task.projectAssignment = Object.assign({}, task.projectAssignment, patch);
  Object.assign(task, presentation || {});
  try { persist(sm, root); }
  catch (error) {
    Object.keys(task).forEach(function (name) { delete task[name]; });
    Object.assign(task, previous);
    return { ok: false, reason: "assignment_persistence_failed" };
  }
  return { ok: true };
}

function queuedResult(root, task, reused) {
  var record = task.projectAssignment;
  return { ok: true, phase: "assignment_queued", queued: true, reused: !!reused,
    created: !reused, taskRef: clone(record.taskRef),
    projectCoordinatorRef: identity.sessionRef({ projectId: identity.LEAD_PROJECT_ID }, root),
    targetProject: clone(record.payload.targetProject),
    portfolioTaskId: record.payload.portfolioTaskId, bindingRevision: record.payload.bindingRevision,
    sessionRef: null, sessionStorageId: null };
}

module.exports = { stage: stage, valid: valid, closed: closed, update: update, queuedResult: queuedResult,
  clone: clone, taskRef: taskRef };
