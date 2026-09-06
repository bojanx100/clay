// Phase 2: an OPTIONAL, forward-only, reference-only coopTopicRef carried by
// durable execution bindings, through completion, into the delivery payload,
// and consumed by the server-side topic-state seam.
//
// The invariants under test are safety properties, not features:
//   - lossless: no SCHEMA_VERSION bump, pre-existing v1/v2 states still load;
//   - forward-only: absent stays absent, nothing is ever backfilled;
//   - fail closed: a bad ref is a conflict or a dead letter, never a guess;
//   - completion is worker-terminal: no topic status is ever written.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var bindingsModule = require("../lib/portfolio-execution-bindings");
var createBindings = bindingsModule.createPortfolioExecutionBindings;
var delivery = require("../lib/cross-project-delivery");
var server = require("../lib/server");
var topicState = require("../lib/coop-topic-state");

var PROJECT_ID = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
var SCHEMA = "clay.portfolio_execution_bindings";

function tempFile(label) {
  // Never touch live ~/.clay owner data.
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), label)), "bindings.json");
}

function request(revision, extra) {
  return Object.assign({
    portfolioTaskId: "portfolio-task",
    mode: "direct_leaf",
    targetProject: { projectId: PROJECT_ID },
    bindingRevision: revision,
    idempotencyKey: "command-" + revision,
  }, extra || {});
}

function workerRef() {
  return { projectId: PROJECT_ID, sessionStorageId: "canonical-worker" };
}

test("reserve -> commit -> complete -> reload preserves coopTopicRef", function () {
  var file = tempFile("clay-binding-topic-");
  var clock = 100;
  var now = function () { return clock++; };
  var store = createBindings({ file: file, now: now });

  var reserved = store.reserve(request(1, { coopTopicRef: { topicId: "topic-alpha" } }));
  assert.equal(reserved.ok, true);
  assert.deepEqual(reserved.binding.coopTopicRef, { topicId: "topic-alpha" });

  var committed = store.commit("portfolio-task", 1, workerRef());
  assert.equal(committed.ok, true);
  assert.deepEqual(committed.binding.coopTopicRef, { topicId: "topic-alpha" });

  var completed = store.complete("portfolio-task", 1, { eventId: "event-1" });
  assert.equal(completed.ok, true);
  assert.equal(completed.binding.status, "completed");
  assert.deepEqual(completed.binding.coopTopicRef, { topicId: "topic-alpha" });
  // Exposed on the result so the delivery layer can carry it without re-reading.
  assert.deepEqual(completed.coopTopicRef, { topicId: "topic-alpha" });

  // Lossless across a real reload from disk.
  var restarted = createBindings({ file: file, now: now });
  assert.equal(restarted.getLoadError(), null);
  assert.deepEqual(restarted.get("portfolio-task", 1).coopTopicRef, { topicId: "topic-alpha" });
});

test("completion never writes a topic status or an acceptance", function () {
  var file = tempFile("clay-binding-no-close-");
  var store = createBindings({ file: file, now: function () { return 5; } });
  store.reserve(request(1, { coopTopicRef: { topicId: "topic-alpha" } }));
  store.commit("portfolio-task", 1, workerRef());
  var completed = store.complete("portfolio-task", 1, { eventId: "event-1" });

  // The topic ref is carried, and nothing about the topic's lifecycle is
  // decided here: no status, no disposition, no acceptance. Owner acceptance
  // stays an explicit, separate, revocable act.
  assert.deepEqual(Object.keys(completed.binding.coopTopicRef), ["topicId"]);
  var persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  var record = persisted.bindings[0];
  assert.equal(record.status, "completed");
  assert.equal(record.topicStatus, undefined);
  assert.equal(record.ownerAcceptance, undefined);
  assert.equal(record.coopTopicStatus, undefined);
  assert.equal(/"(closed|accepted|resolved)"/.test(JSON.stringify(record.coopTopicRef)), false);

  // Worker-terminal is not an owner decision: the binding persists only the
  // execution result and its reference. Topic projection derives its green
  // completed indicator separately from this durable evidence.
  assert.deepEqual(completed.coopTopicRef, { topicId: "topic-alpha" });
});

