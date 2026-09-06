var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var config = require("../lib/config");
var createManager = require("../lib/sessions").createSessionManager;
var createBindings = require("../lib/portfolio-execution-bindings").createBindingStore;
var createRouter = require("../lib/server-cross-project").createCrossProjectRouter;
var attachFollowup = require("../lib/project-task-orchestrator-followup").attachTaskFollowup;
var attachQueue = require("../lib/project-coordinator-update-queue").attachCoordinatorUpdateQueue;
var updates = require("../lib/coop-owner-updates");
var main = require("../lib/coop-main-replay");
var connection = require("../lib/coop-topic-connection");
var PROJECT = "11111111-1111-5111-8111-111111111111";

function fixture(t) {
  var dir = fs.mkdtempSync(path.join(config.CONFIG_DIR, "thread-feedback-"));
  var seen = [];
  var ws = { readyState: 1, send: function (text) { seen.push(JSON.parse(text)); } };
  var options = { cwd: dir, slug: "lead", projectId: "system-lead", send: function () {},
    sendTo: function (target, message) { target.send(JSON.stringify(message)); },
    sendEach: function (callback) { callback(ws); } };
  var sm = createManager(options);
  var session = sm.createSessionRaw({ coopHome: true });
  ws._clayActiveSession = session.localId;
  var workerDir = path.join(dir, "workers");
  fs.mkdirSync(workerDir);
  var workers = createManager({ cwd: workerDir, slug: "webapp", projectId: PROJECT, send: function () {} });
  var bindingFile = path.join(dir, "bindings.json");
  var bindings = createBindings({ file: bindingFile });
  var tasks = ["annotations", "speed"].map(function (topicId) {
    var worker = workers.createSessionRaw({ coopControlledBy: { coopSessionStorageId: session.storageId, since: 1 } });
    var request = { portfolioTaskId: "task-" + topicId, bindingRevision: 1, mode: "project_coordinator",
      idempotencyKey: topicId, targetProject: { projectId: PROJECT }, coopTopicRef: { topicId: topicId },
      source: { projectId: "system-lead", sessionStorageId: session.storageId } };
    worker.orchestrationPolicy = { portfolioExecution: Object.assign({}, request) };
    assert.equal(bindings.reserve(request).ok, true);
    assert.equal(bindings.commit(request.portfolioTaskId, 1,
      { projectId: PROJECT, sessionStorageId: worker.storageId }).ok, true);
    workers.saveSessionFile(worker, { durable: true });
    return { request: request, worker: worker };
  });
  var router = createRouter({ bindingFile: bindingFile, deliveryFile: path.join(dir, "delivery.json") });
  router.registerProjectResolver({ getProjectId: function () { return PROJECT; },
    getSessionManager: function () { return { sessions: new Map() }; } });
  router.registerProjectResolver({ getProjectId: function () { return PROJECT; }, getSessionManager: function () { return workers; } });
  var starts = [];
  var queue;
  function attach() {
    queue = attachQueue({ sm: sm, sdk: { startQuery: function (current, text) {
      starts.push(text); return { ok: true };
    } }, sendState: function () {}, onProcessingChanged: function () {}, sendToSession: function (id, event) {
      sm.sendToSession(sm.sessions.get(id), event);
    },
    ensureProjectAccessForSession: function () {} });
    return attachFollowup({ sm: sm, crossProject: router, queueCoordinatorUpdate: queue.queue,
      flushCoordinatorUpdates: queue.flush, sessionByStorageId: function (id) {
        return Array.from(sm.sessions.values()).find(function (current) { return current.storageId === id; });
      } });
  }
  var followup = attach();
  router.registerProjectResolver({ getProjectId: function () { return "system-lead"; },
    getSessionManager: function () { return sm; },
    deliverCrossProjectEnvelope: function (envelope) { return followup.deliverCrossProjectEnvelope(envelope); } });
  function deliver(index, sourceId, eventId) {
    var entry = tasks[index];
    return followup.deliverCrossProjectEnvelope(router.createEnvelope({
      eventId: eventId || "feedback-" + index,
      source: { projectId: PROJECT, sessionStorageId: sourceId || entry.worker.storageId },
      destination: entry.request.source, bindingRevision: 1, createdAt: Date.now(),
      payload: { type: "coordinator_update", text: entry.request.coopTopicRef.topicId + " work finished." },
    }));
  }
  t.after(function () { router.stopDeliveryRetry(); });
  return { dir: dir, tasks: tasks, workers: workers, router: router, seen: seen, starts: starts,
    sm: function () { return sm; }, session: function () { return session; },
    queue: function () { return queue; }, deliver: deliver,
    restart: function () {
      var id = session.storageId;
      sm = createManager(options);
      session = Array.from(sm.sessions.values()).find(function (current) { return current.storageId === id; });
      assert.ok(session);
      sm.getHistoryView(session);
      ws._clayActiveSession = session.localId;
      followup = attach();
    } };
}

