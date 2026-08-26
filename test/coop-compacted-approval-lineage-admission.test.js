require("./helpers/isolated-clay-home");

var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");

var itemApproval = require("../lib/coop-item-approval");
var createTopicIndex = require("../lib/coop-topic-index").createTopicIndex;
var ownerRequestsModule = require("../lib/coop-owner-requests");
var createExternalTaskCoordinator =
  require("../lib/project-task-orchestrator-external-delegation").createExternalTaskCoordinator;
var createCrossProjectRouter = require("../lib/server-cross-project").createCrossProjectRouter;

var LEAD_PROJECT = "system-lead";
var WEBAPP_PROJECT = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
var OTHER_PROJECT = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var PREDECESSOR = "2d05bb43-8d57-48e4-8b59-b73d09fdd5ff";
var SUCCESSOR = "84b22bd0-f2c4-48ae-9a84-3e02975c9508";
var TASK = "webapp-archive-six-dormant-coop-sessions-20260826";
var TOPIC = { topicId: "owner-approval-lineage-webapp" };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-compacted-approval-lineage-"));
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function exactApproval(overrides) {
  var options = overrides || {};
  var task = options.task || TASK;
  var revision = options.revision == null ? 1 : options.revision;
  var projectId = options.projectId === undefined ? WEBAPP_PROJECT : options.projectId;
  var projectText = projectId ? " for ProjectRef " + projectId : "";
  return {
    type: "user_message",
    text: options.text || "Approve " + task + " revision " + revision +
      " implementation" + projectText,
    coopIngressId: options.ingressId || "coop:" + PREDECESSOR + ":700",
    coopComposerScope: "main",
    _ts: options.at == null ? 700000 : options.at,
  };
}

