// Closing a Thread through a sanctioned path must actually retire it.
//
// threadState is the primary lifecycle axis and the owner's Threads rail filters
// on it alone (sidebar-coop-topic-model.coopTopicSections keeps every record
// whose state is not handed_off or closed). Two paths used to close a record by
// assigning topic.status directly and never advancing threadState:
//
//   * coop-topic-closure.applyClosureProposal -- the owner's confirmed bulk sweep
//   * coop-topic-index-migrations.reconcileTopicDisposition -- the daemon's
//     ledger reconciliation path
//
// A record closed either way read as closed everywhere that looks at status
// while still rendering as a live Thread row, forever -- and could never be
// swept again, because selection requires status === "open". The existing
// healthy closed records did not come from these paths; they were back-filled by
// the migration normalizer, which infers threadState from status only when
// threadState is absent or invalid, so any thread created since threadState
// existed stays damaged.
//
// These tests drive the REAL projection and the REAL sidebar model, because the
// bug was invisible to every assertion that only checked topic.status.

var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var assert = require("node:assert/strict");
var pathToFileURL = require("node:url").pathToFileURL;

var lifecycle = require("../lib/coop-thread-lifecycle");
var topics = require("../lib/coop-topic-index");
var closure = require("../lib/coop-topic-closure");
var topicConnection = require("../lib/coop-topic-connection");