function topicIndexes(h, topicId) {
  var session = h.session();
  return connection.boundedMembershipIndexes({ topicRef: { topicId: topicId },
    threadState: "handed_off", status: "open", turnRefs: [], eventRefs: [] }, session, h.sm().getHistoryView(session));
}

test("mixed queued reports survive restart and publish only into the selected handed-off Thread", function (t) {
  var h = fixture(t);
  h.session().isProcessing = true;
  assert.equal(h.deliver(0).ok, true);
  assert.equal(h.deliver(1).ok, true);
  assert.equal(h.session().pendingCoordinatorUpdates.length, 2);
  h.restart();
  assert.equal(h.queue().flush(h.session()), true);
  assert.equal(h.starts.length, 1);
  assert.equal(h.seen.filter(function (item) { return item.type === "coop_internal_turn_started"; }).length, 1,
    "the durable queue announces internal provenance before provider output reaches the live viewer");
  assert.match(h.starts[0], /feedback-0/);
  assert.match(h.starts[0], /feedback-1/);
  h.sm().sendAndRecord(h.session(), { type: "delta", text: "Inspecting internal worker output." });
  var input = { replyId: "annotation-report", text: "Annotations are ready for your review.", feedbackEventIds: ["feedback-0"] };
  assert.equal(updates.publish(h.sm(), h.session(), input).ok, true);
  var live = h.seen.filter(function (item) { return item.type === "coop_owner_update"; });
  assert.equal(live.length, 1, "the real session IO delivers the saved report to its active viewer");
  assert.equal(live[0].sessionId, h.session().localId);
  assert.deepEqual(live[0].feedbackRefs.map(function (ref) { return ref.coopTopicRef.topicId; }), ["annotations"]);
  assert.equal(updates.publish(h.sm(), h.session(), input).duplicate, true);
  assert.equal(h.seen.filter(function (item) { return item.type === "coop_owner_update"; }).length, 1);
  assert.deepEqual(updates.pending(h.sm(), h.session()).map(function (ref) { return ref.eventId; }), ["feedback-1"]);
  h.restart();
  var view = h.sm().getHistoryView(h.session());
  assert.deepEqual(main.membershipIndexes(h.session(), view).map(function (index) { return view.history[index].text; }), [input.text]);
  assert.deepEqual(topicIndexes(h, "annotations").map(function (index) { return view.history[index].text; }), [input.text]);
  assert.deepEqual(topicIndexes(h, "speed"), []);
  assert.equal(h.deliver(0).duplicate, true, "transport replay cannot create a duplicate live report");
});

test("real router resolves a descendant through its actual owning task, but rejects forged ancestry", function (t) {
  var h = fixture(t);
  var parent = h.tasks[0].worker;
  var child = h.workers.createSessionRaw();
  child.orchestrationParent = { sessionStorageId: parent.storageId, taskId: "child-task" };
  parent.orchestrationTasks = [{ taskId: "child-task", workerStorageId: child.storageId }];
  h.session().isProcessing = true;
  assert.equal(h.deliver(0, child.storageId, "descendant-report").ok, true);
  assert.equal(h.session().pendingCoordinatorUpdates[0].feedback.coopTopicRef.topicId, "annotations");
  parent.orchestrationTasks[0].workerStorageId = h.tasks[1].worker.storageId;
  assert.equal(h.deliver(0, child.storageId, "forged-report").ok, true);
  assert.equal(h.session().pendingCoordinatorUpdates[1].feedback, null);
});

test("unknown feedback and failed saves cannot create visible reports or consume evidence", function (t) {
  var h = fixture(t);
  h.deliver(0);
  var before = h.session().history.length;
  assert.equal(updates.publish(h.sm(), h.session(), { replyId: "missing", text: "Unknown", feedbackEventIds: ["invented"] }).reason,
    "feedback_evidence_missing");
  var save = h.sm().saveSessionFile;
  h.sm().saveSessionFile = function () { return false; };
  var input = { replyId: "save-failure", text: "Annotations are ready.", feedbackEventIds: ["feedback-0"] };
  assert.equal(updates.publish(h.sm(), h.session(), input).reason, "owner_update_persistence_failed");
  assert.equal(h.session().history.length, before);
  assert.equal(h.seen.some(function (item) { return item.type === "coop_owner_update"; }), false);
  assert.equal(updates.pending(h.sm(), h.session()).length, 1);
  h.sm().saveSessionFile = save;
  assert.equal(updates.publish(h.sm(), h.session(), input).ok, true);
  assert.equal(updates.publish(h.sm(), h.session(), Object.assign({}, input, { text: "Different" })).reason, "owner_update_conflict");
});

