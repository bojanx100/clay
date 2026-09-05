var test = require("node:test");
var assert = require("node:assert/strict");
var scheduledMessages = require("../lib/project-scheduled-messages");

var INGRESS = "coop:871a194b-8879-40f7-a1fe-656e48e722af:187";

function harness() {
  var resumed = [];
  var started = [];
  var pushed = [];
  var sm = {
    sendAndRecord: function (session, item) { session.history.push(item); },
    appendToSessionFile: function () {},
    broadcastSessionList: function () {},
    saveSessionFile: function () {},
    sessions: new Map(),
  };
  var messages = scheduledMessages.attachProjectScheduledMessages({
    sm: sm,
    sdk: {
      startQuery: function (session, text) { started.push({ session: session, text: text }); },
      pushMessage: function (session, text) { pushed.push({ session: session, text: text }); },
      autoResumeAllowed: function () { return true; },
    },
    sendToSession: function () {},
    hydrateImageRefs: function (item) { return item; },
    loadImagesForSdk: function () { return []; },
    onProcessingChanged: function () {},
    ensureProjectAccessForSession: function () { return null; },
    resumeCoopIngress: function (session, ingressId) {
      resumed.push(ingressId);
      session.coopConversationIngress.activeIngressId = ingressId;
      return true;
    },
  });
  return { messages: messages, pushed: pushed, resumed: resumed, started: started, sm: sm };
}

test("an auto-resume persists and restores its exact Coop ingress after the idle drain", function () {
  var ctx = harness();
  var session = {
    localId: 42,
    history: [],
    coopConversationIngress: { activeIngressId: INGRESS },
    isProcessing: false,
  };

  ctx.messages.scheduleMessage(session, "continue", Date.now(), "continue", "↻ Resuming", { autoAction: true });
  assert.equal(session.history[0].coopContinuationIngressId, INGRESS);

  session.coopConversationIngress.activeIngressId = null;
  assert.equal(ctx.messages.sendScheduledMessageNow(session), true);
  assert.deepEqual(ctx.resumed, [INGRESS]);
  assert.equal(session.history[2].coopContinuationIngressId, INGRESS);
  assert.equal(session.history[2].autoAction, true);
  assert.equal(ctx.started.length, 1);
});

test("a restored auto-resume timer retains its ingress across a daemon restart", function () {
  var ctx = harness();
  var session = {
    localId: 43,
    history: [{
      type: "scheduled_message_queued",
      text: "↻ Resuming after restart",
      autoAction: true,
      coopContinuationIngressId: INGRESS,
      resetsAt: Date.now() + 60000,
    }],
    coopConversationIngress: { activeIngressId: null },
    isProcessing: false,
  };
  ctx.sm.sessions.set(session.localId, session);

  ctx.messages.restoreScheduledMessageTimers();
  assert.equal(session.scheduledMessage.coopIngressId, INGRESS);
  assert.equal(ctx.messages.sendScheduledMessageNow(session), true);
  assert.deepEqual(ctx.resumed, [INGRESS]);
  assert.equal(session.history[2].coopContinuationIngressId, INGRESS);
});

test("a scheduled Lead wake keeps typed automation provenance on its response turn", function () {
  var ctx = harness();
  var session = { localId: 44, history: [], isProcessing: false };

  ctx.messages.scheduleMessage(session, "lead tick", Date.now(),
    "Run one Lead tick now.", "↻ Lead tick", { autoAction: true });
  assert.equal(ctx.messages.sendScheduledMessageNow(session), true);

  assert.equal(session.history[2].type, "user_message");
  assert.equal(session.history[2].autoAction, true);
  assert.equal(session.history[2].synthetic, true);
  assert.equal(session.history[2].coopContinuationIngressId, undefined);
});

test("a fenceless controlled scheduled turn stays queued until recovery reattaches authority", function () {
  var ctx = harness();
  var session = {
    localId: 45,
    storageId: "restored-coop-home",
    history: [],
    isProcessing: false,
    coopHome: true,
    coopIncarnation: { incarnationId: "inc-restored", epoch: 3 },
  };

  ctx.messages.scheduleMessage(session, "continue", Date.now(),
    "Continue after control recovery.", "↻ Resuming after restart", { autoAction: true });
  assert.equal(ctx.messages.sendScheduledMessageNow(session), false);

  assert.equal(session.history.length, 1, "the queued record remains the last durable event");
  assert.equal(session.history[0].type, "scheduled_message_queued");
  assert.ok(session.scheduledMessage, "the in-memory retry remains queued");
  assert.equal(session.isProcessing, false);
  assert.equal(ctx.started.length, 0);
  assert.equal(ctx.pushed.length, 0);
  clearTimeout(session.scheduledMessage.timer);
});

test("a scheduled turn is cancelled when its source is compacted before the timer fires", function () {
  var ctx = harness();
  var session = { localId: 47, history: [], isProcessing: false };

  ctx.messages.scheduleMessage(session, "continue", Date.now(),
    "Continue after restart.", "↻ Resuming after restart", { autoAction: true });
  session.closedAt = Date.now();
  session.compactedIntoLocalId = 48;

  assert.equal(ctx.messages.sendScheduledMessageNow(session), false);
  assert.deepEqual(session.history.map(function (item) { return item.type; }),
    ["scheduled_message_queued", "scheduled_message_cancelled"]);
  assert.equal(session.scheduledMessage, null);
  assert.equal(session.isProcessing, false);
  assert.equal(ctx.started.length, 0);
  assert.equal(ctx.pushed.length, 0);
});

