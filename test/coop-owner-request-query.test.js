var test = require("node:test");
var assert = require("node:assert/strict");
var query = require("../lib/coop-owner-request-query");

// The owner-facing projection: topic -> projects -> coordinators -> workers,
// plus the unanswered list that outranks all of it.

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var WEBAPP = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
var COOP_SESSION = "871a194b-8879-40f7-a1fe-656e48e722af";
var TOPIC = "auto-a7daa4cc660639337d144d93";
var COORD = { projectId: CLAY, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" };
var WORKER = { projectId: CLAY, sessionStorageId: "09ba91a6-130a-4d44-9f10-3de30f7a10ce" };
var WEBAPP_COORD = { projectId: WEBAPP, sessionStorageId: "7e539a81-8ecf-4943-ad26-bcaf6544f1c0" };

function request(sequence, extra) {
  return Object.assign({
    ingressId: "coop:" + COOP_SESSION + ":" + sequence,
    ingressSequence: sequence,
    ingressKind: "text",
    receivedAt: sequence,
    requestRef: { projectId: "system-lead", sessionStorageId: COOP_SESSION, eventIndex: sequence },
    topicRef: { topicId: TOPIC },
    projectRefs: [{ projectId: CLAY }],
    classification: { kind: "new_topic", source: "ingress_route", at: sequence },
    expectsExecution: true,
    response: { state: "unanswered", answeredAt: null, responseRef: null },
    links: { coordinators: [], tasks: [], sessions: [] },
    state: "working",
    attention: null,
    outcome: null,
  }, extra || {});
}

function session(ref, extra) {
  return Object.assign({
    projectRef: { projectId: ref.projectId },
    sessionRef: ref,
    sessionStorageId: ref.sessionStorageId,
    title: "A session",
    sessionPresent: true,
    hidden: false,
    topLevel: true,
    role: "project_coordinator",
    parentSessionRef: null,
    workState: "working",
    lifecycleState: "running",
  }, extra || {});
}

function overview(input) {
  return query.buildOwnerRequestOverview(Object.assign({
    requests: [], coordinators: [], sessions: [], topics: {},
  }, input || {}));
}

// --- the hierarchy -----------------------------------------------------------

test("the projection shows topic, projects, coordinators and workers", function () {
  var result = overview({
    requests: [request(182)],
    coordinators: [{ topicId: TOPIC, projectId: CLAY, coordinator: COORD }],
    sessions: [
      session(COORD, { title: "Implement owner-topic execution flow" }),
      session(WORKER, { title: "Write the ledger tests", role: "worker",
        topLevel: false, parentSessionRef: COORD }),
    ],
    topics: { "auto-a7daa4cc660639337d144d93": { title: "Owner topic execution flow", status: "open" } },
  });

  assert.equal(result.topics.length, 1);
  var topic = result.topics[0];
  assert.equal(topic.title, "Owner topic execution flow");
  assert.equal(topic.projects.length, 1);
  assert.deepEqual(topic.projects[0].projectRef, { projectId: CLAY });
  assert.equal(topic.projects[0].coordinator.title, "Implement owner-topic execution flow");
  assert.equal(topic.projects[0].workers.length, 1);
  assert.equal(topic.projects[0].workers[0].title, "Write the ledger tests");
  assert.equal(topic.projects[0].workers[0].role, "worker");
});

test("one topic reaching two projects shows one coordinator per project", function () {
  var result = overview({
    requests: [request(182, { projectRefs: [{ projectId: CLAY }, { projectId: WEBAPP }] })],
    coordinators: [
      { topicId: TOPIC, projectId: CLAY, coordinator: COORD },
      { topicId: TOPIC, projectId: WEBAPP, coordinator: WEBAPP_COORD },
    ],
    sessions: [session(COORD), session(WEBAPP_COORD)],
  });

  assert.equal(result.topics[0].projects.length, 2);
  assert.deepEqual(result.topics[0].projects.map(function (p) { return p.projectRef.projectId; }),
    [CLAY, WEBAPP]);
});

test("a claimed coordinator whose session is gone is shown as missing, not omitted", function () {
  var result = overview({
    requests: [request(182)],
    coordinators: [{ topicId: TOPIC, projectId: CLAY, coordinator: COORD }],
    sessions: [],
  });

  var coordinator = result.topics[0].projects[0].coordinator;
  assert.deepEqual(coordinator.sessionRef, COORD);
  assert.equal(coordinator.present, false);
  assert.equal(coordinator.lifecycleState, "missing");
  assert.equal(coordinator.live, false);
});

test("the projection never carries the owner's request text", function () {
  var result = overview({ requests: [request(182)] });
  assert.equal(JSON.stringify(result).indexOf("implement this asap"), -1);
  assert.deepEqual(result.unanswered[0].requestRef,
    { projectId: "system-lead", sessionStorageId: COOP_SESSION, eventIndex: 182 });
});

// --- hidden and terminal sessions never count as working ----------------------

test("a hidden session is not working", function () {
  assert.equal(query.isLiveSession(session(COORD, { hidden: true })), false);
  var result = overview({
    requests: [request(182)],
    coordinators: [{ topicId: TOPIC, projectId: CLAY, coordinator: COORD }],
    sessions: [session(COORD, { hidden: true })],
  });
  assert.equal(result.counts.working, 0);
  assert.equal(result.topics[0].workingCount, 0);
});

test("a completed session is not working", function () {
  var result = overview({
    requests: [request(182)],
    coordinators: [{ topicId: TOPIC, projectId: CLAY, coordinator: COORD }],
    sessions: [session(COORD, { workState: "done", lifecycleState: "completed" })],
  });
  assert.equal(result.counts.working, 0);
});

test("a session that is gone is not working", function () {
  var result = overview({
    requests: [request(182)],
    coordinators: [{ topicId: TOPIC, projectId: CLAY, coordinator: COORD }],
    sessions: [session(COORD, { sessionPresent: false })],
  });
  assert.equal(result.counts.working, 0);
});

test("a genuinely running coordinator and worker both count", function () {
  var result = overview({
    requests: [request(182)],
    coordinators: [{ topicId: TOPIC, projectId: CLAY, coordinator: COORD }],
    sessions: [
      session(COORD),
      session(WORKER, { role: "worker", topLevel: false, parentSessionRef: COORD }),
    ],
  });
  assert.equal(result.counts.working, 2);
});

test("a coordinator waiting on the owner counts as needs input, not working", function () {
  var result = overview({
    requests: [request(182)],
    coordinators: [{ topicId: TOPIC, projectId: CLAY, coordinator: COORD }],
    sessions: [session(COORD, { workState: "needs_input", lifecycleState: "needs_input" })],
  });
  assert.equal(result.counts.working, 0);
  assert.equal(result.counts.needsInput, 1);
});

// --- unanswered requests ------------------------------------------------------

test("unanswered requests are listed oldest first, independently of work", function () {
  var result = overview({
    requests: [
      request(180, { response: { state: "answered", answeredAt: 5, responseRef: null }, state: "done" }),
      request(182),
      request(181),
    ],
  });

  assert.deepEqual(result.unanswered.map(function (r) { return r.ingressSequence; }), [181, 182]);
  assert.equal(result.counts.unanswered, 2);
});

test("a request answered while its work runs is not unanswered but still shows the work", function () {
  var result = overview({
    requests: [request(182, { response: { state: "answered", answeredAt: 9, responseRef: null } })],
    coordinators: [{ topicId: TOPIC, projectId: CLAY, coordinator: COORD }],
    sessions: [session(COORD)],
  });

  assert.equal(result.counts.unanswered, 0);
  assert.equal(result.counts.working, 1);
  assert.equal(result.topics[0].unansweredCount, 0);
});

test("a request whose target was unresolved surfaces as attention and stays unanswered", function () {
  var result = overview({
    requests: [request(182, { state: "attention", attention: "project_target_unavailable" })],
  });

  assert.equal(result.counts.attention, 1);
  assert.equal(result.counts.unanswered, 1);
  assert.equal(result.unanswered[0].attention, "project_target_unavailable");
});

test("a conversational request appears without projects or execution", function () {
  var result = overview({
    requests: [request(180, {
      classification: { kind: "conversational", source: "ingress_route", at: 1 },
      expectsExecution: false, projectRefs: [], state: "open",
    })],
  });

  assert.equal(result.topics[0].projects.length, 0);
  assert.equal(result.unanswered[0].classification, "conversational");
  assert.equal(result.unanswered[0].expectsExecution, false);
});

test("an empty ledger projects an empty, well-formed overview", function () {
  var result = overview({});
  assert.deepEqual(result.unanswered, []);
  assert.deepEqual(result.topics, []);
  assert.deepEqual(result.counts,
    { unanswered: 0, superseded: 0, topics: 0, working: 0, needsInput: 0, attention: 0 });
});

test("internal index scaffolding never leaks into the projection", function () {
  var result = overview({
    requests: [request(182)],
    coordinators: [{ topicId: TOPIC, projectId: CLAY, coordinator: COORD }],
    sessions: [session(COORD)],
  });
  assert.equal(JSON.stringify(result).indexOf("projectIndex"), -1);
});

// --- the read-only WebSocket surface ------------------------------------------

var connection = require("../lib/coop-topic-connection");

function socketCtx(slug, ledger) {
  var sent = [];
  return {
    ctx: {
      slug: slug,
      coopOwnerRequests: ledger,
      coopSessionLedger: { list: function () { return [session(COORD)]; } },
      // The per-viewer scope every read on this socket resolves through.
      getGlobalCoopProjection: function () { return { projects: [{ projectRef: { projectId: CLAY } }] }; },
      sendTo: function (ws, payload) { sent.push(payload); },
    },
    sent: sent,
  };
}

function fakeLedger() {
  return {
    list: function () { return [request(182)]; },
    listCoordinators: function () { return [{ topicId: TOPIC, projectId: CLAY, coordinator: COORD }]; },
  };
}

test("the overview request returns the hierarchy to a Coop client", function () {
  var harness = socketCtx("lead", fakeLedger());
  var handled = connection.handleOwnerRequestOverview(harness.ctx, {},
    { type: "coop_owner_requests_request" });

  assert.equal(handled, true);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].type, "coop_owner_requests");
  assert.equal(harness.sent[0].ok, true);
  assert.equal(harness.sent[0].counts.unanswered, 1);
  assert.equal(harness.sent[0].topics.length, 1);
  assert.equal(harness.sent[0].topics[0].projects[0].coordinator.workState, "working");
});