test("conversation tools are bound to the current canonical Coop query and expire on replacement", async function (t) {
  var h = fixture(t);
  var mcp = require("../lib/coop-owner-updates-mcp");
  assert.equal(mcp.createConversationServer(null, h.sm(), h.session()).instance, undefined);
  h.session().isProcessing = true;
  h.session()._sessionControlToolQuery = new AbortController();
  var server = mcp.createConversationServer(null, h.sm(), h.session());
  var handler = server.instance._registeredTools.publish_coop_update.handler;
  assert.equal((await handler({ replyId: "valid", text: "A business decision needs your input." })).isError, false);
  h.session()._sessionControlToolQuery = new AbortController();
  assert.equal((await handler({ replyId: "stale", text: "Stale query" })).isError, true);
  assert.equal(h.session().history.filter(function (item) { return item.type === "coop_owner_update"; }).length, 1);
  var worker = h.sm().createSessionRaw();
  worker._sessionControlToolQuery = new AbortController();
  assert.equal(mcp.createConversationServer(null, h.sm(), worker).instance, undefined);
});

test("published feedback keeps its Thread identity across a durable canonical continuation", function (t) {
  var h = fixture(t);
  assert.equal(h.deliver(0).ok, true);
  var old = h.session();
  h.sm().sendAndRecord(old, { type: "done", code: 0 });
  old.vendor = "codex";
  var current = require("../lib/project-session-compaction").attachSessionCompaction({
    cwd: h.dir, sm: h.sm(), sdk: { startQuery: function () {} }, sendToSession: function () {},
  }).compactAndContinue(old, { reason: "manual" });
  assert.ok(current);
  var input = { replyId: "continued-report", text: "Annotations are ready to discuss.", feedbackEventIds: ["feedback-0"] };
  assert.equal(updates.publish(h.sm(), current, input).ok, true);
  var view = h.sm().getHistoryView(current);
  assert.equal(view.hasLineage, true);
  assert.deepEqual(updates.indexesForTopic(view, { topicId: "annotations" }).map(function (index) {
    return view.history[index].text;
  }), [input.text]);
  assert.deepEqual(updates.pending(h.sm(), current), []);
});

test("a terminal task transition travels through durable fan-in and back to its Thread", function (t) {
  var h = fixture(t);
  var build = require("../lib/coop-fanin-events").buildFanInEvent;
  var fanIn = require("../lib/coop-fanin-delivery").attachCoopFanIn({ sm: h.workers, slug: "webapp",
    crossProject: h.router, deliveryFile: path.join(h.dir, "fan-in.json"),
    queueCoordinatorUpdate: function () { assert.fail("must use cross-project delivery"); } });
  var event = build(h.tasks[0].worker, { taskId: "finished-task", status: "completed", updatedAt: 100 },
    { occurredAt: 100, summary: "Annotations passed review." });
  assert.equal(fanIn.deliverEvent(event).delivered, true);
  var ids = updates.pending(h.sm(), h.session()).map(function (ref) { return ref.eventId; });
  assert.deepEqual(ids, [event.eventId]);
  assert.equal(updates.publish(h.sm(), h.session(), { replyId: "fan-in-report",
    text: "The annotations passed review.", feedbackEventIds: ids }).ok, true);
  assert.equal(topicIndexes(h, "annotations").length, 1);
  assert.deepEqual(topicIndexes(h, "speed"), []);
});

