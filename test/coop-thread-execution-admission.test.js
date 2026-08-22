var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var lifecycle = require("../lib/coop-thread-lifecycle");
var queueAuthorization = require("../lib/coop-queue-authorization");
var automationAuthorization = require("../lib/project-automation-execution-authorization");
var automationCandidates = require("../lib/project-automation-candidates");
var automationIdentity = require("../lib/project-automation-identity");
var createTopicIndex = require("../lib/coop-topic-index").createTopicIndex;
var createExternalTaskCoordinator =
  require("../lib/project-task-orchestrator-external-delegation").createExternalTaskCoordinator;
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
  // Exact owner ingress 509. Voice transcription produced "con you"; the
  // known request prefix is normalized, while the verb still has to be an
  // explicit implementation action.
  assert.deepEqual(lifecycle.explicitImplementationDecision("con you fix that?"), {
    intent: "fix", projectName: "",
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
  var targetProjectId = options.targetProjectId || PROJECT;
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
    autonomyPolicyFile: options.autonomyPolicyFile,
    bindingFile: path.join(dir, "bindings.json"),
    bindingStore: options.bindingStore,
    ownerRequests: options.ownerRequests || {
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
        entry.classification = { kind: "existing_topic", source: "owner_directed_execution" };
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
    getProjectId: function () { return targetProjectId; },
    validateAutomationAuthorization: options.validateAutomationAuthorization,
    deliverCrossProjectEnvelope: function (envelope) {
      delivered.push(envelope);
      if (typeof options.deliverCrossProjectEnvelope === "function") {
        return options.deliverCrossProjectEnvelope(envelope);
      }
      return { ok: true, created: true,
        sessionRef: { projectId: targetProjectId,
          sessionStorageId: options.targetSessionStorageId || "thread-worker" },
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

test("#2522: a new Webapp automation Thread claims the incumbent before control-plane migration", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-webapp-2522-control-plane-"));
  var ownerFile = path.join(dir, "owner-requests.json");
  var bindingFile = path.join(dir, "bindings.json");
  var topicFile = path.join(dir, "threads.json");
  var webapp = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
  var coopStorageId = "871a194b-8879-40f7-a1fe-656e48e722af";
  var incumbent = { projectId: webapp,
    sessionStorageId: "7e539a81-8ecf-4943-ad26-bcaf6544f1c0" };
  var priorTopic = { topicId: "auto-5cdaa61d7d8d8637ead5adaf" };
  var ownerLedger = require("../lib/coop-owner-requests")
    .attachCoopOwnerRequests({ file: ownerFile });
  var bindingStore = portfolioBindings.createPortfolioExecutionBindings({ file: bindingFile });
  var topicIndex = createTopicIndex({ file: topicFile, now: function () { return 1000; } });
  var portfolioTaskId = "auto:6bab7b2dfa0ca349934de11f:trialview-v2-2522";
  var candidate = {
    candidateKey: "launch:trialview/v2#2522",
    itemKey: "trialview/v2#2522",
    itemClass: "bug",
    admission: "auto",
    status: "pending",
    projectRef: { projectId: webapp },
    policyDigest: "policy-current-2522",
    recipeId: "assigned-to-me",
    eligibilityPass: "scan-current-2522",
    eligibility: {
      assignedToOwner: true,
      recipeAllowsUnassigned: false,
      reason: "assigned_to_owner",
    },
    intent: { recipeId: "assigned-to-me", number: 2522,
      title: "Replace the Excel zoom slider" },
  };
  candidate.digest = automationCandidates.contentDigest(candidate);
  var historicalRequest = {
    source: { projectId: "system-lead", sessionStorageId: coopStorageId },
    targetProject: { projectId: webapp },
    mode: "project_coordinator",
    portfolioTaskId: portfolioTaskId,
    bindingRevision: 1,
    idempotencyKey: automationIdentity.idempotencyKeyFor(portfolioTaskId, 1),
  };
  var delivered = [];
  var handedOff = [];
  var validator = automationAuthorization.createAuthorizationValidator({
    candidates: {
      pending: function () { return { ok: true, candidates: [candidate] }; },
    },
    getLeadMode: function () { return true; },
    loadPolicy: function () {
      return { ok: true, policy: {
        projectRef: { projectId: webapp },
        digest: candidate.policyDigest,
        autonomy: {
          bug: "autonomous", feature: "propose", ambiguous: "propose",
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
  function request() {
    var input = {
      source: { projectId: "system-lead", sessionStorageId: coopStorageId },
      targetProject: { projectId: webapp },
      mode: "project_coordinator",
      portfolioTaskId: portfolioTaskId,
      bindingRevision: 2,
      idempotencyKey: automationIdentity.idempotencyKeyFor(portfolioTaskId, 2),
      title: "#2522 Replace the Excel zoom slider",
      objective: "Resolve trialview/v2#2522.",
    };
    input.automationAuthorization = automationAuthorization.createAuthorization(candidate, input);
    input.coopTopicRef = { topicId: input.automationAuthorization.threadRef.threadId };
    return input;
  }
  function validate(input) { return validator.validate(input); }
  function link(input) {
    return topicIndex.linkExecution(input.topicRef, {
      projectRef: input.projectRef,
      sessionRef: input.sessionRef,
    });
  }
  try {
    assert.equal(ownerLedger.claimCoordinator({
      topicRef: priorTopic,
      projectRef: { projectId: webapp },
      coordinator: incumbent,
    }).ok, true);
    assert.equal(bindingStore.reserve(historicalRequest).ok, true);
    assert.equal(bindingStore.commit(portfolioTaskId, 1,
      { projectId: webapp, sessionStorageId: "historical-2522-worker" },
      { projectCoordinatorRef: incumbent }).ok, true);
    assert.equal(bindingStore.supersede(portfolioTaskId, 1,
      "historical_attempt_superseded").ok, true);
    var historicalBefore = bindingStore.get(portfolioTaskId, 1);

    var first = executionRouter([], delivered, handedOff, {
      dir: dir,
      targetProjectId: webapp,
      targetSessionStorageId: "2522-task-coordinator",
      canonicalStorageId: coopStorageId,
      bindingStore: bindingStore,
      ownerRequests: ownerLedger,
      automationThreadIndex: topicIndex,
      validateAutomationAuthorization: validate,
      onThreadHandedOff: link,
    });
    var created = first.router.createProjectExecution(request());

    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.binding.bindingRevision, 2);
    assert.equal(delivered.length, 1);
    assert.deepEqual(bindingStore.get(portfolioTaskId, 1), historicalBefore,
      "revision 1 remains immutable while the new Thread advances to revision 2");
    var rootRef = created.binding.projectCoordinator;
    assert.equal(rootRef.projectId, "system-lead");
    assert.deepEqual(ownerLedger.canonicalCoordinator(priorTopic, { projectId: webapp }), rootRef);
    assert.deepEqual(ownerLedger.canonicalCoordinator(request().coopTopicRef,
      { projectId: webapp }), rootRef);
    var webappClaims = ownerLedger.listCoordinators().filter(function (claim) {
      return claim.projectId === webapp;
    });
    assert.equal(webappClaims.length, 2);
    assert.deepEqual(webappClaims.map(function (claim) { return claim.coordinator; }),
      [rootRef, rootRef], "one project coordinator owns both the old and new Threads");

    var replay = first.router.createProjectExecution(request());
    assert.equal(replay.ok, true);
    assert.equal(replay.reused, true);
    assert.equal(delivered.length, 1, "an identical admission does not start a second task");

    var reloadedLedger = require("../lib/coop-owner-requests")
      .attachCoopOwnerRequests({ file: ownerFile });
    var reloadedStore = portfolioBindings.createPortfolioExecutionBindings({ file: bindingFile });
    assert.deepEqual(reloadedStore.get(portfolioTaskId, 1), historicalBefore);
    assert.deepEqual(reloadedLedger.canonicalCoordinator(request().coopTopicRef,
      { projectId: webapp }), rootRef);
    var restartDelivered = [];
    var restarted = executionRouter([], restartDelivered, [], {
      dir: dir,
      targetProjectId: webapp,
      canonicalStorageId: coopStorageId,
      bindingStore: reloadedStore,
      ownerRequests: reloadedLedger,
      automationThreadIndex: createTopicIndex({ file: topicFile, now: function () { return 2000; } }),
      validateAutomationAuthorization: validate,
      onThreadHandedOff: link,
    });
    assert.equal(restarted.router.createProjectExecution(request()).reused, true);
    assert.equal(restartDelivered.length, 0, "restart replay reuses revision 2 without redispatch");
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

test("a durably classified unmarked Main ingress binds one exact Thread task", function () {
  var delivered = [];
  var handedOff = [];
  var ingressId = "coop:canonical-coop:461";
  var entries = [{
    ingressId: ingressId,
    topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }],
    expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" },
    classification: { kind: "existing_topic", source: "explicit_owner_turn" },
    response: { state: "answered" },
    requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 0 },
  }];
  var approved = executionRouter(entries, delivered, handedOff, { history: [{
    type: "user_message", text: "solve it", coopComposerScope: "main",
    coopIngressId: ingressId,
  }] });
  var request = {
    source: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
    portfolioTaskId: "clay-stale-project-activity-indicator-2026-08-18",
    bindingRevision: 1,
    idempotencyKey: "clay-stale-project-activity-indicator-2026-08-18-r1",
    mode: "project_coordinator",
    targetProject: { projectId: PROJECT },
    coopTopicRef: TOPIC,
    coopIngressId: ingressId,
  };
  try {
    assert.equal(approved.router.createProjectExecution(request).ok, true);
    assert.deepEqual(entries[0].implementationScope, {
      projectRef: { projectId: PROJECT },
      topicRef: TOPIC,
      portfolioTaskId: "clay-stale-project-activity-indicator-2026-08-18",
      bindingRevision: 1,
      idempotencyKey: "clay-stale-project-activity-indicator-2026-08-18-r1",
    });
    assert.deepEqual(approved.router.createProjectExecution(Object.assign({}, request, {
      bindingRevision: 2,
      idempotencyKey: "clay-stale-project-activity-indicator-2026-08-18-r2",
    })), { ok: false, reason: "owner_implementation_scope_mismatch" });
    assert.equal(delivered.length, 1);
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("a superseded implementation ingress remains closed even when its Thread still exists", function () {
  var entries = [{
    ingressId: INGRESS,
    topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }],
    expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" },
    response: { state: "superseded" },
  }];
  var denied = executionRouter(entries, [], [], { history: [] });
  try {
    assert.deepEqual(execute(denied.router), {
      ok: false, reason: "owner_implementation_decision_required",
    });
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

test("board-exclusions dispatch claims its exact owner Thread before coordinator migration", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-board-exclusions-control-plane-"));
  var ownerFile = path.join(dir, "owner-requests.json");
  var webapp = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
  var coopStorageId = "871a194b-8879-40f7-a1fe-656e48e722af";
  var ingressId = "coop:" + coopStorageId + ":459";
  var boardTopic = { topicId: "owner-65d0dc78c4e6d085002842c1" };
  var priorTopic = { topicId: "auto-fb42f62b499c463e340f95b8" };
  var incumbent = { projectId: webapp,
    sessionStorageId: "7e539a81-8ecf-4943-ad26-bcaf6544f1c0" };
  var ownerLedger = require("../lib/coop-owner-requests")
    .attachCoopOwnerRequests({ file: ownerFile });
  var history = [{
    type: "user_message",
    text: "Implement the Webapp board-exclusions policy repair.",
    coopIngressId: ingressId,
    coopTopicRef: boardTopic,
    coopProjectRef: { projectId: webapp },
    coopImplementationDecision: { intent: "implement" },
    _ts: 1787010344341,
  }];
  var delivered = [];
  var handedOff = [];
  var request = {
    source: { projectId: "system-lead", sessionStorageId: coopStorageId },
    portfolioTaskId: "webapp-automation-policy-board-exclusions",
    bindingRevision: 1,
    idempotencyKey: "webapp-automation-policy-board-exclusions-r1",
    mode: "project_coordinator",
    targetProject: { projectId: webapp },
    coopTopicRef: boardTopic,
    coopIngressId: ingressId,
    title: "Repair Webapp board exclusions",
    objective: "Implement the approved Webapp automation-policy board exclusions.",
  };
  try {
    assert.ok(ownerLedger.record({
      ingressId: ingressId,
      ingressSequence: 459,
      ingressKind: "text",
      sessionRef: { projectId: "system-lead", sessionStorageId: coopStorageId },
      requestRef: { projectId: "system-lead", sessionStorageId: coopStorageId, eventIndex: 0 },
      topicRef: boardTopic,
      projectRefs: [{ projectId: webapp }],
      receivedAt: 1787010344329,
    }));
    var classified = ownerLedger.classify(ingressId, {
      kind: "existing_topic",
      source: "explicit_owner_turn",
      at: 1787010344341,
      topicRef: boardTopic,
      projectRefs: [{ projectId: webapp }],
      implementationDecision: {
        intent: "implement",
        source: "explicit_owner_turn",
        at: 1787010344341,
      },
    });
    var decisionBefore = classified.implementationDecision;
    var requestRefBefore = classified.requestRef;
    assert.equal(ownerLedger.claimCoordinator({
      topicRef: priorTopic,
      projectRef: { projectId: webapp },
      coordinator: incumbent,
    }).ok, true);

    var approved = executionRouter([], delivered, handedOff, {
      dir: dir,
      targetProjectId: webapp,
      targetSessionStorageId: "board-exclusions-task-coordinator",
      canonicalStorageId: coopStorageId,
      history: history,
      ownerRequests: ownerLedger,
    });
    var created = approved.router.createProjectExecution(request);

    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(delivered.length, 1);
    var rootRef = created.binding.projectCoordinator;
    assert.equal(rootRef.projectId, "system-lead");
    assert.deepEqual(ownerLedger.canonicalCoordinator(priorTopic, { projectId: webapp }), rootRef);
    assert.deepEqual(ownerLedger.canonicalCoordinator(boardTopic, { projectId: webapp }), rootRef);
    var boardClaim = ownerLedger.listCoordinators().filter(function (claim) {
      return claim.projectId === webapp && claim.topicId === boardTopic.topicId;
    });
    assert.equal(boardClaim.length, 1);
    assert.deepEqual(boardClaim[0].ingressIds, [ingressId],
      "the claim is linked to the exact owner ingress that authorized this task");
    assert.equal(boardClaim[0].transferReason, "coop_control_plane_migration");
    var linked = ownerLedger.get(ingressId);
    assert.deepEqual(linked.requestRef, requestRefBefore, "canonical owner event history is immutable");
    assert.deepEqual(linked.implementationDecision, decisionBefore,
      "the original owner decision is not restamped during routing");
    assert.deepEqual(linked.implementationScope, {
      projectRef: { projectId: webapp },
      topicRef: boardTopic,
      portfolioTaskId: request.portfolioTaskId,
      bindingRevision: request.bindingRevision,
      idempotencyKey: request.idempotencyKey,
    });
    assert.deepEqual(linked.links.coordinators, [rootRef]);

    var bindingBeforeReplay = approved.router.getExecutionBinding(request.portfolioTaskId, 1);
    var replay = approved.router.createProjectExecution(request);
    assert.equal(replay.ok, true);
    assert.equal(replay.reused, true);
    assert.equal(delivered.length, 1, "owner ingress replay does not create a second task");
    assert.deepEqual(approved.router.getExecutionBinding(request.portfolioTaskId, 1),
      bindingBeforeReplay);

    var reloaded = require("../lib/coop-owner-requests")
      .attachCoopOwnerRequests({ file: ownerFile });
    assert.deepEqual(reloaded.get(ingressId), linked);
    assert.deepEqual(reloaded.canonicalCoordinator(boardTopic, { projectId: webapp }), rootRef);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("owner ingress 508 resolves approval to exact scope and starts one canonical worker", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-ingress-508-"));
  var delivered = [];
  var handedOff = [];
  var approvalIngress = "coop:canonical-coop:508";
  var portfolioTaskId = "clay-voice-end-to-end-qa-2026-08-18";
  var idempotencyKey = portfolioTaskId + "-r2";
  var history = [{
    type: "user_message",
    text: "approve voice rev2, the mcp clay extension should be there",
    coopIngressId: approvalIngress,
    coopIngressSequence: 508,
    coopComposerScope: "main",
    clientMessageId: "ingress-508",
    _ts: 2000,
  }];
  // Reproduces the real ambiguity: the append-only ledger still held Voice
  // attention for three revisions when the owner named rev2.
  var leadEvents = [1, 2, 3].map(function (revision, index) {
    return {
      type: "staffing_attention",
      attentionKey: portfolioTaskId + ":" + revision,
      itemId: portfolioTaskId,
      portfolioTaskId: portfolioTaskId,
      bindingRevision: revision,
      seq: index + 1,
      at: 1000 + index,
    };
  });
  var ownerLedger = require("../lib/coop-owner-requests").attachCoopOwnerRequests({
    file: path.join(dir, "owner-requests.json"),
  });
  var topicIndex = createTopicIndex({ file: path.join(dir, "topics.json") });
  ownerLedger.record({
    ingressId: approvalIngress,
    ingressSequence: 508,
    ingressKind: "text",
    sessionRef: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
    requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 0 },
    receivedAt: 2000,
  });
  ownerLedger.classify(approvalIngress, {
    kind: "conversational",
    source: "ingress_route",
    at: 2000,
  });
  var invalidScope = ownerLedger.scopeImplementation(approvalIngress, {
    projectRef: { projectId: PROJECT },
    portfolioTaskId: portfolioTaskId,
    bindingRevision: 2,
    idempotencyKey: idempotencyKey,
    implementationDecision: {
      intent: "implement", source: "explicit_item_approval", at: 2000,
    },
  });
  assert.equal(invalidScope.reason, "invalid_owner_implementation_scope");
  assert.equal(ownerLedger.get(approvalIngress).implementationDecision, null,
    "an invalid approval scope must not leave broad execution authority behind");
  var approved = executionRouter([], delivered, handedOff, {
    dir: dir,
    ownerRequests: ownerLedger,
    history: history,
    leadEvents: leadEvents,
    onThreadHandedOff: function (input) {
      return topicIndex.linkExecution(input.topicRef, {
        projectRef: input.projectRef,
        sessionRef: input.sessionRef,
      });
    },
  });
  var source = { localId: 1, storageId: "canonical-coop", coopHome: true, history: history };
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    ownerRequests: ownerLedger,
    readLeadEvents: function () { return leadEvents; },
    ensureOwnerThread: function (input) { return topicIndex.ensureOwnerThread(input); },
    createProjectExecution: approved.router.createProjectExecution,
  });
  try {
    var request = {
      coordinatorSessionId: "canonical-coop",
      portfolioTaskId: portfolioTaskId,
      bindingRevision: 2,
      idempotencyKey: idempotencyKey,
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT },
      title: "Verify Clay Voice end to end",
      objective: "Verify Clay Voice end to end through the connected extension.",
    };
    // No ingress, approval ref, ThreadRef, or ProjectRef route is supplied. The
    // production coordinator must discover all approval linkage itself.
    var result = coordinate(request);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.binding.targetProject, { projectId: PROJECT });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].payload.coopApprovalIngressId, approvalIngress);
    assert.equal(delivered[0].destination.projectId, PROJECT);

    var classified = ownerLedger.get(approvalIngress);
    assert.deepEqual(classified.implementationDecision, {
      intent: "implement", source: "explicit_item_approval", at: 2000,
    });
    assert.equal(classified.classification.kind, "existing_topic");
    assert.equal(classified.classification.source, "owner_named_approval");
    assert.equal(classified.expectsExecution, true);
    assert.deepEqual(classified.implementationScope, {
      projectRef: { projectId: PROJECT },
      topicRef: classified.topicRef,
      portfolioTaskId: portfolioTaskId,
      bindingRevision: 2,
      idempotencyKey: idempotencyKey,
    });
    assert.equal(topicIndex.resolve(classified.topicRef, true).thread.relatedExecutions.length, 1);

    var replayed = coordinate(request);
    assert.equal(replayed.ok, true);
    assert.equal(replayed.reused, true);
    assert.equal(delivered.length, 1, "approval replay must not start a duplicate worker");
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("owner ingress 605 dispatches its exact approval despite fenced pasted context", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-ingress-605-"));
  var delivered = [];
  var taskId = "clay-coop-end-to-end-ownership-2026-08-22";
  var ingressId = "coop:canonical-coop:605";
  var history = [{
    type: "user_message",
    text: "Approve " + taskId + " rev1 implementation for ProjectRef " + PROJECT +
      ".\n```Fair. The bar is: visible worker or durable attention. If Coop needs you " +
      "to ask \"what happened?\" again, that is itself a defect.",
    coopIngressId: ingressId,
    coopComposerScope: "main",
    coopClassification: "conversational",
    coopImplementationDecision: null,
    _ts: 605000,
  }];
  var ownerLedger = require("../lib/coop-owner-requests").attachCoopOwnerRequests({
    file: path.join(dir, "owner-requests.json"),
  });
  var topicIndex = createTopicIndex({ file: path.join(dir, "topics.json") });
  ownerLedger.record({
    ingressId: ingressId,
    ingressSequence: 605,
    ingressKind: "text",
    sessionRef: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
    requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 0 },
    receivedAt: 605000,
  });
  ownerLedger.classify(ingressId, { kind: "conversational", source: "ingress_route" });
  var approved = executionRouter([], delivered, [], {
    dir: dir,
    ownerRequests: ownerLedger,
    history: history,
    leadEvents: [],
  });
  var source = { localId: 1, storageId: "canonical-coop", coopHome: true, history: history };
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    ownerRequests: ownerLedger,
    readLeadEvents: function () { return []; },
    ensureOwnerThread: function (input) { return topicIndex.ensureOwnerThread(input); },
    createProjectExecution: approved.router.createProjectExecution,
  });
  try {
    // The production seam receives only the typed target. It must discover the
    // approval ingress and mint the Thread itself; supplying either here would
    // skip the failed lookup this regression exists to exercise.
    var result = coordinate({
      coordinatorSessionId: "canonical-coop",
      portfolioTaskId: taskId,
      bindingRevision: 1,
      idempotencyKey: taskId + "-owner-ingress-605",
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT },
      title: "Make Coop own end-to-end closure without owner nudges",
      objective: "Implement and verify the exact owner-approved change.",
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].payload.coopApprovalIngressId, ingressId);
    assert.equal(delivered[0].destination.projectId, PROJECT,
      "the admitted command must stay project-bound rather than execute in Lead");
    var scoped = ownerLedger.get(ingressId);
    assert.equal(scoped.expectsExecution, true);
    assert.equal(scoped.implementationDecision.source, "explicit_item_approval");
    assert.equal(scoped.implementationScope.portfolioTaskId, taskId);
    assert.deepEqual(scoped.implementationScope.projectRef, { projectId: PROJECT });
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

test("one exact owner turn dispatches every named task and keeps their scopes independent", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-multi-exact-approval-"));
  var delivered = [];
  var approvalIngress = "coop:canonical-coop:552";
  var tasks = [{
    portfolioTaskId: "clay-voice-panel-not-opening-regression-2026-08-21",
    bindingRevision: 3,
  }, {
    portfolioTaskId: "clay-visible-worker-terminal-auto-hide-regression-2026-08-21",
    bindingRevision: 1,
  }];
  var history = [{
    type: "user_message",
    text: "Approve " + tasks[0].portfolioTaskId + " rev3 implementation for ProjectRef " +
      PROJECT + ".\n\nApprove " + tasks[1].portfolioTaskId +
      " rev1 implementation for ProjectRef " + PROJECT + ".",
    coopIngressId: approvalIngress,
    coopComposerScope: "main",
    _ts: 552000,
  }];
  var ownerLedger = require("../lib/coop-owner-requests").attachCoopOwnerRequests({
    file: path.join(dir, "owner-requests.json"),
  });
  var topicIndex = createTopicIndex({ file: path.join(dir, "topics.json") });
  ownerLedger.record({
    ingressId: approvalIngress,
    ingressSequence: 552,
    ingressKind: "text",
    sessionRef: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
    requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 0 },
    receivedAt: 552000,
  });
  ownerLedger.classify(approvalIngress, { kind: "existing_topic", source: "ingress_route" });
  var approved = executionRouter([], delivered, [], {
    dir: dir,
    ownerRequests: ownerLedger,
    history: history,
    leadEvents: [],
  });
  var source = { localId: 1, storageId: "canonical-coop", coopHome: true, history: history };
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    ownerRequests: ownerLedger,
    readLeadEvents: function () { return []; },
    ensureOwnerThread: function (input) { return topicIndex.ensureOwnerThread(input); },
    createProjectExecution: approved.router.createProjectExecution,
  });
  try {
    tasks.forEach(function (task) {
      var result = coordinate({
        coordinatorSessionId: "canonical-coop",
        portfolioTaskId: task.portfolioTaskId,
        bindingRevision: task.bindingRevision,
        idempotencyKey: task.portfolioTaskId + "-r" + task.bindingRevision,
        mode: "project_coordinator",
        targetProject: { projectId: PROJECT },
        title: "Implement " + task.portfolioTaskId,
        objective: "Implement the exact owner-approved change.",
      });
      assert.equal(result.ok, true, JSON.stringify(result));
    });

    assert.equal(delivered.length, 2, "each independently named task gets one binding");
    assert.deepEqual(delivered.map(function (envelope) {
      return envelope.payload.coopApprovalIngressId;
    }), [approvalIngress, approvalIngress]);
    var entry = ownerLedger.get(approvalIngress);
    assert.equal(entry.implementationScopes.length, 2);
    assert.deepEqual(entry.implementationScopes.map(function (scope) {
      return [scope.projectRef.projectId, scope.portfolioTaskId, scope.bindingRevision];
    }), [[PROJECT, tasks[0].portfolioTaskId, 3], [PROJECT, tasks[1].portfolioTaskId, 1]]);
  } finally { fs.rmSync(approved.dir, { recursive: true, force: true }); }
});

// Regression: the standing autonomy grant was unreachable for exactly the
// dispatches it was written for.
//
// A grant in scoped-autonomy-policy.json authorizes a category of work in named
// projects ahead of time, so there is no owner turn behind it and nothing to
// hang a Thread on. But implementationAdmission demands a Thread on its first
// line and only reaches autonomyGrant.standingAdmission through
// itemApproval.executionAdmission far below it, and the only thing that mints a
// Thread is an owner turn that parses as an implementation decision. Measured
// live on 2026-08-22, ingresses 629/632: three read-only diagnosis dispatches
// into an allowlisted project were refused owner_implementation_decision_required
// while standingAdmission, asked directly with the same inputs, answered ok.
//
// test/coop-widened-autonomy-grant.test.js could not see this because every one
// of its requests hand-supplies `coopTopicRef` -- verifying a lookup by
// supplying the answer it is meant to find. This drives the production
// coordinator with no ingress, no ThreadRef and no approval ref, over an owner
// history whose newest turn is an ordinary question, and makes it discover
// everything itself.
function grantPolicyFile(enabled, projects) {
  var shipped = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "scoped-autonomy-policy.json"), "utf8"));
  shipped.enabled = enabled;
  if (projects) shipped.projects = projects;
  var file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clay-grant-route-")),
    "scoped-autonomy-policy.json");
  fs.writeFileSync(file, JSON.stringify(shipped, null, 2) + "\n");
  return file;
}

