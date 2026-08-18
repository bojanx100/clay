var test = require("node:test");
var assert = require("node:assert/strict");

var externalDelegation = require("../lib/project-task-orchestrator-external-delegation");
var attachTaskOrchestrator = require("../lib/project-task-orchestrator").attachTaskOrchestrator;

var PROJECT_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var LEAD_PROJECT_ID = "system-lead";

function request(portfolioTaskId, topicId) {
  return {
    coordinatorSessionId: "canonical-coop",
    portfolioTaskId: portfolioTaskId,
    bindingRevision: 1,
    idempotencyKey: portfolioTaskId + "-r1",
    mode: "project_coordinator",
    targetProject: { projectId: PROJECT_ID },
    coopTopicRef: { topicId: topicId },
    title: portfolioTaskId,
    objective: "Complete " + portfolioTaskId + ".",
    context: "Independent admitted work.",
    acceptanceCriteria: "A durable visible target session is created.",
    ownedPaths: "lib/" + portfolioTaskId + ".js",
  };
}

function ledgerEntry(ingressId, topicId, eventIndex) {
  return {
    ingressId: ingressId,
    topicRef: { topicId: topicId },
    sessionRef: { projectId: LEAD_PROJECT_ID, sessionStorageId: "canonical-coop" },
    requestRef: {
      projectId: LEAD_PROJECT_ID,
      sessionStorageId: "canonical-coop",
      eventIndex: eventIndex,
    },
    expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn" },
  };
}

test("independent admitted project work retains each exact ledger ingress despite a later Main command", function () {
  var alphaTopic = "owner-admitted-alpha";
  var betaTopic = "owner-admitted-beta";
  var alphaIngress = "coop:canonical-coop:473";
  var betaIngress = "coop:canonical-coop:475";
  var laterIngress = "coop:canonical-coop:482";
  var source = {
    localId: 1,
    storageId: "canonical-coop",
    history: [{
      type: "user_message",
      text: "Implement alpha.",
      coopIngressId: alphaIngress,
      coopTopicRef: { topicId: alphaTopic },
    }, {
      type: "user_message",
      text: "Implement beta.",
      coopIngressId: betaIngress,
      coopTopicRef: { topicId: betaTopic },
    }, {
      type: "user_message",
      text: "Fix!",
      coopIngressId: laterIngress,
      coopComposerScope: "main",
      coopImplementationDecision: { intent: "fix" },
    }],
  };
  var entries = [
    ledgerEntry(alphaIngress, alphaTopic, 0),
    ledgerEntry(betaIngress, betaTopic, 1),
  ];
  var createdSessions = new Map();
  var delivered = [];
  var coordinate = externalDelegation.createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return LEAD_PROJECT_ID; },
    ownerRequests: {
      forTopic: function (topicRef) {
        return entries.filter(function (entry) {
          return entry.topicRef.topicId === topicRef.topicId;
        });
      },
    },
    createProjectExecution: function (input) {
      var expectedIngress = input.portfolioTaskId === "admitted-alpha" ? alphaIngress : betaIngress;
      if (input.coopIngressId !== expectedIngress) {
        return { ok: false, error: "wrong owner ingress: " + String(input.coopIngressId || "none") };
      }
      var sessionStorageId = "visible-" + input.portfolioTaskId;
      createdSessions.set(sessionStorageId, {
        storageId: sessionStorageId,
        hidden: false,
        orchestrationPolicy: { portfolioExecution: {
          status: "running",
          portfolioTaskId: input.portfolioTaskId,
        } },
      });
      delivered.push(input);
      return {
        ok: true,
        created: true,
        mode: "project_coordinator",
        sessionStorageId: sessionStorageId,
        coordinatorSessionId: sessionStorageId,
      };
    },
  });

  var alpha = coordinate(request("admitted-alpha", alphaTopic));
  var beta = coordinate(request("admitted-beta", betaTopic));

  assert.equal(alpha.ok, true);
  assert.equal(beta.ok, true);
  assert.deepEqual(delivered.map(function (input) { return input.coopIngressId; }),
    [alphaIngress, betaIngress]);
  assert.equal(createdSessions.size, 2);
  assert.deepEqual(Array.from(createdSessions.values()).map(function (session) {
    return [session.hidden, session.orchestrationPolicy.portfolioExecution.status];
  }), [[false, "running"], [false, "running"]]);
  assert.notEqual(alpha.coordinatorSessionId, beta.coordinatorSessionId);
});

test("a project-bound coordinator starts independent local workers concurrently and persists their visible ownership", function () {
  var sessions = new Map();
  var saved = [];
  var starts = [];
  var nextLocalId = 2;
  var parent = {
    localId: 1,
    storageId: "project-task-coordinator",
    title: "Project task coordinator",
    vendor: "codex",
    model: "gpt-5.6-terra",
    history: [],
    isProcessing: false,
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    orchestrationTasks: [],
    orchestrationEvents: [],
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "admitted-parent",
      bindingRevision: 1,
      idempotencyKey: "admitted-parent-r1",
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT_ID },
      status: "running",
    } },
  };
  sessions.set(parent.localId, parent);
  var sm = {
    sessions: sessions,
    defaultVendor: "codex",
    getProjectId: function () { return PROJECT_ID; },
    createSessionRaw: function (options) {
      var session = Object.assign({
        localId: nextLocalId++,
        history: [],
        isProcessing: false,
      }, options);
      sessions.set(session.localId, session);
      return session;
    },
    appendToSessionFile: function () {},
    saveSessionFile: function (session) { saved.push(session.storageId); },
    broadcastSessionList: function () {},
    subscribeSession: function () { return function () {}; },
  };
  var api = attachTaskOrchestrator({
    slug: "clay",
    sm: sm,
    crossProject: {
      createProjectExecution: function () {
        assert.fail("a project-bound local leaf must not create a second cross-project binding");
      },
    },
    sdk: {
      startQuery: function (session) { starts.push(session); },
      pushMessage: function () {},
    },
    sendToSession: function () {},
    onProcessingChanged: function () {},
    ensureProjectAccessForSession: function () {},
  });

  function localLeaf(clientRef, ownedPaths) {
    return api.coordinateExternalTask({
      coordinatorSessionId: parent.storageId,
      portfolioTaskId: "admitted-parent",
      bindingRevision: 1,
      idempotencyKey: "admitted-parent-r1",
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT_ID },
      clientRef: clientRef,
      title: "Independent " + clientRef,
      objective: "Complete " + clientRef + " independently.",
      context: "This project-bound task is independently admitted.",
      acceptanceCriteria: "A visible durable worker is running.",
      ownedPaths: ownedPaths,
    });
  }

  var first = localLeaf("independent-a", "lib/independent-a.js");
  var second = localLeaf("independent-b", "lib/independent-b.js");
  var tasks = parent.orchestrationTasks;

  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(starts.length, 2);
  assert.deepEqual(tasks.map(function (task) { return task.status; }), ["running", "running"]);
  assert.equal(tasks[0].workerStorageId !== tasks[1].workerStorageId, true);
  assert.deepEqual(tasks.map(function (task) {
    var worker = Array.from(sessions.values()).find(function (session) {
      return session.storageId === task.workerStorageId;
    });
    return {
      hidden: worker.hidden === true,
      parentStorageId: worker.orchestrationParent.sessionStorageId,
      taskId: worker.orchestrationParent.taskId,
      persisted: saved.indexOf(worker.storageId) !== -1,
    };
  }), tasks.map(function (task) {
    return {
      hidden: false,
      parentStorageId: parent.storageId,
      taskId: task.taskId,
      persisted: true,
    };
  }));
});
