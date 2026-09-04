var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var compaction = require("../lib/project-session-compaction");
var conversationControl = require("../lib/coop-conversation-control");
var ownerRequests = require("../lib/coop-owner-requests");
var userMessageQueue = require("../lib/project-user-message-queue");

test("compaction continues the active Coop ingress and drains later owner work exactly once", function () {
  var sourceStorageId = "coop-compaction-source";
  var activeIngressId = "coop:" + sourceStorageId + ":1";
  var queuedIngressId = "coop:" + sourceStorageId + ":2";
  var source = {
    localId: 1,
    storageId: sourceStorageId,
    coopHome: true,
    title: "Coop",
    vendor: "codex",
    isProcessing: true,
    history: [
      { type: "user_message", text: "Answer the active question", coopIngressId: activeIngressId,
        coopTopicRef: { topicId: "active-thread" } },
      { type: "user_message", text: "Then answer the queued question", coopIngressId: queuedIngressId,
        coopIngressSequence: 2, coopIngressPending: true, from: "owner-1" },
    ],
    coopConversationIngress: {
      nextSequence: 3,
      recent: [],
      activeIngressId: activeIngressId,
      activeResponseStartIndex: 1,
    },
    pendingCoopIngress: [{
      ingressId: queuedIngressId,
      ingressSequence: 2,
      actorUserId: "owner-1",
      finalText: "prepared queued owner turn",
      displayText: "Then answer the queued question",
      imageCount: 1,
      clientMessageId: "queued-client-message",
      pastes: [{ text: "queued paste" }],
      coopThreadRef: { threadId: "queued-thread" },
      coopTopicRef: { topicId: "queued-thread" },
      coopProjectRef: { projectId: "queued-project" },
      intent: "chat",
    }],
  };
  var sessions = new Map([[source.localId, source]]);
  var started = [];
  var sm = {
    sessions: sessions,
    createSessionRaw: function (options) {
      var next = Object.assign({ localId: 2, history: [], pendingPermissions: {} }, options);
      sessions.set(next.localId, next);
      return next;
    },
    sendAndRecord: function (session, event) { session.history.push(event); },
    saveSessionFile: function () {},
    switchSession: function () {},
    broadcastSessionList: function () {},
  };
  var ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-compaction-ingress-"));
  var ledger = ownerRequests.attachCoopOwnerRequests({ file: path.join(ledgerDir, "owner.json") });
  ledger.record({
    ingressId: activeIngressId,
    ingressSequence: 1,
    sessionRef: { projectId: "system-lead", sessionStorageId: sourceStorageId },
    requestRef: { projectId: "system-lead", sessionStorageId: sourceStorageId, eventIndex: 0 },
  });
  ledger.record({
    ingressId: queuedIngressId,
    ingressSequence: 2,
    sessionRef: { projectId: "system-lead", sessionStorageId: sourceStorageId },
    requestRef: { projectId: "system-lead", sessionStorageId: sourceStorageId, eventIndex: 1 },
  });
  var control = conversationControl.attachCoopConversationControl({
    coopOwnerRequests: ledger,
    sm: sm,
    sendToSession: function () {},
  });
  var queue = userMessageQueue.attachProjectUserMessageQueue({
    sm: sm,
    sdk: {
      startQuery: function (session, text) { started.push({ session: session, text: text }); },
      pushMessage: function () { return false; },
    },
    sendToSession: function () {},
    onProcessingChanged: function () {},
    onUserMessageDispatched: function () { return ""; },
    ensureProjectAccessForSession: function () { return null; },
    coopControl: control,
  });
  var api = compaction.attachSessionCompaction({
    cwd: "/tmp/project",
    sm: sm,
    sdk: {
      startQuery: function (session, text) { started.push({ session: session, text: text }); },
    },
    sendToSession: function () {},
  });

  var continuation = api.compactAndContinue(source, { reason: "empty_turn" });
  var retry = continuation.history.find(function (event) { return event.compactedRetry; });

  assert.match(started[0].text, /<current_user_message>\nAnswer the active question\n<\/current_user_message>/);
  assert.doesNotMatch(started[0].text, /<current_user_message>\nThen answer the queued question/);
  assert.equal(retry.coopContinuationIngressId, activeIngressId);
  assert.equal(continuation.coopConversationIngress.activeIngressId, activeIngressId);
  assert.deepEqual(control.clientState(continuation).activeThreadRefs, [{ threadId: "active-thread" }]);
  assert.deepEqual(continuation.pendingCoopIngress.map(function (item) { return item.ingressId; }),
    [queuedIngressId]);
  assert.equal(source.coopConversationIngress, undefined);
  assert.equal(source.pendingCoopIngress, undefined);
  assert.equal(queue.rebuildCoopIngressFromHistory(source), false,
    "a hidden compacted predecessor cannot resurrect pending ingress from history");

  continuation.history.push({ type: "delta", text: "Active owner answer." },
    { type: "done", code: 0 });
  assert.equal(control.markAnswered(continuation), true);
  assert.equal(ledger.get(activeIngressId).response.state, "answered");

  continuation.isProcessing = false;
  assert.equal(queue.flushCoopIngress(continuation), true);
  assert.equal(started[1].text, "prepared queued owner turn");
  assert.equal(continuation.coopConversationIngress.activeIngressId, queuedIngressId);
  var queuedTurn = continuation.history.find(function (event) {
    return event.coopIngressId === queuedIngressId;
  });
  assert.ok(queuedTurn, "the transferred owner turn is restored to the live transcript on dispatch");
  assert.equal(queuedTurn.coopIngressPending, undefined);
  assert.equal(queuedTurn.from, "owner-1");
  assert.equal(queuedTurn.clientMessageId, "queued-client-message");
  assert.deepEqual(queuedTurn.coopThreadRef, { threadId: "queued-thread" });

  continuation.history.push({ type: "delta", text: "Queued owner answer." },
    { type: "done", code: 0 });
  assert.equal(control.markAnswered(continuation), true);
  assert.equal(ledger.get(queuedIngressId).response.state, "answered");
  assert.equal(queue.rebuildCoopIngressFromHistory(source), false);
  assert.equal(queue.flushCoopIngress(source), false);
  assert.equal(started.length, 2, "neither restart reconciliation nor the predecessor redispatches work");
});

