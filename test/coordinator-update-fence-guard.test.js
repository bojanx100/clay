// Proves a restored Coop coordinator that has lost its runtime execution fence
// stays queued instead of dispatching into a throw.
//
// A Coop-controlled session persists its control metadata but its fence is a
// runtime capability, so after a daemon restart fenceFor() throws
// COOP_CONTROL_FENCE_MISSING on the first line of startQueryInner -- outside that
// function's try/catch. dispatchCoordinatorUpdate had already appended a
// synthetic user_message and set isProcessing before calling startQuery, and it
// never handled the returned rejection. So every boot: one unhandled rejection,
// a session pinned at isProcessing forever, and one more history item appended.
// The coordinator session that triggered this had grown to 213,000 items.
var test = require("node:test");
var assert = require("node:assert/strict");

var attachTaskOrchestrator = require("../lib/project-task-orchestrator").attachTaskOrchestrator;

function testContext() {
  var sessions = new Map();
  var starts = [];
  var events = [];
  var appended = [];
  var nextId = 2;
  var sm = {
    sessions: sessions,
    getSession: function (id) { return sessions.get(id); },
    getProjectId: function () { return null; },
    createSessionRaw: function (opts) {
      var session = Object.assign({ localId: nextId++, history: [], isProcessing: false }, opts);
      sessions.set(session.localId, session);
      return session;
    },
    appendToSessionFile: function (session, obj) { appended.push({ session: session, obj: obj }); },
    saveSessionFile: function () { return true; },
    broadcastSessionList: function () {},
    hideSession: function (id) { sessions.get(id).hidden = true; },
    subscribeSession: function () {},
  };
  var api = attachTaskOrchestrator({
    crossProject: null,
    slug: "clay",
    sm: sm,
    sdk: {
      startQuery: function (session, prompt) {
        starts.push({ session: session, prompt: prompt });
        return { ok: true, submission: "submitted" };
      },
      pushMessage: function () {},
    },
    sendToSession: function (id, event) { events.push({ id: id, event: event }); },
    onProcessingChanged: function () {},
    ensureProjectAccessForSession: function () {},
    loadImagesForSdk: function (refs) { return refs; },
  });
  return { sm: sm, sessions: sessions, starts: starts, events: events, appended: appended, api: api };
}

// A coordinator restored from disk: it still carries the Coop control metadata
// (coopHome + coopIncarnation) but has no _coopExecutionFence, exactly the state
// the loader leaves behind after a restart.
function restoredCoopCoordinator(ctx) {
  var parent = {
    localId: 1,
    storageId: "coordinator-stable",
    title: "Coordinator",
    vendor: "codex",
    history: [],
    orchestrationTasks: [],
    isProcessing: false,
    coordinationMode: true,
    coopHome: true,
    coopIncarnation: { incarnationId: "inc-1", epoch: 3 },
    pendingCoordinatorUpdates: [{ text: "Worker finished task-1", queuedAt: Date.now() }],
  };
  ctx.sessions.set(parent.localId, parent);
  return parent;
}

test("a restored coordinator with no runtime fence keeps its update queued instead of throwing", function () {
  var ctx = testContext();
  var parent = restoredCoopCoordinator(ctx);

  var flushed = ctx.api.flushCoordinatorUpdates(parent);

  assert.equal(flushed, false, "the flush reports that it did not dispatch");
  assert.equal(ctx.starts.length, 0, "no query is started against a fenceless session");
  assert.equal(parent.isProcessing, false, "the session is not left pinned at processing");
  assert.equal(parent.history.length, 0, "no synthetic history item is appended");
  assert.equal(ctx.appended.length, 0, "nothing is written to the session file");
  assert.equal(parent.pendingCoordinatorUpdates.length, 1,
    "the pending update survives for delivery after re-admission");
});

test("a coordinator that is not Coop-controlled still dispatches normally", function () {
  var ctx = testContext();
  var parent = restoredCoopCoordinator(ctx);
  // No control metadata at all -> fenceFor() returns null and the historical
  // pass-through path applies. The guard must not block this.
  delete parent.coopHome;
  delete parent.coopIncarnation;

  var flushed = ctx.api.flushCoordinatorUpdates(parent);

  assert.equal(flushed, true, "the update is dispatched");
  assert.equal(ctx.starts.length, 1, "a query is started");
  assert.equal(ctx.starts[0].prompt, "Worker finished task-1");
  assert.equal(parent.isProcessing, true, "the session is marked processing");
  assert.equal(parent.pendingCoordinatorUpdates.length, 0, "the queue is drained");
});
