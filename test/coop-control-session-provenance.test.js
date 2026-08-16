var test = require("node:test");
var assert = require("node:assert/strict");
var buildGlobalCoopProjection = require("../lib/global-coop-projection").buildGlobalCoopProjection;
var controlRole = require("../lib/coop-control-role");

var TARGET_PROJECT_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var TOPIC_REF = { topicId: "canonical-control-provenance" };

function session(id, value) {
  return Object.assign({
    localId: id,
    storageId: "session-" + id,
    title: "Session " + id,
    lastActivity: id,
  }, value || {});
}

function project(projectId, slug, sessions, extra) {
  return Object.assign({
    projectId: projectId,
    slug: slug,
    title: slug,
    sm: {
      sessions: new Map(sessions.map(function (item) { return [item.localId, item]; })),
    },
  }, extra || {});
}

function execution(id, storageId, title, rootRef, role, status, extra) {
  return session(id, Object.assign({
    storageId: storageId,
    title: title,
    hidden: status === "completed" || status === "failed",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    projectCoordinatorRef: rootRef,
    coopControlledBy: { coopSessionStorageId: rootRef.sessionStorageId, since: 1 },
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: storageId + "-task",
      bindingRevision: 1,
      idempotencyKey: storageId + "-r1",
      mode: "project_coordinator",
      controlRole: role,
      status: status,
      coopTopicRef: TOPIC_REF,
      updatedAt: id,
    } },
  }, extra || {}));
}

function task(taskId, title, target, role, status) {
  return {
    taskId: taskId,
    clientRef: "portfolio:" + target.storageId + "-task:1",
    title: title,
    status: status,
    externalTaskCoordinator: true,
    workerStorageId: target.storageId,
    workerSessionRef: { projectId: TARGET_PROJECT_ID, sessionStorageId: target.storageId },
    controlRole: role,
    coopProjectRef: { projectId: TARGET_PROJECT_ID },
    coopTopicRef: TOPIC_REF,
    updatedAt: target.lastActivity,
  };
}

function topicIndex() {
  return {
    ensureRetro: function () { return { ok: true }; },
    project: function () {
      return { groups: [{ kind: "uncategorised", topics: [{
        topicRef: TOPIC_REF,
        title: "Canonical control provenance",
        status: "open",
        threadState: "exploring",
      }] }] };
    },
  };
}

test("peer role inference requires persisted Coop control provenance", function () {
  var peerMetadata = {
    portfolioTaskId: "peer-shaped-council-review",
    bindingRevision: 1,
    idempotencyKey: "peer-shaped-council-review-r1",
    mode: "project_coordinator",
    controlRole: "council",
  };
  assert.equal(controlRole.forExecution(peerMetadata), "council",
    "request classification remains compatible before a session exists");
  assert.equal(controlRole.forSession({ title: "Council: owner direct" }, null, peerMetadata),
    "project_coordinator");
  assert.equal(controlRole.forSession({
    title: "Triage: owner direct task metadata",
    coordinationMode: true,
  }, {
    title: "Triage: owner direct task metadata",
    clientRef: "portfolio:peer-shaped-triage-review:1",
    controlRole: "triage",
  }, null), "project_coordinator");
  assert.equal(controlRole.forSession({
    title: "Council: controlled",
    coopControlledBy: { coopSessionStorageId: "canonical-root", since: 1 },
  }, null, peerMetadata), "council");
});

