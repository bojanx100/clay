var test = require("node:test");
var assert = require("node:assert/strict");
var scheduledMessages = require("../lib/project-scheduled-messages");

var INGRESS = "coop:871a194b-8879-40f7-a1fe-656e48e722af:187";

function harness() {
  var resumed = [];
  var started = [];
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
  return { messages: messages, resumed: resumed, started: started, sm: sm };
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
