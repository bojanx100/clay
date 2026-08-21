// The open-work ledger's central promise: a Thread is the durable backlog
// entry and a session is only an execution attempt against it. Losing the
// attempt must never lose the ask. Only verified completion or an explicit
// owner closure settles an entry.

var test = require("node:test");
var assert = require("node:assert/strict");
var buildOwnerSidebar = require("../lib/coop-owner-sidebar-projection").buildOwnerSidebar;
var threadLedger = require("../lib/coop-owner-thread-ledger");
var clientTopicProjection = require("../lib/global-coop-topic-client");

var LEAD = "system-lead";
var PROJECT = "11111111-1111-5111-8111-111111111111";

function thread(id, extra) {
  return Object.assign({
    topicRef: { topicId: id },
    threadRef: { threadId: id },
    title: "Build the open-work ledger",
    status: "open",
    threadState: "handed_off",
    closeOutcome: null,
    relatedSessions: [],
    executionProjectRefs: [],
    updatedAt: 500,
  }, extra || {});
}

function session(id, topic, lifecycleState, extra) {
  return Object.assign({
    sessionRef: { projectId: PROJECT, sessionStorageId: id },
    title: id, role: "worker", controlRole: null,
    sessionPresent: true, hidden: false, lifecycleState: lifecycleState,
    coopTopicRefs: [{ topicId: topic }], portfolioBindings: [], updatedAt: 600,
  }, extra || {});
}

function request(sequence, topic, extra) {
  return Object.assign({
    ingressId: "coop:owner:" + sequence,
    ingressSequence: sequence,
    receivedAt: sequence * 10,
    updatedAt: sequence * 10,
    topicRef: { topicId: topic },
    requestRef: { projectId: LEAD, sessionStorageId: "coop-home", eventIndex: sequence },
    response: { state: "unanswered" },
    links: { coordinators: [], tasks: [], sessions: [] },
    projectRefs: [{ projectId: PROJECT }],
    state: "working",
    expectsExecution: true,
    outcome: null,
  }, extra || {});
}

function ids(entries) {
  return entries.map(function (entry) { return entry.entryId; });
}

test("a failed execution attempt leaves the Thread's entry open and visible", function () {
  var sidebar = buildOwnerSidebar({
    requests: [],
    topics: [thread("topic-failed")],
    sessions: [session("attempt-1", "topic-failed", "failed")],
    executionBindings: [],
  });
  assert.equal(sidebar.entries.length, 1, "the Thread is the durable backlog entry");
  assert.equal(sidebar.entries[0].status, "failed");
  assert.deepEqual(ids(sidebar.openWork), ["thread:topic-failed"],
    "a failed attempt is still open work the owner is owed");
  assert.equal(sidebar.counts.openWork, 1);
  assert.deepEqual(sidebar.landed, [], "a failed attempt is not landed work");
  assert.deepEqual(sidebar.dismissed, [], "a failed attempt is not a dismissal");
  assert.deepEqual(ids(sidebar.attention), ["thread:topic-failed"],
    "the entry stays on an owner-visible attention surface");
});

// The harder case, and the one that actually bit: the attempt did not merely
// fail, its session record is gone. Nothing in the reconciled session ledger
// mentions this work any more.
test("a vanished execution attempt still leaves the Thread's entry open", function () {
  var sidebar = buildOwnerSidebar({
    requests: [],
    topics: [thread("topic-gone")],
    sessions: [],
    executionBindings: [],
  });
  assert.deepEqual(ids(sidebar.openWork), ["thread:topic-gone"],
    "a dead session must not remove the Thread from the open-work view");
  assert.equal(sidebar.entries[0].status, "planned");
  assert.equal(sidebar.entries[0].reason,
    "Handed off with no execution attempt still on record",
    "the row reports the missing attempt instead of implying progress");
  assert.deepEqual(sidebar.entries[0].threadRef, { threadId: "topic-gone" },
    "the row stays navigable back to its Thread");
});

