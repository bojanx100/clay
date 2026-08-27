var test = require("node:test");
var assert = require("node:assert/strict");
var os = require("os");
var path = require("path");
var fs = require("fs");
var ownerRequests = require("../lib/coop-owner-requests");

// The owner-request ledger is the durable record of what the owner asked and
// whether the owner was answered. It is reference-only, exactly like the topic
// index: it stores canonical event references, never transcript copies.
//
// Its one load-bearing rule is that starting work is NOT answering. A worker
// spawning, a coordinator binding, a task moving to running -- none of these
// may ever flip a request to answered. Only the owner-facing turn completing
// does that.

var LEAD_PROJECT = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var COOP_SESSION = "871a194b-8879-40f7-a1fe-656e48e722af";
var TOPIC = { topicId: "auto-a7daa4cc660639337d144d93" };
var OTHER_TOPIC = { topicId: "auto-51790c55a2629f5d66444f0c" };

function tempFile(name) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-requests-"));
  return path.join(dir, name || "coop-owner-requests.json");
}

function makeLedger(options) {
  var opts = options || {};
  var clock = { value: opts.start || 1000 };
  var ledger = ownerRequests.attachCoopOwnerRequests({
    file: opts.file || tempFile(),
    fs: opts.fs,
    now: function () { return clock.value; },
  });
  ledger._clock = clock;
  return ledger;
}

function ingress(sequence, extra) {
  return Object.assign({
    ingressId: "coop:" + COOP_SESSION + ":" + sequence,
    ingressSequence: sequence,
    ingressKind: "text",
    sessionRef: { projectId: LEAD_PROJECT, sessionStorageId: COOP_SESSION },
    requestRef: { projectId: LEAD_PROJECT, sessionStorageId: COOP_SESSION, eventIndex: sequence * 10 },
  }, extra || {});
}

// --- the request record itself ----------------------------------------------

test("recording an ingress creates an unanswered, reference-only request", function () {
  var ledger = makeLedger();
  var record = ledger.record(ingress(182));

  assert.equal(record.ingressId, "coop:" + COOP_SESSION + ":182");
  assert.equal(record.ingressSequence, 182);
  assert.equal(record.ingressKind, "text");
  assert.equal(record.response.state, "unanswered");
  assert.equal(record.response.answeredAt, null);
  assert.equal(record.state, "open");
  assert.equal(record.outcome, null);
  assert.deepEqual(record.requestRef,
    { projectId: LEAD_PROJECT, sessionStorageId: COOP_SESSION, eventIndex: 1820 });
  // Reference-only: the ledger never copies what the owner wrote.
  assert.equal(JSON.stringify(record).indexOf("text\":\"") , -1);
});

test("a request without a usable ingress id is rejected rather than stored under a guessed key", function () {
  var ledger = makeLedger();
  assert.equal(ledger.record({ ingressSequence: 1 }), null);
  assert.equal(ledger.record(null), null);
  assert.equal(ledger.list().length, 0);
});

test("recording the same ingress twice is idempotent and never resets an answer", function () {
  var ledger = makeLedger();
  ledger.record(ingress(182));
  ledger.markAnswered("coop:" + COOP_SESSION + ":182", { eventIndex: 1825 });

  var again = ledger.record(ingress(182));
  assert.equal(again.response.state, "answered");
  assert.equal(ledger.list().length, 1);
});

test("read-only owner-request projections reuse the unchanged file and reload a real external update", function () {
  var file = tempFile();
  var reads = 0;
  var cachedFs = {
    readFileSync: function () { reads++; return fs.readFileSync.apply(fs, arguments); },
    statSync: fs.statSync,
    existsSync: fs.existsSync,
    lstatSync: fs.lstatSync,
    renameSync: fs.renameSync,
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
    unlinkSync: fs.unlinkSync,
  };
  var cached = makeLedger({ file: file, fs: cachedFs });
  cached.record(ingress(182));
  reads = 0;

  assert.equal(cached.get("coop:" + COOP_SESSION + ":182").ingressSequence, 182);
  assert.equal(cached.unanswered().length, 1);
  assert.equal(reads, 0, "unchanged read projections use the cached parsed ledger");

  var external = makeLedger({ file: file });
  external.record(ingress(183));

  assert.equal(cached.get("coop:" + COOP_SESSION + ":183").ingressSequence, 183,
    "the actual external write invalidates the cache and is visible to this reader");
  assert.ok(reads > 0, "the changed size/mtime caused one real ledger reload");
});

