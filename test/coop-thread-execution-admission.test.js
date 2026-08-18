var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var lifecycle = require("../lib/coop-thread-lifecycle");
var mainIngressRecovery = require("../lib/coop-main-ingress-recovery");
var threadsRecovery = require("../lib/coop-threads-implementation-recovery");
var queueAuthorization = require("../lib/coop-queue-authorization");
var automationAuthorization = require("../lib/project-automation-execution-authorization");
var automationCandidates = require("../lib/project-automation-candidates");
var automationIdentity = require("../lib/project-automation-identity");
var createTopicIndex = require("../lib/coop-topic-index").createTopicIndex;
var activeExecutionMetadata =
  require("../lib/coop-control-execution-target").activeExecutionMetadata;
var executionBrief = require("../lib/coop-control-execution-target").executionBrief;
var taskState = require("../lib/orchestration-task-state");
var portfolioBindings = require("../lib/portfolio-execution-bindings");
var createCrossProjectRouter = require("../lib/server-cross-project").createCrossProjectRouter;

var PROJECT = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var TOPIC = { topicId: "auto-a7daa4cc660639337d144d93" };
var INGRESS = "coop:canonical-coop:7";

test("ordinary discussion and project mentions do not admit typed execution", function () {
  assert.equal(lifecycle.explicitImplementationDecision("What is happening with the Clay sidebar?"), null);
  assert.equal(lifecycle.explicitImplementationDecision("Discuss the approach for the Clay project"), null);
  assert.equal(lifecycle.explicitImplementationDecision("Could this be a useful follow-up?"), null);
  assert.equal(lifecycle.explicitImplementationDecision("Let's discuss whether to implement this in Clay"), null);
  assert.equal(lifecycle.explicitImplementationDecision("I think we should fix this in Clay"), null);
  assert.equal(lifecycle.explicitImplementationDecision("The fix is on the way"), null);
  assert.equal(lifecycle.explicitImplementationDecision("Should we set it to implement?"), null);
});

test("explicit owner implementation decisions are recognized separately from theme classification", function () {
  assert.deepEqual(lifecycle.explicitImplementationDecision("Build this in Clay"), {
    intent: "build", projectName: "Clay",
  });
  assert.deepEqual(lifecycle.explicitImplementationDecision("Please fix this in webapp"), {
    intent: "fix", projectName: "webapp",
  });
  assert.deepEqual(lifecycle.explicitImplementationDecision("Hand this to the Clay project"), {
    intent: "hand_off", projectName: "Clay",
  });
  assert.deepEqual(lifecycle.explicitImplementationDecision("Can you fix this in Clay?"), {
    intent: "fix", projectName: "Clay",
  });
  assert.deepEqual(lifecycle.explicitImplementationDecision("ok set it to implement..."), {
    intent: "implement", projectName: "",
  });
  assert.deepEqual(lifecycle.explicitImplementationDecision(
    "If you know to instruct me why cant you just do it?\n\n" +
    "Start a Clay implementation Thread for the Urban Stay auto-launch regression."), {
    intent: "implement", projectName: "Clay",
  });
  assert.deepEqual(lifecycle.explicitImplementationDecision(
    "Create a dedicated Voice conversational mode Thread for Clay, detach Voice work from Webapp, " +
    "use session 18104cdc-5aff-4328-9afc-88bb709dd21d as read-only context, and implement it."), {
    intent: "implement", projectName: "",
  });
});

test("compound implementation decisions reject discussion, hypotheticals, and negation", function () {
  assert.equal(lifecycle.explicitImplementationDecision(
    "Discuss a dedicated Voice Thread, and implement it."), null);
  assert.equal(lifecycle.explicitImplementationDecision(
    "Should we create a dedicated Voice Thread, and implement it?"), null);
  assert.equal(lifecycle.explicitImplementationDecision(
    "If approved, create a dedicated Voice Thread, and implement it."), null);
  assert.equal(lifecycle.explicitImplementationDecision(
    "Create a dedicated Voice Thread, and do not implement it."), null);
  assert.equal(lifecycle.explicitImplementationDecision(
    "Create a dedicated Voice Thread and consider whether to implement it."), null);
});

test("queue-wide authorization language and task snapshots stay narrow and bounded", function () {
  assert.equal(queueAuthorization.explicitQueueAuthorization(
    "Let's run all that you possibly can, anything that is not blocked should run..."), true);
  assert.equal(queueAuthorization.explicitQueueAuthorization("Run everything unblocked"), true);
  assert.equal(queueAuthorization.explicitQueueAuthorization("Can you run everything?"), false);
  assert.equal(queueAuthorization.explicitQueueAuthorization("Run all tests"), false);
  assert.equal(queueAuthorization.explicitQueueAuthorization("Do not run everything unblocked"), false);

  var events = [];
  for (var i = 0; i <= queueAuthorization.MAX_AUTHORIZED_TASKS; i++) {
    events.push({
      type: "staffing_attention",
      attentionKey: "queued-task-" + i + ":1",
      portfolioTaskId: "queued-task-" + i,
      bindingRevision: 1,
      seq: i + 1,
      at: 100 + i,
    });
  }
  assert.deepEqual(queueAuthorization.snapshotAt(events, 1000), {
    ok: false,
    reason: "queue_authorization_scope_too_large",
    tasks: [],
  });

  var gated = queueAuthorization.snapshotAt([{
    type: "staffing_attention", attentionKey: "resolved-task:1",
    portfolioTaskId: "resolved-task", bindingRevision: 1, seq: 1, at: 100,
  }, {
    type: "attention_resolved", attentionKey: "resolved-task:1", seq: 2, at: 120,
  }, {
    type: "staffing_attention", attentionKey: "blocked-task:1",
    portfolioTaskId: "blocked-task", bindingRevision: 1, blocked: true, seq: 3, at: 130,
  }, {
    type: "staffing_attention", attentionKey: "eligible-task:1",
    portfolioTaskId: "eligible-task", bindingRevision: 1, seq: 4, at: 140,
  }], 200);
  assert.deepEqual(gated.tasks.map(function (task) { return task.portfolioTaskId; }),
    ["eligible-task"]);
  assert.equal(queueAuthorization.taskInSnapshot(gated, {
    portfolioTaskId: "eligible-task", bindingRevision: 1, budgetException: true,
  }), null, "typed spend and approval exceptions never inherit a queue-wide grant");
});

