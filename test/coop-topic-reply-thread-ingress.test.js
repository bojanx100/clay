var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var after = require("node:test").after;
var assert = require("node:assert/strict");

var queueModule = require("../lib/project-user-message-queue");
var contextModule = require("../lib/project-user-message-context");
var topicIndexModule = require("../lib/coop-topic-index");
var replyAnchor = require("../lib/coop-topic-reply-anchor");
var projectUserMessageCoop = require("../lib/project-user-message-coop");
var projectUserMessage = require("../lib/project-user-message");
var projectIdentity = require("../lib/project-identity");
var threadIntent = require("../lib/coop-thread-intent");

// The ingress seam, end to end, with nothing reimplemented.
//
// coop-topic-reply-anchor.test.js proves the derivation in isolation. This file
// proves the seam that carries it: a real on-disk topic index, the real message
// pipeline (project-user-message-context.attachProjectUserMessageContext), and
// the two production functions the daemon wires in --
// replyAnchor.replyAnchorForRoute for send-time routing and
// replyAnchor.bindTopicMembership for send-time membership binding. A test that
// stubbed either of those would prove only that the stub agrees with itself,
// which is exactly how this seam broke unobserved before.
//
// The scenario is the one that produces the bug: canonical Coop history is ONE
// append-only log, so a message sent from Topic A lands physically next to
// whatever unrelated Topic B or general-chat traffic arrived last. Everything
// below is about keeping physical placement (correct storage) and logical reply
// association (correct conversation) as separate, independently correct facts.

// --- canonical fixture -------------------------------------------------------
// Seeded history, all four owner messages carrying real provenance so
// coop-topic-relevance treats them as genuine turn starts:
//
//   0 owner "A1"   1 delta   2 done   -> Topic A turn
//   3 owner "B1"   4 delta   5 done   -> Topic B turn
//   6 owner "A2"   7 delta   8 done   -> Topic A turn
//   9 owner "general chat"            -> member of NEITHER topic (physical tail)
//
// Topic A holds turn spans 0-2 and 6-8; Topic B holds 3-5. Index 9 belongs to
// no topic and is the trap: it is the physical tail, and it is what a naive
// "anchor to the last thing in history" implementation would pick for both.

var CANONICAL_STORAGE_ID = "coop-canonical-home";
var TOPIC_A = "thread-topic-a";
var TOPIC_B = "thread-topic-b";
var OWNER = { id: "a66ce4a1", displayName: "Admin" };

var tempDirs = [];

after(function () {
  for (var i = 0; i < tempDirs.length; i++) {
    fs.rmSync(tempDirs[i], { recursive: true, force: true });
  }
});

function tempDir(prefix) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function ownerMsg(ts, text) {
  return {
    type: "user_message", text: text,
    from: OWNER.id, fromName: OWNER.displayName, clientMessageId: "seed-cm-" + ts,
    _ts: ts,
  };
}

function assistantDelta(ts, text) {
  return { type: "delta", text: text, _ts: ts };
}

function assistantDone(ts) {
  return { type: "done", _ts: ts };
}

function seededHistory() {
  return [
    ownerMsg(1000, "A1"),                 // 0 Topic A turn start
    assistantDelta(1001, "A1 answer"),    // 1
    assistantDone(1002),                  // 2
    ownerMsg(1003, "B1"),                 // 3 Topic B turn start
    assistantDelta(1004, "B1 answer"),    // 4
    assistantDone(1005),                  // 5
    ownerMsg(1006, "A2"),                 // 6 Topic A turn start (A's latest)
    assistantDelta(1007, "A2 answer"),    // 7
    assistantDone(1008),                  // 8
    ownerMsg(1009, "general chat"),       // 9 physical tail, in no topic at all
  ];
}

function turnRef(start, end) {
  return {
    projectId: projectIdentity.LEAD_PROJECT_ID,
    sessionStorageId: CANONICAL_STORAGE_ID,
    startEventIndex: start, endEventIndex: end,
  };
}

function seedTopic(state, id, title, turnRefs, now) {
  state.topics[id] = {
    topicRef: { topicId: id }, title: title,
    keywords: [], group: { kind: "uncategorised" }, source: "manual",
    status: "open", createdAt: now, updatedAt: now,
    eventRefs: [], turnRefs: turnRefs, relatedExecutions: [],
  };
}