test("compaction rebases an in-flight linked owner response onto the continuation turn", function () {
  var sourceStorageId = "coop-linked-response-source";
  var ingressId = "coop:" + sourceStorageId + ":1";
  var requestRef = {
    projectId: "system-lead",
    sessionStorageId: sourceStorageId,
    eventIndex: 0,
  };
  var source = {
    localId: 1,
    storageId: sourceStorageId,
    coopHome: true,
    title: "Coop",
    vendor: "codex",
    history: [
      { type: "user_message", text: "What is blocked?", coopIngressId: ingressId,
        coopIngressSequence: 1 },
      { type: "user_message", text: "Answer the pending owner request", autoAction: true,
        synthetic: true },
    ],
    coopConversationIngress: {
      nextSequence: 2,
      recent: [],
      activeIngressId: null,
      pendingOwnerResponse: {
        version: 1,
        turnRef: { projectId: "system-lead", sessionStorageId: sourceStorageId, eventIndex: 1 },
        responseStartEventIndex: 2,
        requests: [{ ingressId: ingressId, requestRef: requestRef }],
      },
    },
  };
  var sessions = new Map([[source.localId, source]]);
  var sm = {
    sessions: sessions,
    createSessionRaw: function (options) {
      var next = Object.assign({ localId: 2, history: [] }, options);
      sessions.set(next.localId, next);
      return next;
    },
    sendAndRecord: function (session, event) { session.history.push(event); },
    saveSessionFile: function () {},
    switchSession: function () {},
    broadcastSessionList: function () {},
  };
  var ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-compaction-linked-response-"));
  var ledger = ownerRequests.attachCoopOwnerRequests({ file: path.join(ledgerDir, "owner.json") });
  ledger.record({
    ingressId: ingressId,
    ingressSequence: 1,
    sessionRef: { projectId: "system-lead", sessionStorageId: sourceStorageId },
    requestRef: requestRef,
  });
  var api = compaction.attachSessionCompaction({
    cwd: "/tmp/project",
    sm: sm,
    sdk: { startQuery: function () {} },
    sendToSession: function () {},
  });

  var continuation = api.compactAndContinue(source, { reason: "empty_turn" });
  var retryIndex = continuation.history.findIndex(function (event) { return event.compactedRetry; });
  var retry = continuation.history[retryIndex];
  var link = continuation.coopConversationIngress.pendingOwnerResponse;

  assert.equal(retry.autoAction, true);
  assert.equal(retry.synthetic, true);
  assert.equal(link.turnRef.sessionStorageId, continuation.storageId);
  assert.equal(link.turnRef.eventIndex, retryIndex);
  assert.equal(link.responseStartEventIndex, retryIndex + 1);
  continuation.history.push({ type: "delta", text: "The owner request is blocked on review." },
    { type: "done", code: 0 });
  var control = conversationControl.attachCoopConversationControl({
    coopOwnerRequests: ledger,
    sm: sm,
    sendToSession: function () {},
  });
  assert.equal(control.markAnswered(continuation), true);
  assert.equal(ledger.get(ingressId).response.state, "answered");
});