test("startup does not restore a scheduled turn for a terminal controlled execution", function () {
  var ctx = harness();
  var session = {
    localId: 48,
    history: [{
      type: "scheduled_message_queued",
      text: "↻ Resuming after restart",
      autoAction: true,
      resetsAt: Date.now() - 1000,
    }],
    isProcessing: false,
    orchestrationPolicy: {
      portfolioExecution: {
        status: "needs_input",
        control: {
          executionId: "exec-terminal",
          incarnationId: "inc-terminal",
          epoch: 2,
          role: "coordinator",
          authorityId: "auth-terminal",
        },
      },
    },
  };
  ctx.sm.sessions.set(session.localId, session);

  ctx.messages.restoreScheduledMessageTimers();

  assert.equal(session.scheduledMessage, undefined);
  assert.equal(ctx.started.length, 0);
  assert.equal(ctx.pushed.length, 0);
});

test("a scheduled continuation reuses an idle resident query instead of deferring forever", function () {
  var ctx = harness();
  var resident = { name: "resident-codex" };
  var session = {
    localId: 46,
    history: [],
    isProcessing: false,
    queryInstance: resident,
  };

  ctx.messages.scheduleMessage(session, "continue", Date.now(),
    "Continue the interrupted Lead reconciliation.",
    "↻ Continuing after rate limit", { autoAction: true });
  assert.equal(ctx.messages.sendScheduledMessageNow(session), true);

  assert.equal(session.queryInstance, resident);
  assert.equal(session.scheduledMessage, null);
  assert.equal(session.isProcessing, true);
  assert.deepEqual(ctx.pushed.map(function (entry) { return entry.text; }),
    ["Continue the interrupted Lead reconciliation."]);
  assert.equal(ctx.started.length, 0,
    "the reusable query must not be replaced with a second provider query");
  assert.equal(session.history[2].text, "↻ Continuing after rate limit");
  assert.equal(session.history[2].autoAction, true);
});

test("a recovered provider turn cancels its queued restart fallback", function () {
  var ctx = harness();
  var session = {
    localId: 49,
    history: [],
    interruptedByRestart: true,
    restartAutoContinueQueued: true,
    isProcessing: false,
  };

  ctx.messages.scheduleMessage(session, "continue", Date.now(),
    "Resume the interrupted turn.", "↻ Resuming after restart", { autoAction: true });
  session.isProcessing = true;

  assert.equal(ctx.messages.sendScheduledMessageNow(session), false);
  assert.deepEqual(session.history.map(function (item) { return item.type; }),
    ["scheduled_message_queued", "scheduled_message_cancelled"]);
  assert.equal(session.scheduledMessage, null);
  assert.equal(session.interruptedByRestart, false);
  assert.equal(session.restartAutoContinueQueued, false);
  assert.equal(ctx.started.length, 0);
  assert.equal(ctx.pushed.length, 0);
});

test("an explicit reopen resumes an old restart interruption without enabling unattended startup", function () {
  var ctx = harness();
  var staleTimestamp = Date.now() - (2 * 60 * 60 * 1000);
  var automatic = {
    localId: 50,
    history: [],
    interruptedByRestart: true,
    restartResumeEligible: true,
    restartInterruptedAt: staleTimestamp,
  };
  var reopened = Object.assign({}, automatic, { localId: 51, history: [] });

  ctx.messages.autoResumeRestartSession(automatic);
  assert.equal(automatic.scheduledMessage, undefined);

  ctx.messages.autoResumeRestartSession(reopened, { userInitiated: true });
  assert.equal(reopened.history[0].type, "scheduled_message_queued");
  assert.equal(reopened.history[0].text, "↻ Resuming after restart");
  clearTimeout(reopened.scheduledMessage.timer);
});

test("a scheduled Coop send retains its captured scope without Main stale refs", function () {
  var ctx = harness();
  var session = { localId: 45, history: [], isProcessing: false, coopHome: true };

  ctx.messages.scheduleMessage(session, "general", Date.now(), null, null, {
    coopRouting: { scope: "main", topicRef: { topicId: "stale" } },
  });
  assert.equal(ctx.messages.sendScheduledMessageNow(session), true);
  assert.equal(session.history[2].coopComposerScope, "main");
  assert.equal(session.history[2].coopTopicRef, undefined);

  session.isProcessing = false;
  ctx.messages.scheduleMessage(session, "threaded", Date.now(), null, null, {
    coopRouting: { scope: "topic", topicRef: { topicId: "exact-thread" }, projectRef: { projectId: "p" } },
  });
  assert.equal(ctx.messages.sendScheduledMessageNow(session), true);
  assert.equal(session.history[5].coopComposerScope, "topic");
  assert.deepEqual(session.history[5].coopTopicRef, { topicId: "exact-thread" });
});