function executionRouter(entries, delivered, handedOff, options) {
  options = options || {};
  var dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), "clay-thread-admission-"));
  var claimed = null;
  var classifications = 0;
  var leadSessions = new Map([[1, { coopHome: true,
    storageId: options.canonicalStorageId || "canonical-coop",
    history: options.history || [] }]]);
  var leadManager = {
    sessions: leadSessions,
    createSessionRaw: function (input) {
      var session = Object.assign({ localId: leadSessions.size + 1, history: [] }, input || {});
      leadSessions.set(session.localId, session);
      return session;
    },
    saveSessionFile: function () {},
  };
  var router = createCrossProjectRouter({
    allowLeadSourcedExecution: true,
    bindingFile: path.join(dir, "bindings.json"),
    ownerRequests: {
      forTopic: function (topicRef) {
        return entries.filter(function (entry) {
          return entry.topicRef && topicRef && entry.topicRef.topicId === topicRef.topicId;
        });
      },
      get: function (ingressId) {
        return entries.find(function (entry) { return entry.ingressId === ingressId; }) || null;
      },
      list: function () { return entries.slice(); },
      classify: function (ingressId, input) {
        classifications++;
        var entry = entries.find(function (candidate) {
          return candidate.ingressId === ingressId;
        });
        if (!entry) return null;
        entry.implementationDecision = input.implementationDecision;
        entry.projectRefs = input.projectRefs;
        entry.expectsExecution = true;
        return entry;
      },
      scopeImplementation: function (ingressId, input) {
        var entry = entries.find(function (candidate) {
          return candidate.ingressId === ingressId;
        });
        if (!entry || !entry.implementationDecision || !entry.expectsExecution) {
          return { ok: false, reason: "owner_implementation_decision_required" };
        }
        if (entry.implementationScope && JSON.stringify(entry.implementationScope) !==
            JSON.stringify(input)) {
          return { ok: false, reason: "owner_implementation_scope_mismatch" };
        }
        var reused = !!entry.implementationScope;
        entry.implementationScope = JSON.parse(JSON.stringify(input));
        entry.topicRef = input.topicRef;
        entry.projectRefs = [input.projectRef];
        return { ok: true, reused: reused, request: entry };
      },
      claimCoordinator: function (input) { claimed = input.coordinator; return { ok: true }; },
      canonicalCoordinator: function () { return claimed; },
      canonicalProjectCoordinator: function () { return null; },
    },
    readLeadEvents: options.readLeadEvents || function () { return options.leadEvents || []; },
    requireOwnerImplementationDecision: true,
    automationThreadIndex: options.automationThreadIndex,
    onThreadHandedOff: function (input) {
      handedOff.push(input);
      if (typeof options.onThreadHandedOff === "function") {
        return options.onThreadHandedOff(input);
      }
      return handedOff.fail ? { ok: false, code: "persistence_failed" } : { ok: true };
    },
  });
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    getSessionManager: function () { return leadManager; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return PROJECT; },
    validateAutomationAuthorization: options.validateAutomationAuthorization,
    deliverCrossProjectEnvelope: function (envelope) {
      delivered.push(envelope);
      if (typeof options.deliverCrossProjectEnvelope === "function") {
        return options.deliverCrossProjectEnvelope(envelope);
      }
      return { ok: true, created: true,
        sessionRef: { projectId: PROJECT, sessionStorageId: "thread-worker" },
        projectCoordinatorRef: envelope.payload.targetProjectCoordinator };
    },
  });
  if (options.extraProjectId) {
    router.registerProjectResolver({
      getProjectId: function () { return options.extraProjectId; },
      deliverCrossProjectEnvelope: function (envelope) {
        delivered.push(envelope);
        return { ok: true, created: true,
          sessionRef: { projectId: options.extraProjectId,
            sessionStorageId: "wrong-project-worker" },
          projectCoordinatorRef: envelope.payload.targetProjectCoordinator };
      },
    });
  }
  return { router: router, dir: dir,
    classificationCount: function () { return classifications; } };
}

function execute(router, source) {
  return router.createProjectExecution({
    source: source || { projectId: "system-lead", sessionStorageId: "canonical-coop" },
    portfolioTaskId: "thread-admission-task", bindingRevision: 1,
    idempotencyKey: "thread-admission-task-r1", mode: "project_coordinator",
    targetProject: { projectId: PROJECT }, coopTopicRef: TOPIC,
    coopIngressId: INGRESS, objective: "Implement the approved change.",
  });
}

test("typed project execution fails closed until the current owner ingress has an explicit decision", function () {
  var delivered = [];
  var handedOff = [];
  var discussion = executionRouter([{ ingressId: INGRESS, topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }], expectsExecution: false,
    implementationDecision: null }], delivered, handedOff);
  try {
    assert.deepEqual(execute(discussion.router), {
      ok: false, reason: "owner_implementation_decision_required",
    });
    assert.equal(delivered.length, 0);
    assert.equal(handedOff.length, 0);
  } finally { fs.rmSync(discussion.dir, { recursive: true, force: true }); }
});

function autonomousCandidate() {
  var candidate = {
    candidateKey: "launch:bojanx100/urban-stay-web#198",
    itemKey: "bojanx100/urban-stay-web#198",
    itemClass: "ambiguous",
    admission: "auto",
    status: "pending",
    projectRef: { projectId: PROJECT },
    policyDigest: "policy-current",
    recipeId: "all-issues",
    eligibilityPass: "scan-current",
    eligibility: {
      assignedToOwner: false,
      recipeAllowsUnassigned: true,
      reason: "recipe_allows_unassigned",
    },
    intent: { recipeId: "all-issues", number: 198, title: "Stuck until refresh" },
  };
  candidate.digest = automationCandidates.contentDigest(candidate);
  return candidate;
}

function autonomousDispatch(router, overrides) {
  var candidate = autonomousCandidate();
  var portfolioTaskId = automationIdentity.portfolioTaskIdFor(candidate);
  var request = {
    source: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
    portfolioTaskId: portfolioTaskId,
    bindingRevision: 1,
    idempotencyKey: automationIdentity.idempotencyKeyFor(portfolioTaskId, 1),
    mode: "project_coordinator",
    targetProject: { projectId: PROJECT },
    title: "#198 Stuck until refresh",
    objective: "Resolve Urban Stay issue #198.",
  };
  request.automationAuthorization = automationAuthorization.createAuthorization(candidate, request);
  request.coopTopicRef = {
    topicId: request.automationAuthorization.threadRef.threadId,
  };
  return router.createProjectExecution(Object.assign(request, overrides || {}));
}

