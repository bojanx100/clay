var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");

var control = require("../lib/coop-control-ledger-reconciliation-mcp-server");
var ownerRequests = require("../lib/coop-owner-requests");
var topics = require("../lib/coop-topic-index");

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var LEAD = "system-lead";
var OLD = "065eb04d-3fa1-4420-be9a-7f3b249941a1";
var MID = "f4078e19-545e-44f9-9235-3644ff874716";
var COOP = "871a194b-8879-40f7-a1fe-656e48e722af";
var WORKER = "a1eccb6a-78ba-44ab-99ab-3b659a1f9b38";
var TASK = "clay-coop-conflict-safe-ledger-reconciliation-fix-2026-08-13";

function worker() {
  return {
    storageId: WORKER,
    coopControlledBy: { coopSessionStorageId: COOP },
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: TASK,
      bindingRevision: 1,
      mode: "direct_leaf",
      status: "running",
      source: { projectId: LEAD, sessionStorageId: COOP },
    } },
  };
}

function smFor(session) {
  return { sessions: new Map([[1, session]]), getProjectId: function () { return CLAY; } };
}

function leadSmFor(session, saveSessionFile) {
  var sessions = session && typeof session.get === "function" ? session : new Map([[1, session]]);
  return {
    sessions: sessions,
    getProjectId: function () { return LEAD; },
    saveSessionFile: saveSessionFile || function () {},
  };
}

function auth(extra) {
  return Object.assign({ sessionId: WORKER, portfolioTaskId: TASK, bindingRevision: 1 }, extra || {});
}

function parsed(toolResult) {
  return JSON.parse(toolResult.content[0].text);
}

function topic(topicId, title) {
  return {
    topicRef: { topicId: topicId }, title: title, group: { kind: "uncategorised" },
    source: "automatic", keywords: [], status: "open", createdAt: 1, updatedAt: 1,
    eventRefs: [], turnRefs: [], relatedExecutions: [],
  };
}

test("a Coop-controlled direct leaf can atomically reconcile exact ledger records", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-control-mcp-"));
  var ownerFile = path.join(dir, "owner.json");
  var topicFile = path.join(dir, "topics.json");
  var ledger = ownerRequests.attachCoopOwnerRequests({ file: ownerFile, now: function () { return 50; } });
  var index = topics.createTopicIndex({ file: topicFile, now: function () { return 60; } });
  var ingressId = "coop:" + COOP + ":240";
  var preservedId = "coop:" + COOP + ":239";
  ledger.record({ ingressId: ingressId, ingressSequence: 240,
    sessionRef: { projectId: LEAD, sessionStorageId: COOP } });
  ledger.supersede(ingressId, "owner_interrupt");
  ledger.record({ ingressId: preservedId, ingressSequence: 239,
    sessionRef: { projectId: LEAD, sessionStorageId: COOP } });
  var state = index.load();
  state.topics.target = topic("target", "Target");
  state.topics.preserved = topic("preserved", "Preserved");
  index.save();
  var deps = { sm: smFor(worker()), ownerRequests: ledger, topicIndex: index };
  var request = auth({
    idempotencyKey: "ledger-repair-r1",
    ownerRequests: [{
      ingressId: ingressId,
      expectedResponseState: "superseded",
      responseState: "answered",
      responseRef: { projectId: LEAD, sessionStorageId: COOP, eventIndex: 127863 },
      at: 70,
    }],
    topics: [{
      topicRef: { topicId: "target" }, expectedStatus: "open", status: "closed",
      verb: "accept_done", note: "Completed by the bound repair task.", expectedRevision: 0,
    }],
  });

  var first = parsed(control.reconcile(deps, request));
  var duplicate = parsed(control.reconcile(deps, request));
  var reloadedLedger = ownerRequests.attachCoopOwnerRequests({ file: ownerFile });
  var reloadedIndex = topics.createTopicIndex({ file: topicFile });

  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.completed[0].result.duplicate, true);
  assert.equal(duplicate.completed[1].result.duplicate, true);
  assert.equal(reloadedLedger.get(ingressId).response.state, "answered");
  assert.equal(reloadedLedger.get(ingressId).response.responseRef.eventIndex, 127863);
  assert.equal(reloadedLedger.get(preservedId).response.state, "unanswered");
  assert.equal(reloadedIndex.resolve({ topicId: "target" }, true).topic.status, "closed");
  assert.equal(reloadedIndex.resolve({ topicId: "target" }, true).topic.ownerDisposition.status, "done");
  assert.equal(reloadedIndex.resolve({ topicId: "preserved" }, true).topic.status, "open");
});

