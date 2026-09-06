var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var config = require("../lib/config");
var createManager = require("../lib/sessions").createSessionManager;
var proactive = require("../lib/coop-proactive-review");
var wakeModule = require("../lib/coop-self-cleanup-runtime");
var scheduled = require("../lib/project-scheduled-messages");
var ledger = require("../lib/lead-ledger");
var topics = require("../lib/coop-topic-index");
var leadMode = require("../lib/lead-mode");
var PROJECT = "11111111-1111-5111-8111-111111111111";
var NOW = 1750000000000;

function fixture(t) {
  fs.rmSync(path.join(config.CONFIG_DIR, "lead"), { recursive: true, force: true });
  assert.equal(leadMode.setLeadMode({ enabled: true, multiUser: false }).ok, true);
  var cwd = fs.mkdtempSync(path.join(config.CONFIG_DIR, "proactive-"));
  var managerOptions = { cwd: cwd, slug: "lead", projectId: "system-lead", send: function () {} };
  var sm = createManager(managerOptions);
  var home = sm.createSessionRaw({ coopHome: true });
  var starts = [];
  var managers = [sm];
  var now = NOW;
  var api;
  function attach() {
    api = scheduled.attachProjectScheduledMessages({ sm: sm, sdk: {
      startQuery: function (session, text) { starts.push(text); },
      pushMessage: function (session, text) { starts.push(text); },
    }, sendToSession: function () {}, hydrateImageRefs: function (item) { return item; },
    onProcessingChanged: function () {}, ensureProjectAccessForSession: function () {} });
  }
  attach();
  function wake() { return wakeModule.createLeadWakeHandler({ projectSlug: "lead", sm: sm,
    scheduleMessage: api.scheduleMessage, now: function () { return now; },
    hasPendingWork: function () { return false; } }); }
  t.after(function () { managers.forEach(function (manager) { manager.sessions.forEach(function (session) {
    if (session.scheduledMessage) clearTimeout(session.scheduledMessage.timer);
  }); }); });
  return { sm: function () { return sm; }, home: function () { return home; }, api: function () { return api; },
    starts: starts, wake: wake, advance: function (ms) { now += ms; },
    select: function () { return proactive.select({ sm: sm, now: now }); },
    restart: function () {
      var storageId = home.storageId;
      if (home.scheduledMessage) clearTimeout(home.scheduledMessage.timer);
      sm = createManager(managerOptions); managers.push(sm);
      home = Array.from(sm.sessions.values()).find(function (session) { return session.storageId === storageId; });
      attach();
    },
    discussion: function () {
      sm.sendAndRecord(home, { type: "user_message", text: "Discuss an annotation workflow for our webapp.", from: "owner" });
      sm.sendAndRecord(home, { type: "delta", text: "We need to understand who can approve annotations." });
      sm.sendAndRecord(home, { type: "done", code: 0 });
      var index = topics.getDefaultTopicIndex();
      assert.equal(index.ensureRetro(home).ok, true);
      return index;
    } };
}

test("an empty execution backlog still wakes Coop for discovery and a separate operating review", function (t) {
  var h = fixture(t);
  assert.equal(h.wake()({ leadMode: true }), true);
  var first = h.home().scheduledMessage.coopProactiveReview;
  assert.equal(first.kind, "discovery");
  assert.equal(h.api().sendScheduledMessageNow(h.home()), true);
  assert.match(h.starts[0], /configured sources/);
  h.sm().sendAndRecord(h.home(), { type: "done", code: 0 });
  assert.equal(h.wake()({ leadMode: true }), true);
  assert.equal(h.home().scheduledMessage.coopProactiveReview.kind, "self_review");
  h.api().sendScheduledMessageNow(h.home());
  h.sm().sendAndRecord(h.home(), { type: "done", code: 0 });
  h.restart();
  assert.equal(h.wake()({ leadMode: true }), false, "unchanged inventory is not an endless wake loop");
});

