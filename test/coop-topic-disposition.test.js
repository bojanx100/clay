var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var assert = require("node:assert/strict");

var topics = require("../lib/coop-topic-index");
var disposition = require("../lib/coop-topic-disposition");
var topicConnection = require("../lib/coop-topic-connection");
var topicProjectionModule = require("../lib/coop-topic-projection");
var topicState = require("../lib/coop-topic-state");

// Revision 26: every projected topic carries exactly one evidence-based state.
// These tests use LEGACY-SHAPED fixtures matching real production data: topics
// with empty relatedExecutions, orchestration tasks with NO coopTopicRef, and
// no disposition records at all -- the exact shape in which all 44 live topics
// rendered blank.

var OWNER = "a66ce4a1";

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-topic-disposition-"));
  var clock = 100;
  var index = topics.createTopicIndex({
    file: path.join(dir, "lead", "coop-topic-index.json"),
    now: function () { clock++; return clock; },
  });
  return {
    index: index,
    dir: dir,
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function legacyTopic(id, status) {
  return {
    topicRef: { topicId: id },
    title: "Topic " + id,
    keywords: [],
    group: { kind: "uncategorised" },
    source: "automatic",
    status: status || "open",
    createdAt: 1,
    updatedAt: 1,
    eventRefs: [],
    turnRefs: [],
    // Production shape: zero durable links on every historical topic.
    relatedExecutions: [],
  };
}

// The canonical Coop session as production had it: real history, real task
// records, but not one task carrying a coopTopicRef.
function legacySession(extra) {
  return Object.assign({
    coopHome: true,
    storageId: "canonical-topic-home",
    history: [
      { type: "user_message", text: "A real owner turn", from: OWNER, fromName: "Admin", clientMessageId: "cm-owner" },
      { type: "delta_replace", text: "Final assistant reply" },
      { type: "done" },
    ],
    orchestrationTasks: [
      { taskId: "legacy-1", status: "completed", coopTopicRef: null, resolutionSummary: "done things" },
      { taskId: "legacy-2", status: "dismissed" },
    ],
  }, extra || {});
}

function seedLegacyIndex(h, topicsById) {
  var state = h.index.load();
  state.canonicalSessionStorageId = "canonical-topic-home";
  Object.keys(topicsById).forEach(function (id) { state.topics[id] = topicsById[id]; });
  h.index.save();
}

// --- the backfill ------------------------------------------------------------

test("the backfill defaults every unlinked open topic to a durable Needs input record", function () {
  var h = harness();
  try {
    seedLegacyIndex(h, {
      "historical-a": legacyTopic("historical-a"),
      "historical-b": legacyTopic("historical-b"),
      "was-closed": legacyTopic("was-closed", "closed"),
      "was-merged": legacyTopic("was-merged", "merged"),
    });
    var result = h.index.ensureDispositionBackfill(legacySession());
    assert.equal(result.ok, true);
    assert.equal(result.report.defaulted, 2, "both unlinked open topics get a record");
    assert.equal(result.report.linked, 0, "no production task carried a coopTopicRef");

    var state = h.index.load();
    var record = state.topics["historical-a"].ownerDisposition;
    assert.equal(record.status, "needs_input");
    assert.equal(record.source, "unlinked_historical");
    assert.ok(record.at > 0);
    assert.equal(record.schemaVersion, disposition.DISPOSITION_SCHEMA_VERSION);
    // Closed is already terminal Done evidence and merged never projects:
    // neither gets a record.
    assert.equal(state.topics["was-closed"].ownerDisposition, undefined);
    assert.equal(state.topics["was-merged"].ownerDisposition, undefined);
    // The exactly-once stamp is persisted on the index itself.
    assert.equal(state.dispositionBackfill.schemaVersion, disposition.DISPOSITION_SCHEMA_VERSION);
    assert.equal(state.dispositionBackfill.defaulted, 2);
  } finally { h.cleanup(); }
});

test("a topic with a genuinely linked task is left to live derivation", function () {
  var h = harness();
  try {
    seedLegacyIndex(h, { "linked-topic": legacyTopic("linked-topic"), "unlinked-topic": legacyTopic("unlinked-topic") });
    var session = legacySession({
      orchestrationTasks: [{ taskId: "t1", status: "running", coopTopicRef: { topicId: "linked-topic" } }],
    });
    var result = h.index.ensureDispositionBackfill(session);
    assert.equal(result.report.linked, 1);
    assert.equal(result.report.defaulted, 1);
    var state = h.index.load();
    assert.equal(state.topics["linked-topic"].ownerDisposition, undefined,
      "live task evidence needs no disposition record");
    assert.equal(state.topics["unlinked-topic"].ownerDisposition.source, "unlinked_historical");
  } finally { h.cleanup(); }
});

test("the backfill is exactly-once across repeat calls and restart", function () {
  var h = harness();
  try {
    seedLegacyIndex(h, { "historical-a": legacyTopic("historical-a") });
    var session = legacySession();
    assert.equal(h.index.ensureDispositionBackfill(session).ok, true);
    var saved = fs.readFileSync(h.index.file, "utf8");
    // Second call on the same instance: stamped, so a strict no-op.
    var again = h.index.ensureDispositionBackfill(session);
    assert.equal(again.alreadyComplete, true);
    assert.equal(fs.readFileSync(h.index.file, "utf8"), saved, "no rewrite on a completed stamp");
    // Restart: a new index instance over the same file must also be a no-op.
    var restarted = topics.createTopicIndex({ file: h.index.file, now: function () { return 999; } });
    assert.equal(restarted.ensureDispositionBackfill(session).alreadyComplete, true);
    assert.equal(fs.readFileSync(h.index.file, "utf8"), saved);
  } finally { h.cleanup(); }
});

test("the backfill fails closed on an unavailable canonical history without burning the stamp", function () {
  var h = harness();
  try {
    seedLegacyIndex(h, { "historical-a": legacyTopic("historical-a") });
    var empty = legacySession({ history: [] });
    var result = h.index.ensureDispositionBackfill(empty);
    assert.equal(result.ok, false);
    assert.equal(result.code, "canonical_history_unavailable");
    var state = h.index.load();
    assert.equal(state.dispositionBackfill, undefined, "no stamp on a failed run");
    assert.equal(state.topics["historical-a"].ownerDisposition, undefined);
    // The real session arriving later still runs the migration.
    assert.equal(h.index.ensureDispositionBackfill(legacySession()).ok, true);
    assert.equal(h.index.load().topics["historical-a"].ownerDisposition.source, "unlinked_historical");
  } finally { h.cleanup(); }
});

test("the backfill never overwrites an explicit owner decision", function () {
  var h = harness();
  try {
    var accepted = legacyTopic("owner-accepted");
    accepted.ownerDisposition = { status: "done", source: "owner_accept_done", at: 50, note: "", schemaVersion: 1 };
    seedLegacyIndex(h, { "owner-accepted": accepted });
    var result = h.index.ensureDispositionBackfill(legacySession());
    assert.equal(result.report.kept, 1);
    assert.equal(h.index.load().topics["owner-accepted"].ownerDisposition.source, "owner_accept_done",
      "the owner's decision survives the migration");
  } finally { h.cleanup(); }
});

// --- states through the real projection path ---------------------------------

function projectWithState(h, session) {
  return h.index.project({
    canAccessProject: function () { return true; },
    computeTopicState: function (topicRef, metadata) {
      return topicState.projectedTopicState(topicRef, {
        tasks: session.orchestrationTasks,
        metadata: metadata,
        foreground: { isProcessing: false, topicRef: null },
      });
    },
  });
}

test("after the backfill no projected topic is blank and closed topics read Done", function () {
  var h = harness();
  try {
    seedLegacyIndex(h, {
      "historical-a": legacyTopic("historical-a"),
      "linked-working": legacyTopic("linked-working"),
      "resolved-closed": legacyTopic("resolved-closed", "closed"),
    });
    var session = legacySession({
      orchestrationTasks: [{ taskId: "t1", status: "running", coopTopicRef: { topicId: "linked-working" } }],
    });
    h.index.ensureDispositionBackfill(session);
    var projection = projectWithState(h, session);
    var byId = {};
    projection.groups.forEach(function (group) {
      group.topics.forEach(function (topic) { byId[topic.topicRef.topicId] = topic; });
    });
    assert.equal(byId["historical-a"].workState, "needs_input");
    assert.equal(byId["historical-a"].stateSource, "owner_disposition:unlinked_historical");
    assert.equal(byId["linked-working"].workState, "working");
    assert.equal(byId["linked-working"].stateSource, "task_working");
    assert.equal(byId["resolved-closed"].workState, "done");
    assert.equal(byId["resolved-closed"].stateSource, "topic_closed");
    Object.keys(byId).forEach(function (id) {
      assert.notEqual(byId[id].workState, "", id + " must never be blank");
    });
  } finally { h.cleanup(); }
});

test("projection metadata carries the disposition as inspectable provenance", function () {
  var topic = legacyTopic("historical-a");
  topic.ownerDisposition = { status: "needs_input", source: "unlinked_historical", at: 42, note: "", schemaVersion: 1 };
  var metadata = topicProjectionModule.topicProjectionMetadata(topic);
  assert.deepEqual(metadata.ownerDisposition, {
    status: "needs_input", source: "unlinked_historical", at: 42, note: "",
  });
  // A malformed record does not project.
  topic.ownerDisposition = { status: "working" };
  assert.equal(topicProjectionModule.topicProjectionMetadata(topic).ownerDisposition, null);
});

// --- explicit owner decisions ------------------------------------------------

test("applyTopicDisposition records each verb durably and validates notes", function () {
  var h = harness();
  try {
    seedLegacyIndex(h, { "historical-a": legacyTopic("historical-a") });
    h.index.ensureDispositionBackfill(legacySession());

    assert.equal(h.index.applyTopicDisposition({ topicId: "historical-a" }, { verb: "promote" }).code, "unknown_decision");
    assert.equal(h.index.applyTopicDisposition({ topicId: "missing" }, { verb: "accept_done" }).code, "topic_not_found");
    assert.equal(h.index.applyTopicDisposition({ topicId: "historical-a" }, { verb: "request_changes", note: "  " }).code, "note_required");

    var accepted = h.index.applyTopicDisposition({ topicId: "historical-a" }, { verb: "accept_done" });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.disposition.status, "done");
    assert.equal(accepted.disposition.source, "owner_accept_done");

    // Durable: a restarted index reads the decision back.
    var restarted = topics.createTopicIndex({ file: h.index.file, now: function () { return 999; } });
    assert.equal(restarted.load().topics["historical-a"].ownerDisposition.status, "done");

    var reopened = h.index.applyTopicDisposition({ topicId: "historical-a" }, { verb: "reopen" });
    assert.equal(reopened.disposition.status, "needs_input");
    assert.equal(reopened.disposition.source, "owner_reopen");

    var changes = h.index.applyTopicDisposition({ topicId: "historical-a" }, {
      verb: "request_changes", note: "Split the anchor\u202e work\u2028into its own topic please",
    });
    assert.equal(changes.ok, true);
    // The note is sanitised: unicode line separators and bidi controls gone.
    assert.equal(changes.disposition.note.indexOf("\u2028"), -1);
    assert.equal(changes.disposition.note.indexOf("\u202e"), -1);
    assert.equal(changes.disposition.note, "Split the anchor work into its own topic please");
  } finally { h.cleanup(); }
});