// --- harness -----------------------------------------------------------------
// Shape copied from test/project-user-message-context.test.js and adapted: the
// session is a canonical Coop home (coopHome plus a storageId equal to the
// index's canonicalSessionStorageId, which is what coop-topic-index
// .validateIngress requires), and its title is already set so ensureSessionTitle
// never fires and never rewrites session state mid-assertion.
//
// By default there is no coopControl, so metadata.coopIngress is null and
// applyText does NOT inject <coop_topic_context> into the dispatched text.
// Assertion (h) exercises the rebuild the restart path uses by calling
// withTopicContext on the PERSISTED record instead. Pass { coopControl: true }
// to additionally run the live foreground path -- reserveIngress ->
// buildMetadata -> applyText -> withTopicContext -- which is what actually
// carries the anchor to the agent.

// Stands in for lib/coop-conversation-control.js. reserveIngress returns the
// same shape the real one returns on acceptance (coop/accepted/ingressId/
// sequence/kind/key); foregroundText is a pass-through so the assertions read
// the text applyText itself produced rather than the control module's framing.
function makeCoopControlDouble(calls) {
  var sequence = 0;
  return {
    isCoopConversation: function () { return true; },
    reserveIngress: function () {
      sequence++;
      return {
        coop: true, accepted: true,
        ingressId: "coop:test:" + sequence, sequence: sequence,
        kind: "text", key: "key-" + sequence,
      };
    },
    foregroundText: function (reservation, text) { calls.push("foregroundText"); return text; },
    publish: function () { calls.push("publish"); },
    markDispatched: function () { calls.push("markDispatched"); },
    markIdle: function () { calls.push("markIdle"); },
    recordAttention: function (session, reason) { calls.push("recordAttention:" + reason); },
    clearAttention: function () { calls.push("clearAttention"); },
  };
}

function makeHarness(options) {
  var opts = options || {};
  var cwd = tempDir("clay-reply-thread-ingress-");
  var clock = 5000;
  var index = topicIndexModule.createTopicIndex({
    file: path.join(cwd, "lead", "coop-topic-index.json"),
    now: function () { clock++; return clock; },
  });
  var state = index.load();
  state.canonicalSessionStorageId = CANONICAL_STORAGE_ID;
  seedTopic(state, TOPIC_A, "Topic A", [turnRef(0, 2), turnRef(6, 8)], 1);
  seedTopic(state, TOPIC_B, "Topic B", [turnRef(3, 5)], 1);
  index.save();

  var session = {
    localId: 21, vendor: "codex", coopHome: true,
    storageId: CANONICAL_STORAGE_ID,
    title: "Canonical Coop home",
    history: opts.history || seededHistory(),
  };
  var sent = [];
  var sdkCalls = [];
  var routes = [];
  var binds = [];
  var controlCalls = [];
  var coopControl = opts.coopControl ? makeCoopControlDouble(controlCalls) : null;
  var sm = {
    sessions: new Map([[session.localId, session]]),
    appendToSessionFile: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    queuedUserMessagesForClient: function () { return []; },
  };
  var sdk = {
    startQuery: function (target, text, images) { sdkCalls.push({ kind: "start", text: text, images: images }); },
    pushMessage: function (target, text, images) { sdkCalls.push({ kind: "push", text: text, images: images }); },
  };
  var queue = queueModule.attachProjectUserMessageQueue({
    sm: sm, sdk: sdk, sendToSession: function (id, message) { sent.push(message); },
    onProcessingChanged: function () {}, onUserMessageDispatched: function () { return ""; },
    ensureProjectAccessForSession: function () {},
    coopControl: coopControl,
  });
  var context = contextModule.attachProjectUserMessageContext({
    cwd: cwd, slug: "test", sm: sm, sdk: sdk, adapter: {},
    coopControl: coopControl,
    email: null,
    tm: { getScrollback: function () { return null; }, list: function () { return []; } },
    browserState: { _browserTabList: {} },
    requestTabContext: function () { return Promise.resolve(null); },
    sendTo: function (ws, message) { sent.push(message); },
    sendToSession: function (id, message) { sent.push(message); },
    sendToSessionOthers: function () {},
    hydrateImageRefs: function (item) { return item; },
    saveImageFile: function () { return null; },
    imagesDir: path.join(cwd, "images"),
    getLinuxUserForSession: function () { return null; },
    onProcessingChanged: function () {},
    loadContextSources: function () { return []; },
    getSessionForMessage: function () { return session; },
    recoverHandoffContextForSend: function () {},
    shouldQueueMessage: function () { return false; },
    queue: queue,
    hasStaleProcessingState: function () { return false; },
    coopHandoffTraceStore: { recordIntent: function () { return { ok: false }; } },
    canCaptureCoopHandoff: function () { return false; },
    handoffTraceOwnerId: function () { return "_single_user"; },
    observeAssistantTurns: function () { return function () { return 0; }; },
    usersModule: { isMultiUser: function () { return false; } },
    // The production seams, wired exactly as the daemon wires them.
    validateCoopTopicIngress: function (currentSession, msg) {
      if (opts.contextualResolver) {
        return projectUserMessage.validateCoopTopicIngress({
          topicIndexFor: function () { return index; },
          getProjectList: function () { return []; },
        }, currentSession, msg, null);
      }
      var route = replyAnchor.replyAnchorForRoute(index, currentSession, index.validateIngress(currentSession, msg, {
        isProjectAvailable: function () { return true; },
      }));
      routes.push(route);
      return route;
    },
    resolveCoopThreadIntentTarget: function (currentSession, evidence) {
      return threadIntent.resolveDominantTarget(index, currentSession, evidence);
    },
    bindCoopTopicMessage: function (currentSession, msg, eventIndex) {
      var bound = replyAnchor.bindTopicMembership(index, currentSession, msg, eventIndex);
      binds.push({ eventIndex: eventIndex, bound: bound });
      return bound;
    },
  });
  return {
    context: context, session: session, index: index,
    sent: sent, sdkCalls: sdkCalls, routes: routes, binds: binds,
    controlCalls: controlCalls,
  };
}