test("a non-Coop socket is denied the overview", function () {
  var harness = socketCtx("some-project", fakeLedger());
  connection.handleOwnerRequestOverview(harness.ctx, {}, { type: "coop_owner_requests_request" });

  assert.equal(harness.sent[0].ok, false);
  assert.equal(harness.sent[0].code, "access_denied");
});

test("the overview handler ignores unrelated messages", function () {
  var harness = socketCtx("lead", fakeLedger());
  assert.equal(connection.handleOwnerRequestOverview(harness.ctx, {}, { type: "coop_topic_select" }), false);
  assert.equal(harness.sent.length, 0);
});

test("a broken ledger reports unavailable rather than throwing at the socket", function () {
  var harness = socketCtx("lead", {
    list: function () { throw new Error("corrupt"); },
    listCoordinators: function () { return []; },
  });
  connection.handleOwnerRequestOverview(harness.ctx, {}, { type: "coop_owner_requests_request" });

  assert.equal(harness.sent[0].ok, false);
  assert.equal(harness.sent[0].code, "overview_unavailable");
});

test("topic titles survive an unwarmed canonical session", async function () {
  // topicIndexForContext resolves through the canonical Coop session and
  // returns null before that session exists. The overview must still name its
  // topics rather than rendering every row as "Untitled topic".
  var harness = socketCtx("lead", fakeLedger());
  harness.ctx.coopTopicIndex = {
    load: function () {
      return { topics: { "auto-a7daa4cc660639337d144d93": { title: "Owner topic execution flow", status: "open" } } };
    },
  };
  connection.handleOwnerRequestOverview(harness.ctx, {}, { type: "coop_owner_requests_request" });

  assert.equal(harness.sent[0].ok, true);
  assert.equal(harness.sent[0].topics[0].title, "Owner topic execution flow");
  assert.equal(harness.sent[0].unanswered[0].topicTitle, "Owner topic execution flow");
});