test("verified completion closes the entry", function () {
  var sidebar = buildOwnerSidebar({
    requests: [],
    topics: [thread("topic-done")],
    sessions: [session("attempt-1", "topic-done", "completed", {
      terminalOutcome: { status: "completed", at: 700, summary: "Ledger shipped",
        verification: "Targeted owner-ledger suite green" },
    })],
    executionBindings: [{ portfolioTaskId: "ledger", bindingRevision: 1,
      status: "completed", coopTopicRef: { topicId: "topic-done" } }],
  });
  assert.equal(sidebar.entries[0].status, "completed");
  assert.deepEqual(sidebar.openWork, [], "verified completion closes the entry");
  assert.equal(sidebar.counts.openWork, 0);
  assert.deepEqual(ids(sidebar.landed), ["thread:topic-done"],
    "the closed entry stays auditable rather than disappearing");
});

// A completion claim without concrete verification must not close the entry.
// This is the difference between "a session said it was done" and "the work is
// verified done", and it is why a failed suite cannot quietly land work.
test("an unverified completion claim does not close the entry", function () {
  var sidebar = buildOwnerSidebar({
    requests: [],
    topics: [thread("topic-claimed")],
    sessions: [session("attempt-1", "topic-claimed", "completed", {
      terminalOutcome: { status: "completed", at: 700, summary: "Think it works",
        verification: "not run" },
    })],
    executionBindings: [{ portfolioTaskId: "ledger", bindingRevision: 1,
      status: "completed", coopTopicRef: { topicId: "topic-claimed" } }],
  });
  assert.equal(sidebar.entries[0].status, "needs_owner");
  assert.deepEqual(ids(sidebar.openWork), ["thread:topic-claimed"],
    "an unverified claim leaves the ask open");
});

// Closing a Thread replaces `handed_off` with `closed`, so a closed Thread is
// recognised as work by its surviving dispatch evidence. `relatedExecutions`
// is append-only on the durable record, so a Thread that was really handed off
// still projects an execution project after closure.
function closedThread(id, closeOutcome) {
  var extra = { status: "closed", threadState: "closed",
    executionProjectRefs: [{ projectId: PROJECT }] };
  if (closeOutcome) extra.closeOutcome = closeOutcome;
  return thread(id, extra);
}

test("an explicit owner closure settles the entry either way", function () {
  var dropped = buildOwnerSidebar({
    requests: [],
    topics: [closedThread("topic-dropped", "not_pursuing")],
    sessions: [session("attempt-1", "topic-dropped", "failed")],
    executionBindings: [],
  });
  assert.equal(dropped.entries[0].status, "dismissed",
    "the owner deciding not to pursue closes the entry despite a failed attempt");
  assert.deepEqual(dropped.openWork, []);
  assert.deepEqual(ids(dropped.dismissed), ["thread:topic-dropped"],
    "the dropped ask stays auditable");
  assert.equal(dropped.entries[0].reason, "Owner is not pursuing this Thread");

  var resolved = buildOwnerSidebar({
    requests: [],
    topics: [closedThread("topic-resolved", "implemented_resolved")],
    sessions: [],
    executionBindings: [],
  });
  assert.equal(resolved.entries[0].status, "completed");
  assert.deepEqual(resolved.openWork, []);
  assert.deepEqual(ids(resolved.landed), ["thread:topic-resolved"]);
  assert.equal(resolved.entries[0].reason, "Owner closed this Thread as implemented");

});

// RETRACTED: the automated closure sweep used to write `status: "closed"` with
// no closeOutcome. It now records implemented_resolved. This fixture preserves
// the legacy status-only record contract: reading one as a dismissal would file
// the ask under a decision the owner never made.
test("a Thread closed without a recorded owner outcome stays open work", function () {
  var sidebar = buildOwnerSidebar({
    requests: [], topics: [closedThread("topic-swept", null)],
    sessions: [], executionBindings: [],
  });
  assert.equal(sidebar.entries[0].status, "planned",
    "a sweep is not an owner decision, so the ask is still owed");
  assert.deepEqual(ids(sidebar.openWork), ["thread:topic-swept"]);
  assert.deepEqual(sidebar.dismissed, [],
    "the entry is not filed under a dismissal the owner never made");
});