test("a real canonical discussion is found, survives schedule reload, and receives its review finding", function (t) {
  var h = fixture(t);
  var index = h.discussion();
  assert.equal(h.wake()({ leadMode: true }), true);
  var review = h.home().scheduledMessage.coopProactiveReview;
  assert.equal(review.kind, "thread");
  assert.ok(index.resolve(review.topicRef).topic.turnRefs.length);
  h.restart();
  h.api().restoreScheduledMessageTimers();
  assert.ok(h.home().scheduledMessage);
  assert.equal(h.api().sendScheduledMessageNow(h.home()), true);
  assert.match(h.starts[0], /canonical conversation/);
  assert.match(h.starts[0], /permitted web research/);
  assert.ok(h.starts[0].includes(JSON.stringify(review)), "the exact agenda reaches the provider after restart");
  var updates = require("../lib/coop-owner-updates");
  var refs = updates.pending(h.sm(), h.home());
  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, "review");
  assert.equal(updates.publish(h.sm(), h.home(), { replyId: "review-finding",
    text: "We still need to decide who approves an annotation.", feedbackEventIds: [refs[0].eventId] }).ok, true);
  var view = h.sm().getHistoryView(h.home());
  assert.equal(updates.indexesForTopic(view, review.topicRef).length, 1);
  assert.deepEqual(updates.indexesForTopic(view, { topicId: "unrelated" }), []);
  assert.equal(ledger.readEvents().filter(function (event) { return event.type === "lead_tick_wake"; }).length, 1,
    "restoring a scheduled review does not claim another wake or completed result");
});

test("parked and closed discussions do not become work-seeking targets", function (t) {
  var h = fixture(t);
  var index = h.discussion();
  var review = h.select();
  assert.equal(review.kind, "thread");
  assert.equal(index.setThreadState(review.topicRef, "parked").ok, true);
  assert.notEqual(h.select().kind, "thread");
  assert.equal(index.reopen(review.topicRef).ok, true);
  assert.equal(index.close(review.topicRef).ok, true);
  assert.notEqual(h.select().kind, "thread");
});

test("current resident coordinators are found even when there is no staffing capacity", function (t) {
  var h = fixture(t);
  var root = require("../lib/coop-control-plane").ensureProjectCoordinator(h.sm(), { projectId: PROJECT }, "Webapp",
    { projectId: "system-lead", sessionStorageId: h.home().storageId });
  var review = h.select();
  assert.equal(review.kind, "coordinator");
  assert.equal(review.sessionRef.sessionStorageId, root.storageId);
  var decisions = require("../lib/lead-loop").leadTick({ proactiveReview: review,
    inFlight: [{ item: { id: "already-running" } }], capacity: 1, now: NOW, lastStandupAt: NOW });
  assert.equal(decisions[0].action, "proactive_review");
  assert.ok(decisions.some(function (item) { return item.action === "wait" && /at capacity/.test(item.reason); }));
  assert.equal(decisions.some(function (item) { return item.action === "staff"; }), false);
  var limited = require("../lib/lead-loop").leadTick({ proactiveReview: review, ownerContinuationScope: [] });
  assert.equal(limited.some(function (item) { return item.action === "proactive_review"; }), false);
});

test("unchanged evidence backs off across reload while a changed Thread becomes due sooner", function (t) {
  var h = fixture(t);
  var index = h.discussion();
  var first = h.select();
  function record(review, at) { ledger.appendEvent({ type: "lead_tick_wake", proactiveReview: review }, { now: at }); }
  record(first, NOW);
  // Consume the two other due areas using the real selector, never feed it the selected answer.
  record(h.select(), NOW); record(h.select(), NOW);
  assert.equal(h.select(), null);
  h.advance(15 * 60000);
  var repeated = h.select();
  assert.equal(repeated.key, first.key);
  record(repeated, NOW + 15 * 60000);
  h.restart();
  h.advance(15 * 60000);
  assert.equal(h.select(), null, "the next unchanged retry has doubled to thirty minutes");
  assert.equal(index.rename(first.topicRef, "Clarify annotation approval authority").ok, true);
  assert.equal(h.select().key, first.key);
  assert.notEqual(h.select().evidenceDigest, first.evidenceDigest);
});

test("Lead OFF and owner ingress cancel a queued proactive review before provider submission", function (t) {
  var h = fixture(t);
  assert.equal(h.wake()({ leadMode: false }), false);
  assert.equal(h.wake()({ leadMode: true }), true);
  assert.equal(leadMode.setLeadMode({ enabled: false, multiUser: false }).ok, true);
  h.restart();
  assert.equal(h.api().sendScheduledMessageNow(h.home()), false);
  assert.equal(h.starts.length, 0);
  assert.equal(leadMode.setLeadMode({ enabled: true, multiUser: false }).ok, true);
  assert.equal(h.wake()({ leadMode: true }), true);
  h.home().pendingCoopIngress = [{ ingressId: "new-owner-message" }];
  assert.equal(h.api().sendScheduledMessageNow(h.home()), false);
  assert.equal(h.starts.length, 0);
});

test("a failed durable schedule cannot start a review or claim a wake receipt", function (t) {
  var h = fixture(t);
  h.sm().sendAndRecord = function () { return false; };
  assert.equal(h.wake()({ leadMode: true }), false);
  assert.equal(h.home().scheduledMessage, undefined);
  assert.equal(ledger.readEvents().length, 0);
  assert.equal(h.starts.length, 0);
});

