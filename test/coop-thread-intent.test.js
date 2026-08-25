var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var intent = require("../lib/coop-thread-intent");
var ingress = require("../lib/coop-topic-ingress");
var projectIdentity = require("../lib/project-identity");
var replyAnchor = require("../lib/coop-topic-reply-anchor");
var userMessage = require("../lib/project-user-message");
var topicIndex = require("../lib/coop-topic-index");

var CANONICAL_STORAGE_ID = "canonical-coop";

function indexHarness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-thread-intent-"));
  var tick = 100;
  var index = topicIndex.createTopicIndex({
    file: path.join(dir, "lead", "topics.json"),
    now: function () { tick += 1; return tick; },
  });
  var state = index.load();
  state.topics["thread-a"] = {
    topicRef: { topicId: "thread-a" }, threadRef: { threadId: "thread-a" },
    title: "Thread A", group: { kind: "uncategorised" }, source: "manual",
    status: "open", createdAt: 1, updatedAt: 1, eventRefs: [], turnRefs: [], relatedExecutions: [],
  };
  state.topics["thread-b"] = {
    topicRef: { topicId: "thread-b" }, threadRef: { threadId: "thread-b" },
    title: "Thread B", group: { kind: "uncategorised" }, source: "manual",
    status: "open", createdAt: 1, updatedAt: 1, eventRefs: [], turnRefs: [], relatedExecutions: [],
  };
  index.save();
  index.ensureThreadLifecycle();
  return { dir: dir, index: index };
}

function canonicalRef(eventIndex) {
  return {
    projectId: projectIdentity.LEAD_PROJECT_ID,
    sessionStorageId: CANONICAL_STORAGE_ID,
    eventIndex: eventIndex,
  };
}

function turnRef(startEventIndex, endEventIndex) {
  return {
    projectId: projectIdentity.LEAD_PROJECT_ID,
    sessionStorageId: CANONICAL_STORAGE_ID,
    startEventIndex: startEventIndex,
    endEventIndex: endEventIndex,
  };
}

function routedTopic(id, turns, events) {
  return {
    topicRef: { topicId: id }, threadRef: { threadId: id },
    title: id === "thread-a" ? "Thread A" : "Thread B",
    group: { kind: "uncategorised" }, source: "manual", status: "open",
    threadState: "exploring", createdAt: 1, updatedAt: 1,
    eventRefs: events.map(canonicalRef), turnRefs: turns.slice(), relatedExecutions: [],
  };
}

function routingIndex(topics) {
  var state = { canonicalSessionStorageId: CANONICAL_STORAGE_ID, topics: topics };
  function idOf(ref) {
    return ref && (ref.threadId || ref.topicId) || "";
  }
  function resolve(ref, includeClosed) {
    var id = idOf(ref);
    var topic = state.topics[id];
    if (!topic) return { ok: false, code: "thread_not_found" };
    if (!includeClosed && topic.status !== "open") return { ok: false, code: "thread_closed" };
    return {
      ok: true, ref: { topicId: id }, topicRef: { topicId: id },
      threadRef: { threadId: id }, topic: topic, thread: topic,
    };
  }
  return {
    load: function () { return state; },
    resolve: resolve,
    ensureRetro: function () { return { ok: true }; },
    reconcileTopicAnchors: function () {},
    retrofitTopicTitles: function () {},
    validateIngress: function (session, msg, options) {
      var ref = msg.coopThreadRef || msg.coopTopicRef;
      var resolved = resolve(ref, !!(options && options.includeClosedTopics));
      if (!resolved.ok) return resolved;
      return {
        ok: true, topicRef: resolved.topicRef, threadRef: resolved.threadRef,
        threadState: resolved.topic.threadState, projectRef: null,
      };
    },
  };
}