// The <coop_topic_context> block applyText prepends, parsed back out of the
// text the SDK was handed. Returns null when no block is present at all.
function topicContextFromDispatchedText(text) {
  var lines = String(text || "").split("\n");
  if (lines[0] !== "<coop_topic_context>") return null;
  assert.equal(lines[2], "</coop_topic_context>", "the block is exactly open/JSON/close");
  return JSON.parse(lines[1]);
}

function threadControlFromDispatchedText(text) {
  var match = String(text || "").match(/<coop_thread_control>\n([^\n]+)\n<\/coop_thread_control>/);
  return match ? JSON.parse(match[1]) : null;
}

function ws() {
  return { _clayUser: { id: OWNER.id, displayName: OWNER.displayName } };
}

// A send from a topic lens, exactly as the owner's client issues it: an explicit
// coopTopicRef the owner selected, plus the composer's clientMessageId.
function send(h, topicId, text, clientMessageId) {
  var msg = { type: "message", text: text, clientMessageId: clientMessageId,
    coopComposerScope: topicId ? "topic" : "main" };
  if (topicId) msg.coopTopicRef = { topicId: topicId };
  return h.context.handleUserMessage(ws(), msg);
}

function lastItem(h) {
  return h.session.history[h.session.history.length - 1];
}

function membership(h, topicId) {
  var resolved = h.index.resolve({ topicId: topicId }, true);
  return JSON.parse(JSON.stringify({ eventRefs: resolved.topic.eventRefs, turnRefs: resolved.topic.turnRefs }));
}

// --- (a) a topic send anchors to its OWN latest owner turn -------------------

test("a send routed to Topic A anchors to Topic A's own latest owner turn start, not the physical tail and not Topic B", function () {
  var h = makeHarness();
  assert.equal(send(h, TOPIC_A, "A reply from the topic lens", "cm-a-1"), true);

  var item = lastItem(h);
  assert.equal(item.type, "user_message", "the send appended one canonical user_message");
  assert.deepEqual(item.coopTopicRef, { topicId: TOPIC_A });
  assert.ok(item.coopTopicAnchor, "an explicitly routed send into a topic with owner turns must carry an anchor");
  assert.equal(item.coopTopicAnchor.eventIndex, 6,
    "anchors to index 6, Topic A's own latest owner turn start");
  assert.notEqual(item.coopTopicAnchor.eventIndex, 9,
    "index 9 is the physical tail and belongs to no topic -- anchoring there is the cross-topic misattribution this exists to prevent");
  assert.notEqual(item.coopTopicAnchor.eventIndex, 3,
    "index 3 is Topic B's turn start -- Topic A must never read another topic's events");
  assert.equal(item.coopTopicAnchor.topicId, TOPIC_A);
  assert.equal(item.coopTopicAnchor.sessionStorageId, CANONICAL_STORAGE_ID);
  assert.equal(item.coopTopicAnchor.type, "user_message",
    "the anchored record is a turn start, which the transcript always renders a block for");
});

// --- (b) interleaved topics stay isolated ------------------------------------

