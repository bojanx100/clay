var test = require("node:test");
var assert = require("node:assert/strict");
var continuity = require("../lib/coop-control-continuity");
var rehydration = require("../lib/coop-control-rehydration");

var PROJECT_A = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var SOURCE = { projectId: "system-lead", sessionStorageId: "871a194b-8879-40f7-a1fe-656e48e722af" };

function packet(overrides) {
  return Object.assign({
    schemaVersion: 1,
    objectives: [
      { objectiveId: "objective-main", text: "Implement recoverable handoff without transcript replay." },
    ],
    decisions: [
      { decisionId: "decision-approved", value: "Use monotonic roll-forward after cutover.", acceptedAt: 10 },
    ],
    ownerRequests: [
      { requestId: "owner-request-2", ingressId: "ingress-2", receivedAt: 12 },
      { requestId: "owner-request-1", ingressId: "ingress-1", receivedAt: 11 },
    ],
    tasks: [
      { taskId: "task-two", objectiveId: "objective-main", status: "pending", owner: null },
      { taskId: "task-one", objectiveId: "objective-main", status: "in_progress", owner: SOURCE },
    ],
    bindings: [
      { portfolioTaskId: "task-one", bindingRevision: 2, targetProject: { projectId: PROJECT_A },
        mode: "project_coordinator", status: "active" },
    ],
    authorities: [
      { authorityId: "auth:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", source: SOURCE,
        portfolioTaskId: "task-one", bindingRevision: 2, targetProject: { projectId: PROJECT_A },
        role: "coordinator", actionMask: 31 },
    ],
    executions: [
      { executionId: "exec:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", source: SOURCE,
        authorityId: "auth:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        portfolioTaskId: "task-one", bindingRevision: 2, targetProject: { projectId: PROJECT_A },
        mode: "project_coordinator", role: "coordinator" },
    ],
    learningReferences: [
      { learningId: "learning-two", version: 2 },
      { learningId: "learning-one", version: 1 },
    ],
  }, overrides || {});
}

test("continuity normalization preserves required records in deterministic identity order", function () {
  var normalized = continuity.normalizeContinuityPacket(packet());
  assert.deepEqual(normalized.ownerRequests.map(function (item) { return item.requestId; }),
    ["owner-request-1", "owner-request-2"]);
  assert.deepEqual(normalized.tasks.map(function (item) { return item.taskId; }), ["task-one", "task-two"]);
  assert.deepEqual(normalized.learningReferences.map(function (item) { return item.learningId; }),
    ["learning-one", "learning-two"]);
  assert.equal(normalized.ownerRequests.length, 2);
  assert.equal(normalized.objectives[0].text, packet().objectives[0].text);
  assert.equal(normalized.decisions[0].value, packet().decisions[0].value);
  assert.deepEqual(normalized.bindings[0].targetProject, { projectId: PROJECT_A });
  assert.equal(normalized.authorities[0].actionMask, 31);
});

test("continuity rejects topic, projection, transcript, reasoning, and runtime-context aliases", function () {
  var fields = ["topicRef", "projection", "transcript", "hiddenReasoning", "runtime_context"];
  for (var i = 0; i < fields.length; i++) {
    (function (field) {
      var input = packet();
      input[field] = "private";
      assert.throws(function () {
        continuity.normalizeContinuityPacket(input);
      }, function (error) { return error && error.code === "COOP_CONTROL_CONTINUITY_OUT_OF_SCOPE"; }, field);
    })(fields[i]);
  }
});

