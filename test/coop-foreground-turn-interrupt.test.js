var test = require("node:test");
var assert = require("node:assert/strict");

var conversationControl = require("../lib/coop-conversation-control");
var queueModule = require("../lib/project-user-message-queue");
var streamFinalize = require("../lib/sdk-bridge-stream-finalize");
var cleanupRuntime = require("../lib/coop-self-cleanup-runtime");
var scheduledMessages = require("../lib/project-scheduled-messages");

var COOP_SESSION = "871a194b-8879-40f7-a1fe-656e48e722af";
var OWNER_MESSAGES = [
  { sequence: 254, at: 1786708474842,
    text: "Ok I think we can remove topics? Or do we need some way of still to track discussions before it goes to project coordinators?" },
  { sequence: 255, at: 1786708519657,
    text: "The now category is certainly out of the picture... because now are project coordinators..." },
  { sequence: 256, at: 1786708552282,
    text: "again you are failing to respond to my messages" },
];

function query(name) {
  return {
    name: name,
    close: function () {},
  };
}

function harness(options) {
  options = options || {};
  var starts = [];
  var pushes = [];
  var leadTicks = 0;
  var session = {
    coopHome: true,
    storageId: COOP_SESSION,
    localId: "coop-home",
    history: [],
    pendingAskUser: {},
    pendingElicitations: {},
    pendingUserDialogs: {},
    pendingPermissions: {},
    blocks: {},
    activeTaskToolIds: {},
    taskIdMap: {},
    _turnDoneSent: true,
  };
  var sm = {
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    queuedUserMessagesForClient: function () { return []; },
  };

  function scheduleLeadTick() {
    if (session.isProcessing || session.scheduledMessage) return false;
    leadTicks++;
    session.scheduledMessage = { text: "↻ Lead tick", autoAction: true };
    session.history.push({ type: "scheduled_message_queued", text: "↻ Lead tick",
      autoAction: true });
    return true;
  }

  var control = conversationControl.attachCoopConversationControl({
    sm: sm,
    sendToSession: function () {},
    onIngressDrained: scheduleLeadTick,
  });
  var queue = queueModule.attachProjectUserMessageQueue({
    sm: sm,
    coopControl: control,
    sdk: {
      // Production startQuery is async and does not replace queryInstance until
      // provider setup finishes. Preserve that timing in this regression.
      startQuery: function (target, text) { starts.push(text); },
      pushMessage: function (target, text) {
        if (!options.allowPush) throw new Error("foreground turns must start separately");
        pushes.push(text);
      },
    },
    sendToSession: function () {},
    onProcessingChanged: function () {},
    onUserMessageDispatched: function () { return ""; },
    ensureProjectAccessForSession: function () { return null; },
  });

  function finalize(activeQuery) {
    streamFinalize.finalizeStream({
      session: session,
      query: activeQuery,
      abortController: session.abortController,
      clearInteractiveToolWaits: function () {},
      sm: sm,
      sendAndRecord: function (target, item) { target.history.push(item); },
      opts: {
        getAutoContinueSetting: function () { return false; },
        reconcileQueuedUserMessages: function () { return queue.flushCoopIngress(session); },
      },
      rateLimitResumeLabel: "↻ Auto-continued",
    });
  }

  function startLeadTick(name) {
    session.scheduledMessage = null;
    session.history.push({ type: "scheduled_message_sent" },
      { type: "user_message", text: "↻ Lead tick", autoAction: true, synthetic: true });
    session.queryInstance = query(name);
    session.isProcessing = true;
    session.abortController = { abort: function () {} };
    return session.queryInstance;
  }

  return {
    control: control,
    finalize: finalize,
    leadTickCount: function () { return leadTicks; },
    pushes: pushes,
    queue: queue,
    session: session,
    starts: starts,
    startLeadTick: startLeadTick,
  };
}

