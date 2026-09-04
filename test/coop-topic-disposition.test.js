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
    // Pre-revision records project as revision 1: a real first record.
    revision: 1,
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

test("owner disposition passes the acting socket to the production-shaped work-state callback", function () {
  var h = harness();
  try {
    seedLegacyIndex(h, { "historical-a": legacyTopic("historical-a") });
    var session = legacySession();
    h.index.ensureDispositionBackfill(session);
    var harnessed = connectionHarness(h, session);
    var ownerSocket = { isOwner: true };
    var actorSeen = null;
    function ledgerTopicBindings(topicRef, metadata, ws) {
      if (!ws) throw new ReferenceError("ws is not defined");
      actorSeen = ws;
      return [];
    }
    // Mirrors the injected server callback: binding evidence is resolved
    // against the acting socket before the stale-state check is evaluated.
    harnessed.ctx.computeCoopTopicWorkState = function (topicRef, metadata, ws) {
      return topicState.projectedTopicState(topicRef, {
        tasks: session.orchestrationTasks,
        bindings: ledgerTopicBindings(topicRef, metadata, ws),
        metadata: metadata,
        foreground: { isProcessing: false, topicRef: null },
      }).workState;
    };

    assert.doesNotThrow(function () {
      assert.equal(topicConnection.handleCoopMessage(harnessed.ctx, ownerSocket, {
        type: "coop_topic_disposition", requestId: "actor-context",
        topicRef: { topicId: "historical-a" }, verb: "accept_done",
        expectedState: "needs_input",
      }), true);
    });
    assert.equal(actorSeen, ownerSocket);
    assert.equal(harnessed.sent[0].type, "coop_topic_disposition_result");
    assert.equal(harnessed.sent[0].requestId, "actor-context");
    assert.equal(harnessed.sent[0].ok, true);
    assert.equal(harnessed.sent[0].disposition.status, "done");
  } finally { h.cleanup(); }
});

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

// --- review findings P1-1/P1-3/P2-4/P2-5 regressions --------------------------

test("non-owner management mutations are denied with zero writes", function () {
  // Mirrors the reviewer's NON_OWNER_CLOSE_WRITES probe: a lead-project viewer
  // that is NOT the canonical owner could previously close/reopen topics
  // because management checked only the project slug.
  var h = harness();
  try {
    seedLegacyIndex(h, { "historical-a": legacyTopic("historical-a") });
    var session = legacySession();
    h.index.ensureDispositionBackfill(session);
    var harnessed = connectionHarness(h, session);
    var before = JSON.stringify(h.index.load());

    ["coop_topic_close", "coop_topic_reopen", "coop_topic_rename"].forEach(function (type) {
      harnessed.sent.length = 0;
      assert.equal(topicConnection.handleTopicMessage(harnessed.ctx, { isOwner: false }, {
        type: type, topicRef: { topicId: "historical-a" }, title: "Leaked",
      }, {
        isCoopClient: function () { return true; },
        globalProjectionProvider: function (ctx) { return ctx.getGlobalCoopProjection; },
        topicIndexForContext: function () { return h.index; },
        visibleProjects: function () { return {}; },
      }), true);
      assert.equal(harnessed.sent[0].ok, false, type + " must be denied");
      assert.equal(harnessed.sent[0].code, "access_denied");
    });
    assert.equal(JSON.stringify(h.index.load()), before, "zero writes on denial");

    // Fail closed: no owner check wired at all also denies.
    var noCheck = connectionHarness(h, session);
    delete noCheck.ctx.isCoopTopicOwner;
    noCheck.sent.length = 0;
    topicConnection.handleCoopMessage(noCheck.ctx, { isOwner: true }, {
      type: "coop_topic_close", topicRef: { topicId: "historical-a" },
    });
    assert.equal(noCheck.sent[0].code, "access_denied");
    assert.equal(JSON.stringify(h.index.load()), before);

    // The read-only projection_request stays available to any lead viewer.
    var reader = connectionHarness(h, session);
    reader.sent.length = 0;
    topicConnection.handleCoopMessage(reader.ctx, { isOwner: false }, { type: "coop_topic_projection_request" });
    assert.equal(reader.sent[0].ok, true, "projection stays readable");
  } finally { h.cleanup(); }
});