function approvalHarness(options) {
  var opts = options || {};
  var dir = tempDir();
  var approval = opts.approval || exactApproval();
  var predecessor = opts.predecessor || {
    coopHome: true,
    storageId: PREDECESSOR,
    history: [approval],
  };
  var successor = opts.successor || {
    coopHome: true,
    storageId: SUCCESSOR,
    history: [],
  };
  if (opts.lineage !== false && successor.compactedFromStorageId === undefined) {
    successor.compactedFromStorageId = opts.predecessorStorageId === undefined ?
      PREDECESSOR : opts.predecessorStorageId;
  }
  var sessions = new Map([[1, successor]]);
  if (opts.includePredecessor !== false) sessions.set(2, predecessor);
  (opts.additionalSessions || []).forEach(function (session, index) {
    sessions.set(index + 3, session);
  });
  var manager = {
    sessions: sessions,
    createSessionRaw: function (input) { return Object.assign({ history: [] }, input || {}); },
    saveSessionFile: function () {},
  };
  var ownerRequests = ownerRequestsModule.attachCoopOwnerRequests({
    file: path.join(dir, "owner-requests.json"),
  });
  ownerRequests.record({
    ingressId: approval.coopIngressId,
    ingressSequence: 700,
    ingressKind: "text",
    sessionRef: { projectId: LEAD_PROJECT, sessionStorageId: PREDECESSOR },
    requestRef: { projectId: LEAD_PROJECT, sessionStorageId: PREDECESSOR, eventIndex: 0 },
    receivedAt: approval._ts,
  });
  ownerRequests.classify(approval.coopIngressId, {
    kind: "existing_topic",
    source: "ingress_route",
  });

  var deliveries = [];
  var topicIndex = createTopicIndex({ file: path.join(dir, "topics.json") });
  var router = createCrossProjectRouter({
    allowLeadSourcedExecution: true,
    autonomyPolicyFile: path.join(dir, "absent-autonomy-policy.json"),
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    ownerRequests: ownerRequests,
    readLeadEvents: function () { return opts.leadEvents || [{
      type: "cutover_attention",
      portfolioTaskId: TASK,
      bindingRevision: 1,
      attentionKey: TASK + ":1",
      at: 600000,
    }]; },
    requireOwnerImplementationDecision: true,
    onThreadHandedOff: function () { return { ok: true }; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return LEAD_PROJECT; },
    getSessionManager: function () { return manager; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return WEBAPP_PROJECT; },
    deliverCrossProjectEnvelope: function (envelope) {
      deliveries.push(envelope);
      return {
        ok: true,
        created: true,
        sessionRef: { projectId: WEBAPP_PROJECT, sessionStorageId: "webapp-worker" },
        projectCoordinatorRef: envelope.payload.targetProjectCoordinator,
      };
    },
  });
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return successor; },
    projectId: function () { return LEAD_PROJECT; },
    sm: manager,
    ownerRequests: ownerRequests,
    readLeadEvents: function () { return opts.leadEvents || [{
      type: "cutover_attention",
      portfolioTaskId: TASK,
      bindingRevision: 1,
      attentionKey: TASK + ":1",
      at: 600000,
    }]; },
    ensureOwnerThread: function (input) { return topicIndex.ensureOwnerThread(input); },
    createProjectExecution: router.createProjectExecution,
  });
  return {
    approval: approval,
    coordinate: coordinate,
    deliveries: deliveries,
    dir: dir,
    ownerRequests: ownerRequests,
    predecessor: predecessor,
    successor: successor,
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function dispatch(harness) {
  return harness.coordinate({
    coordinatorSessionId: SUCCESSOR,
    portfolioTaskId: TASK,
    bindingRevision: 1,
    idempotencyKey: "lead-tick-20260826-webapp-archive-six-dormant-r1",
    mode: "project_coordinator",
    targetProject: { projectId: WEBAPP_PROJECT },
    title: "Archive six dormant Webapp sessions",
    objective: "Archive only the six exact Webapp sessions the owner approved.",
    ownedPaths: "read-only: exact six dormant Webapp sessions",
  });
}

test("an exact staged Webapp approval remains admissible through its compacted Coop successor",
  function (t) {
    var h = approvalHarness();
    t.after(h.cleanup);
    var predecessorBefore = copy(h.predecessor);
    var successorBefore = copy(h.successor);

    var first = dispatch(h);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.deliveries[0].payload.coopApprovalIngressId, h.approval.coopIngressId);
    var entry = h.ownerRequests.get(h.approval.coopIngressId);
    var firstScopes = ownerRequestsModule.implementationScopesFor(entry);
    assert.deepEqual(firstScopes.map(function (scope) {
      return [scope.projectRef.projectId, scope.portfolioTaskId, scope.bindingRevision];
    }), [[WEBAPP_PROJECT, TASK, 1]]);
    assert.deepEqual(h.predecessor, predecessorBefore,
      "lineage lookup must not rewrite the predecessor transcript");
    assert.deepEqual(h.successor, successorBefore,
      "lineage lookup must not rewrite the successor metadata or transcript");

    var decisionAfterFirstAdmission = copy(entry.implementationDecision);
    var scopesAfterFirstAdmission = copy(firstScopes);
    var second = dispatch(h);
    assert.equal(second.ok, true, JSON.stringify(second));
    entry = h.ownerRequests.get(h.approval.coopIngressId);
    assert.equal(ownerRequestsModule.implementationScopesFor(entry).length, 1,
      "retrying the successor dispatch must not duplicate the owner's exact scope");
    assert.deepEqual(entry.implementationDecision, decisionAfterFirstAdmission,
      "retrying admission must not change the recorded owner decision");
    assert.deepEqual(ownerRequestsModule.implementationScopesFor(entry), scopesAfterFirstAdmission,
      "retrying admission must retain the same single exact scope");
  });