test("a live Coop ledger lock fails fast instead of blocking the daemon event loop", function () {
  var file = tempFile();
  fs.writeFileSync(file + ".lock", JSON.stringify({ token: "other", pid: process.pid }) + "\n");
  var ledger = makeLedger({ file: file });
  var started = Date.now();
  try {
    assert.equal(ledger.record(ingress(182)), null);
    assert.ok(Date.now() - started < 500,
      "contention must return through the persistence-failure path, not sleep for seconds");
  } finally {
    try { fs.unlinkSync(file + ".lock"); } catch (error) {}
  }
});

test("two live ledger instances preserve disjoint owner-request mutations", function () {
  var file = tempFile();
  var seed = makeLedger({ file: file, start: 500 });
  var answeredId = "coop:" + COOP_SESSION + ":233";
  var laterId = "coop:" + COOP_SESSION + ":240";
  seed.record(ingress(233));
  var staleDaemon = makeLedger({ file: file, start: 1000 });
  var reconciler = makeLedger({ file: file, start: 2000 });

  reconciler.markAnswered(answeredId, { eventIndex: 118921, at: 3000 });
  staleDaemon.record(ingress(240));

  var reloaded = ownerRequests.attachCoopOwnerRequests({ file: file });
  assert.equal(reloaded.get(answeredId).response.state, "answered");
  assert.equal(reloaded.get(answeredId).response.responseRef.eventIndex, 118921);
  assert.equal(reloaded.get(laterId).response.state, "unanswered");
  assert.deepEqual(reloaded.list().map(function (record) { return record.ingressId; }),
    [answeredId, laterId]);
});

// --- response semantics: worker start is not an answer -----------------------

test("linking a coordinator does NOT answer the owner", function () {
  var ledger = makeLedger();
  ledger.record(ingress(182));
  ledger.linkExecution("coop:" + COOP_SESSION + ":182", {
    coordinator: { projectId: LEAD_PROJECT, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" },
  });

  var record = ledger.get("coop:" + COOP_SESSION + ":182");
  assert.equal(record.response.state, "unanswered", "spawning work must never count as answering");
  assert.equal(record.links.coordinators.length, 1);
  assert.equal(ledger.unanswered().length, 1);
});

test("linking tasks, workers and moving to working leaves the request unanswered", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  ledger.linkExecution(id, { task: { projectId: LEAD_PROJECT, taskId: "task-1" } });
  ledger.linkExecution(id, {
    session: { projectId: LEAD_PROJECT, sessionStorageId: "09ba91a6-130a-4d44-9f10-3de30f7a10ce" },
  });
  ledger.setState(id, "working");

  var record = ledger.get(id);
  assert.equal(record.state, "working");
  assert.equal(record.response.state, "unanswered");
  assert.equal(ledger.unanswered().length, 1);
});

test("markAnswered is the only transition to answered and is stamped with the reply event", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  ledger._clock.value = 2000;
  var record = ledger.markAnswered(id, { eventIndex: 1825 });

  assert.equal(record.response.state, "answered");
  assert.equal(record.response.answeredAt, 2000);
  assert.deepEqual(record.response.responseRef,
    { projectId: LEAD_PROJECT, sessionStorageId: COOP_SESSION, eventIndex: 1825 });
  assert.equal(ledger.unanswered().length, 0);
});

test("an informational owner message can be settled without inventing an answer", function () {
  var file = tempFile();
  var ledger = makeLedger({ file: file });
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));

  var record = ledger.markNoResponseRequired(id);
  var reloaded = ownerRequests.attachCoopOwnerRequests({ file: file }).get(id);

  assert.equal(record.response.state, "not_required");
  assert.equal(record.response.responseRef, null);
  assert.equal(record.state, "done");
  assert.equal(ledger.hasUnansweredOwnerRequests(), false);
  assert.equal(reloaded.response.state, "not_required");
});

test("answering does not close the request: work may still be running", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  ledger.setState(id, "working");
  ledger.markAnswered(id, { eventIndex: 1825 });

  var record = ledger.get(id);
  assert.equal(record.response.state, "answered");
  assert.equal(record.state, "working", "an answered owner still has work in flight");
});

test("the first answer wins: a later turn cannot restamp an answered request", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  ledger._clock.value = 2000;
  ledger.markAnswered(id, { eventIndex: 1825 });
  ledger._clock.value = 5000;
  var record = ledger.markAnswered(id, { eventIndex: 1900 });

  assert.equal(record.response.answeredAt, 2000);
  assert.equal(record.response.responseRef.eventIndex, 1825);
});