test("a resent request id writes once and returns the recorded outcome, across restart", function () {
  // Mirrors the reviewer's duplicate keep_waiting probe, which wrote twice.
  var h = harness();
  try {
    seedLegacyIndex(h, { "historical-a": legacyTopic("historical-a") });
    h.index.ensureDispositionBackfill(legacySession());

    var first = h.index.applyTopicDisposition({ topicId: "historical-a" }, {
      verb: "keep_waiting", requestId: "req-dup",
    });
    assert.equal(first.ok, true);
    var recordAfterFirst = JSON.stringify(h.index.load().topics["historical-a"].ownerDisposition);

    var resent = h.index.applyTopicDisposition({ topicId: "historical-a" }, {
      verb: "keep_waiting", requestId: "req-dup",
    });
    assert.equal(resent.ok, true);
    assert.equal(resent.duplicate, true);
    assert.deepEqual(resent.disposition, first.disposition, "the recorded outcome is replayed");
    assert.equal(JSON.stringify(h.index.load().topics["historical-a"].ownerDisposition),
      recordAfterFirst, "one write, one effective decision");

    // Restart-safe: the dedup log is persisted in the index file itself.
    var restarted = topics.createTopicIndex({ file: h.index.file, now: function () { return 999; } });
    var afterRestart = restarted.applyTopicDisposition({ topicId: "historical-a" }, {
      verb: "keep_waiting", requestId: "req-dup",
    });
    assert.equal(afterRestart.duplicate, true);
    assert.equal(JSON.stringify(restarted.load().topics["historical-a"].ownerDisposition), recordAfterFirst);

    // A conflicting reuse of the id against a DIFFERENT topic is an error, not
    // a replay of the other topic's result.
    seedLegacyIndex(h, { "historical-b": legacyTopic("historical-b") });
    var conflict = h.index.applyTopicDisposition({ topicId: "historical-b" }, {
      verb: "keep_waiting", requestId: "req-dup",
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "request_conflict");
  } finally { h.cleanup(); }
});

test("a same-state decision against a superseded revision is stale", function () {
  // The three-word state label alone cannot distinguish "the record I saw"
  // from "a newer record that happens to read the same"; the revision can.
  var h = harness();
  try {
    seedLegacyIndex(h, { "historical-a": legacyTopic("historical-a") });
    h.index.ensureDispositionBackfill(legacySession());
    // Backfill record is revision 1.
    assert.equal(h.index.load().topics["historical-a"].ownerDisposition.revision, 1);

    // Tab A decides while Tab B still renders revision 1.
    var applied = h.index.applyTopicDisposition({ topicId: "historical-a" }, {
      verb: "keep_waiting", requestId: "tab-a", expectedRevision: 1,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.disposition.revision, 2);

    // Tab B's decision -- same state label, older revision -- is stale.
    var stale = h.index.applyTopicDisposition({ topicId: "historical-a" }, {
      verb: "keep_waiting", requestId: "tab-b", expectedRevision: 1,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "stale_disposition");
    assert.equal(stale.currentRevision, 2);
    assert.equal(h.index.load().topics["historical-a"].ownerDisposition.revision, 2, "no write");

    // A decision without expectedRevision (legacy client) still applies.
    var legacy = h.index.applyTopicDisposition({ topicId: "historical-a" }, {
      verb: "accept_done", requestId: "tab-c",
    });
    assert.equal(legacy.ok, true);
    assert.equal(legacy.disposition.revision, 3);
  } finally { h.cleanup(); }
});

test("a successful decision fans the projection out to every owner viewer", function () {
  // Mirrors the reviewer's cross-client finding: only the deciding socket was
  // refreshed. With the injected viewer refresher, the server-side fan-out
  // (the same one the action queue uses) is invoked instead.
  var h = harness();
  try {
    seedLegacyIndex(h, { "historical-a": legacyTopic("historical-a") });
    var session = legacySession();
    h.index.ensureDispositionBackfill(session);
    var harnessed = connectionHarness(h, session);
    var fanouts = 0;
    harnessed.ctx.refreshCoopTopicViewers = function () { fanouts++; };

    topicConnection.handleCoopMessage(harnessed.ctx, { isOwner: true }, {
      type: "coop_topic_disposition", requestId: "fan-1", topicRef: { topicId: "historical-a" },
      verb: "accept_done", expectedState: "needs_input",
    });
    assert.equal(harnessed.sent[0].ok, true);
    assert.equal(fanouts, 1, "all viewers refreshed, not just the deciding socket");

    // A deduplicated resend changed nothing and fans out nothing.
    topicConnection.handleCoopMessage(harnessed.ctx, { isOwner: true }, {
      type: "coop_topic_disposition", requestId: "fan-1", topicRef: { topicId: "historical-a" },
      verb: "accept_done", expectedState: "done",
    });
    assert.equal(fanouts, 1);

    // Management mutations fan out through the same seam.
    topicConnection.handleCoopMessage(harnessed.ctx, { isOwner: true }, {
      type: "coop_topic_close", topicRef: { topicId: "historical-a" },
    });
    var closeResult = harnessed.sent.filter(function (m) { return m.type === "coop_topic_result"; }).pop();
    assert.equal(closeResult.ok, true);
    assert.equal(fanouts, 2);
  } finally { h.cleanup(); }
});

test("closing a completed topic requests archival of its linked Coop session", function () {
  var h = harness();
  try {
    seedLegacyIndex(h, { "historical-a": legacyTopic("historical-a") });
    var session = legacySession();
    h.index.ensureDispositionBackfill(session);
    var harnessed = connectionHarness(h, session);
    var archived = [];
    harnessed.ctx.archiveCompletedCoopTopicSessions = function (topicRef) {
      archived.push(topicRef);
    };

    topicConnection.handleCoopMessage(harnessed.ctx, { isOwner: true }, {
      type: "coop_topic_close", topicRef: { topicId: "historical-a" },
    });

    assert.equal(h.index.resolve({ topicId: "historical-a" }, true).topic.status, "closed");
    assert.deepEqual(archived, [{ topicId: "historical-a" }]);
  } finally { h.cleanup(); }
});

test("all-abandoned linked work is not evidence and leaves the owner an action", function () {
  // Mirrors the reviewer's dead-end finding: dismissed/cancelled tasks were
  // counted like completed work awaiting acceptance, but the action queue
  // excludes them and the review panel hid task-derived sources -- Needs input
  // with no available owner action anywhere.
  var abandoned = topicState.coopTopicState({ topicId: "t" }, {
    tasks: [
      { taskId: "a", status: "dismissed", coopTopicRef: { topicId: "t" } },
      { taskId: "b", status: "cancelled", coopTopicRef: { topicId: "t" } },
    ],
  });
  assert.equal(abandoned.state, "needs_input");
  assert.equal(abandoned.awaitingAcceptance, undefined, "nothing to accept");
  assert.equal(abandoned.stateSource, "task_abandoned", "topic-scoped review applies");

  // An existing owner disposition decides an all-abandoned topic.
  var decided = topicState.coopTopicState({ topicId: "t" }, {
    tasks: [{ taskId: "a", status: "dismissed", coopTopicRef: { topicId: "t" } }],
    metadata: { ownerDisposition: { status: "done", source: "owner_accept_done", at: 5 } },
  });
  assert.equal(decided.state, "done");
  assert.equal(decided.stateSource, "owner_disposition:owner_accept_done");

  // A closed all-abandoned topic reads Done with close provenance.
  var closed = topicState.coopTopicState({ topicId: "t" }, {
    tasks: [{ taskId: "a", status: "cancelled", coopTopicRef: { topicId: "t" } }],
    metadata: { status: "closed" },
  });
  assert.equal(closed.state, "done");
  assert.equal(closed.stateSource, "topic_closed");

  // One abandoned among live work stays live evidence.
  assert.equal(topicState.coopTopicState({ topicId: "t" }, {
    tasks: [
      { taskId: "a", status: "dismissed", coopTopicRef: { topicId: "t" } },
      { taskId: "b", status: "running", coopTopicRef: { topicId: "t" } },
    ],
  }).state, "working");

  // The review panel offers the topic-scoped verbs for task_abandoned.
  var reviewSource = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coop-topic-review.js"), "utf8");
  assert.match(reviewSource, /task_abandoned/);
});

test("a closed Done topic replays only its own indexed history on selection and reconnect", function () {
  // Mirrors the reviewer's closed-replay probe: selection admitted closed
  // topics (includeClosedTopics) but the follow-up resolve did not, so the
  // indexes came back null and the replay fell through to the FULL canonical
  // history on initial selection, and to an empty indexed replay on reconnect.
  var h = harness();
  try {
    var closedTopic = legacyTopic("closed-done", "closed");
    // Real legacy-shaped closed membership: a proven turn span plus an event
    // ref, both on the canonical session.
    closedTopic.turnRefs = [{ sessionStorageId: "canonical-topic-home", startEventIndex: 0, endEventIndex: 2 }];
    closedTopic.eventRefs = [{ sessionStorageId: "canonical-topic-home", eventIndex: 0 }];
    seedLegacyIndex(h, { "closed-done": closedTopic });
    var session = legacySession({ localId: "local-1" });
    var harnessed = connectionHarness(h, session);
    var deps = {
      isCoopClient: function () { return true; },
      globalProjectionProvider: function (ctx) { return ctx.getGlobalCoopProjection; },
    };

    // Reconnect path: the socket already carries the selection.
    var ws = { isOwner: true, _clayCoopTopicRef: { topicId: "closed-done" }, _clayCoopProjectRef: null };
    var replay = topicConnection.selectedTopicReplay(harnessed.ctx, ws, session, deps);
    assert.equal(replay.ok, true, "a closed topic selection survives reconnect");
    assert.ok(Array.isArray(replay.options.eventIndexes), "indexed replay, not full canonical");
    assert.ok(replay.options.eventIndexes.length > 0, "the topic's own history is not empty");
    assert.ok(replay.options.eventIndexes.every(function (i) { return i >= 0 && i < session.history.length; }));

    // Initial selection path: coop_topic_select for the closed topic.
    var replays = [];
    harnessed.ctx.sm.switchSession = function (localId, target, hydrate, options) { replays.push(options); };
    harnessed.ctx.getProjectList = function () { return []; };
    var freshWs = { isOwner: true };
    assert.equal(topicConnection.handleTopicMessage(harnessed.ctx, freshWs, {
      type: "coop_topic_select", topicRef: { topicId: "closed-done" }, historyScope: "topic",
    }, deps), true);
    var selected = harnessed.sent.filter(function (m) { return m.type === "coop_topic_selected"; }).pop();
    assert.equal(selected.ok, true);
    assert.equal(replays.length, 1);
    assert.equal(replays[0].scope, "topic");
    assert.ok(Array.isArray(replays[0].eventIndexes), "initial selection replays indexed history");
    assert.deepEqual(replays[0].eventIndexes, replay.options.eventIndexes,
      "initial selection and reconnect replay the same membership");
  } finally { h.cleanup(); }
});