test("the session ledger resolves through the cross-project router", function () {
  // Regression: ctx.coopSessionLedger is a key nothing in the daemon sets, so
  // the coordinator and worker levels were permanently empty and every count
  // read zero for the wrong reason.
  var harness = socketCtx("lead", fakeLedger());
  delete harness.ctx.coopSessionLedger;
  harness.ctx.crossProject = { sessionLedger: { list: function () { return [session(COORD)]; } } };
  connection.handleOwnerRequestOverview(harness.ctx, {}, { type: "coop_owner_requests_request" });

  var coordinator = harness.sent[0].topics[0].projects[0].coordinator;
  assert.equal(coordinator.present, true);
  assert.equal(coordinator.live, true);
  assert.equal(harness.sent[0].counts.working, 1);
});

// --- per-user scoping ---------------------------------------------------------
//
// The overview is slug-gated: it only answers a socket looking at the Coop
// project. That proves WHICH PROJECT the socket is on, not WHO is looking. Every
// other read here projects through the viewer's visible projects; without the
// same filter a non-owner viewer of Coop receives topic titles, project ids and
// coordinator/worker session refs for projects they cannot access.

test("a viewer only sees projects they can access", function () {
  var result = query.buildOwnerRequestOverview({
    requests: [request(182, { projectRefs: [{ projectId: CLAY }, { projectId: WEBAPP }] })],
    coordinators: [
      { topicId: TOPIC, projectId: CLAY, coordinator: COORD },
      { topicId: TOPIC, projectId: WEBAPP, coordinator: WEBAPP_COORD },
    ],
    sessions: [session(COORD), session(WEBAPP_COORD)],
    visibleProjects: { "5332aafc-31e7-5cb1-ba96-c8d90e78260e": true },
  });

  var projects = result.topics[0].projects;
  assert.deepEqual(projects.map(function (p) { return p.projectRef.projectId; }), [CLAY]);
  assert.equal(JSON.stringify(result).indexOf(WEBAPP), -1, "no trace of an unreachable project");
  assert.equal(JSON.stringify(result).indexOf(WEBAPP_COORD.sessionStorageId), -1);
});