test("ledger reconciliation rejects unbound callers and stale record preconditions", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-control-deny-"));
  var ledger = ownerRequests.attachCoopOwnerRequests({ file: path.join(dir, "owner.json") });
  var index = topics.createTopicIndex({ file: path.join(dir, "topics.json") });
  var ingressId = "coop:" + COOP + ":233";
  ledger.record({ ingressId: ingressId, ingressSequence: 233,
    sessionRef: { projectId: LEAD, sessionStorageId: COOP } });
  var change = auth({ idempotencyKey: "deny-r1", ownerRequests: [{
    ingressId: ingressId, expectedResponseState: "superseded", responseState: "answered",
    responseRef: { projectId: LEAD, sessionStorageId: COOP, eventIndex: 118921 },
  }] });

  var denied = control.reconcile({ sm: smFor({ storageId: WORKER }),
    ownerRequests: ledger, topicIndex: index }, change);
  var stale = control.reconcile({ sm: smFor(worker()),
    ownerRequests: ledger, topicIndex: index }, change);

  assert.equal(denied.isError, true);
  assert.equal(parsed(denied).code, "not_authorized");
  assert.equal(stale.isError, true);
  assert.equal(parsed(stale).code, "stale_response");
  assert.equal(ledger.get(ingressId).response.state, "unanswered");
});

test("canonical Coop can stage exact answer_owner refs without changing response state", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-answer-link-mcp-"));
  var ledger = ownerRequests.attachCoopOwnerRequests({ file: path.join(dir, "owner.json") });
  var ingressId = "coop:" + COOP + ":292";
  var requestRef = { projectId: LEAD, sessionStorageId: COOP, eventIndex: 20 };
  ledger.record({
    ingressId: ingressId,
    ingressSequence: 292,
    sessionRef: { projectId: LEAD, sessionStorageId: COOP },
    requestRef: requestRef,
  });
  var session = {
    coopHome: true,
    storageId: COOP,
    isProcessing: true,
    history: [{ type: "user_message", text: "↻ Lead tick",
      autoAction: true, synthetic: true }],
    coopConversationIngress: { nextSequence: 293, recent: [], activeIngressId: null },
  };
  var saves = 0;
  var linked = parsed(control.linkOwnerResponse({
    sm: leadSmFor(session, function () { saves++; }),
    ownerRequests: ledger,
  }, { sessionId: COOP, requests: [{ ingressId: ingressId, requestRef: requestRef }] }));

  assert.equal(linked.ok, true);
  assert.equal(linked.link.requests[0].ingressId, ingressId);
  assert.equal(ledger.get(ingressId).response.state, "unanswered");
  assert.equal(session.coopConversationIngress.pendingOwnerResponse.turnRef.eventIndex, 0);
  assert.equal(saves, 1);
  var denied = control.linkOwnerResponse({ sm: smFor(worker()), ownerRequests: ledger },
    auth({ requests: [{ ingressId: ingressId, requestRef: requestRef }] }));
  assert.equal(denied.isError, true);
  assert.equal(parsed(denied).code, "not_authorized");
});