test("the transcript-free rehydration exam is byte-stable and reports only bounded counts", function () {
  var first = rehydration.examineRehydrationPacket(packet());
  var shuffled = packet({
    ownerRequests: packet().ownerRequests.slice().reverse(),
    tasks: packet().tasks.slice().reverse(),
    learningReferences: packet().learningReferences.slice().reverse(),
  });
  var second = rehydration.examineRehydrationPacket(shuffled);
  assert.equal(first.passed, true);
  assert.equal(second.digest, first.digest);
  assert.deepEqual(first.counts, {
    authorities: 1, bindings: 1, decisions: 1, executions: 1, learningReferences: 2,
    objectives: 1, ownerRequests: 2, tasks: 2,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(first, "packet"), false);
  assert.equal(JSON.stringify(first).includes("Implement recoverable"), false);
});

test("continuity mode membership rejects inherited object names", function () {
  var inheritedBinding = packet();
  inheritedBinding.bindings[0].mode = "constructor";
  assert.throws(function () {
    continuity.normalizeContinuityPacket(inheritedBinding);
  }, function (error) { return error && error.code === "COOP_CONTROL_CONTINUITY_INVALID"; });

  var inheritedExecution = packet();
  inheritedExecution.bindings[0].mode = "toString";
  inheritedExecution.executions[0].mode = "toString";
  inheritedExecution.executions[0].role = Object.prototype.toString;
  assert.throws(function () {
    continuity.normalizeContinuityPacket(inheritedExecution);
  }, function (error) { return error && error.code === "COOP_CONTROL_CONTINUITY_INVALID"; });
});

test("rehydration builds deterministic bounded provider input from every continuity category", function () {
  var value = packet();
  value.learningReferences = [{ learningId: "learning-resume", version: 3 }];
  var first = rehydration.buildResumeInput(value);
  var shuffled = Object.assign({}, value, {
    objectives: value.objectives.slice().reverse(),
    decisions: value.decisions.slice().reverse(),
    ownerRequests: value.ownerRequests.slice().reverse(),
    tasks: value.tasks.slice().reverse(),
    bindings: value.bindings.slice().reverse(),
    authorities: value.authorities.slice().reverse(),
    executions: value.executions.slice().reverse(),
    learningReferences: value.learningReferences.slice().reverse(),
  });
  var second = rehydration.buildResumeInput(shuffled);
  assert.equal(second, first);
  assert.ok(Buffer.byteLength(first, "utf8") <= rehydration.MAX_RESUME_INPUT_BYTES);
  ["objective-main", "decision-approved", "owner-request-1", "task-one",
    "project_coordinator", "auth:aaaaaaaa", "exec:aaaaaaaa", "learning-resume"].forEach(function (needle) {
    assert.match(first, new RegExp(needle));
  });
  assert.doesNotMatch(first, /provider-history-secret|reasoning-secret|runtime-context-secret/i);
});

test("continuity rejects inherited status names and preserves an exact unrouted binding without an execution", function () {
  ["constructor", "toString"].forEach(function (status) {
    assert.throws(function () {
      continuity.normalizeContinuityPacket(packet({ tasks: [{ taskId: "task-one", objectiveId: "objective-main",
        status: status, owner: SOURCE }] }));
    }, function (error) { return error && error.code === "COOP_CONTROL_CONTINUITY_INVALID"; });
    assert.throws(function () {
      continuity.normalizeContinuityPacket(packet({ bindings: [{ portfolioTaskId: "task-one", bindingRevision: 2,
        targetProject: { projectId: PROJECT_A }, mode: "project_coordinator", status: status }] }));
    }, function (error) { return error && error.code === "COOP_CONTROL_CONTINUITY_INVALID"; });
  });
  var normalized = continuity.normalizeContinuityPacket(packet({
    bindings: [{ portfolioTaskId: "task-one", bindingRevision: 2,
      targetProject: { projectId: PROJECT_A }, mode: "project_coordinator", status: "unrouted" }],
    authorities: [],
    executions: [],
  }));
  assert.equal(normalized.bindings[0].status, "unrouted");
  assert.equal(normalized.executions.length, 0);
  assert.throws(function () {
    continuity.normalizeContinuityPacket(packet({
      bindings: [{ portfolioTaskId: "task-one", bindingRevision: 2,
        targetProject: { projectId: PROJECT_A }, mode: "project_coordinator", status: "active" }],
      authorities: [], executions: [],
    }));
  }, function (error) { return error && error.code === "COOP_CONTROL_CONTINUITY_INVALID"; });
});

test("continuity rejects oversized collections and canonical packet bytes", function () {
  var oversized = packet({ objectives: [] });
  for (var i = 0; i < continuity.MAX_COLLECTION_ITEMS + 1; i++) {
    oversized.objectives.push({ objectiveId: "objective-" + i, text: "Bounded objective." });
  }
  assert.throws(function () { continuity.normalizeContinuityPacket(oversized); },
    function (error) { return error && error.code === "COOP_CONTROL_CONTINUITY_INVALID"; });
  assert.throws(function () {
    continuity.normalizeContinuityPacket(packet({ objectives: [{ objectiveId: "objective-main",
      text: "x".repeat(continuity.MAX_PACKET_BYTES) }] }));
  }, function (error) { return error && error.code === "COOP_CONTROL_CONTINUITY_INVALID"; });
});