// One coordinator session legitimately serves several Threads. Publishing its
// portfolio task as Thread identity would union two unrelated asks into one
// row and silently delete an open backlog entry.
test("two Threads sharing one execution session stay two entries", function () {
  var sidebar = buildOwnerSidebar({
    requests: [],
    topics: [thread("topic-sso", { title: "Add SSO" }),
      thread("topic-pdf", { title: "Fix invoice PDF" })],
    sessions: [{
      sessionRef: { projectId: PROJECT, sessionStorageId: "shared-coordinator" },
      title: "coordinator", role: "worker", sessionPresent: true, hidden: false,
      lifecycleState: "running", updatedAt: 600,
      coopTopicRefs: [{ topicId: "topic-sso" }, { topicId: "topic-pdf" }],
      portfolioBindings: [{ targetProject: { projectId: PROJECT },
        portfolioTaskId: "TASK-1", status: "running", bindingRevision: 1 }],
    }],
    executionBindings: [],
  });
  assert.deepEqual(ids(sidebar.openWork).sort(), ["thread:topic-pdf", "thread:topic-sso"]);
  assert.equal(sidebar.counts.openWork, 2, "the backlog is not under-reported");
  assert.deepEqual(sidebar.entries.map(function (entry) { return entry.title; }).sort(),
    ["Add SSO", "Fix invoice PDF"], "neither row is mislabelled with the other ask");
});

// A Thread dispatched only through a task binding never gets a durable
// handed_off state, and the projection recomputes that state from live
// evidence -- so it reverts to exploring once the task record is pruned. The
// typed binding is the evidence that outlives both.
test("a typed execution binding is dispatch evidence on its own", function () {
  var pruned = thread("topic-bound", { threadState: "exploring" });
  var withBinding = buildOwnerSidebar({
    requests: [], topics: [pruned], sessions: [],
    executionBindings: [{ portfolioTaskId: "TASK-9", bindingRevision: 1,
      status: "failed", coopTopicRef: { topicId: "topic-bound" } }],
  });
  assert.deepEqual(ids(withBinding.openWork), ["thread:topic-bound"],
    "the binding keeps the ask on the ledger after its task and session are gone");
  assert.equal(withBinding.entries[0].status, "failed");

  var withoutBinding = buildOwnerSidebar({
    requests: [], topics: [pruned], sessions: [], executionBindings: [],
  });
  assert.deepEqual(withoutBinding.entries, [],
    "with no dispatch evidence at all it is still only a conversation");
});

// `titleEntry` ranks a topic-sourced title above every other source, so an
// unscreened Thread title would outrank the owner's own words.
test("a Thread anchor cannot restate a row a recorded ask already describes", function () {
  var sidebar = buildOwnerSidebar({
    requests: [request(1, "topic-labelled")],
    topics: [thread("topic-labelled", { title: "Council" })],
    sessions: [session("attempt-1", "topic-labelled", "failed")],
    executionBindings: [],
    requestContexts: {
      "coop:owner:1": {
        title: "Fix the broken login redirect",
        sourceSessionRef: { projectId: LEAD, sessionStorageId: "coop-home" },
        requestRef: { projectId: LEAD, sessionStorageId: "coop-home", eventIndex: 1 },
      },
    },
  });
  assert.equal(sidebar.entries.length, 1);
  assert.equal(sidebar.entries[0].title, "Fix the broken login redirect",
    "the owner's own words survive the Thread anchor");
  assert.equal(sidebar.entries[0].titleSource, "request");
  assert.equal(sidebar.entries[0].status, "failed",
    "the anchor does not restate a failure the execution record reported");
});

// A Thread's timestamp moves whenever anything happens in the conversation,
// while the failed session here is reachable only through the owner request's
// own links. If the freshest component described the row, typing in the Thread
// would erase an owner-visible failure.
test("a fresher Thread anchor cannot mask a failure only the request can see", function () {
  function ledger(threadUpdatedAt) {
    return buildOwnerSidebar({
      requests: [request(1, "topic-masked", { updatedAt: 20,
        links: { coordinators: [], tasks: [],
          sessions: [{ projectId: PROJECT, sessionStorageId: "dead-attempt" }] } })],
      topics: [thread("topic-masked", { updatedAt: threadUpdatedAt })],
      sessions: [session("dead-attempt", "topic-masked", "failed", { coopTopicRefs: [] })],
      executionBindings: [],
    });
  }
  assert.equal(ledger(100).entries[0].status, "failed");
  assert.equal(ledger(900).entries[0].status, "failed",
    "a Thread touched after the failure does not restate the row as unstarted");
  assert.equal(ledger(900).entries[0].reason, "Execution failed");
  assert.deepEqual(ids(ledger(900).openWork), ["coop:owner:1"]);
});