test("a send routed to Topic B anchors to index 3, proving the two interleaved topics never read each other's events or the tail", function () {
  var h = makeHarness();
  assert.equal(send(h, TOPIC_B, "B reply from the topic lens", "cm-b-1"), true);

  var item = lastItem(h);
  assert.deepEqual(item.coopTopicRef, { topicId: TOPIC_B });
  assert.equal(item.coopTopicAnchor.eventIndex, 3,
    "Topic B's only owner turn start is index 3");
  assert.notEqual(item.coopTopicAnchor.eventIndex, 6, "index 6 is Topic A's latest turn -- never Topic B's parent");
  assert.notEqual(item.coopTopicAnchor.eventIndex, 9, "index 9 is unrelated general chat at the physical tail");
});

test("Topic A and Topic B sends into the same canonical log land at adjacent physical indexes yet keep separate logical parents", function () {
  // The whole point of the anchor: storage order and conversation order are
  // different facts. These two messages are physically adjacent (10 and 11) and
  // logically belong to two conversations that never touch.
  var h = makeHarness();
  send(h, TOPIC_A, "A reply", "cm-a-1");
  send(h, TOPIC_B, "B reply", "cm-b-1");

  assert.equal(h.session.history.length, 12, "both sends appended, physically adjacent");
  assert.equal(h.session.history[10].coopTopicAnchor.eventIndex, 6, "the A send answers Topic A's own latest turn");
  assert.equal(h.session.history[11].coopTopicAnchor.eventIndex, 3, "the B send answers Topic B's own latest turn");
  assert.notEqual(h.session.history[10].coopTopicAnchor.eventIndex, h.session.history[11].coopTopicAnchor.eventIndex,
    "physically adjacent, logically unrelated");
});

// --- (c) successive replies chain forward ------------------------------------

test("a second successive send in Topic A anchors to the first send's own event index -- successive replies chain forward", function () {
  // This only works if send-time membership binding actually claimed the first
  // message for Topic A. Extraction claims a turn only once a `done` lands, and
  // no `done` has landed here, so without bindTopicMembership the topic would
  // still end at index 8 and the second reply would re-anchor to index 6 --
  // the reported bug, where a topic lens replays without the owner's own message.
  var h = makeHarness();
  send(h, TOPIC_A, "first reply", "cm-a-1");
  var firstIndex = h.session.history.length - 1;
  assert.equal(firstIndex, 10);

  send(h, TOPIC_A, "second reply", "cm-a-2");
  var second = lastItem(h);
  assert.equal(second.coopTopicAnchor.eventIndex, firstIndex,
    "the second reply's logical parent is the first reply, not the turn that preceded both");
  assert.equal(second.coopTopicAnchor.clientMessageId, "cm-a-1",
    "the fingerprint names the first reply's own record, so a later drift check can tell it apart");
  assert.equal(second.coopTopicAnchor.ts, h.session.history[firstIndex]._ts);
  assert.equal(h.binds[0].bound, true, "send-time binding claimed the first message for the topic");
});

// --- (d) membership grows by exactly one reference, append-only --------------

test("each topic send adds exactly one new eventRef and reorders or removes nothing, and a repeated bind does not duplicate it", function () {
  var h = makeHarness();
  var beforeA = membership(h, TOPIC_A);
  var beforeB = membership(h, TOPIC_B);

  send(h, TOPIC_A, "A reply", "cm-a-1");
  var afterA = membership(h, TOPIC_A);
  assert.equal(afterA.eventRefs.length, beforeA.eventRefs.length + 1, "exactly one new membership reference");
  assert.deepEqual(afterA.eventRefs[afterA.eventRefs.length - 1], {
    projectId: projectIdentity.LEAD_PROJECT_ID, sessionStorageId: CANONICAL_STORAGE_ID, eventIndex: 10,
  }, "the new reference names the just-appended canonical event and nothing else");
  assert.deepEqual(afterA.eventRefs.slice(0, beforeA.eventRefs.length), beforeA.eventRefs,
    "no pre-existing eventRef was reordered or rewritten");
  assert.deepEqual(afterA.turnRefs, beforeA.turnRefs,
    "turn spans are extraction's to write -- send-time binding never touches them");
  assert.deepEqual(membership(h, TOPIC_B), beforeB, "the untouched topic gained nothing");

  send(h, TOPIC_B, "B reply", "cm-b-1");
  var afterBSend = membership(h, TOPIC_B);
  assert.equal(afterBSend.eventRefs.length, beforeB.eventRefs.length + 1);
  assert.deepEqual(afterBSend.eventRefs[afterBSend.eventRefs.length - 1], {
    projectId: projectIdentity.LEAD_PROJECT_ID, sessionStorageId: CANONICAL_STORAGE_ID, eventIndex: 11,
  });
  assert.deepEqual(membership(h, TOPIC_A), afterA, "the A send's membership is untouched by the B send");

  // Binding the same event again -- a replay, a retry, or a reconnect
  // redelivering the same send -- must be a true no-op.
  var repeated = replyAnchor.bindTopicMembership(h.index, h.session, { coopTopicRef: { topicId: TOPIC_A } }, 10);
  assert.equal(repeated, true, "a repeated bind still reports success");
  assert.deepEqual(membership(h, TOPIC_A), afterA,
    "binding the same event twice leaves the stored membership byte-for-byte unchanged");
});