function routingHarness(history, overrides) {
  var opts = overrides || {};
  var topics = {
    "thread-a": routedTopic("thread-a", opts.aTurns || [turnRef(0, 2)], opts.aEvents || [0]),
    "thread-b": routedTopic("thread-b", opts.bTurns || [turnRef(3, 5)], opts.bEvents || [3]),
  };
  var index = routingIndex(topics);
  return {
    index: index,
    session: {
      coopHome: true,
      storageId: CANONICAL_STORAGE_ID,
      history: history,
    },
  };
}

function ownerMessage(text, topicId, eventIndex) {
  var item = {
    type: "user_message", text: text, from: "owner", fromName: "Owner",
    clientMessageId: "owner-" + eventIndex, _ts: 1000 + eventIndex,
  };
  if (topicId) {
    item.coopTopicRef = { topicId: topicId };
    item.coopThreadRef = { threadId: topicId };
  }
  return item;
}

function completedHistory() {
  return [
    ownerMessage("A question", "thread-a", 0),
    { type: "delta", text: "A answer" },
    { type: "done" },
    ownerMessage("B question", "thread-b", 3),
    { type: "delta", text: "B answer" },
    { type: "done" },
  ];
}

function prepareFollowup(harness, message, historyView) {
  var errors = [];
  var resolverCalls = 0;
  var routeContext = {
    topicIndexFor: function () { return harness.index; },
    getProjectList: function () { return []; },
  };
  var ok = ingress.prepareIngress({
    resolveCoopThreadIntentTarget: function (session, evidence) {
      resolverCalls += 1;
      return intent.resolveDominantTarget(harness.index, session,
        Object.assign({}, evidence, historyView ? { historyView: historyView } : {}));
    },
    validateCoopTopicIngress: function (session, msg, ws) {
      return userMessage.validateCoopTopicIngress(routeContext, session, msg, ws);
    },
    sendTo: function (ws, messageValue) { errors.push(messageValue); },
  }, {}, message, harness.session);
  return { ok: ok, errors: errors, resolverCalls: resolverCalls };
}

test("natural language maps clear lifecycle commands when a concrete target is proven", function () {
  assert.equal(intent.parse("keep this open", { explicitTarget: true }).kind, "keep_open");
  assert.equal(intent.parse("continue the discussion", { explicitTarget: true }).kind, "keep_open");
  assert.equal(intent.parse("open this", { explicitTarget: true }).kind, "reopen");
  assert.equal(intent.parse("keep discussing this", { explicitTarget: true }).kind, "keep_open");
  assert.equal(intent.parse("hand this off", { explicitTarget: true }).kind, "hand_off");
  assert.equal(intent.parse("hand this to Clay", { explicitTarget: true }).kind, "hand_off");
  assert.equal(intent.parse("implement this", { explicitTarget: true }).kind, "implement");
  assert.deepEqual(intent.parse("request changes: add a regression test", { explicitTarget: true }), {
    kind: "request_changes", note: "add a regression test",
  });
  assert.equal(intent.parse("hide this", { explicitTarget: true }).kind, "hide");
  assert.equal(intent.parse("do not pursue this", { explicitTarget: true }).kind, "hide");
  assert.equal(intent.parse("reopen", { explicitTarget: true }).kind, "reopen");
  assert.equal(intent.parse("undo that", { explicitTarget: true }).kind, "undo");
});

test("unresolved command-shaped language is clarification-only and never actionable", function () {
  var parsed = intent.parse("hide this", { explicitTarget: false });
  assert.equal(parsed.kind, "ambiguous");
  assert.equal(intent.isActionable(parsed), false);
  assert.equal(intent.parse("request changes", { explicitTarget: true }).kind, "ambiguous");
  assert.equal(intent.isControlShaped("FIX!"), true);
  assert.equal(intent.isControlShaped("What about this?"), false);
});