function grantHistory() {
  // The exact shape that broke it: the newest owner turn is a question, so
  // explicitImplementationDecision returns null and nothing mints a Thread.
  return [{
    type: "user_message",
    text: "what you're going to check is why you did not respond to me in voice " +
      "when I was in a different Project",
    coopIngressId: "coop:canonical-coop:631",
    coopIngressSequence: 631,
    coopComposerScope: "main",
    clientMessageId: "ingress-631",
    _ts: 3000,
  }];
}

function grantCoordinator(policyFile, delivered, topicIndex, dir) {
  var history = grantHistory();
  var built = executionRouter([], delivered, [], {
    dir: dir,
    autonomyPolicyFile: policyFile,
    history: history,
    onThreadHandedOff: function (input) {
      return topicIndex.linkExecution(input.topicRef, {
        projectRef: input.projectRef,
        sessionRef: input.sessionRef,
      });
    },
  });
  var source = { localId: 1, storageId: "canonical-coop", coopHome: true, history: history };
  return createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    autonomyPolicyFile: policyFile,
    readLeadEvents: function () { return []; },
    ensureOwnerThread: function (input) { return topicIndex.ensureOwnerThread(input); },
    createProjectExecution: built.router.createProjectExecution,
  });
}

function grantDispatch(overrides) {
  return Object.assign({
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: "clay-codex-openai-unavailable-diagnosis-2026-08-22",
    bindingRevision: 1,
    idempotencyKey: "clay-codex-openai-unavailable-diagnosis-2026-08-22-r1",
    mode: "project_coordinator",
    targetProject: { projectId: PROJECT },
    title: "Diagnose why Codex via OpenAI reports unavailable",
    objective: "Investigate and report why the provider route reports unavailable. Change nothing.",
    ownedPaths: "read-only: lib/provider-routes.js; read-only: lib/provider-command.js",
  }, overrides || {});
}