// --- (e) general chat with no topic is untouched -----------------------------

test("a message with no coopTopicRef gets no anchor and adds no membership to any topic", function () {
  var h = makeHarness();
  var beforeA = membership(h, TOPIC_A);
  var beforeB = membership(h, TOPIC_B);

  assert.equal(send(h, null, "general chat with no topic at all", "cm-general-1"), true);

  var item = lastItem(h);
  assert.equal(item.type, "user_message");
  assert.equal(item.text, "general chat with no topic at all");
  assert.equal(Object.prototype.hasOwnProperty.call(item, "coopTopicRef"), false,
    "an unrouted message claims no topic");
  assert.equal(Object.prototype.hasOwnProperty.call(item, "coopTopicAnchor"), false,
    "no topic means no reply relationship -- threading general chat onto a guessed topic is exactly the misattribution to avoid");
  assert.deepEqual(membership(h, TOPIC_A), beforeA, "Topic A gained no membership from general chat");
  assert.deepEqual(membership(h, TOPIC_B), beforeB, "Topic B gained no membership from general chat");
  assert.deepEqual(h.binds, [{ eventIndex: 10, bound: false }],
    "binding was attempted and correctly declined -- an unrouted message claims nothing");
});

// --- (f) a closed topic refuses the send -------------------------------------

test("a closed topic refuses the send outright: no user_message, no anchor, no membership", function () {
  var h = makeHarness();
  assert.equal(h.index.close({ topicId: TOPIC_A }).ok, true);
  var historyBefore = JSON.parse(JSON.stringify(h.session.history));
  var beforeA = membership(h, TOPIC_A);

  assert.equal(send(h, TOPIC_A, "reply into a closed topic", "cm-closed-1"), true,
    "the message is consumed, not passed through to another handler");

  assert.deepEqual(h.session.history, historyBefore,
    "coop-topic-ingress.prepareIngress refused the route, so nothing was appended -- a closed topic accepts no new turn");
  assert.deepEqual(membership(h, TOPIC_A), beforeA, "and no membership was claimed");
  assert.deepEqual(h.binds, [], "binding is never even reached when ingress is refused");
  assert.equal(h.routes.length, 1);
  assert.equal(h.routes[0].ok, false, "validateIngress resolves open topics only");
  assert.equal(h.routes[0].code, "topic_closed");
  assert.equal(h.routes[0].topicAnchor, undefined,
    "a refused route hands out no anchor either -- fail closed, never a guess");
  assert.ok(h.sent.some(function (message) {
    return message.type === "error";
  }), "the owner is told the target is unavailable rather than silently rerouted");
});

// --- (g) append-only proof ----------------------------------------------------

test("a topic send is strictly append-only: every pre-existing history element is byte-identical afterwards", function () {
  // The anchor exists precisely so no earlier record has to be rewritten to
  // express a reply relationship. If this ever fails, canonical chronology has
  // been edited and every other consumer of the log is reading altered history.
  var h = makeHarness();
  var before = JSON.parse(JSON.stringify(h.session.history));

  send(h, TOPIC_A, "A reply", "cm-a-1");

  assert.equal(h.session.history.length, before.length + 1, "exactly one element was added");
  for (var i = 0; i < before.length; i++) {
    assert.deepEqual(h.session.history[i], before[i],
      "pre-existing history element " + i + " must be byte-identical -- nothing rewritten, nothing reordered");
  }
  assert.equal(h.session.history[before.length].text, "A reply", "the only change is the new tail element");
});

// --- (h) restart / replay determinism ----------------------------------------