// --- classification ----------------------------------------------------------

test("classification records the routing decision durably", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  var record = ledger.classify(id, {
    kind: "existing_topic",
    topicRef: TOPIC,
    projectRefs: [{ projectId: LEAD_PROJECT }],
    source: "keyword_overlap",
  });

  assert.equal(record.classification.kind, "existing_topic");
  assert.equal(record.classification.source, "keyword_overlap");
  assert.deepEqual(record.topicRef, TOPIC);
  assert.deepEqual(record.projectRefs, [{ projectId: LEAD_PROJECT }]);
});

test("a conversational classification carries no ProjectRef and expects no execution", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":180";
  ledger.record(ingress(180));
  var record = ledger.classify(id, { kind: "conversational", topicRef: OTHER_TOPIC, source: "low_information" });

  assert.equal(record.classification.kind, "conversational");
  assert.deepEqual(record.projectRefs, []);
  assert.equal(record.expectsExecution, false);
});

test("theme classification never expects execution without an owner implementation decision", function () {
  var ledger = makeLedger();
  ledger.record(ingress(1));
  ledger.record(ingress(2));
  var created = ledger.classify("coop:" + COOP_SESSION + ":1",
    { kind: "new_topic", topicRef: TOPIC, projectRefs: [{ projectId: LEAD_PROJECT }] });
  var reused = ledger.classify("coop:" + COOP_SESSION + ":2",
    { kind: "existing_topic", topicRef: TOPIC, projectRefs: [{ projectId: LEAD_PROJECT }] });

  assert.equal(created.expectsExecution, false);
  assert.equal(reused.expectsExecution, false);
});

test("an explicit owner implementation decision admits the selected ProjectRef", function () {
  var ledger = makeLedger();
  ledger.record(ingress(3));
  var record = ledger.classify("coop:" + COOP_SESSION + ":3", {
    kind: "existing_topic", topicRef: TOPIC,
    projectRefs: [{ projectId: LEAD_PROJECT }],
    implementationDecision: { intent: "implement" },
  });

  assert.equal(record.expectsExecution, true);
  assert.equal(record.implementationDecision.intent, "implement");
  assert.equal(record.implementationDecision.source, "explicit_owner_turn");
});

test("the first durable implementation decision survives classification replay", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":4";
  ledger.record(ingress(4));
  var first = ledger.classify(id, {
    kind: "existing_topic",
    topicRef: TOPIC,
    implementationDecision: { intent: "implement", at: 4000 },
  });
  var replayed = ledger.classify(id, {
    kind: "existing_topic",
    topicRef: TOPIC,
    implementationDecision: { intent: "ship", at: 9000 },
  });

  assert.deepEqual(replayed.implementationDecision, first.implementationDecision);
  assert.deepEqual(replayed.implementationDecision, {
    intent: "implement",
    source: "explicit_owner_turn",
    at: 4000,
  });
});

test("a Main implementation decision is durably scoped to one exact typed task", function () {
  var file = tempFile();
  var ledger = makeLedger({ file: file });
  var id = "coop:" + COOP_SESSION + ":5";
  var scope = {
    projectRef: { projectId: LEAD_PROJECT },
    topicRef: TOPIC,
    portfolioTaskId: "owner-directed-task",
    bindingRevision: 1,
    idempotencyKey: "owner-directed-task-r1",
  };
  ledger.record(ingress(5));
  ledger.classify(id, {
    kind: "conversational",
    implementationDecision: { intent: "fix" },
  });

  var first = ledger.scopeImplementation(id, scope);
  var replay = ledger.scopeImplementation(id, scope);
  var mismatch = ledger.scopeImplementation(id,
    Object.assign({}, scope, { portfolioTaskId: "different-task" }));
  var reloaded = ownerRequests.attachCoopOwnerRequests({ file: file }).get(id);

  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(replay.ok, true);
  assert.equal(replay.reused, true);
  assert.deepEqual(mismatch, { ok: false, reason: "owner_implementation_scope_mismatch" });
  assert.deepEqual(reloaded.implementationScope, scope);
  assert.deepEqual(reloaded.topicRef, TOPIC);
  assert.deepEqual(reloaded.projectRefs, [{ projectId: LEAD_PROJECT }]);
});