// --- the owner decision end-to-end through the real WS handler ---------------

function connectionHarness(h, session) {
  var sent = [];
  var sessions = new Map();
  sessions.set("local-1", session);
  var ctx = {
    slug: "lead",
    sendTo: function (ws, msg) { sent.push(msg); },
    sm: { sessions: sessions, saveSessionFile: function () {} },
    coopTopicIndex: h.index,
    getProjectList: function () { return []; },
    getGlobalCoopProjection: function () {
      return { type: "global_coop_projection", projects: [], topics: [] };
    },
    isCoopTopicOwner: function (ws) { return !!(ws && ws.isOwner); },
    computeCoopTopicWorkState: function (topicRef, metadata) {
      return topicState.projectedTopicState(topicRef, {
        tasks: session.orchestrationTasks,
        metadata: metadata,
        foreground: { isProcessing: false, topicRef: null },
      }).workState;
    },
  };
  return { ctx: ctx, sent: sent };
}

test("a topic decision is owner-only, stale-checked, applied once and broadcast", function () {
  var h = harness();
  try {
    seedLegacyIndex(h, { "historical-a": legacyTopic("historical-a") });
    var session = legacySession();
    h.index.ensureDispositionBackfill(session);
    var harnessed = connectionHarness(h, session);

    // Not the owner: read-only viewers of the Coop project cannot decide.
    assert.equal(topicConnection.handleCoopMessage(harnessed.ctx, { isOwner: false }, {
      type: "coop_topic_disposition", topicRef: { topicId: "historical-a" },
      verb: "accept_done", expectedState: "needs_input",
    }), true);
    assert.equal(harnessed.sent[0].type, "coop_topic_disposition_result");
    assert.equal(harnessed.sent[0].ok, false);
    assert.equal(harnessed.sent[0].code, "access_denied");
    assert.equal(h.index.load().topics["historical-a"].ownerDisposition.status, "needs_input",
      "a rejected decision changes nothing");

    // Stale: the owner decided against a row that no longer shows that state.
    harnessed.sent.length = 0;
    assert.equal(topicConnection.handleCoopMessage(harnessed.ctx, { isOwner: true }, {
      type: "coop_topic_disposition", topicRef: { topicId: "historical-a" },
      verb: "accept_done", expectedState: "working",
    }), true);
    assert.equal(harnessed.sent[0].ok, false);
    assert.equal(harnessed.sent[0].code, "stale_state");
    assert.equal(harnessed.sent[0].currentState, "needs_input");

    // The genuine decision: applied, durable, acknowledged, projection pushed.
    harnessed.sent.length = 0;
    assert.equal(topicConnection.handleCoopMessage(harnessed.ctx, { isOwner: true }, {
      type: "coop_topic_disposition", requestId: "r-1", topicRef: { topicId: "historical-a" },
      verb: "accept_done", expectedState: "needs_input",
    }), true);
    assert.equal(harnessed.sent[0].ok, true);
    assert.equal(harnessed.sent[0].requestId, "r-1");
    assert.equal(harnessed.sent[0].disposition.status, "done");
    assert.equal(harnessed.sent[1].type, "global_coop_projection",
      "the updated projection follows the ack");
    assert.equal(h.index.load().topics["historical-a"].ownerDisposition.status, "done");

    // Decisions are single-topic by construction: no array form is accepted.
    harnessed.sent.length = 0;
    assert.equal(topicConnection.handleCoopMessage(harnessed.ctx, { isOwner: true }, {
      type: "coop_topic_disposition", topicRef: [{ topicId: "historical-a" }],
      verb: "reopen", expectedState: "done",
    }), true);
    assert.equal(harnessed.sent[0].ok, false);
  } finally { h.cleanup(); }
});