// A Thread-only row has no other component to carry the owner's Clear, so the
// Thread itself must record it or the control is inert.
test("Clear works on a Thread-only row", function () {
  var settled = closedThread("topic-clearable", "implemented_resolved");
  var visible = buildOwnerSidebar({
    requests: [], topics: [settled], sessions: [], executionBindings: [],
  });
  assert.equal(visible.entries[0].clearable, true);
  assert.deepEqual(ids(visible.landed), ["thread:topic-clearable"]);
  assert.deepEqual(visible.hidden, []);

  var cleared = buildOwnerSidebar({
    requests: [], topics: [settled], sessions: [], executionBindings: [],
    visibility: { hidden: ["thread:topic-clearable"], revision: 1 },
  });
  assert.equal(cleared.entries[0].hidden, true, "clearing the row actually hides it");
  assert.deepEqual(ids(cleared.hidden), ["thread:topic-clearable"]);
  assert.deepEqual(cleared.landed, [], "the cleared row leaves the visible sections");
  assert.deepEqual(cleared.open, []);
});

// A Thread the owner closed without ever dispatching work was a conversation,
// not a backlog entry, so it never joins the work ledger at all.
test("a closed Thread that was never dispatched is not a ledger row", function () {
  var sidebar = buildOwnerSidebar({
    requests: [],
    topics: [thread("topic-chat-closed", { status: "closed", threadState: "closed",
      closeOutcome: "not_pursuing" })],
    sessions: [], executionBindings: [],
  });
  assert.deepEqual(sidebar.entries, []);
});

test("a Thread and the owner request for the same ask are one row, not two", function () {
  var sidebar = buildOwnerSidebar({
    requests: [request(7, "topic-shared")],
    topics: [thread("topic-shared", { title: "Ship the ledger" })],
    sessions: [session("attempt-1", "topic-shared", "failed")],
    executionBindings: [],
  });
  assert.equal(sidebar.entries.length, 1, "shared TopicRef evidence merges the sources");
  assert.equal(sidebar.entries[0].entryId, "coop:owner:7",
    "the recorded owner ingress keeps the durable owner-facing handle");
  assert.equal(sidebar.entries[0].title, "Ship the ledger");
  assert.equal(sidebar.entries[0].status, "failed");
  assert.deepEqual(sidebar.entries[0].threadRef, { threadId: "topic-shared" });
});

// An action-queue row carries no owner ingress either, so nothing but the
// anchor rule keeps a Thread from taking its entryId. The Thread here is the
// older record, which is exactly when it would otherwise win. Renaming the row
// would silently break the owner's decision controls, which address the item
// by entryId.
test("a Thread anchor cannot take an action row's entryId", function () {
  var sidebar = buildOwnerSidebar({
    requests: [],
    topics: [thread("topic-decide", { updatedAt: 100 })],
    sessions: [], executionBindings: [],
    actionQueue: [{
      itemId: "owner-decision-9", taskId: "task-9", portfolioTaskId: "task-9",
      projectRef: { projectId: PROJECT }, projectTitle: "Clay",
      topicRef: { topicId: "topic-decide" }, kind: "decision",
      title: "Accept these ledger defaults?", decision: "Needs your decision",
      status: "needs_input", evidence: "Plan staged", updatedAt: 900,
    }],
  });
  assert.equal(sidebar.entries.length, 1, "the Thread and its decision are one ask");
  assert.equal(sidebar.entries[0].entryId, "owner-decision-9",
    "the action row keeps the handle the owner's decision controls address");
  assert.ok(sidebar.entries[0].action, "the decision control survives the merge");
  assert.equal(sidebar.entries[0].action.itemId, "owner-decision-9");
  assert.deepEqual(ids(sidebar.openWork), ["owner-decision-9"]);
});

// entryId is the handle the owner's Clear/Restore and detail requests are
// addressed to. A Thread anchor joining the group must not rename the row or
// revive one the owner already cleared.
test("a Thread anchor cannot rename or un-hide a row the owner cleared", function () {
  var landed = request(3, "topic-cleared", {
    state: "done", response: { state: "answered", answeredAt: 40 },
    outcome: { status: "completed", at: 40, summary: "Landed" },
  });
  var sidebar = buildOwnerSidebar({
    requests: [landed],
    topics: [closedThread("topic-cleared", "implemented_resolved")],
    sessions: [session("attempt-1", "topic-cleared", "completed", {
      terminalOutcome: { status: "completed", at: 40, summary: "Landed",
        verification: "suite green" },
    })],
    executionBindings: [{ portfolioTaskId: "ledger", bindingRevision: 1,
      status: "completed", coopTopicRef: { topicId: "topic-cleared" } }],
    visibility: { hidden: ["coop:owner:3"], revision: 4 },
  });
  assert.equal(sidebar.entries.length, 1);
  assert.equal(sidebar.entries[0].entryId, "coop:owner:3");
  assert.equal(sidebar.entries[0].hidden, true, "the owner's Clear survives the Thread anchor");
  assert.deepEqual(ids(sidebar.hidden), ["coop:owner:3"]);
  assert.deepEqual(sidebar.openWork, []);
  assert.equal(sidebar.entries[0].anchorOnly, undefined,
    "the internal anchor marker never reaches the owner-facing payload");
});