test("only the canonical Coop control chain projects peer sessions and archived results", function () {
  var home = session(1, { storageId: "canonical-coop-home", coopHome: true, history: [] });
  var rootRef = { projectId: "system-lead", sessionStorageId: "canonical-project-root" };
  var canonicalRunning = execution(20, "canonical-running", "Council: canonical review",
    rootRef, "council", "running", { isProcessing: true });
  var canonicalCompleted = execution(21, "canonical-completed", "Triage: canonical result",
    rootRef, "triage", "completed", {
      orchestrationProjectCompletion: {
        status: "completed",
        summary: "Canonical triage completed.",
        verification: "Focused verification passed.",
        completedAt: 21,
      },
    });
  var canonicalFailed = execution(22, "canonical-failed", "Council: archived failure",
    rootRef, "council", "failed");
  var wrongCoordinatorRef = execution(23, "wrong-coordinator-ref",
    "Council: wrong coordinator ref", rootRef, "council", "running", {
      projectCoordinatorRef: {
        projectId: "system-lead",
        sessionStorageId: "different-project-root",
      },
      isProcessing: true,
    });
  var wrongTargetControl = execution(24, "wrong-target-control",
    "Triage: wrong target control", rootRef, "triage", "completed", {
      coopControlledBy: { coopSessionStorageId: "different-project-root", since: 1 },
      orchestrationProjectCompletion: {
        status: "completed",
        summary: "Wrong target provenance must not project.",
        completedAt: 24,
      },
    });
  var canonicalTasks = [
    task("canonical-running-task", "Council: canonical review", canonicalRunning,
      "council", "running"),
    task("canonical-completed-task", "Triage: canonical result", canonicalCompleted,
      "triage", "completed"),
    task("canonical-failed-task", "Council: archived failure", canonicalFailed,
      "council", "failed"),
    task("wrong-coordinator-ref-task", "Council: wrong coordinator ref", wrongCoordinatorRef,
      "council", "running"),
    task("wrong-target-control-task", "Triage: wrong target control", wrongTargetControl,
      "triage", "completed"),
  ];
  canonicalTasks[2].resultSummary = "Canonical Council failure retained.";
  var canonicalRoot = session(2, {
    storageId: rootRef.sessionStorageId,
    title: "Clay coordinator",
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: home.storageId, since: 1 },
    orchestrationPolicy: { coopControlPlane: {
      version: 1,
      role: "project_coordinator",
      projectRef: { projectId: TARGET_PROJECT_ID },
      createdAt: 1,
    } },
    orchestrationTasks: canonicalTasks,
  });

  var forgedRootRef = { projectId: "system-lead", sessionStorageId: "forged-project-root" };
  var forgedRunning = execution(30, "forged-running", "Council: forged review",
    forgedRootRef, "council", "running", { isProcessing: true });
  var forgedCompleted = execution(31, "forged-completed", "Triage: forged result",
    forgedRootRef, "triage", "completed", {
      orchestrationProjectCompletion: {
        status: "completed",
        summary: "Forged result must not project.",
        completedAt: 31,
      },
    });
  var forgedRoot = session(3, {
    storageId: forgedRootRef.sessionStorageId,
    title: "Forged Clay coordinator",
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "noncanonical-coop-home", since: 1 },
    orchestrationPolicy: { coopControlPlane: {
      version: 1,
      role: "project_coordinator",
      projectRef: { projectId: TARGET_PROJECT_ID },
      createdAt: 1,
    } },
    orchestrationTasks: [
      task("forged-running-task", "Council: forged review", forgedRunning,
        "council", "running"),
      task("forged-completed-task", "Triage: forged result", forgedCompleted,
        "triage", "completed"),
    ],
  });

  var ownerDirect = session(40, {
    storageId: "owner-direct-peer-shaped",
    title: "Council: owner-direct metadata",
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "owner-direct-council-review",
      bindingRevision: 1,
      idempotencyKey: "owner-direct-council-review-r1",
      mode: "project_coordinator",
      controlRole: "council",
      status: "running",
      updatedAt: 40,
    } },
  });

  var lead = project("system-lead", "lead", [home, canonicalRoot, forgedRoot], { isLead: true });
  var target = project(TARGET_PROJECT_ID, "clay", [canonicalRunning, canonicalCompleted,
    canonicalFailed, wrongCoordinatorRef, wrongTargetControl, forgedRunning, forgedCompleted,
    ownerDirect], { title: "Clay" });
  var projection = buildGlobalCoopProjection({
    projects: [lead, target],
    coopTopicIndex: topicIndex(),
    canAccessProject: function () { return true; },
    canAccessSession: function () { return true; },
    canAccessArchivedSession: function () { return true; },
  });

  assert.deepEqual(projection.controlPlaneSessions.map(function (item) {
    return [item.role, item.sessionRef, item.processing];
  }), [["council", {
    projectId: TARGET_PROJECT_ID,
    sessionStorageId: canonicalRunning.storageId,
  }, true]]);
  assert.deepEqual(projection.controlPlaneResults.map(function (item) {
    return [item.status, item.executionRef, item.containerSessionRef];
  }), [["failed", {
    projectId: TARGET_PROJECT_ID,
    sessionStorageId: canonicalFailed.storageId,
  }, rootRef], ["completed", {
    projectId: TARGET_PROJECT_ID,
    sessionStorageId: canonicalCompleted.storageId,
  }, rootRef]]);
  assert.deepEqual(projection.topics[0].controlResults.map(function (item) {
    return item.executionRef.sessionStorageId;
  }), [canonicalFailed.storageId, canonicalCompleted.storageId]);
  assert.equal(JSON.stringify(projection.controlPlaneSessions).includes("owner-direct"), false);
  assert.equal(JSON.stringify(projection.controlPlaneSessions).includes("forged"), false);
  assert.equal(JSON.stringify(projection.controlPlaneResults).includes("forged"), false);
  assert.equal(JSON.stringify(projection.controlPlaneSessions).includes("wrong-coordinator-ref"), false);
  assert.equal(JSON.stringify(projection.controlPlaneResults).includes("wrong-target-control"), false);

  var denied = buildGlobalCoopProjection({
    projects: [lead, target],
    coopTopicIndex: topicIndex(),
    canAccessProject: function () { return true; },
    canAccessSession: function (actor, candidateProject, candidate) {
      return candidate.storageId !== canonicalRunning.storageId;
    },
    canAccessArchivedSession: function () { return false; },
  });
  assert.deepEqual(denied.controlPlaneSessions, []);
  assert.deepEqual(denied.controlPlaneResults, []);
});