test("replaying a revision with a different coopTopicRef is an idempotency conflict", function () {
  var file = tempFile("clay-binding-topic-conflict-");
  var clock = 10;
  var store = createBindings({ file: file, now: function () { return clock++; } });
  assert.equal(store.reserve(request(1, { coopTopicRef: { topicId: "topic-alpha" } })).ok, true);

  var same = store.reserve(request(1, { coopTopicRef: { topicId: "topic-alpha" } }));
  assert.equal(same.ok, true);
  assert.equal(same.created, false);
  assert.equal(store.list().length, 1);

  var different = store.reserve(request(1, { coopTopicRef: { topicId: "topic-beta" } }));
  assert.equal(different.ok, false);
  assert.equal(different.reason, "idempotency_conflict");

  // Dropping the ref on a replay is also a different claim, not the same call.
  assert.equal(store.reserve(request(1)).reason, "idempotency_conflict");
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.get("portfolio-task", 1).coopTopicRef, { topicId: "topic-alpha" });
});

test("an invalid coopTopicRef is dropped, not fatal, and is never guessed at", function () {
  assert.equal(bindingsModule.normalizeBindingTopicRef({ topicId: "  " }), null);
  assert.equal(bindingsModule.normalizeBindingTopicRef("topic-alpha"), null);
  assert.equal(bindingsModule.normalizeBindingTopicRef(undefined), null);
  // Reference-only: extra content keys are stripped, never persisted.
  assert.deepEqual(
    bindingsModule.normalizeBindingTopicRef({ topicId: "topic-a", title: "leaked" }),
    { topicId: "topic-a" });
  // Bounded by rejection: an over-long id is dropped rather than truncated
  // into a different (possibly colliding) topic id. Absent beats wrong.
  assert.equal(bindingsModule.normalizeBindingTopicRef({ topicId: new Array(400).join("x") }), null);
  assert.deepEqual(bindingsModule.normalizeBindingTopicRef({ topicId: new Array(129).join("y") }),
    { topicId: new Array(129).join("y") });

  // A malformed ref must not invalidate an otherwise valid binding.
  var valid = bindingsModule.normalizeRequest(request(1, { coopTopicRef: { nope: true } }));
  assert.ok(valid);
  assert.equal(valid.coopTopicRef, undefined);

  // Absent stays absent: nothing backfills a ref onto a ref-less binding.
  var file = tempFile("clay-binding-no-topic-");
  var store = createBindings({ file: file, now: function () { return 7; } });
  store.reserve(request(1));
  store.commit("portfolio-task", 1, workerRef());
  assert.equal(store.get("portfolio-task", 1).coopTopicRef, undefined);
  var restarted = createBindings({ file: file, now: function () { return 8; } });
  assert.equal(restarted.get("portfolio-task", 1).coopTopicRef, undefined);
});

test("pre-existing v1 and v2 states with no coopTopicRef load cleanly", function () {
  function persistedRecord(revision) {
    return {
      portfolioTaskId: "portfolio-task-" + revision,
      mode: "direct_leaf",
      targetProject: { projectId: PROJECT_ID },
      bindingRevision: revision,
      idempotencyKey: "command-" + revision,
      status: "active",
      worker: workerRef(),
      createdAt: 1,
      updatedAt: 2,
    };
  }

  [1, 2].forEach(function (version) {
    var file = tempFile("clay-binding-v" + version + "-");
    fs.writeFileSync(file, JSON.stringify({
      schema: SCHEMA,
      version: version,
      bindings: [persistedRecord(1), persistedRecord(2)],
    }, null, 2) + "\n", "utf8");

    var store = createBindings({ file: file, now: function () { return 9; }, reconcileOnLoad: false });
    assert.equal(store.getLoadError(), null, "v" + version + " must not be malformed_state");
    assert.equal(store.list().length, 2);
    assert.equal(store.get("portfolio-task-1", 1).coopTopicRef, undefined);

    // Still a valid shape on disk afterwards, and still reloadable.
    var rewritten = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(rewritten.schema, SCHEMA);
    assert.equal(rewritten.version, 2, "adding an optional field must not bump SCHEMA_VERSION");
    var reloaded = createBindings({ file: file, reconcileOnLoad: false });
    assert.equal(reloaded.getLoadError(), null);
    assert.equal(reloaded.list().length, 2);
  });
});