test("a discussion Thread is not requested work and stays out of the ledger", function () {
  var sidebar = buildOwnerSidebar({
    requests: [],
    topics: [
      thread("topic-exploring", { threadState: "exploring" }),
      thread("topic-parked", { threadState: "parked" }),
      thread("topic-catchall", { topicRef: { topicId: threadLedger.CATCH_ALL_THREAD_ID },
        threadRef: { threadId: threadLedger.CATCH_ALL_THREAD_ID } }),
      thread("topic-merged", { status: "merged" }),
    ],
    sessions: [], executionBindings: [],
  });
  assert.deepEqual(sidebar.entries, [],
    "conversations, the catch-all bucket and merged Threads are not backlog entries");
});

// An exploring Thread that nonetheless carries execution links is dispatched
// work: the projection only ever upgrades a Thread to handed_off, so a caller
// holding an unprojected record must still be read correctly.
test("execution links make a Thread requested work whatever its recorded state", function () {
  var sidebar = buildOwnerSidebar({
    requests: [],
    topics: [thread("topic-linked", { threadState: "exploring",
      relatedExecutions: [{ projectRef: { projectId: PROJECT },
        sessionRef: { projectId: PROJECT, sessionStorageId: "attempt-1" } }] })],
    sessions: [session("attempt-1", "topic-linked", "failed")],
    executionBindings: [],
  });
  assert.deepEqual(ids(sidebar.openWork), ["thread:topic-linked"]);
  assert.deepEqual(sidebar.entries[0].projectRefs, [{ projectId: PROJECT }],
    "project identity comes from where the work is executing");
});

// Guards the shape the server actually sends. The client projection drops
// relatedExecutions and createdAt entirely, so a predicate written against a
// hand-authored topic literal would pass here and never fire in production.
test("the ledger reads the Thread shape the server actually projects", function () {
  var topics = clientTopicProjection.clientTopics({
    groups: [{ kind: "uncategorised", projectRef: null, topics: [{
      topicRef: { topicId: "topic-projected" },
      title: "Six days stuck with no default surface",
      status: "open",
      threadState: "handed_off",
      relatedSessions: [],
      executionProjectRefs: [],
      eventRefs: [], turnRefs: [],
      updatedAt: 900,
    }] }],
  });
  assert.equal(topics[0].relatedExecutions, undefined,
    "the projected Thread carries no durable execution list");
  assert.equal(topics[0].createdAt, undefined, "the projected Thread carries no createdAt");

  var sidebar = buildOwnerSidebar({
    requests: [], topics: topics, sessions: [], executionBindings: [],
  });
  assert.deepEqual(ids(sidebar.openWork), ["thread:topic-projected"],
    "the projected handed-off Thread is open work on the real payload shape");
  assert.equal(sidebar.entries[0].title, "Six days stuck with no default surface");
  assert.equal(sidebar.entries[0].receivedAt, 900,
    "the row falls back to updatedAt when the projection omits createdAt");
});

test("open is the full visible history while openWork is only the outstanding ask", function () {
  var sidebar = buildOwnerSidebar({
    requests: [],
    topics: [
      thread("topic-open", { title: "Still owed" }),
      Object.assign(closedThread("topic-shut", "implemented_resolved"), { title: "Finished" }),
    ],
    sessions: [], executionBindings: [],
  });
  assert.deepEqual(ids(sidebar.open), ["thread:topic-open", "thread:topic-shut"],
    "open keeps settled rows so the ledger stays auditable");
  assert.deepEqual(ids(sidebar.openWork), ["thread:topic-open"],
    "openWork is only what the owner is still owed");
  assert.equal(sidebar.counts.openWork, 1);
});