function modulePath(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-thread-closure-retires-"));
  var tick = 1000;
  var index = topics.createTopicIndex({
    file: path.join(dir, "lead", "coop-topic-index.json"),
    now: function () { tick++; return tick; },
  });
  lifecycle.ensureIndex(index, function () { tick++; return tick; });
  return {
    dir: dir,
    index: index,
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// A thread as it exists AFTER threadState was introduced: status open with an
// already-valid threadState, so the migration normalizer's status -> threadState
// inference is skipped and cannot mask a missing advance.
function modernThread(index, id, title) {
  var state = index.load();
  state.topics[id] = {
    topicRef: { topicId: id },
    threadRef: { threadId: id },
    title: title,
    group: "uncategorised",
    status: "open",
    threadState: lifecycle.THREAD_STATES.EXPLORING,
    closeOutcome: null,
    hidden: false,
    mergedIntoThreadRef: null,
    origin: "owner",
    createdAt: 1000,
    updatedAt: 1000,
    threadStateUpdatedAt: 1000,
    eventRefs: [],
    turnRefs: [],
    relatedExecutions: [],
    keywords: [],
    explicitRoutes: 1,
  };
  index.save();
  return state.topics[id];
}

// The owner's Threads rail, built the way the client builds it: server
// projection -> buildTopicBuckets -> coopTopicSections.
async function threadsRail(index) {
  var model = await import(modulePath("sidebar-coop-topic-model.js"));
  var message = index.project({});
  var buckets = model.buildTopicBuckets(message, [], function (ref) {
    return ref && String(ref.projectId || "") || "";
  });
  var sections = model.coopTopicSections({ projects: [], allTopics: buckets.all });
  var threads = sections.filter(function (section) { return section.kind === "threads"; })[0];
  return (threads ? threads.topics : []).map(function (topic) {
    return model.topicRefKey(topic.topicRef);
  });
}

test("the bulk-closure sweep retires the thread it closes", async function (t) {
  var ctx = harness();
  t.after(ctx.cleanup);
  var id = "auto-sweep0000000000000001";
  modernThread(ctx.index, id, "Sweep me");

  assert.ok((await threadsRail(ctx.index)).includes(id),
    "a modern open thread should start in the Threads rail");

  var state = ctx.index.load();
  var proposal = closure.proposeClosures(state, { sessions: [], now: function () { return 2000; } });
  assert.ok(proposal.candidates.some(function (c) { return c.topicId === id; }),
    "the thread should be a closure candidate");
  var applied = closure.applyClosureProposal(state,
    { proposalId: proposal.proposalId, confirmed: true },
    { sessions: [], now: function () { return 3000; } });
  ctx.index.save();
  assert.equal(applied.closed >= 1, true);
  assert.ok((applied.closedTopicIds || []).includes(id));

  // The durable record, then the surface the owner actually looks at.
  var record = ctx.index.load().topics[id];
  assert.equal(record.status, "closed");
  assert.equal(record.threadState, lifecycle.THREAD_STATES.CLOSED,
    "a close must advance threadState, not just status");
  assert.equal(record.closeOutcome, lifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED);

  assert.equal((await threadsRail(ctx.index)).includes(id), false,
    "a swept thread must leave the Threads rail");
});

test("ledger reconciliation to closed retires the thread", async function (t) {
  var ctx = harness();
  t.after(ctx.cleanup);
  var id = "auto-reconcile00000000001";
  modernThread(ctx.index, id, "Reconcile me");

  assert.ok((await threadsRail(ctx.index)).includes(id));

  var reconciled = ctx.index.reconcileTopicDisposition({ topicId: id }, {
    requestId: "req-close-1", expectedStatus: "open", status: "closed",
    verb: "accept_done", note: "delivered",
  });
  assert.equal(reconciled.ok, true);

  var record = ctx.index.load().topics[id];
  assert.equal(record.status, "closed");
  assert.equal(record.threadState, lifecycle.THREAD_STATES.CLOSED,
    "reconciling status to closed must advance threadState");

  assert.equal((await threadsRail(ctx.index)).includes(id), false,
    "a reconciled-closed thread must leave the Threads rail");
});

test("a caller may name the close outcome, and not_pursuing hides the row", async function (t) {
  var ctx = harness();
  t.after(ctx.cleanup);
  var id = "auto-notpursuing000000001";
  modernThread(ctx.index, id, "Not pursuing this");

  var reconciled = ctx.index.reconcileTopicDisposition({ topicId: id }, {
    requestId: "req-close-2", expectedStatus: "open", status: "closed",
    verb: "accept_done", note: "superseded",
    closeOutcome: lifecycle.CLOSE_OUTCOMES.NOT_PURSUING,
  });
  assert.equal(reconciled.ok, true);
  var record = ctx.index.load().topics[id];
  assert.equal(record.closeOutcome, lifecycle.CLOSE_OUTCOMES.NOT_PURSUING);
  assert.equal(record.hidden, true, "not_pursuing suppresses the row entirely");
  assert.equal((await threadsRail(ctx.index)).includes(id), false);
});

// Regression: a closed -> closed reconciliation that only revises a note must
// not re-label the close. Defaulting the outcome unconditionally would rewrite
// not_pursuing as implemented_resolved and clear hidden, resurrecting a row the
// owner had deliberately suppressed.
test("reconciling an already-closed record preserves its close outcome", async function (t) {
  var ctx = harness();
  t.after(ctx.cleanup);
  var id = "auto-preserve00000000001";
  modernThread(ctx.index, id, "Already closed");
  ctx.index.setThreadState({ topicId: id }, lifecycle.THREAD_STATES.CLOSED,
    { closeOutcome: lifecycle.CLOSE_OUTCOMES.NOT_PURSUING });
  assert.equal(ctx.index.load().topics[id].hidden, true);

  var reconciled = ctx.index.reconcileTopicDisposition({ topicId: id }, {
    requestId: "req-note-1", expectedStatus: "closed", status: "closed",
    verb: "accept_done", note: "just a note",
  });
  assert.equal(reconciled.ok, true);
  var record = ctx.index.load().topics[id];
  assert.equal(record.closeOutcome, lifecycle.CLOSE_OUTCOMES.NOT_PURSUING);
  assert.equal(record.hidden, true);
});

// Reopening must not silently demote a handed-off thread to exploring: that is
// the same downgrade setThreadState refuses outright.
test("reconciling back to open keeps a handed-off thread handed off", async function (t) {
  var ctx = harness();
  t.after(ctx.cleanup);
  var id = "auto-handedoff0000000001";
  modernThread(ctx.index, id, "Handed off");
  ctx.index.linkExecution({ topicId: id },
    { sessionRef: { projectId: "system-lead", sessionStorageId: "exec-1" } });
  assert.equal(ctx.index.load().topics[id].threadState, lifecycle.THREAD_STATES.HANDED_OFF);
  ctx.index.setThreadState({ topicId: id }, lifecycle.THREAD_STATES.CLOSED,
    { closeOutcome: lifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED });

  var reconciled = ctx.index.reconcileTopicDisposition({ topicId: id }, {
    requestId: "req-reopen-1", expectedStatus: "closed", status: "open",
    verb: "reopen", note: "more work",
  });
  assert.equal(reconciled.ok, true);
  var record = ctx.index.load().topics[id];
  assert.equal(record.status, "open");
  assert.equal(record.threadState, lifecycle.THREAD_STATES.HANDED_OFF);
  assert.equal(record.closeOutcome, null);
});

test("a lifecycle transition repairs the status field even when its state already matches", function () {
  var handedOff = {
    status: "closed",
    threadState: lifecycle.THREAD_STATES.HANDED_OFF,
    closeOutcome: null,
    hidden: false,
    relatedExecutions: [{ sessionRef: { projectId: "project-a", sessionStorageId: "session-a" } }],
  };
  var reopened = lifecycle.applyRecordStatus(handedOff, "open", { now: function () { return 2000; } });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.changed, true);
  assert.equal(handedOff.status, "open");
  assert.equal(handedOff.threadState, lifecycle.THREAD_STATES.HANDED_OFF);

  var closed = {
    status: "open",
    threadState: lifecycle.THREAD_STATES.CLOSED,
    closeOutcome: lifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED,
    hidden: false,
  };
  var retired = lifecycle.applyRecordStatus(closed, "closed", {
    closeOutcome: lifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED,
    now: function () { return 3000; },
  });
  assert.equal(retired.ok, true);
  assert.equal(retired.changed, true);
  assert.equal(closed.status, "closed");
  assert.equal(closed.threadState, lifecycle.THREAD_STATES.CLOSED);
});

// The repair for records damaged before the fix landed.
test("healClosedThreadStates repairs damaged records and is idempotent", async function (t) {
  var ctx = harness();
  t.after(ctx.cleanup);
  var leaking = "auto-damaged000000000001";
  var parked = "auto-damagedparked000001";
  var healthy = "auto-healthy000000000001";
  modernThread(ctx.index, leaking, "Damaged exploring");
  modernThread(ctx.index, parked, "Damaged parked");
  modernThread(ctx.index, healthy, "Healthy closed");

  // Exactly the damage the old code wrote: status alone.
  var state = ctx.index.load();
  state.topics[leaking].status = "closed";
  state.topics[parked].status = "closed";
  state.topics[parked].threadState = lifecycle.THREAD_STATES.PARKED;
  ctx.index.save();
  ctx.index.setThreadState({ topicId: healthy }, lifecycle.THREAD_STATES.CLOSED,
    { closeOutcome: lifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED });

  var railBefore = await threadsRail(ctx.index);
  assert.ok(railBefore.includes(leaking), "a status-only close leaks into the rail");
  assert.ok(railBefore.includes(parked), "parked leaks too -- the rail filter is a denylist");
  assert.equal(railBefore.includes(healthy), false);

  var healed = ctx.index.healClosedThreadStates({
    closeOutcomes: (function () {
      var map = {};
      map[parked] = lifecycle.CLOSE_OUTCOMES.NOT_PURSUING;
      return map;
    })(),
  });
  assert.equal(healed.ok, true);
  assert.deepEqual(healed.healed.map(function (e) { return e.threadId; }).sort(),
    [leaking, parked].sort(), "only the damaged records are touched");
  assert.equal(ctx.index.load().topics[leaking].threadState, lifecycle.THREAD_STATES.CLOSED);
  assert.equal(ctx.index.load().topics[leaking].closeOutcome,
    lifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED);
  assert.equal(ctx.index.load().topics[parked].closeOutcome,
    lifecycle.CLOSE_OUTCOMES.NOT_PURSUING);

  var railAfter = await threadsRail(ctx.index);
  assert.equal(railAfter.includes(leaking), false);
  assert.equal(railAfter.includes(parked), false);

  // Re-running is a no-op, which is what makes it safe to ship to the owner.
  var again = ctx.index.healClosedThreadStates({});
  assert.equal(again.changed, false);
  assert.deepEqual(again.healed, []);
});

test("healClosedThreadStates leaves closed/handed_off alone unless asked", async function (t) {
  var ctx = harness();
  t.after(ctx.cleanup);
  var id = "auto-closedhandedoff0001";
  modernThread(ctx.index, id, "Closed while handed off");
  var state = ctx.index.load();
  state.topics[id].status = "closed";
  state.topics[id].threadState = lifecycle.THREAD_STATES.HANDED_OFF;
  ctx.index.save();

  var skipped = ctx.index.healClosedThreadStates({});
  assert.equal(skipped.changed, false);
  assert.deepEqual(skipped.skippedHandedOff, [id]);
  assert.equal(ctx.index.load().topics[id].threadState, lifecycle.THREAD_STATES.HANDED_OFF);

  var included = ctx.index.healClosedThreadStates({ includeHandedOff: true });
  assert.equal(included.changed, true);
  assert.equal(ctx.index.load().topics[id].threadState, lifecycle.THREAD_STATES.CLOSED);
});

// ---------------------------------------------------------------------------
// The side effects that make a close CORRECT, and the authority boundary.
//
// A close that retires the thread but skips these leaves linked owner requests
// unsettled, which is a silent ledger inconsistency and strictly worse than the
// cosmetic rail bug. These drive the real connection layer with spies rather
// than reasoning about the call sites.
// ---------------------------------------------------------------------------

function connectionHarness(index, session) {
  var sent = [];
  var sessions = new Map();
  sessions.set("local-1", session);
  var archived = [];
  var reconciledClosures = [];
  var ctx = {
    slug: "lead",
    sendTo: function (ws, msg) { sent.push(msg); },
    sm: { sessions: sessions, saveSessionFile: function () {} },
    coopTopicIndex: index,
    getProjectList: function () { return []; },
    getGlobalCoopProjection: function () {
      return { type: "global_coop_projection", projects: [], topics: [] };
    },
    isCoopTopicOwner: function (ws) { return !!(ws && ws.isOwner); },
    archiveCompletedCoopTopicSessions: function (topicRef) { archived.push(topicRef); },
    coopOwnerRequests: {
      list: function () { return []; },
      reconcileTopicClosure: function (topicRef) {
        reconciledClosures.push(topicRef);
        return { ok: true, settled: [], preserved: [], changed: false };
      },
    },
  };
  return { ctx: ctx, sent: sent, archived: archived, reconciledClosures: reconciledClosures };
}

function canonicalSession() {
  return {
    coopHome: true, storageId: "canonical-coop-threads", history: [], orchestrationTasks: [],
  };
}

test("closing a thread through coop_thread_state still archives and reconciles", async function (t) {
  var ctx = harness();
  t.after(ctx.cleanup);
  var id = "auto-sideeffects00000001";
  modernThread(ctx.index, id, "Side effects");
  var h = connectionHarness(ctx.index, canonicalSession());

  topicConnection.handleCoopMessage(h.ctx, { isOwner: true }, {
    type: "coop_thread_state", threadRef: { threadId: id },
    state: lifecycle.THREAD_STATES.CLOSED,
    closeOutcome: lifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED,
  });
  var result = h.sent.filter(function (m) { return m.type === "coop_thread_result"; }).pop();
  assert.equal(result.ok, true, "the owner close should succeed");

  assert.deepEqual(h.archived, [{ topicId: id }],
    "archiveCompletedTopicSessions must still run on the thread-state close path");
  assert.deepEqual(h.reconciledClosures, [{ topicId: id }],
    "reconcileClosedTopicRequests must still run on the thread-state close path");
  assert.equal(ctx.index.load().topics[id].threadState, lifecycle.THREAD_STATES.CLOSED);
  assert.equal((await threadsRail(ctx.index)).includes(id), false);
});

test("the confirmed bulk sweep still reconciles owner requests for every closed topic", function (t) {
  var ctx = harness();
  t.after(ctx.cleanup);
  var id = "auto-bulkeffects00000001";
  modernThread(ctx.index, id, "Bulk side effects");
  var session = canonicalSession();
  var h = connectionHarness(ctx.index, session);

  var proposed = topicConnection.handleCoopMessage(h.ctx, { isOwner: true },
    { type: "coop_topic_closure_propose" });
  assert.equal(proposed, true);
  var proposal = h.sent.filter(function (m) { return m.type === "coop_topic_closure_proposal"; }).pop();
  assert.equal(proposal.ok, true);
  assert.ok(proposal.candidates.some(function (c) { return c.topicId === id; }));

  topicConnection.handleCoopMessage(h.ctx, { isOwner: true }, {
    type: "coop_topic_closure_confirm", proposalId: proposal.proposalId, confirm: true,
  });
  var confirmed = h.sent.filter(function (m) { return m.type === "coop_topic_closure_result"; }).pop();
  assert.equal(confirmed.ok, true);
  assert.ok((confirmed.closedTopicIds || []).includes(id));

  assert.ok(h.reconciledClosures.some(function (ref) { return ref.topicId === id; }),
    "reconcileBulkClosureRequests must still settle owner requests for swept topics");
  assert.equal(ctx.index.load().topics[id].threadState, lifecycle.THREAD_STATES.CLOSED,
    "the sweep must retire the thread it closes");

  // PRE-EXISTING GAP, recorded here rather than left implicit: unlike the
  // single-topic and thread-state closes, the bulk sweep has never called
  // archiveCompletedCoopTopicSessions. This fix does not remove that call --
  // there was none -- and does not add it either, because doing so would change
  // owner-visible session archival behaviour beyond the bug being fixed. If the
  // owner wants sweeps to archive too, this assertion is the one to flip.
  assert.deepEqual(h.archived, [],
    "bulk sweep does not archive sessions (pre-existing; see comment)");
});

// The owner gate. setThreadState is deliberately gated on isOwnerSocket and the
// bulk sweep on the same owner check plus propose-then-confirm. Nothing in this
// fix may widen either: applyRecordStatus is a field-level helper, not a route
// from a socket to a close.
test("a non-owner socket cannot close a thread by any path this fix touches", function (t) {
  var ctx = harness();
  t.after(ctx.cleanup);
  var id = "auto-nonowner00000000001";
  modernThread(ctx.index, id, "Not yours");
  var h = connectionHarness(ctx.index, canonicalSession());
  var guest = { isOwner: false };

  topicConnection.handleCoopMessage(h.ctx, guest, {
    type: "coop_thread_state", threadRef: { threadId: id },
    state: lifecycle.THREAD_STATES.CLOSED,
    closeOutcome: lifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED,
  });
  var denied = h.sent.filter(function (m) { return m.type === "coop_thread_result"; }).pop();
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "access_denied");

  topicConnection.handleCoopMessage(h.ctx, guest, { type: "coop_topic_closure_propose" });
  var proposeDenied = h.sent.filter(function (m) {
    return m.type === "coop_topic_closure_proposal";
  }).pop();
  assert.equal(proposeDenied.ok, false);
  assert.equal(proposeDenied.code, "access_denied");

  topicConnection.handleCoopMessage(h.ctx, guest, {
    type: "coop_topic_closure_confirm", proposalId: "close-whatever", confirm: true,
  });
  var confirmDenied = h.sent.filter(function (m) {
    return m.type === "coop_topic_closure_result";
  }).pop();
  assert.equal(confirmDenied.ok, false);
  assert.equal(confirmDenied.code, "access_denied");

  var record = ctx.index.load().topics[id];
  assert.equal(record.status, "open", "nothing was closed");
  assert.equal(record.threadState, lifecycle.THREAD_STATES.EXPLORING);
  assert.deepEqual(h.archived, []);
});