test("an active Thread lens is the exact target for a contextual follow-up", function () {
  var h = routingHarness(completedHistory());
  var message = {
    type: "message", text: "Fix that too", coopComposerScope: "topic",
    coopTopicRef: { topicId: "thread-a" },
  };
  var result = prepareFollowup(h, message);
  assert.equal(result.ok, true);
  assert.equal(result.resolverCalls, 0);
  assert.deepEqual(message.coopThreadRef, { threadId: "thread-a" });
  assert.equal(message.coopThreadIntent.kind, "implement");
});

test("ordinary Main conversation does not consult contextual Thread evidence", function () {
  var h = routingHarness(completedHistory());
  var message = { type: "message", text: "What about this?", coopComposerScope: "main" };
  var result = prepareFollowup(h, message);
  assert.equal(result.ok, true);
  assert.equal(result.resolverCalls, 0);
  assert.equal(message.coopThreadIntent, undefined);
  assert.equal(message.coopThreadRef, undefined);
});

test("a bare Main implementation request stays conversational when no Thread is proven", function () {
  var h = routingHarness([]);
  var message = { type: "message", text: "Fix it", coopComposerScope: "main" };
  var result = prepareFollowup(h, message);
  assert.equal(result.ok, true);
  assert.equal(result.resolverCalls, 1);
  assert.equal(message.coopThreadIntent, undefined);
  assert.equal(message.coopThreadRef, undefined);
});

test("a validated reply turn anchor resolves one concrete ThreadRef", function () {
  var history = completedHistory();
  var h = routingHarness(history);
  var anchor = replyAnchor.buildReplyAnchor(
    { topicId: "thread-a" }, h.index.load().topics["thread-a"], h.session);
  var message = {
    type: "message", text: "Fix that too", coopComposerScope: "main",
    coopTopicAnchor: anchor,
  };
  var result = prepareFollowup(h, message);
  assert.equal(result.ok, true);
  assert.equal(result.resolverCalls, 1);
  assert.deepEqual(message.coopThreadRef, { threadId: "thread-a" });
  assert.equal(message.coopThreadIntent.kind, "implement");
  assert.equal(message.coopTopicAnchor.topicId, "thread-a");
});

test("the immediately preceding assistant topic resolves FIX to one ThreadRef", function () {
  var history = completedHistory();
  history.push(ownerMessage("An unlabelled current turn", null, 6));
  history.push({ type: "delta", text: "Current A answer" });
  history.push({ type: "done" });
  var h = routingHarness(history, {
    aTurns: [turnRef(0, 2), turnRef(6, 8)], aEvents: [0, 6],
  });
  var message = { type: "message", text: "FIX!", coopComposerScope: "main" };
  var result = prepareFollowup(h, message);
  assert.equal(result.ok, true);
  assert.equal(result.resolverCalls, 1);
  assert.deepEqual(message.coopThreadRef, { threadId: "thread-a" });
  assert.equal(message.coopThreadIntent.kind, "implement");
});

test("the canonical current owner Thread resolves a follow-up before an assistant reply", function () {
  var history = completedHistory();
  history.push(ownerMessage("One more A detail", "thread-a", 6));
  var h = routingHarness(history, { aEvents: [0, 6] });
  var message = { type: "message", text: "FIX!", coopComposerScope: "main" };
  var result = prepareFollowup(h, message);
  assert.equal(result.ok, true);
  assert.equal(result.resolverCalls, 1);
  assert.deepEqual(message.coopThreadRef, { threadId: "thread-a" });
  assert.equal(message.coopThreadIntent.kind, "implement");
});