test("one exact named-approval ingress retains each independently named task scope", function () {
  var file = tempFile();
  var ledger = makeLedger({ file: file });
  var id = "coop:" + COOP_SESSION + ":552";
  var firstScope = {
    projectRef: { projectId: LEAD_PROJECT },
    topicRef: TOPIC,
    portfolioTaskId: "clay-voice-panel-not-opening-regression-2026-08-21",
    bindingRevision: 3,
    idempotencyKey: "clay-voice-panel-not-opening-regression-2026-08-21-r3",
  };
  var secondScope = {
    projectRef: { projectId: LEAD_PROJECT },
    topicRef: TOPIC,
    portfolioTaskId: "clay-visible-worker-terminal-auto-hide-regression-2026-08-21",
    bindingRevision: 1,
    idempotencyKey: "clay-visible-worker-terminal-auto-hide-regression-2026-08-21-r1",
  };
  var itemDecision = {
    intent: "implement", source: "explicit_item_approval", at: 552000,
  };
  ledger.record(ingress(552));
  ledger.classify(id, { kind: "existing_topic", source: "ingress_route" });

  var first = ledger.scopeImplementation(id,
    Object.assign({}, firstScope, { implementationDecision: itemDecision }));
  var second = ledger.scopeImplementation(id,
    Object.assign({}, secondScope, { implementationDecision: itemDecision }));
  var unqualified = ledger.scopeImplementation(id, {
    projectRef: { projectId: LEAD_PROJECT },
    topicRef: TOPIC,
    portfolioTaskId: "clay-unapproved-third-task",
    bindingRevision: 1,
    idempotencyKey: "clay-unapproved-third-task-r1",
  });
  var reloaded = ownerRequests.attachCoopOwnerRequests({ file: file }).get(id);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true,
    "a second exact item in the same owner turn must not overwrite the first");
  assert.deepEqual(reloaded.implementationScope, firstScope,
    "legacy readers keep the first scope as their compatibility projection");
  assert.deepEqual(reloaded.implementationScopes, [firstScope, secondScope]);
  assert.deepEqual(unqualified,
    { ok: false, reason: "owner_implementation_scope_mismatch" },
    "a generic continuation cannot turn the named approval into a blanket grant");
});

test("a plural scope record never unions a divergent legacy projection into authority", function () {
  var first = {
    projectRef: { projectId: LEAD_PROJECT }, topicRef: TOPIC,
    portfolioTaskId: "clay-first-approved-task", bindingRevision: 1,
    idempotencyKey: "clay-first-approved-task-r1",
  };
  var injectedLegacy = {
    projectRef: { projectId: LEAD_PROJECT }, topicRef: TOPIC,
    portfolioTaskId: "clay-injected-legacy-task", bindingRevision: 1,
    idempotencyKey: "clay-injected-legacy-task-r1",
  };
  assert.deepEqual(ownerRequests.implementationScopesFor({
    implementationScope: injectedLegacy,
    implementationScopes: [first],
  }), [first]);
});

test("an unresolved ProjectRef records attention instead of silently dropping the request", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  var record = ledger.recordAttention(id, "project_target_unavailable");

  assert.equal(record.state, "attention");
  assert.equal(record.attention, "project_target_unavailable");
  // Attention is an owner-blocking state, so the request is still outstanding.
  assert.equal(record.response.state, "unanswered");
});

test("an unknown attention code is normalized rather than stored as free prose", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  var record = ledger.recordAttention(id, "the project named foo/bar could not be found on disk");

  assert.equal(record.attention, "attention_required");
});

// --- unanswered priority -----------------------------------------------------

test("unanswered returns oldest-first so the longest-waiting owner request leads", function () {
  var ledger = makeLedger();
  ledger.record(ingress(180));
  ledger.record(ingress(181));
  ledger.record(ingress(182));
  ledger.markAnswered("coop:" + COOP_SESSION + ":181", { eventIndex: 1815 });

  var pending = ledger.unanswered();
  assert.deepEqual(pending.map(function (r) { return r.ingressSequence; }), [180, 182]);
});

test("unanswered requests outrank routine work and say so", function () {
  var ledger = makeLedger();
  ledger.record(ingress(182));
  assert.equal(ledger.hasUnansweredOwnerRequests(), true);
  ledger.markAnswered("coop:" + COOP_SESSION + ":182", { eventIndex: 1825 });
  assert.equal(ledger.hasUnansweredOwnerRequests(), false);
});