// Confirming is still bound to the exact proposal id: a close cannot be driven
// without the propose step, and a stale id closes nothing.
test("bulk closure still requires confirming the exact proposed id", function (t) {
  var ctx = harness();
  t.after(ctx.cleanup);
  var id = "auto-staleproposal000001";
  modernThread(ctx.index, id, "Stale proposal");
  var h = connectionHarness(ctx.index, canonicalSession());

  topicConnection.handleCoopMessage(h.ctx, { isOwner: true }, {
    type: "coop_topic_closure_confirm", proposalId: "close-0000000000000000", confirm: true,
  });
  var result = h.sent.filter(function (m) { return m.type === "coop_topic_closure_result"; }).pop();
  assert.equal(result.ok, false);
  assert.equal(result.code, "closure_proposal_stale");
  assert.equal(ctx.index.load().topics[id].status, "open");
  assert.equal(ctx.index.load().topics[id].threadState, lifecycle.THREAD_STATES.EXPLORING);
});

// The authority boundary this fix must not touch. setThreadState stays the
// owner-gated entry point; applyRecordStatus is a field-level helper for callers
// that have already done their own gating, and it is not reachable from a socket.
test("applyRecordStatus refuses merged records and unclassified closes", function () {
  var merged = { status: "merged", threadState: lifecycle.THREAD_STATES.EXPLORING };
  assert.equal(lifecycle.applyRecordStatus(merged, "closed",
    { closeOutcome: lifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED }).code, "topic_merged");

  var thread = { status: "open", threadState: lifecycle.THREAD_STATES.EXPLORING };
  assert.equal(lifecycle.applyRecordStatus(thread, "closed", {}).code, "close_outcome_required");
  assert.equal(thread.status, "open", "a refused close changes nothing");

  assert.equal(lifecycle.applyRecordStatus(thread, "merged", {}).code, "invalid_thread_status");
});