test("canonical Coop accepts predecessor owner refs across a compacted continuation chain", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-answer-link-compacted-"));
  var ledger = ownerRequests.attachCoopOwnerRequests({ file: path.join(dir, "owner.json") });
  var ingressId = "coop:" + OLD + ":292";
  var requestRef = { projectId: LEAD, sessionStorageId: OLD, eventIndex: 20 };
  ledger.record({
    ingressId: ingressId,
    ingressSequence: 292,
    sessionRef: { projectId: LEAD, sessionStorageId: OLD },
    requestRef: requestRef,
  });
  var predecessor = { localId: 1, storageId: OLD, coopHome: true, history: [] };
  var middle = {
    localId: 2,
    storageId: MID,
    compactedFromStorageId: OLD,
    coopHome: true,
    history: [],
  };
  var session = {
    localId: 3,
    coopHome: true,
    storageId: COOP,
    compactedFromStorageId: MID,
    isProcessing: true,
    history: [{ type: "user_message", text: "↻ Lead tick",
      autoAction: true, synthetic: true }],
    coopConversationIngress: { nextSequence: 293, recent: [], activeIngressId: null },
  };
  var saves = 0;
  var linked = parsed(control.linkOwnerResponse({
    sm: leadSmFor(new Map([
      [predecessor.localId, predecessor],
      [middle.localId, middle],
      [session.localId, session],
    ]), function () { saves++; }),
    ownerRequests: ledger,
  }, { sessionId: COOP, requests: [{ ingressId: ingressId, requestRef: requestRef }] }));

  assert.equal(linked.ok, true);
  assert.equal(linked.link.requests[0].requestRef.sessionStorageId, OLD);
  assert.equal(session.coopConversationIngress.pendingOwnerResponse.requests[0].requestRef.sessionStorageId, OLD);
  assert.equal(saves, 1);
});

test("canonical Coop hydrates missing compacted predecessors before linking owner refs", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-answer-link-hydrate-"));
  var ledger = ownerRequests.attachCoopOwnerRequests({ file: path.join(dir, "owner.json") });
  var ingressId = "coop:" + OLD + ":293";
  var requestRef = { projectId: LEAD, sessionStorageId: OLD, eventIndex: 21 };
  ledger.record({
    ingressId: ingressId,
    ingressSequence: 293,
    sessionRef: { projectId: LEAD, sessionStorageId: OLD },
    requestRef: requestRef,
  });
  var predecessor = { localId: 1, storageId: OLD, coopHome: true, history: [] };
  var middle = {
    localId: 2,
    storageId: MID,
    compactedFromStorageId: OLD,
    coopHome: true,
    history: [],
  };
  var session = {
    localId: 3,
    coopHome: true,
    storageId: COOP,
    compactedFromStorageId: MID,
    isProcessing: true,
    history: [{ type: "user_message", text: "↻ Lead tick",
      autoAction: true, synthetic: true }],
    coopConversationIngress: { nextSequence: 294, recent: [], activeIngressId: null },
  };
  var saves = 0;
  var adopted = [];
  var sessions = new Map([[session.localId, session]]);
  var sm = {
    sessions: sessions,
    getProjectId: function () { return LEAD; },
    saveSessionFile: function () { saves++; },
    adoptSessionFile: function (storageId) {
      adopted.push(storageId);
      if (storageId === MID) {
        sessions.set(middle.localId, middle);
        return middle.localId;
      }
      if (storageId === OLD) {
        sessions.set(predecessor.localId, predecessor);
        return predecessor.localId;
      }
      return null;
    },
  };
  var linked = parsed(control.linkOwnerResponse({
    sm: sm,
    ownerRequests: ledger,
  }, { sessionId: COOP, requests: [{ ingressId: ingressId, requestRef: requestRef }] }));

  assert.equal(linked.ok, true);
  assert.deepEqual(adopted, [MID, OLD]);
  assert.equal(linked.link.requests[0].requestRef.sessionStorageId, OLD);
  assert.equal(session.coopConversationIngress.pendingOwnerResponse.requests[0].requestRef.sessionStorageId, OLD);
  assert.equal(saves, 1);
});