test("the persisted record rebuilds the same coop_topic_context replyTo the live anchor produced, and survives a JSON round-trip", function () {
  // project-user-message-queue.coopIngressFromHistory rebuilds the outgoing text
  // from the persisted history item after a restart, calling withTopicContext
  // with exactly these four fields. If the durable record did not reproduce the
  // live anchor, a restart would silently re-thread the owner's message.
  var h = makeHarness();
  send(h, TOPIC_A, "A reply", "cm-a-1");
  var item = lastItem(h);
  var liveAnchor = h.routes[0].topicAnchor;
  assert.ok(liveAnchor, "the live route produced an anchor");

  var rebuilt = projectUserMessageCoop.withTopicContext(item.text, item.coopTopicRef, item.coopProjectRef, item.coopTopicAnchor);
  var lines = rebuilt.split("\n");
  assert.equal(lines[0], "<coop_topic_context>");
  assert.equal(lines[2], "</coop_topic_context>");
  var payload = JSON.parse(lines[1]);
  assert.deepEqual(payload.replyTo, replyAnchor.anchorContextPayload(liveAnchor),
    "the rebuilt context carries the same reference-only replyTo the live anchor projects");
  assert.deepEqual(payload.replyTo, {
    topicId: TOPIC_A, sessionStorageId: CANONICAL_STORAGE_ID, eventIndex: 6,
  }, "reference-only: the topic, the canonical session, and the anchored event index -- no copied content");
  assert.deepEqual(payload.topicRef, { topicId: TOPIC_A });

  var roundTripped = JSON.parse(JSON.stringify(item));
  assert.equal(
    projectUserMessageCoop.withTopicContext(roundTripped.text, roundTripped.coopTopicRef, roundTripped.coopProjectRef, roundTripped.coopTopicAnchor),
    rebuilt,
    "a JSON round-trip of the persisted item reproduces identical text -- this is the restart rebuild path"
  );
});

// --- the live foreground dispatch path that carries the anchor to the agent --
//
// Everything above stops at the durable record. This is the other half: with a
// coopControl reservation in play, metadata.coopIngress is truthy, so
// project-user-message-coop.applyText runs withTopicContext on the OUTGOING
// text. That block is the only thing the agent ever sees of the anchor, so if
// this path dropped it the durable record would be right and the conversation
// would still read as unthreaded.

test("the text handed to the SDK carries a coop_topic_context block whose replyTo matches the anchor on the persisted record", function () {
  var h = makeHarness({ coopControl: true });
  send(h, TOPIC_A, "A reply from the topic lens", "cm-a-1");

  assert.equal(h.sdkCalls.length, 1, "the reserved foreground turn was dispatched");
  var context = topicContextFromDispatchedText(h.sdkCalls[0].text);
  assert.ok(context, "an explicitly routed Coop send must carry the topic context to the agent");
  assert.deepEqual(context.topicRef, { topicId: TOPIC_A });

  var item = lastItem(h);
  assert.deepEqual(context.replyTo, replyAnchor.anchorContextPayload(item.coopTopicAnchor),
    "the agent-visible replyTo is exactly the reference-only projection of the anchor on the durable record");
  assert.deepEqual(context.replyTo, {
    topicId: TOPIC_A, sessionStorageId: CANONICAL_STORAGE_ID, eventIndex: 6,
  }, "and it still names Topic A's own latest owner turn start, not the physical tail");
  assert.ok(h.sdkCalls[0].text.indexOf("A reply from the topic lens") !== -1,
    "the owner's own text survives the framing");
  assert.ok(h.controlCalls.indexOf("foregroundText") !== -1,
    "the real applyText seam ran, including the coopControl foreground framing hook");
  assert.ok(h.controlCalls.indexOf("clearAttention") !== -1,
    "every target check passed, so the accept point cleared attention");
});

test("repeated contextual fixes carry one concrete ThreadRef and no raw ambiguity question to the foreground agent", function () {
  var h = makeHarness({
    coopControl: true,
    contextualResolver: true,
    history: seededHistory().slice(0, 9),
  });
  var commands = ["Fix that too", "FIX!"];

  for (var i = 0; i < commands.length; i++) {
    h.session.isProcessing = false;
    assert.equal(send(h, null, commands[i], "cm-contextual-" + i), true);
    assert.equal(h.sdkCalls.length, i + 1);
    var foregroundText = h.sdkCalls[i].text;
    var control = threadControlFromDispatchedText(foregroundText);
    assert.ok(control, "the foreground text carries the Thread control block");
    assert.equal(control.kind, "implement");
    assert.deepEqual(control.threadRef, { threadId: TOPIC_A });
    assert.equal(control.question, "");
    assert.doesNotMatch(foregroundText, /Which Thread should I apply that to\?/);
    assert.deepEqual(h.session.history[9 + i].coopThreadRef, { threadId: TOPIC_A });
  }
});