test("a standing read-only grant supplies its own Thread when no owner turn can", function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-grant-reachable-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var topicIndex = createTopicIndex({ file: path.join(dir, "topics.json") });

  // Switch OFF must be byte-identical to having no grant: the same dispatch is
  // refused with the same reason the live session saw.
  var offDelivered = [];
  var offDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-grant-off-"));
  t.after(function () { fs.rmSync(offDir, { recursive: true, force: true }); });
  var refused = grantCoordinator(grantPolicyFile(false), offDelivered,
    createTopicIndex({ file: path.join(offDir, "topics.json") }), offDir)(grantDispatch());
  assert.equal(refused.ok, false);
  assert.match(String(refused.error || refused.reason),
    /owner_implementation_decision_required/);
  assert.equal(offDelivered.length, 0);

  // Switched on, the same dispatch is admitted as read-only work, and the
  // Thread it runs under was minted by policy rather than by an owner turn.
  var delivered = [];
  var onFile = grantPolicyFile(true);
  var result = grantCoordinator(onFile, delivered, topicIndex, dir)(grantDispatch());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].destination.projectId, PROJECT);
  var topicId = delivered[0].payload.coopTopicRef.topicId;
  assert.ok(topicId, "the dispatch must carry a Thread");
  assert.equal(delivered[0].payload.coopIngressId, undefined,
    "a standing grant cites no owner ingress, because there is none");

  // Deterministic per task, so a retry reuses the container instead of minting
  // a second one for the same work.
  var second = grantCoordinator(onFile, delivered, topicIndex, dir)(grantDispatch());
  assert.equal(second.reused, true, JSON.stringify(second));
  assert.equal(Object.keys(topicIndex.load().topics).length, 1);
});