test("owner ingress dispatches through an idle reusable Codex query", function () {
  var h = harness({ allowPush: true });
  var idleQuery = query("idle-codex");
  var owner = OWNER_MESSAGES[0];
  var ingressId = "coop:" + COOP_SESSION + ":" + owner.sequence;
  h.session.queryInstance = idleQuery;
  h.session.isProcessing = false;
  h.session.history.push({
    type: "user_message",
    text: owner.text,
    _ts: owner.at,
    coopIngressId: ingressId,
    coopIngressSequence: owner.sequence,
    coopIngressPending: true,
  });

  h.queue.dispatchPreparedToSdk(h.session, {
    coopIngress: true,
    ingressId: ingressId,
    ingressSequence: owner.sequence,
    finalText: owner.text,
    displayText: owner.text,
    images: null,
    pastes: null,
    imageCount: 0,
    clientMessageId: "owner-" + owner.sequence,
    intent: "chat",
  });

  assert.equal(h.session.pendingCoopIngress.length, 0);
  assert.equal(h.session.coopConversationIngress.activeIngressId, ingressId);
  assert.equal(h.session.isProcessing, true);
  assert.equal(h.session.queryInstance, idleQuery);
  assert.deepEqual(h.pushes, [owner.text]);
  assert.deepEqual(h.starts, []);
});

test("foreground drain wakes Lead through an idle resident Codex query", function () {
  var pushed = [];
  var started = [];
  var residentQuery = query("resident-codex");
  var session = {
    coopHome: true,
    storageId: COOP_SESSION,
    localId: "coop-home",
    history: [],
    isProcessing: false,
    queryInstance: residentQuery,
  };
  var sm = {
    sessions: new Map([[session.localId, session]]),
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    appendToSessionFile: function () {},
    sendAndRecord: function (target, item) { target.history.push(item); },
  };
  var messages = scheduledMessages.attachProjectScheduledMessages({
    sm: sm,
    sdk: {
      pushMessage: function (target, text) { pushed.push(text); },
      startQuery: function (target, text) { started.push(text); },
      autoResumeAllowed: function () { return true; },
    },
    sendToSession: function () {},
    hydrateImageRefs: function (item) { return item; },
    loadImagesForSdk: function () { return []; },
    onProcessingChanged: function () {},
    ensureProjectAccessForSession: function () { return null; },
  });
  var wake = cleanupRuntime.createLeadWakeHandler({
    projectSlug: "lead",
    sm: sm,
    hasPendingWork: function () { return true; },
    scheduleMessage: messages.scheduleMessage,
    now: function () { return 1_000_000; },
  });
  var control = conversationControl.attachCoopConversationControl({
    sm: sm,
    sendToSession: function () {},
    onIngressDrained: function () {
      return wake({ leadMode: true }, { force: true });
    },
  });
  var ingressId = "coop:" + COOP_SESSION + ":533";

  session.history.push({ type: "user_message", coopIngressId: ingressId });
  control.markDispatched(session, ingressId);
  session.history.push({ type: "delta", text: "The foreground answer is complete." },
    { type: "done", code: 0 });
  control.markIdle(session);

  assert.equal(session.coopConversationIngress.activeIngressId, null);
  assert.equal(session.scheduledMessage.displayText, "↻ Lead tick");
  assert.equal(session.scheduledMessage.autoAction, true);
  assert.equal(session.queryInstance, residentQuery,
    "the scheduled continuation must retain the resident query before dispatch");

  assert.equal(messages.sendScheduledMessageNow(session), true,
    "the queued Lead tick must actually dispatch without another owner message");
  assert.equal(session.queryInstance, residentQuery);
  assert.equal(session.isProcessing, true);
  assert.equal(started.length, 0, "dispatch must not replace the resident query");
  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /Staff, verify, close, and advance safe work/);
  assert.equal(session.history[session.history.length - 1].text, "↻ Lead tick");
  assert.equal(session.history[session.history.length - 1].autoAction, true);
});