test("a request answered but still working is not unanswered", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  ledger.markAnswered(id, { eventIndex: 1825 });
  ledger.setState(id, "working");

  assert.equal(ledger.unanswered().length, 0);
  assert.equal(ledger.hasUnansweredOwnerRequests(), false);
});

// --- fan-in ------------------------------------------------------------------

test("an execution outcome fans into the request without inventing an answer", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  ledger.classify(id, { kind: "new_topic", topicRef: TOPIC, projectRefs: [{ projectId: LEAD_PROJECT }] });
  ledger.setState(id, "working");
  ledger._clock.value = 3000;
  var record = ledger.applyOutcome(id, { status: "completed", summary: "Shipped the flow." });

  assert.equal(record.state, "done");
  assert.equal(record.outcome.status, "completed");
  assert.equal(record.outcome.at, 3000);
  assert.equal(record.response.state, "unanswered",
    "a completed execution is evidence, not an answer to the owner");
});

test("a failed execution moves the request to attention, not done", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  var record = ledger.applyOutcome(id, { status: "failed", summary: "Route unavailable." });

  assert.equal(record.state, "attention");
  assert.equal(record.outcome.status, "failed");
});

test("a needs_input outcome projects the owner decision onto the request", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  var record = ledger.applyOutcome(id, { status: "needs_input" });

  assert.equal(record.state, "needs_input");
});