test("current autonomous evidence creates one deterministic visible Thread and binding across restart", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-auto-thread-admission-"));
  var topicFile = path.join(dir, "threads.json");
  var topicIndex = createTopicIndex({ file: topicFile, now: function () { return 1000; } });
  var delivered = [];
  var handedOff = [];
  var currentCandidate = autonomousCandidate();
  var validator = automationAuthorization.createAuthorizationValidator({
    candidates: {
      pending: function () { return { ok: true, candidates: [currentCandidate] }; },
    },
    getLeadMode: function () { return true; },
    loadPolicy: function () {
      return { ok: true, policy: {
        projectRef: { projectId: PROJECT },
        digest: "policy-current",
        autonomy: {
          bug: "propose", feature: "propose", ambiguous: "autonomous",
          pr_review: "propose", default: "propose",
        },
        externalActions: {
          comment: "approval", done_workflow: "approval", merge: "approval", close: "approval",
        },
      } };
    },
    now: function () { return 1000; },
  });
  function validate(input) {
    return validator.validate(input);
  }
  var first = executionRouter([], delivered, handedOff, {
    dir: dir,
    automationThreadIndex: topicIndex,
    validateAutomationAuthorization: validate,
    onThreadHandedOff: function (input) {
      return topicIndex.linkExecution(input.topicRef, {
        projectRef: input.projectRef,
        sessionRef: input.sessionRef,
      });
    },
  });
  try {
    var created = autonomousDispatch(first.router);
    assert.equal(created.ok, true);
    assert.equal(created.created, true);
    assert.equal(delivered.length, 1);
    assert.equal(created.binding.targetProject.projectId, PROJECT);
    assert.equal(created.binding.automationAuthorization.kind, "project_policy_autonomous");

    var ref = created.binding.coopTopicRef;
    var resolved = topicIndex.resolve(ref, true);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.thread.source, "project_automation");
    assert.equal(resolved.thread.group.projectRef.projectId, PROJECT);
    assert.equal(resolved.thread.threadState, "handed_off");
    assert.equal(resolved.thread.relatedExecutions.length, 1);

    var replay = autonomousDispatch(first.router);
    assert.equal(replay.ok, true);
    assert.equal(replay.reused, true);
    assert.equal(delivered.length, 1, "a second tick starts no duplicate session");
    assert.equal(topicIndex.resolve(ref, true).thread.relatedExecutions.length, 1,
      "a second tick adds no duplicate execution link");

    var restartedIndex = createTopicIndex({ file: topicFile, now: function () { return 2000; } });
    var restartDelivered = [];
    var restartHandedOff = [];
    var restarted = executionRouter([], restartDelivered, restartHandedOff, {
      dir: dir,
      automationThreadIndex: restartedIndex,
      validateAutomationAuthorization: validate,
      onThreadHandedOff: function (input) {
        return restartedIndex.linkExecution(input.topicRef, {
          projectRef: input.projectRef,
          sessionRef: input.sessionRef,
        });
      },
    });
    var afterRestart = autonomousDispatch(restarted.router);
    assert.equal(afterRestart.ok, true);
    assert.equal(afterRestart.reused, true);
    assert.equal(restartDelivered.length, 0, "restart reuses the canonical binding/session");
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(topicFile, "utf8")).topics)
      .filter(function (id) { return id === ref.topicId; }).length, 1);

    var metadata = activeExecutionMetadata(null, created.binding,
      { projectId: "system-lead", sessionStorageId: "canonical-coop" });
    assert.equal(metadata.automationAuthorization.kind, "project_policy_autonomous",
      "the target session keeps typed automation provenance");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("autonomous coordinator instructions block approval-gated external actions at execution", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-auto-external-gate-"));
  var topicIndex = createTopicIndex({ file: path.join(dir, "threads.json") });
  var delivered = [];
  var handedOff = [];
  var currentCandidate = autonomousCandidate();
  var prompt = "";
  var validator = automationAuthorization.createAuthorizationValidator({
    candidates: {
      pending: function () { return { ok: true, candidates: [currentCandidate] }; },
    },
    getLeadMode: function () { return true; },
    loadPolicy: function () {
      return { ok: true, policy: {
        projectRef: { projectId: PROJECT },
        digest: "policy-current",
        autonomy: {
          bug: "propose", feature: "propose", ambiguous: "autonomous",
          pr_review: "propose", default: "propose",
        },
        externalActions: {
          comment: "approval", done_workflow: "approval",
          merge: "approval", close: "approval",
        },
      } };
    },
    now: function () { return 1000; },
  });
  var h = executionRouter([], delivered, handedOff, {
    dir: dir,
    automationThreadIndex: topicIndex,
    validateAutomationAuthorization: function (input) { return validator.validate(input); },
    deliverCrossProjectEnvelope: function (envelope) {
      var payload = envelope.payload || {};
      var request = portfolioBindings.normalizeRequest(
        Object.assign({}, payload, { source: envelope.source }));
      prompt = taskState.portfolioExecutionPrompt(
        executionBrief(payload), request, request.mode);
      return { ok: true, created: true,
        sessionRef: { projectId: PROJECT, sessionStorageId: "gated-coordinator" },
        projectCoordinatorRef: payload.targetProjectCoordinator };
    },
    onThreadHandedOff: function (input) {
      return topicIndex.linkExecution(input.topicRef, {
        projectRef: input.projectRef,
        sessionRef: input.sessionRef,
      });
    },
  });
  try {
    assert.equal(autonomousDispatch(h.router).ok, true);
    assert.equal(delivered.length, 1, "the autonomous assigned:any work still launches");
    assert.match(prompt, /internal edits, tests, and local commits/i);
    assert.match(prompt, /comment=approval/);
    assert.match(prompt, /done_workflow=approval/);
    assert.match(prompt, /merge=approval/);
    assert.match(prompt, /close=approval/);
    assert.match(prompt, /push, publish, release, or deploy/i);
    assert.match(prompt, /WORKER_STATUS: needs_input/);
    assert.doesNotMatch(prompt, /no further owner approval is pending on it/i);
    assert.doesNotMatch(prompt, /committed and pushed/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("autonomous admission rejects unavailable, stale, owner-shaped, and foreign Thread evidence", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-auto-thread-deny-"));
  var topicIndex = createTopicIndex({ file: path.join(dir, "threads.json") });
  var delivered = [];
  var handedOff = [];
  try {
    var unavailable = executionRouter([], delivered, handedOff, {
      dir: path.join(dir, "unavailable"), automationThreadIndex: topicIndex,
    });
    assert.equal(autonomousDispatch(unavailable.router).reason,
      "automation_authorization_unavailable");

    var stale = executionRouter([], delivered, handedOff, {
      dir: path.join(dir, "stale"), automationThreadIndex: topicIndex,
      validateAutomationAuthorization: function () {
        return { ok: false, reason: "automation_policy_stale" };
      },
    });
    assert.equal(autonomousDispatch(stale.router).reason, "automation_policy_stale");

    var policyUnavailable = executionRouter([], delivered, handedOff, {
      dir: path.join(dir, "policy-unavailable"), automationThreadIndex: topicIndex,
      validateAutomationAuthorization: function (input) {
        return { ok: true,
          authorization: automationAuthorization.normalizeAuthorization(input.authorization) };
      },
    });
    assert.equal(autonomousDispatch(policyUnavailable.router).reason,
      "automation_external_policy_unavailable");

    var valid = function (input) {
      return { ok: true,
        authorization: automationAuthorization.normalizeAuthorization(input.authorization),
        policy: {
          externalActions: {
            comment: "approval", done_workflow: "approval",
            merge: "approval", close: "approval",
          },
        } };
    };
    var ownerShaped = executionRouter([], delivered, handedOff, {
      dir: path.join(dir, "owner-shaped"), automationThreadIndex: topicIndex,
      validateAutomationAuthorization: valid,
    });
    assert.equal(autonomousDispatch(ownerShaped.router, {
      coopIngressId: "coop:fake-owner:1",
    }).reason, "automation_owner_ingress_forbidden");

    var candidate = autonomousCandidate();
    var foreignRef = automationIdentity.threadRefFor(candidate);
    topicIndex.createTopic({
      topicId: foreignRef.threadId,
      title: "Foreign Thread",
      group: { kind: "project", projectRef: { projectId: PROJECT } },
    });
    var foreign = executionRouter([], delivered, handedOff, {
      dir: path.join(dir, "foreign"), automationThreadIndex: topicIndex,
      validateAutomationAuthorization: valid,
    });
    assert.equal(autonomousDispatch(foreign.router).reason,
      "automation_thread_identity_conflict");
    assert.equal(delivered.length, 0, "no rejected evidence reaches a target project");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("production admission rejects direct project leaves instead of falling back around the coordinator", function () {
  var delivered = [];
  var handedOff = [];
  var approved = executionRouter([{ ingressId: INGRESS, topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }], expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" } }],
  delivered, handedOff);
  try {
    var result = approved.router.createProjectExecution({
      source: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
      portfolioTaskId: "no-direct-leaf", bindingRevision: 1,
      idempotencyKey: "no-direct-leaf-r1", mode: "direct_leaf",
      targetProject: { projectId: PROJECT }, coopTopicRef: TOPIC,
      coopIngressId: INGRESS, objective: "Do not bypass the project coordinator.",
    });
    assert.deepEqual(result, { ok: false, reason: "persistent_project_coordinator_required" });
    assert.equal(delivered.length, 0);
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("owner text approval is replayed from the exact canonical event and persisted once", function () {
  var delivered = [];
  var handedOff = [];
  var entries = [{ ingressId: INGRESS, topicRef: TOPIC, projectRefs: [],
    expectsExecution: false, implementationDecision: null,
    classification: { kind: "conversational", source: "ingress_route" },
    requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 0 } }];
  var approved = executionRouter(entries, delivered, handedOff, { history: [{
    type: "user_message", text: "ok set it to implement...", coopIngressId: INGRESS,
    coopTopicRef: TOPIC, _ts: 1786779753167,
  }] });
  try {
    var result = execute(approved.router);
    assert.equal(result.ok, true);
    assert.equal(approved.classificationCount(), 1);
    assert.deepEqual(entries[0].implementationDecision, {
      intent: "implement", projectName: "",
      source: "explicit_owner_turn", at: 1786779753167,
    });
    assert.equal(delivered.length, 1);

    var replay = execute(approved.router);
    assert.equal(replay.ok, true);
    assert.equal(replay.reused, true);
    assert.equal(approved.classificationCount(), 1,
      "a replay must reuse the persisted decision instead of recording it again");
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("an explicit Main command authorizes one exact ProjectRef and task without a Thread worker", function () {
  var delivered = [];
  var handedOff = [];
  var ingressId = "coop:canonical-coop:8";
  var entries = [{
    ingressId: ingressId,
    topicRef: null,
    projectRefs: [],
    expectsExecution: true,
    implementationDecision: { intent: "fix", source: "explicit_owner_turn" },
    classification: { kind: "conversational", source: "ingress_route" },
    requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 0 },
  }];
  var approved = executionRouter(entries, delivered, handedOff, { history: [{
    type: "user_message", text: "Fix it", coopComposerScope: "main",
    coopIngressId: ingressId, coopImplementationDecision: { intent: "fix" },
  }] });
  var exact = {
    source: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
    portfolioTaskId: "main-owner-directed-task", bindingRevision: 1,
    idempotencyKey: "main-owner-directed-task-r1", mode: "project_coordinator",
    targetProject: { projectId: PROJECT }, coopTopicRef: TOPIC,
    coopIngressId: ingressId, objective: "Implement the exact owner-directed fix.",
  };
  try {
    var result = approved.router.createProjectExecution(exact);
    assert.equal(result.ok, true);
    assert.deepEqual(entries[0].implementationScope, {
      projectRef: { projectId: PROJECT },
      topicRef: TOPIC,
      portfolioTaskId: "main-owner-directed-task",
      bindingRevision: 1,
      idempotencyKey: "main-owner-directed-task-r1",
    });
    assert.equal(approved.router.createProjectExecution(exact).reused, true);
    assert.deepEqual(approved.router.createProjectExecution(Object.assign({}, exact, {
      portfolioTaskId: "different-main-task",
      idempotencyKey: "different-main-task-r1",
    })), { ok: false, reason: "owner_implementation_scope_mismatch" });
    assert.equal(delivered.length, 1);
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("recovered ingress 360 replays from its exact canonical Main event into the Voice Thread", function () {
  var targetTopic = { topicId: mainIngressRecovery.TARGET_THREAD_ID };
  var ingressId = "coop:871a194b-8879-40f7-a1fe-656e48e722af:360";
  var history = [];
  history[166989] = {
    type: "user_message",
    text: "Create a dedicated Voice conversational mode Thread for Clay, detach Voice work from Webapp, " +
      "use session 18104cdc-5aff-4328-9afc-88bb709dd21d as read-only context, and implement it.",
    coopIngressId: ingressId,
    coopIngressSequence: 360,
    coopIngressKind: "text",
    coopTopicRef: { topicId: mainIngressRecovery.SOURCE_THREAD_ID },
    coopThreadRef: { threadId: mainIngressRecovery.SOURCE_THREAD_ID },
    coopProjectRef: null,
    coopImplementationDecision: null,
    _ts: 1786840579387,
  };
  var entries = [{
    ingressId: ingressId,
    ingressSequence: 360,
    topicRef: targetTopic,
    projectRefs: [],
    expectsExecution: false,
    implementationDecision: null,
    classification: { kind: "existing_topic", source: "ingress_route" },
    sessionRef: { projectId: "system-lead",
      sessionStorageId: mainIngressRecovery.CANONICAL_SESSION_ID },
    requestRef: { projectId: "system-lead",
      sessionStorageId: mainIngressRecovery.CANONICAL_SESSION_ID, eventIndex: 166989 },
  }];
  var delivered = [];
  var handedOff = [];
  var approved = executionRouter(entries, delivered, handedOff, {
    canonicalStorageId: mainIngressRecovery.CANONICAL_SESSION_ID,
    history: history,
    extraProjectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9",
  });
  try {
    assert.deepEqual(approved.router.createProjectExecution({
      source: { projectId: "system-lead",
        sessionStorageId: mainIngressRecovery.CANONICAL_SESSION_ID },
      portfolioTaskId: "clay-voice-wrong-project-2026-08-16",
      bindingRevision: 1,
      idempotencyKey: "clay-voice-wrong-project-2026-08-16-r1",
      mode: "project_coordinator",
      targetProject: { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" },
      coopTopicRef: targetTopic,
      coopIngressId: ingressId,
    }), { ok: false, reason: "owner_implementation_project_mismatch" });
    var result = approved.router.createProjectExecution({
      source: { projectId: "system-lead",
        sessionStorageId: mainIngressRecovery.CANONICAL_SESSION_ID },
      portfolioTaskId: "clay-voice-conversational-mode-2026-08-16",
      bindingRevision: 1,
      idempotencyKey: "clay-voice-conversational-mode-2026-08-16-r1",
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT },
      coopTopicRef: targetTopic,
      coopIngressId: ingressId,
      objective: "Implement the approved Voice conversational mode.",
    });
    assert.equal(result.ok, true);
    assert.equal(approved.classificationCount(), 1);
    assert.deepEqual(entries[0].implementationDecision, {
      intent: "implement", projectName: "",
      source: "explicit_owner_turn", at: 1786840579387,
    });
    assert.equal(entries[0].expectsExecution, true);
    assert.deepEqual(entries[0].projectRefs, [{ projectId: PROJECT }]);
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].payload.targetProject, { projectId: PROJECT });
    assert.deepEqual(delivered[0].payload.coopTopicRef, targetTopic);
    assert.equal(delivered[0].payload.coopIngressId, ingressId);
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("recovered replay stays closed when verified production metadata changes", function () {
  var ingressId = "coop:871a194b-8879-40f7-a1fe-656e48e722af:360";
  var targetTopic = { topicId: mainIngressRecovery.TARGET_THREAD_ID };
  var history = [];
  history[166989] = {
    type: "user_message",
    text: "Create a dedicated Voice conversational mode Thread for Clay, detach Voice work from Webapp, " +
      "use session 18104cdc-5aff-4328-9afc-88bb709dd21d as read-only context, and implement it.",
    coopIngressId: ingressId,
    coopIngressSequence: 360,
    coopIngressKind: "text",
    coopTopicRef: { topicId: mainIngressRecovery.SOURCE_THREAD_ID },
    coopThreadRef: { threadId: mainIngressRecovery.SOURCE_THREAD_ID },
    coopProjectRef: null,
    coopImplementationDecision: { intent: "ship" },
    _ts: 1786840579387,
  };
  var denied = executionRouter([{
    ingressId: ingressId, ingressSequence: 360, topicRef: targetTopic,
    projectRefs: [], expectsExecution: false, implementationDecision: null,
    sessionRef: { projectId: "system-lead",
      sessionStorageId: mainIngressRecovery.CANONICAL_SESSION_ID },
    requestRef: { projectId: "system-lead",
      sessionStorageId: mainIngressRecovery.CANONICAL_SESSION_ID, eventIndex: 166989 },
  }], [], [], {
    canonicalStorageId: mainIngressRecovery.CANONICAL_SESSION_ID,
    history: history,
  });
  try {
    assert.deepEqual(denied.router.createProjectExecution({
      source: { projectId: "system-lead",
        sessionStorageId: mainIngressRecovery.CANONICAL_SESSION_ID },
      portfolioTaskId: "changed-recovered-event",
      bindingRevision: 1,
      idempotencyKey: "changed-recovered-event-r1",
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT },
      coopTopicRef: targetTopic,
      coopIngressId: ingressId,
    }), { ok: false, reason: "owner_implementation_decision_required" });
  } finally { fs.rmSync(denied.dir, { recursive: true, force: true }); }
});

test("recovered ingress 371 admits the exact current Threads direction only to Clay", function () {
  var ingressId = threadsRecovery.EXPECTED.ingressId;
  var targetTopic = { topicId: threadsRecovery.THREAD_ID };
  var history = [];
  history[threadsRecovery.EXPECTED.eventIndex] = {
    type: "user_message",
    text: "Also when are we starting threads work?\n\n" +
      "Concil is repeted several times in sidebar.\n\n" +
      "Voce is a thread and should have started work by now. \n\n" +
      "A bunch of issues there... move on it",
    coopIngressId: ingressId,
    coopIngressSequence: threadsRecovery.EXPECTED.sequence,
    coopIngressKind: "text",
    coopTopicRef: null,
    coopThreadRef: null,
    coopProjectRef: null,
    coopImplementationDecision: null,
    _ts: 1786877151125,
  };
  var entries = [{
    ingressId: ingressId,
    ingressSequence: threadsRecovery.EXPECTED.sequence,
    topicRef: targetTopic,
    projectRefs: [],
    expectsExecution: false,
    implementationDecision: null,
    classification: { kind: "conversational", source: "ingress_route" },
    sessionRef: { projectId: "system-lead",
      sessionStorageId: threadsRecovery.CANONICAL_SESSION_ID },
    requestRef: { projectId: "system-lead",
      sessionStorageId: threadsRecovery.CANONICAL_SESSION_ID,
      eventIndex: threadsRecovery.EXPECTED.eventIndex },
  }];
  var delivered = [];
  var approved = executionRouter(entries, delivered, [], {
    canonicalStorageId: threadsRecovery.CANONICAL_SESSION_ID,
    history: history,
    extraProjectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9",
  });
  try {
    assert.deepEqual(approved.router.createProjectExecution({
      source: { projectId: "system-lead",
        sessionStorageId: threadsRecovery.CANONICAL_SESSION_ID },
      portfolioTaskId: "threads-wrong-project",
      bindingRevision: 1,
      idempotencyKey: "threads-wrong-project-r1",
      mode: "project_coordinator",
      targetProject: { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" },
      coopTopicRef: targetTopic,
      coopIngressId: ingressId,
    }), { ok: false, reason: "owner_implementation_project_mismatch" });

    var result = approved.router.createProjectExecution({
      source: { projectId: "system-lead",
        sessionStorageId: threadsRecovery.CANONICAL_SESSION_ID },
      portfolioTaskId: "clay-threads-v2-implementation-2026-08-16",
      bindingRevision: 1,
      idempotencyKey: "clay-threads-v2-implementation-20260816-r1-owner-directed",
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT },
      coopTopicRef: targetTopic,
      coopIngressId: ingressId,
      objective: "Implement the accepted Threads V2 direction.",
    });
    assert.equal(result.ok, true);
    assert.equal(approved.classificationCount(), 1);
    assert.deepEqual(entries[0].implementationDecision, {
      intent: "implement", source: "explicit_owner_turn", at: 1786877151125,
    });
    assert.deepEqual(entries[0].projectRefs, [{ projectId: PROJECT }]);
    assert.equal(entries[0].expectsExecution, true);
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].payload.coopTopicRef, targetTopic);
    assert.equal(delivered[0].payload.coopIngressId, ingressId);
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("recovered Threads replay rejects altered owner direction metadata", function () {
  var ingressId = threadsRecovery.EXPECTED.ingressId;
  var targetTopic = { topicId: threadsRecovery.THREAD_ID };
  var history = [];
  history[threadsRecovery.EXPECTED.eventIndex] = {
    type: "user_message",
    text: "Also when are we starting threads work? Move on it",
    coopIngressId: ingressId,
    coopIngressSequence: threadsRecovery.EXPECTED.sequence,
    coopIngressKind: "text",
    coopTopicRef: null,
    coopThreadRef: null,
    coopProjectRef: null,
    coopImplementationDecision: null,
    _ts: 1786877151125,
  };
  var denied = executionRouter([{
    ingressId: ingressId,
    ingressSequence: threadsRecovery.EXPECTED.sequence,
    topicRef: targetTopic,
    projectRefs: [],
    expectsExecution: false,
    implementationDecision: null,
    sessionRef: { projectId: "system-lead",
      sessionStorageId: threadsRecovery.CANONICAL_SESSION_ID },
    requestRef: { projectId: "system-lead",
      sessionStorageId: threadsRecovery.CANONICAL_SESSION_ID,
      eventIndex: threadsRecovery.EXPECTED.eventIndex },
  }], [], [], {
    canonicalStorageId: threadsRecovery.CANONICAL_SESSION_ID,
    history: history,
  });
  try {
    assert.deepEqual(denied.router.createProjectExecution({
      source: { projectId: "system-lead",
        sessionStorageId: threadsRecovery.CANONICAL_SESSION_ID },
      portfolioTaskId: "changed-threads-event",
      bindingRevision: 1,
      idempotencyKey: "changed-threads-event-r1",
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT },
      coopTopicRef: targetTopic,
      coopIngressId: ingressId,
    }), { ok: false, reason: "owner_implementation_decision_required" });
  } finally { fs.rmSync(denied.dir, { recursive: true, force: true }); }
});

test("a generic explicit decision admits the next typed ProjectRef but an explicit mismatch does not", function () {
  var delivered = [];
  var handedOff = [];
  var generic = executionRouter([{ ingressId: INGRESS, topicRef: TOPIC,
    projectRefs: [], expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" } }],
  delivered, handedOff);
  try {
    assert.equal(execute(generic.router).ok, true);
  } finally { fs.rmSync(generic.dir, { recursive: true, force: true }); }

  var mismatch = executionRouter([{ ingressId: INGRESS, topicRef: TOPIC,
    projectRefs: [{ projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" }],
    expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" } }], [], []);
  try {
    assert.deepEqual(execute(mismatch.router), {
      ok: false, reason: "owner_implementation_project_mismatch",
    });
  } finally { fs.rmSync(mismatch.dir, { recursive: true, force: true }); }
});

test("bounded queue-wide authorization admits an exact queued task without replacing its refs", function () {
  var delivered = [];
  var handedOff = [];
  var queueTopic = { topicId: "auto-run-everything-unblocked" };
  var authorizationIngress = "coop:canonical-coop:339";
  var entries = [{
    ingressId: INGRESS,
    ingressSequence: 323,
    receivedAt: 100,
    topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }],
    expectsExecution: false,
    implementationDecision: null,
    response: { state: "answered" },
    requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 0 },
  }, {
    ingressId: authorizationIngress,
    ingressSequence: 339,
    receivedAt: 300,
    topicRef: queueTopic,
    projectRefs: [],
    expectsExecution: false,
    implementationDecision: null,
    response: { state: "answered" },
    requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 1 },
  }];
  var approved = executionRouter(entries, delivered, handedOff, {
    history: [{
      type: "user_message",
      text: "Put Coop's owner controls in Session Context.",
      coopIngressId: INGRESS,
      coopTopicRef: TOPIC,
      coopProjectRef: { projectId: PROJECT },
      _ts: 100,
    }, {
      type: "user_message",
      text: "Let's run all that you possibly can, anything that is not blocked should run...",
      coopIngressId: authorizationIngress,
      coopTopicRef: queueTopic,
      _ts: 300,
    }],
    leadEvents: [{
      type: "staffing_attention",
      attentionKey: "clay-coop-owner-control-sidebar-2026-08-15:1",
      portfolioTaskId: "clay-coop-owner-control-sidebar-2026-08-15",
      bindingRevision: 1,
      seq: 40,
      at: 200,
    }],
  });
  try {
    var request = {
      source: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
      portfolioTaskId: "clay-coop-owner-control-sidebar-2026-08-15",
      bindingRevision: 1,
      idempotencyKey: "clay-coop-owner-control-sidebar-20260815-r1",
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT },
      coopTopicRef: TOPIC,
      coopIngressId: INGRESS,
      coopAuthorizationIngressId: authorizationIngress,
      objective: "Implement the queued owner control sidebar.",
    };
    var result = approved.router.createProjectExecution(request);
    assert.equal(result.ok, true);
    assert.deepEqual(result.binding.coopTopicRef, TOPIC);
    assert.deepEqual(result.binding.targetProject, { projectId: PROJECT });
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].payload.coopTopicRef, TOPIC);
    assert.deepEqual(delivered[0].payload.targetProject, { projectId: PROJECT });
    assert.equal(delivered[0].payload.coopIngressId, INGRESS);
    assert.equal(delivered[0].payload.coopAuthorizationIngressId, authorizationIngress);
    assert.deepEqual(handedOff[0].topicRef, TOPIC);
    assert.deepEqual(handedOff[0].projectRef, { projectId: PROJECT });

    var replay = approved.router.createProjectExecution(request);
    assert.equal(replay.ok, true);
    assert.equal(replay.reused, true);
    assert.equal(delivered.length, 1, "the durable binding keeps retries idempotent");
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("queue-wide authorization rejects tasks added after the authorization snapshot", function () {
  var queueTopic = { topicId: "auto-run-everything-unblocked" };
  var authorizationIngress = "coop:canonical-coop:339";
  var futureIngress = "coop:canonical-coop:340";
  var entries = [{
    ingressId: futureIngress,
    ingressSequence: 340,
    receivedAt: 400,
    topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }],
    response: { state: "answered" },
    requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 1 },
  }, {
    ingressId: authorizationIngress,
    ingressSequence: 339,
    receivedAt: 300,
    topicRef: queueTopic,
    projectRefs: [],
    response: { state: "answered" },
    requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 0 },
  }];
  var denied = executionRouter(entries, [], [], {
    history: [{
      type: "user_message",
      text: "Run everything unblocked",
      coopIngressId: authorizationIngress,
      coopTopicRef: queueTopic,
      _ts: 300,
    }, {
      type: "user_message",
      text: "A later task must need a later decision.",
      coopIngressId: futureIngress,
      coopTopicRef: TOPIC,
      coopProjectRef: { projectId: PROJECT },
      _ts: 400,
    }],
    leadEvents: [{
      type: "staffing_attention",
      attentionKey: "future-task:1",
      portfolioTaskId: "future-task",
      bindingRevision: 1,
      seq: 41,
      at: 400,
    }],
  });
  try {
    assert.deepEqual(denied.router.createProjectExecution({
      source: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
      portfolioTaskId: "future-task",
      bindingRevision: 1,
      idempotencyKey: "future-task-r1",
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT },
      coopTopicRef: TOPIC,
      coopIngressId: futureIngress,
      coopAuthorizationIngressId: authorizationIngress,
    }), { ok: false, reason: "owner_implementation_decision_required" });
  } finally { fs.rmSync(denied.dir, { recursive: true, force: true }); }
});

test("an explicit decision creates typed ProjectRef execution and marks the Thread handed off", function () {
  var delivered = [];
  var handedOff = [];
  var approved = executionRouter([{ ingressId: INGRESS, topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }], expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" } }],
  delivered, handedOff);
  try {
    var result = execute(approved.router);
    assert.equal(result.ok, true);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].source.projectId, "system-lead");
    assert.notEqual(delivered[0].source.sessionStorageId, "canonical-coop",
      "Coop dispatch must target the ProjectRef-bound coordinator, never the project session");
    assert.deepEqual(delivered[0].payload.targetProjectCoordinator, delivered[0].source);
    assert.match(delivered[0].payload.controlPlaneTaskId, /^task-/);
    assert.deepEqual(result.binding.targetProject, { projectId: PROJECT });
    assert.deepEqual(result.binding.coopTopicRef, TOPIC);
    assert.deepEqual(result.binding.projectCoordinator, delivered[0].source);
    assert.deepEqual(result.binding.coordinator,
      { projectId: PROJECT, sessionStorageId: "thread-worker" });
    assert.equal(handedOff.length, 1);
    assert.deepEqual(handedOff[0].topicRef, TOPIC);
    assert.deepEqual(handedOff[0].projectRef, { projectId: PROJECT });
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("a failed durable handoff link retries against the same coordinator", function () {
  var delivered = [];
  var handedOff = [];
  handedOff.fail = true;
  var approved = executionRouter([{ ingressId: INGRESS, topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }], expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" } }],
  delivered, handedOff);
  try {
    var failed = execute(approved.router);
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "thread_handoff_link_failed");
    assert.equal(failed.retryable, true);
    assert.equal(delivered.length, 1);
    handedOff.fail = false;
    var retried = execute(approved.router);
    assert.equal(retried.ok, true);
    assert.equal(retried.reused, true);
    assert.equal(delivered.length, 1);
    assert.equal(handedOff.length, 2);
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("an owner-direct Lead session cannot adopt the canonical Thread handoff", function () {
  var delivered = [];
  var handedOff = [];
  var approved = executionRouter([{ ingressId: INGRESS, topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }], expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" } }],
  delivered, handedOff);
  try {
    assert.deepEqual(execute(approved.router,
      { projectId: "system-lead", sessionStorageId: "owner-direct" }), {
      ok: false, reason: "canonical_coop_required",
    });
    assert.equal(delivered.length, 0);
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

// --- owner-approved read-only planning/review admission ------------------------
//
// Production incident: after the owner explicitly authorized with "do them"
// (Coop ingress 332, recorded as a conversational turn with no implementation
// decision), dispatching the read-only Threads V2 Council and Triage review
// coordinators still failed with owner_implementation_decision_required. The
// gate exists to stop unapproved MUTATING work; a worker whose ownership
// boundary is read-only and whose brief is explicitly review-framed carries no
// such risk, so the cited owner turn is sufficient authorization for it.

var THREADS_TOPIC = { topicId: "auto-61f5ae911c79deab7fa6b255" };
var INGRESS_332 = "coop:871a194b-8879-40f7-a1fe-656e48e722af:332";

function ownerApprovedConversationalEntry(overrides) {
  return Object.assign({
    ingressId: INGRESS_332,
    ingressSequence: 332,
    sessionRef: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
    requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 0 },
    response: { state: "answered", answeredAt: 1786809937639, responseRef: null,
      supersededAt: null, supersededBy: "" },
    classification: { kind: "conversational", source: "ingress_route" },
    implementationDecision: null,
    topicRef: THREADS_TOPIC,
    projectRefs: [],
    expectsExecution: false,
  }, overrides || {});
}

function ownerTurnHistory() {
  return [{ type: "user_message", text: "do them", coopIngressId: INGRESS_332,
    coopTopicRef: THREADS_TOPIC, _ts: 1786809874802 }];
}

function reviewDispatch(router, spec) {
  return router.createProjectExecution(Object.assign({
    source: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
    mode: "project_coordinator",
    targetProject: { projectId: PROJECT },
    coopTopicRef: THREADS_TOPIC,
    coopIngressId: INGRESS_332,
  }, spec));
}

function councilDispatch(router, overrides) {
  return reviewDispatch(router, Object.assign({
    portfolioTaskId: "clay-threads-v2-council-review-2026-08-15",
    bindingRevision: 2,
    idempotencyKey: "clay-threads-v2-council-review-20260815-r2-owner-approved",
    title: "Threads V2 Council review",
    objective: "Run the Council design review of Threads V2 and report findings. No source edits.",
    ownedPaths: "read-only: entire repository",
  }, overrides || {}));
}

test("an explicit owner turn admits read-only Council and Triage review workers without an implementation decision", function () {
  var delivered = [];
  var handedOff = [];
  var approved = executionRouter([ownerApprovedConversationalEntry()], delivered, handedOff,
    { history: ownerTurnHistory() });
  try {
    var council = councilDispatch(approved.router);
    assert.equal(council.ok, true);
    assert.equal(council.created, true);
    assert.equal(delivered.length, 1);

    var triage = reviewDispatch(approved.router, {
      portfolioTaskId: "clay-threads-v2-triage-review-2026-08-15",
      bindingRevision: 1,
      idempotencyKey: "clay-threads-v2-triage-review-20260815-r1-owner-approved",
      title: "Threads V2 Triage review",
      objective: "Triage the open Threads V2 review findings and rank them. Read-only.",
      ownedPaths: "read-only: entire repository",
    });
    assert.equal(triage.ok, true);
    assert.equal(delivered.length, 2);

    assert.equal(approved.classificationCount(), 0,
      "a conversational owner turn must never be restamped as an implementation decision");

    var replay = councilDispatch(approved.router);
    assert.equal(replay.ok, true);
    assert.equal(replay.reused, true);
    assert.equal(delivered.length, 2, "idempotent replay starts no second review worker");
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("owner authorization without a decision still blocks anything that is not provably read-only review work", function () {
  var delivered = [];
  var approved = executionRouter([ownerApprovedConversationalEntry()], delivered, [],
    { history: ownerTurnHistory() });
  try {
    assert.deepEqual(councilDispatch(approved.router, {
      ownedPaths: "lib/",
      idempotencyKey: "clay-threads-v2-council-review-20260815-r2-write-boundary",
    }), { ok: false, reason: "owner_implementation_decision_required" },
    "review framing with a writable boundary stays behind the implementation gate");

    assert.deepEqual(councilDispatch(approved.router, {
      title: "Threads V2 rollout",
      objective: "Implement the Threads V2 changes across the client.",
      idempotencyKey: "clay-threads-v2-council-review-20260815-r2-implementation-framed",
    }), { ok: false, reason: "owner_implementation_decision_required" },
    "a read-only boundary without review framing stays behind the implementation gate");

    assert.deepEqual(councilDispatch(approved.router, {
      coopIngressId: "coop:871a194b-8879-40f7-a1fe-656e48e722af:999",
    }), { ok: false, reason: "owner_implementation_decision_required" },
    "an owner turn that was never recorded authorizes nothing");

    assert.equal(delivered.length, 0);
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("a matching conversational ingress without explicit owner authorization admits nothing", function () {
  var delivered = [];
  var discussion = executionRouter([ownerApprovedConversationalEntry()], delivered, [],
    { history: [{ type: "user_message", text: "Let's discuss both reviews first",
      coopIngressId: INGRESS_332, coopTopicRef: THREADS_TOPIC, _ts: 1786809874802 }] });
  try {
    assert.deepEqual(councilDispatch(discussion.router), {
      ok: false, reason: "owner_implementation_decision_required",
    });
    assert.equal(delivered.length, 0);
  } finally { fs.rmSync(discussion.dir, { recursive: true, force: true }); }
});

test("a withdrawn owner turn authorizes no review worker", function () {
  var delivered = [];
  var withdrawn = executionRouter([ownerApprovedConversationalEntry({
    response: { state: "superseded", answeredAt: null, responseRef: null,
      supersededAt: 1786809880000, supersededBy: "owner_interrupt" },
  })], delivered, [], { history: ownerTurnHistory() });
  try {
    assert.deepEqual(councilDispatch(withdrawn.router), {
      ok: false, reason: "owner_implementation_decision_required",
    });
    assert.equal(delivered.length, 0);
  } finally { fs.rmSync(withdrawn.dir, { recursive: true, force: true }); }
});

test("review admission preserves exact owner project scoping", function () {
  var delivered = [];
  var scoped = executionRouter([ownerApprovedConversationalEntry({
    projectRefs: [{ projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" }],
  })], delivered, [], { history: ownerTurnHistory() });
  try {
    assert.deepEqual(councilDispatch(scoped.router), {
      ok: false, reason: "owner_implementation_project_mismatch",
    });
    assert.equal(delivered.length, 0);
  } finally { fs.rmSync(scoped.dir, { recursive: true, force: true }); }
});

test("a named owner approval admits the exact pending task it named", function () {
  var delivered = [];
  var handedOff = [];
  var approvalIngress = "coop:canonical-coop:455";
  // The Thread the approval route mints for the approved work. Owner
  // provenance, bound to the approval turn.
  var approvalTopic = { topicId: "owner-2f4c9d1a8b3e5f7061c2d4e6" };
  var entries = [{
    ingressId: approvalIngress,
    ingressSequence: 455,
    receivedAt: 2000,
    topicRef: null,
    projectRefs: [],
    expectsExecution: false,
    implementationDecision: null,
    response: { state: "answered" },
    requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 0 },
  }];
  var approved = executionRouter(entries, delivered, handedOff, {
    history: [{
      type: "user_message",
      text: "approve eligibility fix",
      coopIngressId: approvalIngress,
      coopComposerScope: "main",
      _ts: 2000,
    }],
    // Recorded BEFORE the approval, which is what makes it approvable at all.
    leadEvents: [{
      type: "staffing_attention",
      attentionKey: "clay-lead-project-policy-eligibility:1",
      itemId: "clay-lead-project-policy-eligibility",
      portfolioTaskId: "clay-lead-project-policy-eligibility",
      bindingRevision: 1,
      seq: 40,
      at: 1000,
    }],
  });
  try {
    var request = {
      source: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
      portfolioTaskId: "clay-lead-project-policy-eligibility",
      bindingRevision: 1,
      idempotencyKey: "clay-lead-project-policy-eligibility-r1",
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT },
      coopTopicRef: approvalTopic,
      coopApprovalIngressId: approvalIngress,
      objective: "Honor project auto-launch eligibility policy before Lead scoring.",
    };
    var result = approved.router.createProjectExecution(request);
    assert.equal(result.ok, true, "the approval must admit the work it named");
    assert.deepEqual(result.binding.targetProject, { projectId: PROJECT });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].payload.coopApprovalIngressId, approvalIngress);

    // A revision the owner never approved is refused on the same evidence.
    var bumped = Object.assign({}, request, {
      bindingRevision: 2,
      idempotencyKey: "clay-lead-project-policy-eligibility-r2",
    });
    var refused = approved.router.createProjectExecution(bumped);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "owner_approval_task_mismatch");
    assert.equal(delivered.length, 1, "nothing new may be dispatched");
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});