test("owner response boundaries survive real transcript coalescing without showing earlier tick prose", function (t) {
  var h = fixture(t);
  var session = h.session();
  var id = "coop:" + session.storageId + ":1";
  h.sm().sendAndRecord(session, { type: "user_message", text: "What is the outcome?", from: "owner", coopIngressId: id });
  var ledger = require("../lib/coop-owner-requests").getDefaultOwnerRequests();
  var requestRef = { projectId: "system-lead", sessionStorageId: session.storageId, eventIndex: 0 };
  ledger.record({ ingressId: id, ingressSequence: 1, requestRef: requestRef,
    topicRef: { topicId: "annotations" }, sessionRef: { projectId: "system-lead", sessionStorageId: session.storageId } });
  h.sm().sendAndRecord(session, { type: "user_message", text: "Lead tick", synthetic: true, autoAction: true });
  session.isProcessing = true;
  h.sm().sendAndRecord(session, { type: "delta", text: "Inspecting " });
  h.sm().sendAndRecord(session, { type: "delta", text: "the workers. " });
  h.sm().sendAndRecord(session, { type: "delta", text: "Checking their reports." });
  assert.equal(require("../lib/coop-owner-response-linkage").stageOwnerResponse({ session: session,
    sessions: h.sm().sessions, ownerRequests: ledger, requests: [{ ingressId: id, requestRef: requestRef }],
    saveSession: function (current) { return h.sm().saveSessionFile(current, { durable: true }); } }).ok, true);
  h.sm().sendAndRecord(session, { type: "delta", text: "The annotations are ready." });
  h.sm().sendAndRecord(session, { type: "done", code: 0 });
  h.restart();
  var view = h.sm().getHistoryView(h.session());
  var texts = main.membershipIndexes(h.session(), view).map(function (index) { return view.history[index].text; });
  assert.deepEqual(texts, ["What is the outcome?", "The annotations are ready."]);
  assert.deepEqual(topicIndexes(h, "annotations").map(function (index) { return view.history[index].text; }),
    ["The annotations are ready."]);
  assert.deepEqual(main.liveState(h.session()).topicRefs, [{ topicId: "annotations" }]);
});

test("historical automated answers remain in Main and their Thread through proven response UUIDs", function (t) {
  var h = fixture(t);
  var session = h.session();
  var id = "coop:" + session.storageId + ":1";
  h.sm().sendAndRecord(session, { type: "user_message", text: "Are annotations ready?", from: "owner", coopIngressId: id });
  var ledger = require("../lib/coop-owner-requests").getDefaultOwnerRequests();
  ledger.record({ ingressId: id, ingressSequence: 1,
    requestRef: { projectId: "system-lead", sessionStorageId: session.storageId, eventIndex: 0 },
    sessionRef: { projectId: "system-lead", sessionStorageId: session.storageId }, topicRef: { topicId: "annotations" } });
  h.deliver(0);
  h.sm().sendAndRecord(session, { type: "delta", text: "Internal execution commentary." });
  h.sm().sendAndRecord(session, { type: "tool_result", id: "internal-tool", content: "done" });
  h.sm().sendAndRecord(session, { type: "message_uuid", uuid: "answer-" + session.storageId });
  h.sm().sendAndRecord(session, { type: "delta", text: "Annotations " });
  h.sm().sendAndRecord(session, { type: "delta", text: "are ready." });
  h.sm().sendAndRecord(session, { type: "done", code: 0 });
  var anchor = require("../lib/coop-owner-response-resolution").anchorForDone(session.history, session.history.length - 1);
  ledger.markAnswered(id, { eventIndex: 9999, messageUuid: anchor });
  session._historyNeedsRewrite = true;
  h.sm().saveSessionFile(session, { durable: true });
  h.restart();
  var view = h.sm().getHistoryView(h.session());
  var texts = main.membershipIndexes(h.session(), view).map(function (index) { return view.history[index].text; });
  assert.deepEqual(texts, ["Are annotations ready?", "Annotations are ready."]);
  assert.deepEqual(topicIndexes(h, "annotations").map(function (index) { return view.history[index].text; }), ["Annotations are ready."]);
  assert.deepEqual(topicIndexes(h, "speed"), []);
});

test("task feedback follows a verified execution continuation after worker compaction", function (t) {
  var h = fixture(t);
  var worker = h.tasks[0].worker;
  worker.vendor = "codex";
  h.workers.sendAndRecord(worker, { type: "user_message", text: "Implement annotations.", from: "owner" });
  var current = require("../lib/project-session-compaction").attachSessionCompaction({
    cwd: path.join(h.dir, "workers"), sm: h.workers, sdk: { startQuery: function () {} }, sendToSession: function () {},
  }).compactAndContinue(worker, { reason: "manual" });
  assert.ok(current);
  h.session().isProcessing = true;
  assert.equal(h.deliver(0, current.storageId, "continued-task-report").ok, true);
  assert.equal(h.session().pendingCoordinatorUpdates[0].feedback.coopTopicRef.topicId, "annotations");
  current.orchestrationPolicy.portfolioExecution.idempotencyKey = "unrelated-attempt";
  assert.equal(h.deliver(0, current.storageId, "unproven-task-report").ok, true);
  assert.equal(h.session().pendingCoordinatorUpdates[1].feedback, null);
});