test("a topic left with no reachable project is dropped entirely", function () {
  var result = query.buildOwnerRequestOverview({
    requests: [request(182, { projectRefs: [{ projectId: WEBAPP }] })],
    coordinators: [{ topicId: TOPIC, projectId: WEBAPP, coordinator: WEBAPP_COORD }],
    sessions: [session(WEBAPP_COORD)],
    visibleProjects: { "5332aafc-31e7-5cb1-ba96-c8d90e78260e": true },
  });
  assert.deepEqual(result.topics, []);
});

test("omitting visibleProjects keeps the unrestricted single-user view", function () {
  var result = query.buildOwnerRequestOverview({
    requests: [request(182, { projectRefs: [{ projectId: CLAY }, { projectId: WEBAPP }] })],
    coordinators: [], sessions: [], topics: {},
  });
  assert.equal(result.topics[0].projects.length, 2);
});

test("an unanswered request is never hidden by project scoping", function () {
  // The owner asked; that fact is not a project secret, and burying it is the
  // exact failure this surface exists to prevent.
  var result = query.buildOwnerRequestOverview({
    requests: [request(182, { projectRefs: [{ projectId: WEBAPP }] })],
    coordinators: [], sessions: [],
    visibleProjects: { "5332aafc-31e7-5cb1-ba96-c8d90e78260e": true },
  });
  assert.equal(result.counts.unanswered, 1);
  assert.equal(result.unanswered[0].ingressSequence, 182);
});

test("a socket with no resolvable viewer scope is shown no projects", function () {
  // Fail closed, exactly like every other read on this socket: a deployment
  // that cannot establish who is looking must not hand over the tree.
  var harness = socketCtx("lead", fakeLedger());
  delete harness.ctx.getGlobalCoopProjection;
  connection.handleOwnerRequestOverview(harness.ctx, {}, { type: "coop_owner_requests_request" });

  assert.equal(harness.sent[0].ok, true);
  assert.deepEqual(harness.sent[0].topics, []);
  // The owner's own outstanding requests are still reported: that they asked
  // is not a project secret.
  assert.equal(harness.sent[0].counts.unanswered, 1);
});

// --- superseded is not unanswered ---------------------------------------------
//
// Regression caught on live data: the projection derived "answered" as
// response.state === "answered", so the third response state -- superseded,
// meaning the owner withdrew the question by replacing or stopping it -- fell
// into the unanswered bucket. The owner would have been shown 16 requests they
// themselves retracted as still outstanding, on the one surface whose whole job
// is to be trusted about what is outstanding.

test("a superseded request is not reported as unanswered", function () {
  var result = overview({
    requests: [
      request(180, { response: { state: "superseded", answeredAt: null, responseRef: null,
        supersededAt: 5, supersededBy: "owner_interrupt" } }),
      request(182),
    ],
  });

  assert.deepEqual(result.unanswered.map(function (r) { return r.ingressSequence; }), [182]);
  assert.equal(result.counts.unanswered, 1);
  assert.equal(result.topics[0].unansweredCount, 1);
});

test("the projection reports the response state so the owner can tell them apart", function () {
  var result = overview({
    requests: [request(180, { response: { state: "superseded", answeredAt: null, responseRef: null,
      supersededAt: 5, supersededBy: "owner_interrupt" } })],
  });
  var topic = result.topics[0];
  assert.equal(topic.unansweredCount, 0);
  // Withdrawn is a real outcome, not an absence: it must be visible somewhere.
  assert.equal(result.counts.superseded, 1);
});

test("answered, superseded and unanswered are counted as three distinct things", function () {
  var result = overview({
    requests: [
      request(180, { response: { state: "answered", answeredAt: 1, responseRef: null } }),
      request(181, { response: { state: "superseded", answeredAt: null, responseRef: null,
        supersededAt: 2, supersededBy: "owner_interrupt" } }),
      request(182),
    ],
  });
  assert.equal(result.counts.unanswered, 1);
  assert.equal(result.counts.superseded, 1);
  assert.equal(result.topics[0].requestCount, 3);
});