function completionPayload(extra) {
  return Object.assign({
    type: "portfolio_execution_completed",
    portfolioTaskId: "portfolio-task",
    bindingRevision: 1,
    executionMode: "direct_leaf",
    completedAt: 1000,
    resultEventId: "result-1",
    terminalStatus: "completed",
    ownerNotification: true,
    text: "done",
  }, extra || {});
}

test("completion payloads accept a valid ref, tolerate none, and reject a malformed one", function () {
  assert.equal(delivery.validationReason(envelope(completionPayload())), "");
  assert.equal(delivery.validationReason(envelope(completionPayload({
    terminalStatus: "needs_input",
  }))), "");
  assert.equal(delivery.validationReason(envelope(completionPayload({
    executionMode: "project_coordinator", terminalStatus: "needs_input",
  }))), "");
  assert.equal(delivery.validationReason(envelope(completionPayload({
    executionMode: "project_coordinator", terminalStatus: "needs_input", ownerNotification: false,
  }))), "invalid_payload");
  assert.equal(delivery.validationReason(envelope(completionPayload({
    executionMode: "project_coordinator", terminalStatus: "needs_input",
    reviewOnly: true, controlRole: "project_coordinator",
  }))), "");
  assert.equal(delivery.validationReason(envelope(completionPayload({
    coopTopicRef: { topicId: "topic-a" },
  }))), "");
  // Explicit null is "no attribution", not a malformed ref.
  assert.equal(delivery.validationReason(envelope(completionPayload({ coopTopicRef: null }))), "");

  // Fail closed: half-formed refs must dead-letter as invalid_payload rather
  // than be delivered with an attribution nobody can trust.
  [
    { topicId: "" },
    { topicId: "   " },
    { topicId: 12 },
    { topicId: "topic-a", title: "leaked content" },
    { topicKey: "topic-a" },
    "topic-a",
    [{ topicId: "topic-a" }],
    { topicId: new Array(400).join("x") },
  ].forEach(function (bad) {
    assert.equal(delivery.validationReason(envelope(completionPayload({ coopTopicRef: bad }))),
      "invalid_payload", "must reject " + JSON.stringify(bad));
  });
});