test("requests for one topic are queryable so a follow-up finds the existing work", function () {
  var ledger = makeLedger();
  ledger.record(ingress(181));
  ledger.record(ingress(182));
  ledger.record(ingress(183));
  ledger.classify("coop:" + COOP_SESSION + ":181", { kind: "new_topic", topicRef: TOPIC });
  ledger.classify("coop:" + COOP_SESSION + ":182", { kind: "existing_topic", topicRef: TOPIC });
  ledger.classify("coop:" + COOP_SESSION + ":183", { kind: "new_topic", topicRef: OTHER_TOPIC });
  ledger.linkExecution("coop:" + COOP_SESSION + ":181", {
    coordinator: { projectId: LEAD_PROJECT, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" },
  });

  var forTopic = ledger.forTopic(TOPIC);
  assert.deepEqual(forTopic.map(function (r) { return r.ingressSequence; }), [181, 182]);
  assert.deepEqual(ledger.coordinatorsForTopic(TOPIC), [
    { projectId: LEAD_PROJECT, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" },
  ]);
});

// --- durability --------------------------------------------------------------

test("the ledger survives a restart with response and link state intact", function () {
  var file = tempFile();
  var first = makeLedger({ file: file });
  var id = "coop:" + COOP_SESSION + ":182";
  first.record(ingress(182));
  first.classify(id, { kind: "new_topic", topicRef: TOPIC, projectRefs: [{ projectId: LEAD_PROJECT }] });
  first.linkExecution(id, {
    coordinator: { projectId: LEAD_PROJECT, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" },
  });

  var reloaded = ownerRequests.attachCoopOwnerRequests({ file: file });
  var record = reloaded.get(id);
  assert.equal(record.response.state, "unanswered");
  assert.deepEqual(record.topicRef, TOPIC);
  assert.equal(record.links.coordinators.length, 1);
  assert.equal(reloaded.unanswered().length, 1);
});

test("links are deduplicated so a retried delegation does not inflate the record", function () {
  var ledger = makeLedger();
  var id = "coop:" + COOP_SESSION + ":182";
  var coordinator = { projectId: LEAD_PROJECT, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" };
  ledger.record(ingress(182));
  ledger.linkExecution(id, { coordinator: coordinator });
  ledger.linkExecution(id, { coordinator: coordinator });

  assert.equal(ledger.get(id).links.coordinators.length, 1);
});

test("mutations against an unknown ingress id are no-ops, never silent inserts", function () {
  var ledger = makeLedger();
  assert.equal(ledger.markAnswered("coop:missing:1", {}), null);
  assert.equal(ledger.classify("coop:missing:1", { kind: "new_topic" }), null);
  assert.equal(ledger.linkExecution("coop:missing:1", {}), null);
  assert.equal(ledger.applyOutcome("coop:missing:1", { status: "completed" }), null);
  assert.equal(ledger.list().length, 0);
});

// --- review finding: a failed write must not report success -------------------

function failingLedger(failAfter) {
  var writes = 0;
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-requests-fail-"));
  var realFs = require("fs");
  return ownerRequests.attachCoopOwnerRequests({
    file: path.join(dir, "r.json"),
    fs: {
      readFileSync: realFs.readFileSync,
      existsSync: realFs.existsSync,
      renameSync: realFs.renameSync,
      mkdirSync: realFs.mkdirSync,
      writeFileSync: function (target, data, options) {
        writes += 1;
        if (writes > failAfter) throw new Error("ENOSPC");
        return realFs.writeFileSync(target, data, options);
      },
    },
  });
}

test("a mutation whose write fails reports failure instead of a clean record", function () {
  var ledger = failingLedger(1);
  var id = "coop:" + COOP_SESSION + ":182";
  assert.ok(ledger.record(ingress(182)), "the first write succeeds");

  // Disk is now failing. markAnswered must NOT hand back a record claiming
  // answered when that fact never reached disk.
  assert.equal(ledger.markAnswered(id, { eventIndex: 5 }), null);
  // And in-memory state must not diverge from disk either.
  assert.equal(ledger.get(id).response.state, "unanswered");
  assert.equal(ledger.unanswered().length, 1);
});

test("a failed write leaves the prior value intact, not half-applied", function () {
  var ledger = failingLedger(2);
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  assert.ok(ledger.classify(id, { kind: "new_topic", topicRef: TOPIC }));

  assert.equal(ledger.setState(id, "working"), null);
  assert.equal(ledger.get(id).state, "open", "the state change was rolled back");
  assert.deepEqual(ledger.get(id).topicRef, TOPIC, "the earlier committed value survives");
});

// Review finding: persist() calls prune() BEFORE writing, so a failed write
// left the prune applied in memory while disk still held the evicted record.
// Rollback only restored the immediate mutation, never the prune.
test("a failed write does not silently evict a record from memory only", function () {
  var realFs = require("fs");
  var broken = false;
  var dir = realFs.mkdtempSync(path.join(os.tmpdir(), "clay-prune-"));
  var file = path.join(dir, "r.json");
  var ledger = ownerRequests.attachCoopOwnerRequests({
    file: file,
    fs: {
      readFileSync: realFs.readFileSync, existsSync: realFs.existsSync,
      renameSync: realFs.renameSync, mkdirSync: realFs.mkdirSync,
      writeFileSync: function (t, d, o) {
        if (broken) throw new Error("ENOSPC");
        return realFs.writeFileSync(t, d, o);
      },
    },
  });

  // Fill past the cap with settled records so the next insert triggers a prune.
  var cap = ownerRequests.MAX_RECORDS || 2000;
  for (var i = 1; i <= cap; i++) {
    var id = "coop:" + COOP_SESSION + ":" + i;
    ledger.record({ ingressId: id, ingressSequence: i,
      sessionRef: { projectId: LEAD_PROJECT, sessionStorageId: COOP_SESSION } });
    ledger.markAnswered(id, { eventIndex: i });
  }
  var before = ledger.list().length;

  broken = true;
  var overflow = ledger.record({ ingressId: "coop:" + COOP_SESSION + ":" + (cap + 1),
    ingressSequence: cap + 1,
    sessionRef: { projectId: LEAD_PROJECT, sessionStorageId: COOP_SESSION } });

  assert.equal(overflow, null, "the failed insert is reported as failed");
  assert.equal(ledger.list().length, before,
    "a failed write must not evict an older record from memory only");
  // And memory agrees with disk.
  var reloaded = ownerRequests.attachCoopOwnerRequests({ file: file });
  assert.equal(reloaded.list().length, ledger.list().length);
});

test("a newly created record has the same shape as one loaded from disk", function () {
  // Review finding: a fresh response omitted supersededAt/supersededBy while
  // normalizeResponse adds them on load, so ledger.list() changed shape across
  // a restart -- a strict retry-convergence check could never hold.
  var file = tempFile();
  var ledger = makeLedger({ file: file });
  ledger.record(ingress(182));

  var inMemory = ledger.list();
  var afterReload = ownerRequests.attachCoopOwnerRequests({ file: file }).list();
  assert.deepEqual(Object.keys(inMemory[0].response).sort(),
    Object.keys(afterReload[0].response).sort());
  assert.deepEqual(inMemory, afterReload, "memory and reload must agree exactly");
});

test("markAnswered returns the exact response shape that reload produces", function () {
  var file = tempFile();
  var ledger = makeLedger({ file: file });
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  var answered = ledger.markAnswered(id, { eventIndex: 1825 });
  var reloaded = ownerRequests.attachCoopOwnerRequests({ file: file }).get(id);

  assert.deepEqual(answered, reloaded,
    "a successful live mutation must converge exactly with its durable reload");
});

// --- approval carry-forward, the half this module can prove -------------------
//
// An owner approval is scoped to a task AT A REVISION. First scope wins, so a
// retry that bumps the revision loses it. Carry-forward is the owner's narrow
// exception, and it is split: this module proves the retry is the same work at
// exactly the next revision in the same ProjectRef and TopicRef, while the caller
// proves from the binding store that the exact approved revision failed and no
// matching completion consumed the approval. Both halves must hold.

function scopedLedger(revision, taskId, projectId) {
  var file = tempFile();
  var ledger = makeLedger({ file: file });
  var id = "coop:" + COOP_SESSION + ":182";
  ledger.record(ingress(182));
  ledger.classify(id, {
    kind: "existing_topic",
    source: "transcript_replay",
    topicRef: TOPIC,
    implementationDecision: { intent: "implement", source: "explicit_owner_turn", at: 500 },
  });
  var scoped = ledger.scopeImplementation(id, {
    projectRef: { projectId: projectId || LEAD_PROJECT },
    topicRef: TOPIC,
    portfolioTaskId: taskId || "carry-task",
    bindingRevision: revision,
    idempotencyKey: (taskId || "carry-task") + "-r" + revision,
  });
  assert.equal(scoped.ok, true);
  return { ledger: ledger, id: id, file: file };
}

function rescope(fixture, revision, extra) {
  return fixture.ledger.scopeImplementation(fixture.id, Object.assign({
    projectRef: { projectId: LEAD_PROJECT },
    topicRef: TOPIC,
    portfolioTaskId: "carry-task",
    bindingRevision: revision,
    idempotencyKey: "carry-task-r" + revision,
  }, extra || {}));
}

test("a carry-forward replaces the scope and records that it did", function () {
  var fixture = scopedLedger(1);

  var result = rescope(fixture, 2, { carryForward: true });

  assert.equal(result.ok, true);
  assert.equal(result.carriedForward, true);
  assert.equal(result.request.implementationScope.bindingRevision, 2);
  assert.equal(result.request.classification.source, "owner_directed_execution_carry_forward",
    "the carry-forward has to be durable rather than implicit");
});

test("a bumped revision without the carry-forward flag is still refused", function () {
  // First scope wins remains the default. Carry-forward is opt-in, and the caller
  // only earns it after checking the binding outcome history it can see and this
  // module cannot.
  var fixture = scopedLedger(1);

  var result = rescope(fixture, 2);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_implementation_scope_mismatch");
  assert.equal(fixture.ledger.get(fixture.id).implementationScope.bindingRevision, 1);
});

test("the carry-forward flag cannot walk an approval backwards or sideways", function () {
  // The flag is not a bypass: this module independently proves the retry is the
  // same work at exactly the next revision, so a caller asking for anything
  // else is refused here even with the flag set.
  [
    { revision: 1, extra: {}, why: "same revision" },
    { revision: 2, extra: { portfolioTaskId: "other-task", idempotencyKey: "other-task-r2" },
      why: "different task" },
    { revision: 2, extra: { projectRef: { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" } },
      why: "different project" },
  ].forEach(function (attempt) {
    var fixture = scopedLedger(3);
    var result = rescope(fixture, attempt.revision,
      Object.assign({ carryForward: true }, attempt.extra));
    assert.equal(result.ok, false, attempt.why + " must not carry forward");
    assert.equal(result.reason, "owner_implementation_scope_mismatch");
    assert.equal(fixture.ledger.get(fixture.id).implementationScope.bindingRevision, 3);
  });
});

test("the carry-forward flag cannot rewrite the durable Thread scope", function () {
  var fixture = scopedLedger(1);
  var before = fs.readFileSync(fixture.file, "utf8");

  var result = rescope(fixture, 2, {
    carryForward: true,
    topicRef: OTHER_TOPIC,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_implementation_scope_mismatch");
  assert.equal(fs.readFileSync(fixture.file, "utf8"), before,
    "a cross-Thread refusal must leave the durable ledger byte-stable");
});

test("an identical rescope is a reuse even when carry-forward is offered", function () {
  var fixture = scopedLedger(1);

  var result = rescope(fixture, 1, { carryForward: true });

  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(fixture.ledger.get(fixture.id).classification.source,
    "owner_directed_execution", "reuse must not be relabelled as a carry-forward");
});

// --- review scopes ------------------------------------------------------------

// scopeReview exists because review admission used to return ok and record
// nothing, which left the router with no durable evidence that a review turn
// covered a given task -- and therefore no way to bound the review branch of the
// history scan. That is what let owner turn :595 ("Do both") claim the route for
// unrelated work on 2026-08-23.
//
// Its safety property is the whole point: it must be unable to create
// implementation authority. A read-only "do them" carries no implementation
// decision, so scopeImplementation refuses it outright, and this must not become
// a way around that refusal.

function reviewScope(extra) {
  return Object.assign({
    projectRef: { projectId: LEAD_PROJECT },
    topicRef: TOPIC,
    portfolioTaskId: "clay-review-external-codex-recent-commits",
    bindingRevision: 2,
    idempotencyKey: "clay-review-external-codex-recent-commits-r2",
  }, extra || {});
}

test("a review scope records coverage without creating implementation authority", function () {
  var ledger = makeLedger();
  ledger.record(ingress(595));

  // The turn this models is "Do both": no implementation decision at all. The
  // implementation writer must refuse it, and does.
  assert.equal(ledger.scopeImplementation("coop:" + COOP_SESSION + ":595",
    reviewScope()).ok, false,
    "a turn with no implementation decision cannot write an implementation scope");

  var scoped = ledger.scopeReview("coop:" + COOP_SESSION + ":595", reviewScope());
  assert.equal(scoped.ok, true, JSON.stringify(scoped));

  var stored = ledger.get("coop:" + COOP_SESSION + ":595");
  assert.equal(ownerRequests.reviewScopesFor(stored).length, 1,
    "the review coverage is durable");

  // And none of the implementation-authority fields moved.
  assert.equal(stored.implementationDecision, null);
  assert.equal(stored.implementationScope, null);
  assert.equal(ownerRequests.implementationScopesFor(stored).length, 0,
    "a review scope must never appear as an implementation scope");
  assert.equal(stored.expectsExecution, false,
    "and it must not make the turn look like it expects execution");
});

test("review scopes are exact, idempotent, and never widen the record", function () {
  var ledger = makeLedger();
  ledger.record(ingress(332, { topicRef: TOPIC }));
  var id = "coop:" + COOP_SESSION + ":332";

  var first = ledger.scopeReview(id, reviewScope());
  assert.equal(first.ok, true);
  var again = ledger.scopeReview(id, reviewScope());
  assert.equal(again.ok, true);
  assert.equal(again.reused, true, "the same review re-dispatched reuses its record");
  assert.equal(ownerRequests.reviewScopesFor(ledger.get(id)).length, 1);

  // A second, genuinely different review from the same turn is additive: this is
  // the plural "do them" case, and each task gets its own exact scope.
  assert.equal(ledger.scopeReview(id, reviewScope({
    portfolioTaskId: "clay-other-review",
    idempotencyKey: "clay-other-review-r2",
  })).ok, true);
  var scopes = ownerRequests.reviewScopesFor(ledger.get(id));
  assert.equal(scopes.length, 2);

  // The record's own project set is untouched: review coverage must not enlarge
  // the set of projects the owner turn is taken to have named, because that feeds
  // implementation admission's project matching.
  assert.deepEqual(ledger.get(id).projectRefs, []);

  assert.equal(ledger.scopeReview(id, { projectRef: null }).ok, false,
    "an unusable scope is refused rather than stored");
  assert.equal(ledger.scopeReview("coop:" + COOP_SESSION + ":999", reviewScope()).ok, false,
    "and an unknown ingress cannot be scoped");
});

test("review scopes survive a reload, because normalizeRecord is a whitelist", function () {
  var file = tempFile();
  var ledger = makeLedger({ file: file });
  ledger.record(ingress(595));
  assert.equal(ledger.scopeReview("coop:" + COOP_SESSION + ":595", reviewScope()).ok, true);

  // Reopened from disk. Omitting reviewScopes from normalizeRecord would drop
  // coverage here silently, and the router would fall back to the newest-turn
  // rule without anything saying why.
  var reopened = makeLedger({ file: file });
  var stored = reopened.get("coop:" + COOP_SESSION + ":595");
  assert.equal(ownerRequests.reviewScopesFor(stored).length, 1,
    "review coverage must round-trip through the ledger file");
  assert.equal(ownerRequests.implementationScopesFor(stored).length, 0,
    "and must still not be implementation authority after a reload");
});