test("a Coop send with no topic ref produces no coop_topic_context block at all", function () {
  // withTopicContext returns the text untouched without a topicRef, so an
  // unrouted general-chat turn stays byte-identical to the pre-anchor wire
  // format even on the foreground path.
  var h = makeHarness({ coopControl: true });
  send(h, null, "general chat with no topic at all", "cm-general-1");

  assert.equal(h.sdkCalls.length, 1);
  assert.equal(topicContextFromDispatchedText(h.sdkCalls[0].text), null,
    "no topic means no context block -- nothing is guessed onto the agent's view");
  assert.equal(h.sdkCalls[0].text.indexOf("coop_topic_context"), -1);
  assert.equal(h.sdkCalls[0].text, "general chat with no topic at all",
    "the dispatched text is the owner's text and nothing else");
});

test("recordPrepared persists the prepared text and leaves the ingress anchor on the record the restart rebuild reads", function () {
  // project-user-message-queue.coopIngressFromHistory prefers
  // coopIngressPreparedText when present and otherwise rebuilds from
  // coopTopicAnchor. Both fields must survive recordPrepared, which rewrites
  // the item in place after dispatch.
  var h = makeHarness({ coopControl: true });
  var ingressAnchor = null;
  send(h, TOPIC_A, "A reply", "cm-a-1");
  ingressAnchor = h.routes[0].topicAnchor;

  var item = lastItem(h);
  assert.equal(typeof item.coopIngressPreparedText, "string", "recordPrepared ran");
  assert.equal(item.coopIngressPreparedText, h.sdkCalls[0].text,
    "the persisted prepared text is exactly what the agent received, so a restart replays it verbatim");
  assert.deepEqual(item.coopTopicAnchor, ingressAnchor,
    "recordPrepared rewrote the item without disturbing the anchor stamped at ingress");
  assert.deepEqual(item.coopTopicRef, { topicId: TOPIC_A });
  assert.equal(item.coopProjectRef, null, "an uncategorised topic routes to no project");
  assert.ok(topicContextFromDispatchedText(item.coopIngressPreparedText),
    "the persisted prepared text still contains the topic context block");
});

// --- two writers, one canonical event ----------------------------------------
//
// The real risk of the new send-time write: binding claims the event
// immediately, and post-`done` extraction claims the same turn again later.
// Both write into the same topic, through different fields (eventRefs vs
// turnRefs). If they disagreed, the topic lens would replay the owner's own
// message twice or out of order.