test("compacted approval lineage refuses mismatched, unscoped, post-hoc, and unrelated assent",
  function (t) {
    var cases = [{
      name: "mismatched task",
      options: { approval: exactApproval({ task: TASK + "-other" }) },
    }, {
      name: "mismatched revision",
      options: { approval: exactApproval({ revision: 2 }) },
    }, {
      name: "mismatched ProjectRef",
      options: { approval: exactApproval({ projectId: OTHER_PROJECT }) },
    }, {
      name: "unscoped assent",
      options: { approval: exactApproval({ text: "Yes, proceed." }) },
    }, {
      name: "post-hoc exact assent",
      options: {
        approval: exactApproval({ at: 100 }),
        leadEvents: [{
          type: "cutover_attention",
          portfolioTaskId: TASK,
          bindingRevision: 1,
          attentionKey: TASK + ":1",
          at: 200,
        }],
      },
    }, {
      name: "missing lineage",
      options: { lineage: false },
    }, {
      name: "unrelated lineage",
      options: {
        predecessorStorageId: "unrelated-predecessor",
        additionalSessions: [{
          coopHome: true,
          storageId: "unrelated-predecessor",
          history: [],
        }],
      },
    }];
    cases.forEach(function (candidate) {
      var h = approvalHarness(candidate.options);
      t.after(h.cleanup);
      var result = dispatch(h);
      assert.equal(result.ok, false, candidate.name + " must remain refused: " +
        JSON.stringify(result));
      assert.equal(h.deliveries.length, 0, candidate.name + " must create no dispatch");
      assert.equal(ownerRequestsModule.implementationScopesFor(
        h.ownerRequests.get(h.approval.coopIngressId)).length, 0,
        candidate.name + " must not create an implementation scope");
    });
  });

test("compacted approval traversal is bounded, deterministic, cycle-safe, and read-only",
  function () {
    var predecessor = {
      storageId: "lineage-predecessor",
      history: [exactApproval({ ingressId: "coop:lineage-predecessor:1" })],
    };
    var successor = {
      storageId: "lineage-successor",
      compactedFromStorageId: predecessor.storageId,
      history: [{ type: "done", code: 0 }],
    };
    var sessions = new Map([[1, predecessor], [2, successor]]);
    var predecessorBefore = copy(predecessor);
    var successorBefore = copy(successor);
    assert.strictEqual(itemApproval.compactedApprovalSessionFor(successor, sessions,
      predecessor.storageId), predecessor);
    assert.deepEqual(itemApproval.approvalHistoryFor(successor, sessions),
      predecessor.history.concat(successor.history));
    assert.deepEqual(itemApproval.approvalHistoryFor(successor, sessions),
      predecessor.history.concat(successor.history), "the same lineage must replay deterministically");
    assert.deepEqual(predecessor, predecessorBefore);
    assert.deepEqual(successor, successorBefore);

    var chain = [];
    for (var i = 0; i <= itemApproval.MAX_COMPACTED_APPROVAL_PREDECESSORS + 1; i++) {
      chain.push({ storageId: "bounded-lineage-" + i, history: [{ type: "done", code: i }] });
      if (i > 0) chain[i].compactedFromStorageId = chain[i - 1].storageId;
    }
    var boundedSessions = new Map(chain.map(function (session, index) {
      return [index, session];
    }));
    var bounded = chain[chain.length - 1];
    assert.deepEqual(itemApproval.approvalHistoryFor(bounded, boundedSessions), bounded.history,
      "a lineage beyond the fixed predecessor bound must fail closed");
    assert.equal(itemApproval.compactedApprovalSessionFor(bounded, boundedSessions,
      chain[0].storageId), null, "a too-distant predecessor is never resolved");

    var cyclePredecessor = {
      storageId: "cycle-predecessor",
      compactedFromStorageId: "cycle-successor",
      history: [exactApproval({ ingressId: "coop:cycle-predecessor:1" })],
    };
    var cycleSuccessor = {
      storageId: "cycle-successor",
      compactedFromStorageId: "cycle-predecessor",
      history: [{ type: "done", code: 0 }],
    };
    var cycleSessions = new Map([[1, cyclePredecessor], [2, cycleSuccessor]]);
    assert.deepEqual(itemApproval.approvalHistoryFor(cycleSuccessor, cycleSessions),
      cycleSuccessor.history, "a cyclic lineage must not expose predecessor assent");
    assert.equal(itemApproval.compactedApprovalSessionFor(cycleSuccessor, cycleSessions,
      cyclePredecessor.storageId), null, "a cyclic predecessor reference stays refused");
  });