test("the standing grant route refuses work the policy does not cover", function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-grant-uncovered-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var onFile = grantPolicyFile(true);

  // A writable dispatch is not read-only diagnosis, so no category covers it and
  // no Thread is minted -- the same refusal as with the switch off.
  var writableDelivered = [];
  var writable = grantCoordinator(onFile, writableDelivered,
    createTopicIndex({ file: path.join(dir, "writable.json") }), dir)(grantDispatch({
      ownedPaths: "lib/provider-routes.js",
    }));
  assert.equal(writable.ok, false);
  assert.match(String(writable.error || writable.reason),
    /owner_implementation_decision_required/);
  assert.equal(writableDelivered.length, 0);

  // A read-only shape whose text names a permanently gated action stays gated,
  // even inside an allowlisted project.
  var gatedDelivered = [];
  var gated = grantCoordinator(onFile, gatedDelivered,
    createTopicIndex({ file: path.join(dir, "gated.json") }), dir)(grantDispatch({
      objective: "Investigate the route, then git push the fix to origin.",
    }));
  assert.equal(gated.ok, false);
  assert.equal(gatedDelivered.length, 0);

  // An allowlisted category in a project the policy does not name is not covered.
  var otherDelivered = [];
  var other = grantCoordinator(grantPolicyFile(true, ["f2b7c47a-bb03-5b3d-89ff-dd32ddb2be53"]),
    otherDelivered, createTopicIndex({ file: path.join(dir, "other.json") }),
    dir)(grantDispatch());
  assert.equal(other.ok, false);
  assert.equal(otherDelivered.length, 0);
});