["internal", "answer", "decision"].forEach(function (kind) {
  test("reconnect after actual compaction preserves the " + kind + " conversation and Thread scope", async function (t) {
    var h = fixture(t);
    var old = h.session();
    var ledger = require("../lib/coop-owner-requests").getDefaultOwnerRequests();
    var ingressId = "coop:" + old.storageId + ":1";
    var requestRef = { projectId: "system-lead", sessionStorageId: old.storageId, eventIndex: 0 };
    h.sm().sendAndRecord(old, { type: "user_message", text: "How are annotations going?", from: "owner", coopIngressId: ingressId });
    ledger.record({ ingressId: ingressId, ingressSequence: 1, requestRef: requestRef,
      topicRef: { topicId: "annotations" }, sessionRef: { projectId: "system-lead", sessionStorageId: old.storageId } });
    h.deliver(0);
    old.isProcessing = true;
    if (kind !== "internal") h.sm().sendAndRecord(old, {
      type: "user_message", text: "Lead tick", synthetic: true, autoAction: true,
    });
    h.sm().sendAndRecord(old, { type: "delta", text: "Internal worker analysis." });
    if (kind === "answer") {
      assert.equal(require("../lib/coop-owner-response-linkage").stageOwnerResponse({ session: old,
        sessions: h.sm().sessions, ownerRequests: ledger, requests: [{ ingressId: ingressId, requestRef: requestRef }],
        saveSession: function (current) { return h.sm().saveSessionFile(current, { durable: true }); } }).ok, true);
    } else if (kind === "decision") {
      var staged = require("../lib/coop-owner-decision-staging").newDecision({
        targetProject: { projectId: PROJECT }, portfolioTaskId: "task-annotations", bindingRevision: 1,
        planRevision: 1, planDigest: "0123456789abcdef0123456789abcdef", coopTopicRef: { topicId: "annotations" },
      }, old);
      old.orchestrationTasks = [{ taskId: "decision-task", status: "waiting_user", ownerDecision: staged }];
    }
    if (kind !== "internal") h.sm().sendAndRecord(old, { type: "delta", text: "Annotations are ready. " });
    old.vendor = "codex";
    var current = require("../lib/project-session-compaction").attachSessionCompaction({
      cwd: h.dir, sm: h.sm(), sdk: { startQuery: function () {} }, sendToSession: function () {},
    }).compactAndContinue(old, { reason: "manual" });
    assert.ok(current);
    h.sm().sendAndRecord(current, { type: "delta", text: "Continued response." });
    var view = h.sm().getHistoryView(current);
    var lens = await import("../lib/public/modules/coop-lens-relevance.js");
    ["main", "topic"].forEach(function (scope) {
      var tracker = lens.createTurnRelevanceTracker();
      var replayed = [];
      var ws = { readyState: 1, send: function (text) {
        var message = JSON.parse(text); replayed.push(message); tracker.relevance(message);
      } };
      var indexes = scope === "main" ? main.membershipIndexes(current, view)
        : connection.boundedMembershipIndexes({ topicRef: { topicId: "annotations" },
          eventRefs: [], turnRefs: [] }, current, view);
      h.sm().replayHistory(current, undefined, ws, main.transformFor({}), {
        scope: scope, historyView: view, eventIndexes: indexes,
      });
      var done = replayed.find(function (item) { return item.type === "history_done"; });
      assert.equal(done.coopConversationState.internalTurn, true);
      assert.equal(done.coopConversationState.ownerResponse, kind !== "internal");
      assert.deepEqual(done.coopConversationState.topicRefs, kind === "internal" ? [] : [{ topicId: "annotations" }]);
      assert.equal(tracker.relevance({ type: "delta", text: "More continued text." }), kind === "internal" ? "internal" : "owner");
      assert.equal(replayed.some(function (item) { return item.text === "Continued response."; }), kind !== "internal");
    });
    h.sm().sendAndRecord(current, { type: "user_message", text: "Now discuss speed.", from: "owner", coopTopicRef: { topicId: "speed" } });
    var reset = main.liveState(current, h.sm().getHistoryView(current));
    assert.equal(reset.internalTurn, false);
    assert.equal(reset.ownerResponse, false);
    assert.deepEqual(reset.topicRefs, [{ topicId: "speed" }]);
  });
});