test("a completed Lead tick does not masquerade as drained owner ingress", function () {
  var drained = [];
  var session = {
    coopHome: true,
    storageId: COOP_SESSION,
    localId: "coop-home",
    history: [],
    isProcessing: false,
  };
  var control = conversationControl.attachCoopConversationControl({
    sm: {
      saveSessionFile: function () {},
      broadcastSessionList: function () {},
    },
    sendToSession: function () {},
    onIngressDrained: function (target, ingressId) {
      drained.push({ session: target, ingressId: ingressId });
    },
  });

  control.markIdle(session);
  assert.equal(drained.length, 0,
    "an automatic Lead turn has no owner ingress to resume from");

  var ingressId = "coop:" + COOP_SESSION + ":534";
  control.markDispatched(session, ingressId);
  control.markIdle(session);
  assert.deepEqual(drained, [{ session: session, ingressId: ingressId }]);
});

test("owner ingress 254-256 preempts each Lead tick before background work resumes", function () {
  var h = harness();
  var activeTick = h.startLeadTick("initial-lead-tick");

  OWNER_MESSAGES.forEach(function (owner, index) {
    var ingressId = "coop:" + COOP_SESSION + ":" + owner.sequence;
    h.session.history.push({
      type: "user_message",
      text: owner.text,
      _ts: owner.at,
      coopIngressId: ingressId,
      coopIngressSequence: owner.sequence,
      coopIngressPending: true,
    });
    h.queue.dispatchPreparedToSdk(h.session, {
      coopIngress: true,
      ingressId: ingressId,
      ingressSequence: owner.sequence,
      finalText: owner.text,
      displayText: owner.text,
      images: null,
      pastes: null,
      imageCount: 0,
      clientMessageId: "owner-" + owner.sequence,
      intent: "chat",
    });

    // handleStreamEnd clears isProcessing and invokes onTurnDone while the old
    // query is still owned. Dispatching here lets that old query's finally
    // block erase the new owner's processing state.
    h.session.isProcessing = false;
    assert.equal(h.queue.flushCoopIngress(h.session), false,
      "owner " + owner.sequence + " must wait for the interrupted tick to finalize");
    h.finalize(activeTick);

    assert.equal(h.session.coopConversationIngress.activeIngressId, ingressId);
    assert.equal(h.session.isProcessing, true);
    assert.equal(h.leadTickCount(), index,
      "a Lead tick cannot be queued before owner " + owner.sequence + " gets a turn");
    assert.equal(h.starts.length, index + 1);

    var ownerQuery = query("owner-" + owner.sequence);
    h.session.queryInstance = ownerQuery;
    h.session.history.push({ type: "delta", text: "Owner-facing answer " + owner.sequence },
      { type: "done", code: 0 });
    h.session.isProcessing = false;
    h.queue.flushCoopIngress(h.session);
    h.finalize(ownerQuery);

    if (index < OWNER_MESSAGES.length - 1) {
      assert.equal(h.leadTickCount(), index + 1);
      activeTick = h.startLeadTick("lead-tick-after-" + owner.sequence);
    }
  });

  assert.deepEqual(h.starts, OWNER_MESSAGES.map(function (owner) { return owner.text; }));
  assert.deepEqual(h.session.history.filter(function (item) {
    return item.type === "user_message" &&
      (item.text === "↻ Lead tick" || item.coopIngressSequence);
  }).map(function (item) {
    return item.text === "↻ Lead tick" ? item.text : "owner:" + item.coopIngressSequence;
  }), ["↻ Lead tick", "owner:254", "↻ Lead tick", "owner:255", "↻ Lead tick", "owner:256"]);
  assert.deepEqual(h.session.history.filter(function (item) {
    return item.type === "delta";
  }).map(function (item) { return item.text; }),
    ["Owner-facing answer 254", "Owner-facing answer 255", "Owner-facing answer 256"]);
});