test("send-time binding and post-done extraction claim the same event without duplicating or reordering the lens", function () {
  var topicConnection = require("../lib/coop-topic-connection");
  var h = makeHarness();
  send(h, TOPIC_A, "A reply", "cm-a-1");
  var sentIndex = h.session.history.length - 1;
  assert.equal(sentIndex, 10);

  // The lens as it stands with only the send-time binding: the owner's own
  // message is already there, before any `done` has landed. That is the gap
  // binding exists to close.
  var beforeExtraction = topicConnection.boundedMembershipIndexes(h.index.resolve({ topicId: TOPIC_A }, true).topic, h.session);
  assert.ok(beforeExtraction.indexOf(sentIndex) !== -1,
    "the topic lens shows the owner's message immediately, without waiting for extraction");

  // Complete the turn so extraction will claim it too.
  h.session.history.push({ type: "delta", text: "an answer", _ts: 2000 });
  h.session.history.push({ type: "done", _ts: 2001 });

  var retro = h.index.ensureRetro(h.session, { projects: [] });
  assert.equal(retro.ok, true, "the extraction/retro path ran against the canonical session");

  var topicA = h.index.resolve({ topicId: TOPIC_A }, true).topic;
  var lens = topicConnection.boundedMembershipIndexes(topicA, h.session);

  // Extraction really did claim the same turn through turnRefs, so this is a
  // genuine double claim and not a vacuous pass.
  var claimedByTurnSpan = topicA.turnRefs.some(function (ref) {
    return sentIndex >= ref.startEventIndex && sentIndex <= ref.endEventIndex;
  });
  var claimedByEventRef = topicA.eventRefs.some(function (ref) { return ref.eventIndex === sentIndex; });
  assert.equal(claimedByTurnSpan, true, "extraction claimed the completed turn through a turn span");
  assert.equal(claimedByEventRef, true, "send-time binding's own event reference is still there, never rewritten");

  var occurrences = lens.filter(function (value) { return value === sentIndex; }).length;
  assert.equal(occurrences, 1,
    "two independent writers claimed event " + sentIndex + " and the lens still names it exactly once");
  assert.deepEqual(lens, lens.slice().sort(function (a, b) { return a - b; }),
    "the replayed index list is sorted ascending -- the owner's message keeps its canonical position");
  assert.equal(new Set(lens).size, lens.length, "no index appears twice anywhere in the lens");
  assert.ok(lens.indexOf(sentIndex) !== -1, "and the owner's own message is still in its topic's lens");

  // The unrouted general-chat message at index 9 opens a turn that is never
  // closed by a `done` (index 10 supersedes it), so extraction never completes
  // it and no topic claims it.
  assert.equal(lens.indexOf(9), -1, "the unrouted general-chat message never entered any topic's lens");

  // NOTE, deliberately asserted as observed rather than asserted away:
  // ensureRetro also widens Topic A's lens to cover indexes 3-5, which is Topic
  // B's turn. That is pre-existing CLASSIFIER behaviour and has nothing to do
  // with the reply anchor: this fixture's turn texts ("A1", "B1") are
  // low-information and match no seed, so coop-topic-classification reuses the
  // most recent open topic -- Topic A, whose span 0-2 precedes index 3 --
  // instead of minting a new one. test/coop-topic-index.test.js pins that same
  // rule ("a low-information turn still reuses a recent open topic instead of
  // falling to the catch-all"). It is unrelated to send-time binding: it is
  // driven purely by the seeded turns, which carry no coopTopicRef at all.
  assert.ok(lens.indexOf(3) !== -1,
    "observed: the low-information seeded turns are re-classified into Topic A by the recent-topic rule, independent of anything the anchor writes");
  assert.deepEqual(
    topicConnection.boundedMembershipIndexes(h.index.resolve({ topicId: TOPIC_B }, true).topic, h.session),
    [3, 4, 5],
    "and Topic B keeps its own membership exactly -- the reclassification widened A, it did not take anything from B"
  );
  assert.equal(
    topicConnection.boundedMembershipIndexes(h.index.resolve({ topicId: TOPIC_B }, true).topic, h.session).indexOf(sentIndex),
    -1,
    "the send-time binding is the isolated part under test: the message routed to Topic A never entered Topic B"
  );

  // Idempotence: a second retro pass over settled history changes nothing.
  var second = h.index.ensureRetro(h.session, { projects: [] });
  assert.equal(second.ok, true);
  assert.deepEqual(
    topicConnection.boundedMembershipIndexes(h.index.resolve({ topicId: TOPIC_A }, true).topic, h.session),
    lens,
    "re-running extraction over already-settled history is a true no-op for the lens"
  );
});

test("the reply anchor still resolves after extraction has also claimed the turn", function () {
  // The anchor is a fingerprint into canonical history, and extraction writes
  // only to the index. If extraction could disturb the anchored record, a chip
  // would start failing its read-time gate the moment a turn completed.
  var h = makeHarness();
  send(h, TOPIC_A, "A reply", "cm-a-1");
  var item = lastItem(h);
  h.session.history.push({ type: "delta", text: "an answer", _ts: 2000 });
  h.session.history.push({ type: "done", _ts: 2001 });
  h.index.ensureRetro(h.session, { projects: [] });

  assert.deepEqual(replyAnchor.anchorForItem(item, h.session.history), item.coopTopicAnchor,
    "the anchor stamped at ingress still passes its read-time gate after the turn completed and was extracted");

  // And the next reply in the topic now chains onto the sent message, which by
  // this point both writers agree is a member.
  send(h, TOPIC_A, "A follow-up", "cm-a-2");
  assert.equal(lastItem(h).coopTopicAnchor.eventIndex, 10,
    "the follow-up answers the owner's previous message in this topic, not the completed answer after it");
});

test("the anchor stamped at ingress still resolves against the history it was stamped against", function () {
  // anchorForItem is the read-time gate: same topic, and the anchored record is
  // still itself. A record written by this pipeline must pass its own gate, or
  // the chip would be dropped the moment it was rendered.
  var h = makeHarness();
  send(h, TOPIC_A, "A reply", "cm-a-1");
  var item = lastItem(h);
  assert.deepEqual(replyAnchor.anchorForItem(item, h.session.history), item.coopTopicAnchor,
    "the freshly stamped anchor passes the read-time topic-match and fingerprint checks");
  assert.equal(replyAnchor.anchorResolves(item.coopTopicAnchor, h.session.history), true);
});