test("delivery carries a ref, still delivers without one, and dead-letters a malformed one", function () {
  var directory = fs.mkdtempSync(path.join(os.tmpdir(), "clay-topic-delivery-"));
  var applied = [];
  var transport = delivery.createDurableDelivery({
    deliveryFile: path.join(directory, "delivery.json"),
    recordRecoveryEvent: function () {},
    getProjectContextById: function (projectId) {
      if (projectId !== PROJECT_ID) return null;
      return {
        deliverCrossProjectEnvelope: function (item) {
          applied.push(item.payload);
          return { ok: true };
        },
      };
    },
  });

  function send(eventId, seq, payload) {
    var item = envelope(payload);
    item.eventId = eventId;
    item.sourceSeq = seq;
    return transport.deliverEnvelope(item);
  }

  var tagged = send("22222222-2222-4222-8222-222222222222", 1,
    completionPayload({ coopTopicRef: { topicId: "topic-a" } }));
  assert.equal(tagged.acknowledged, true);
  assert.deepEqual(applied[0].coopTopicRef, { topicId: "topic-a" });

  var plain = send("33333333-3333-4333-8333-333333333333", 2, completionPayload());
  assert.equal(plain.acknowledged, true);
  assert.equal("coopTopicRef" in applied[1], false);

  var malformed = send("44444444-4444-4444-8444-444444444444", 3,
    completionPayload({ coopTopicRef: { topicId: "topic-a", title: "leaked" } }));
  assert.equal(malformed.deadLettered, true);
  assert.equal(malformed.reason, "invalid_payload");
  assert.equal(applied.length, 2, "a malformed ref must never reach the target");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("bounded payloads emit the ref only when present so replay stays byte-identical", function () {
  var without = delivery.boundedPayload(completionPayload());
  assert.equal("coopTopicRef" in without, false);
  // Byte-for-byte identical to what a pre-existing envelope produced.
  assert.equal(JSON.stringify(without), JSON.stringify({
    type: "portfolio_execution_completed",
    portfolioTaskId: "portfolio-task",
    bindingRevision: 1,
    executionMode: "direct_leaf",
    completedAt: 1000,
    resultEventId: "result-1",
    terminalStatus: "completed",
    ownerNotification: true,
    text: "done",
  }));
  assert.equal(JSON.stringify(delivery.boundedPayload(completionPayload({ coopTopicRef: null }))),
    JSON.stringify(without));

  var withRef = delivery.boundedPayload(completionPayload({
    coopTopicRef: { topicId: " topic-a " },
  }));
  assert.deepEqual(withRef.coopTopicRef, { topicId: "topic-a" });
  assert.equal(delivery.boundedPayload(completionPayload({ coopTopicRef: { topicId: "" } })), null);
});

test("review-only project coordinator attention preserves its bounded metadata", function () {
  var bounded = delivery.boundedPayload(completionPayload({
    executionMode: "project_coordinator",
    terminalStatus: "needs_input",
    reviewOnly: true,
    controlRole: "Council",
  }));

  assert.equal(bounded.reviewOnly, true);
  assert.equal(bounded.controlRole, "council");
});

function envelope(payload) {
  return {
    schema: delivery.SCHEMA,
    schemaVersion: delivery.SCHEMA_VERSION,
    eventId: "11111111-1111-4111-8111-111111111111",
    source: { projectId: PROJECT_ID, sessionStorageId: "source" },
    destination: { projectId: PROJECT_ID, sessionStorageId: "destination" },
    bindingRevision: 1,
    sourceSeq: 1,
    createdAt: 1000,
    payload: payload,
  };
}

test("envelope identity is unchanged without a ref and distinguishes different refs", function () {
  var plain = envelope(completionPayload());
  assert.equal(delivery.isSameEnvelope(plain, envelope(completionPayload())), true);
  assert.equal(delivery.isSameEnvelope(plain, envelope(completionPayload({ coopTopicRef: null }))), true);

  var tagged = envelope(completionPayload({ coopTopicRef: { topicId: "topic-a" } }));
  assert.equal(delivery.isSameEnvelope(tagged, envelope(completionPayload({
    coopTopicRef: { topicId: "topic-a" },
  }))), true);
  assert.equal(delivery.isSameEnvelope(plain, tagged), false);
  assert.equal(delivery.isSameEnvelope(tagged, envelope(completionPayload({
    coopTopicRef: { topicId: "topic-b" },
  }))), false);
});

// The server-side consumption seam is tested through the exported pure rule
// rather than through createServer(): createServer binds a TLS listener, a
// project registry, a session manager, and the cross-project router, none of
// which a unit test can stand up. The rule below IS the fail-closed guarantee
// server.js applies before handing bindings to coopTopicState.projectedTopicState,
// so exercising it directly tests the behaviour rather than the wiring.
test("server-side topic-state consumption fails closed on missing and merged refs", function () {
  var linked = { coopTopicRef: { topicId: "topic-a" }, status: "active" };
  var otherTopic = { coopTopicRef: { topicId: "topic-b" }, status: "active" };
  var unlinked = { status: "active" };
  var ghost = { coopTopicRef: { topicId: "topic-does-not-exist" }, status: "completed" };
  var all = [linked, otherTopic, unlinked, ghost];
  var open = { status: "open" };

  // A binding-carried ref counts as linked work for its own topic.
  assert.deepEqual(server.coopTopicLinkedBindings(all, { topicId: "topic-a" }, open), [linked]);

  // A ref naming a topic that does not exist contributes nothing to any topic.
  assert.deepEqual(server.coopTopicLinkedBindings(all, { topicId: "topic-a" }, open)
    .indexOf(ghost), -1);
  assert.deepEqual(server.coopTopicLinkedBindings([ghost], { topicId: "topic-a" }, open), []);

  // A merged topic is no longer a lens: it contributes nothing, and its work is
  // never re-attributed to the merge target.
  assert.deepEqual(server.coopTopicLinkedBindings(all, { topicId: "topic-a" },
    { status: "merged", mergedInto: { topicId: "topic-b" } }), []);
  assert.deepEqual(server.coopTopicLinkedBindings([linked], { topicId: "topic-b" }, open), []);

  // Forward-only: a binding with no ref is never attributed to anything.
  assert.deepEqual(server.coopTopicLinkedBindings([unlinked], { topicId: "topic-a" }, open), []);

  // Degenerate inputs fail closed rather than throwing or over-matching.
  assert.deepEqual(server.coopTopicLinkedBindings(all, null, open), []);
  assert.deepEqual(server.coopTopicLinkedBindings(all, { topicId: "  " }, open), []);
  assert.deepEqual(server.coopTopicLinkedBindings(all, { topicId: "topic-a" }, null), []);
  assert.deepEqual(server.coopTopicLinkedBindings(null, { topicId: "topic-a" }, open), []);
});

test("server topic consumption follows visible project-session lifecycle over stale bindings", function () {
  var binding = {
    mode: "project_coordinator", status: "active", coopTopicRef: { topicId: "topic-a" },
  };
  var hidden = server.coopTopicLinkedBindings([binding], { topicId: "topic-a" }, { status: "open" },
    function () { return { hidden: true }; });
  assert.deepEqual(hidden, [], "hidden sessions cannot keep a topic Working");

  var hiddenDirectLeaf = server.coopTopicLinkedBindings([{
    mode: "direct_leaf", status: "active", coopTopicRef: { topicId: "topic-a" },
  }], { topicId: "topic-a" }, { status: "open" }, function () {
    return {
      hidden: true,
      orchestrationPolicy: { portfolioExecution: { status: "needs_input" } },
    };
  });
  assert.deepEqual(hiddenDirectLeaf, [],
    "a hidden terminal direct leaf cannot keep its Coop topic Working");
  assert.equal(topicState.coopTopicState({ topicId: "topic-a" }, {
    bindings: hiddenDirectLeaf,
  }).state, "needs_input");

  var attention = server.coopTopicLinkedBindings([binding], { topicId: "topic-a" }, { status: "open" },
    function () {
      return {
        orchestrationPolicy: { portfolioExecution: { status: "running" } },
        orchestrationTasks: [{ status: "needs_input" }],
      };
    });
  assert.equal(attention[0].status, "needs_input");
  assert.equal(topicState.coopTopicState({ topicId: "topic-a" }, {
    bindings: attention,
  }).state, "needs_input");

  var completed = server.coopTopicLinkedBindings([binding], { topicId: "topic-a" }, { status: "open" },
    function () {
      return {
        orchestrationPolicy: { portfolioExecution: { status: "completed" } },
        orchestrationProjectCompletion: { status: "completed" },
      };
    });
  assert.equal(completed[0].status, "completed");
  assert.equal(topicState.coopTopicState({ topicId: "topic-a" }, {
    bindings: completed,
  }).state, "done");
});