test("merged source Threads retire from the agenda and queued reviews recheck lifecycle before starting", function (t) {
  var h = fixture(t);
  var index = h.discussion();
  assert.equal(h.wake()({ leadMode: true }), true);
  var source = h.home().scheduledMessage.coopProactiveReview.topicRef;
  var created = index.createTopic({ title: "Annotation approvals", topicId: "annotation-approvals" });
  assert.equal(created.ok, true);
  var target = { topicId: "annotation-approvals" };
  assert.equal(index.merge(target, [source]).ok, true);
  assert.equal(index.load().topics[source.topicId].status, "merged");
  h.restart();
  assert.equal(h.api().sendScheduledMessageNow(h.home()), false);
  assert.equal(h.starts.length, 0, "a stale scheduled review cannot act on a merged-away conversation");
  assert.deepEqual(h.select().topicRef, target);
  assert.equal(index.setThreadState(target, "parked").ok, true);
  assert.notEqual(h.select().kind, "thread", "neither the parked target nor its merged source remains eligible");
});

test("the learning agenda discovers actual recorded owner decisions and preserves their exact ingress references", function (t) {
  var h = fixture(t);
  var ingressId = "coop:" + h.home().storageId + ":1";
  h.sm().sendAndRecord(h.home(), { type: "user_message", text: "For this project, review accessibility before polishing animation.",
    from: "owner", coopIngressId: ingressId });
  var requests = require("../lib/coop-owner-requests").getDefaultOwnerRequests();
  requests.record({ ingressId: ingressId, ingressSequence: 1,
    requestRef: { projectId: "system-lead", sessionStorageId: h.home().storageId, eventIndex: 0 },
    sessionRef: { projectId: "system-lead", sessionStorageId: h.home().storageId } });
  var review = h.select();
  assert.equal(review.kind, "learning");
  assert.deepEqual(review.ingressIds, [ingressId]);
  assert.match(proactive.promptFor(review), /remember_owner_preference with exact observed evidence/);
  assert.equal(requests.get(ingressId).response.state, "unanswered", "selecting a review is not an answer or learned preference");
});

test("real append and fallback-rename failures leave no recoverable review and permit a later durable retry", function (t) {
  var h = fixture(t);
  assert.equal(h.sm().saveSessionFile(h.home(), { durable: true }), true);
  var file = path.join(h.sm().sessionsDir, h.home().storageId + ".jsonl");
  var append = fs.appendFileSync;
  var rename = fs.renameSync;
  var failures = [];
  function ioError() { var error = new Error("injected review storage failure"); error.code = "EIO"; return error; }
  try {
    fs.appendFileSync = function (target) {
      if (String(target) === file) { failures.push("append"); throw ioError(); }
      return append.apply(fs, arguments);
    };
    fs.renameSync = function (from, to) {
      if (String(to) === file) { failures.push("rename"); throw ioError(); }
      return rename.apply(fs, arguments);
    };
    assert.equal(h.wake()({ leadMode: true }), false);
  } finally { fs.appendFileSync = append; fs.renameSync = rename; }
  assert.deepEqual(failures, ["append", "rename"]);
  assert.equal(h.home().history.some(function (item) { return item.type === "scheduled_message_queued"; }), false);
  assert.equal(fs.readFileSync(file, "utf8").includes("scheduled_message_queued"), false);
  h.api().restoreScheduledMessageTimers();
  assert.equal(h.home().scheduledMessage, undefined);
  assert.equal(ledger.readEvents().length, 0);
  h.restart();
  assert.equal(h.wake()({ leadMode: true }), true);
  assert.equal(h.api().sendScheduledMessageNow(h.home()), true);
  assert.equal(h.starts.length, 1);
});

test("a failed replacement preserves the existing scheduled message and its live timer", function (t) {
  var h = fixture(t);
  h.api().scheduleMessage(h.home(), "Existing owner reminder", Date.now() + 60000);
  var previous = h.home().scheduledMessage;
  var sendAndRecord = h.sm().sendAndRecord;
  h.sm().sendAndRecord = function (session, item) { session.history.push(item); return false; };
  assert.equal(h.api().scheduleMessage(h.home(), "Failed replacement", Date.now() + 60000), false);
  h.sm().sendAndRecord = sendAndRecord;
  assert.equal(h.home().scheduledMessage, previous);
  assert.equal(previous.timer._destroyed, false);
  assert.equal(h.home().history.some(function (item) { return item.text === "Failed replacement"; }), false);
  assert.equal(h.api().sendScheduledMessageNow(h.home()), true);
  assert.deepEqual(h.starts, ["Existing owner reminder"]);
});