test("a compacted Coop successor resolves against the exact canonical ancestor evidence", function () {
  var history = completedHistory();
  var h = routingHarness([{ type: "info", text: "Compacted continuation" }, { type: "delta", text: "Current answer" }]);
  var oldStorageId = CANONICAL_STORAGE_ID;
  var successorStorageId = "successor-coop";
  h.session.storageId = successorStorageId;
  h.session.history = [{ type: "info", text: "Compacted continuation" }, { type: "delta", text: "Current answer" }];
  h.session.compactedFromStorageId = oldStorageId;
  var historyView = {
    history: history.concat(h.session.history),
    entries: history.map(function (item, index) {
      return { historyIndex: index, sessionStorageId: oldStorageId, eventIndex: index };
    }).concat(h.session.history.map(function (item, index) {
      return { historyIndex: history.length + index, sessionStorageId: successorStorageId, eventIndex: index };
    })),
  };
  var message = { type: "message", text: "Fix it", coopComposerScope: "main" };
  var result = prepareFollowup(h, message, historyView);
  assert.equal(result.ok, true);
  assert.equal(result.resolverCalls, 1);
  assert.deepEqual(message.coopThreadRef, { threadId: "thread-b" });
  assert.equal(message.coopThreadIntent.kind, "implement");
});

test("machine-injected user messages do not hide one current Thread from a Main follow-up", function () {
  var history = completedHistory();
  history.push({ type: "user_message", text: "↻ Lead tick" });
  var h = routingHarness(history);
  var message = { type: "message", text: "Fix it", coopComposerScope: "main" };
  var result = prepareFollowup(h, message);
  assert.equal(result.ok, true);
  assert.equal(result.resolverCalls, 1);
  assert.deepEqual(message.coopThreadRef, { threadId: "thread-b" });
  assert.equal(message.coopThreadIntent.kind, "implement");
});

test("two plausible preceding Threads yield one clarification and mutate neither Thread", function () {
  var history = completedHistory();
  history.push(ownerMessage("A and B overlap", "thread-a", 6));
  history.push({ type: "delta", text: "Shared answer" });
  history.push({ type: "done" });
  history.push({ type: "user_message", text: "↻ Lead tick" });
  var shared = turnRef(6, 8);
  var h = routingHarness(history, {
    aTurns: [turnRef(0, 2), shared], aEvents: [0, 6],
    bTurns: [turnRef(3, 5), shared], bEvents: [3, 6],
  });
  var before = JSON.stringify(h.index.load().topics);
  var message = { type: "message", text: "FIX!", coopComposerScope: "main" };
  var result = prepareFollowup(h, message);
  assert.equal(result.ok, true);
  assert.equal(result.resolverCalls, 1);
  assert.deepEqual(message.coopThreadIntent, {
    kind: "ambiguous", question: "Which Thread should I apply that to?",
  });
  assert.equal(message.coopThreadRef, undefined);
  assert.equal(intent.isActionable(message.coopThreadIntent), false);
  assert.equal(JSON.stringify(h.index.load().topics), before);
});

test("hide retains exact refs, request changes is durable, and reopen/undo repeat safely", function () {
  var h = indexHarness();
  try {
    var ref = { threadId: "thread-a" };
    var hidden = intent.apply(h.index, ref, { kind: "hide" }, {});
    assert.equal(hidden.ok, true);
    var retained = h.index.resolve({ topicId: "thread-a" }, true).thread;
    assert.equal(retained.hidden, true);
    assert.deepEqual(retained.threadRef, ref);
    assert.equal(h.index.resolve({ topicId: "thread-b" }, true).thread.hidden, false);

    var reopened = intent.apply(h.index, ref, { kind: "reopen" }, {});
    assert.equal(reopened.ok, true);
    assert.equal(h.index.resolve(ref, true).thread.hidden, false);
    assert.equal(intent.apply(h.index, ref, { kind: "reopen" }, {}).unchanged, true);

    var requested = intent.apply(h.index, ref, {
      kind: "request_changes", note: "Please add coverage.",
    }, { requestId: "thread-control:one" });
    assert.equal(requested.ok, true);
    assert.equal(h.index.resolve(ref, true).thread.ownerDisposition.status, "needs_input");

    var undone = intent.apply(h.index, ref, { kind: "undo" }, {});
    assert.equal(undone.ok, true);
    assert.equal(h.index.resolve(ref, true).thread.threadState, "exploring");
    assert.equal(intent.apply(h.index, ref, { kind: "undo" }, {}).unchanged, true);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});
