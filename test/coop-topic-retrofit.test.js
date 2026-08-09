var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("node:crypto");
var retrofit = require("../lib/coop-topic-retrofit");
var classification = require("../lib/coop-topic-classification");

// Bounded, idempotent retrofit for topics minted before the classifier fixes
// (contraction collapse, fuller stopword list, low-information routing).
// Deliberately not a RETRO_VERSION bump: it only ever acts on already-open
// automatic topics using their already-proven anchors, rewriting .title (and
// .keywords) or rerouting membership into the uncategorised catch-all -- never
// .topicRef, so every existing link keeps working.

function ownerMsg(text, extra) {
  return Object.assign({
    type: "user_message", text: text,
    from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-" + text.length,
    _ts: 1000 + text.length,
  }, extra || {});
}

// Builds a canonical history with N owner turns at known indices, each
// followed by a delta/done pair, so provenTurnRefs resolves every start at
// the canonical offset 0.
function historyOf(texts) {
  var h = [];
  var starts = [];
  for (var i = 0; i < texts.length; i++) {
    starts.push(h.length);
    h.push(ownerMsg(texts[i]));
    h.push({ type: "delta", text: "reply", _ts: h.length });
    h.push({ type: "done", _ts: h.length });
  }
  return { history: h, starts: starts };
}

function turnRefsFor(starts) {
  return starts.map(function (i) { return { sessionStorageId: "s1", startEventIndex: i, endEventIndex: i + 2 }; });
}

// Builds an automatic topic whose topicId is a genuine, unmodified creation
// fingerprint for `title` -- exactly what isUnmodifiedAutomaticTitle expects:
// sha256(groupKey + "\n" + normalizeText(title)). Real auto-creation computes
// this once from the ORIGINAL derived title text and never recomputes it, so
// mirroring that same construction directly (rather than going through
// automaticTopicId, which re-derives a title from raw owner text) is what
// makes these fixtures behave like genuinely untouched automatic topics.
function groupKey(group) {
  return group && group.kind === "project" ? "project:" + group.projectRef.projectId : (group && group.kind) || "uncategorised";
}
function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function fingerprintTopicId(title, group) {
  var digest = crypto.createHash("sha256").update(groupKey(group) + "\n" + normalizeText(title)).digest("hex");
  return "auto-" + digest.slice(0, 24);
}
function automaticTopic(title, starts, group) {
  var grp = group || { kind: "uncategorised" };
  var id = fingerprintTopicId(title, grp);
  return {
    topicRef: { topicId: id }, title: title, group: grp, source: "automatic",
    status: "open", createdAt: 1, updatedAt: 1,
    keywords: [], eventRefs: [], turnRefs: turnRefsFor(starts), relatedExecutions: [],
  };
}

function uncategorisedTopic() {
  return {
    topicRef: { topicId: "uncategorised-conversations" }, title: "Uncategorised conversations",
    group: { kind: "uncategorised" }, source: "seed", status: "open",
    createdAt: 1, updatedAt: 1, keywords: [], eventRefs: [], turnRefs: [], relatedExecutions: [],
  };
}

function indexWith(topics) {
  var map = {};
  for (var i = 0; i < topics.length; i++) map[topics[i].topicRef.topicId] = topics[i];
  return { topics: map };
}

// --- retitling ---------------------------------------------------------------

test("an unmodified automatic title is regenerated from its own proven turn text", function () {
  var built = historyOf(["What do you mean by checking whether it should be delegated"]);
  var t = automaticTopic("What Mean Checking Should Delegated", built.starts);
  var idx = indexWith([t, uncategorisedTopic()]);

  var report = retrofit.retrofitTitles(idx, { historyFor: function () { return built.history; }, now: function () { return 42; } });

  assert.equal(report.retitled, 1);
  assert.equal(t.titleRetrofitAudit.action, "retitled");
  assert.equal(t.titleRetrofitAudit.schemaVersion, retrofit.TITLE_RETROFIT_SCHEMA_VERSION);
  assert.equal(report.entries[0].topicId, t.topicRef.topicId);
  assert.equal(report.entries[0].action, "retitled");
  assert.equal(report.entries[0].from, "What Mean Checking Should Delegated");
  assert.notEqual(t.title, "What Mean Checking Should Delegated");
});

test("a contraction-mangled title is regenerated coherently", function () {
  var built = historyOf(["Don't create a project, just categorise them"]);
  var t = automaticTopic("Don Create Project Categorised Them", built.starts);
  var idx = indexWith([t, uncategorisedTopic()]);
  retrofit.retrofitTitles(idx, { historyFor: function () { return built.history; } });
  assert.notEqual(t.title, "Don Create Project Categorised Them");
  assert.doesNotMatch(t.title, /\bDon\b/, "must not split the contraction into an orphan fragment again");
});

test("multiple proven turns are combined for a richer, still-coherent title", function () {
  var built = historyOf(["Renderer caching regression details", "Workbench Alpha verification needed"]);
  var t = automaticTopic("Renderer Caching Regression Details", [built.starts[0]]);
  t.turnRefs = turnRefsFor(built.starts);
  var idx = indexWith([t, uncategorisedTopic()]);
  retrofit.retrofitTitles(idx, { historyFor: function () { return built.history; } });
  assert.match(t.title, /Renderer/);
});

test("a legacy offset-proven anchor reads title text from the real owner message, not its boundary record", function () {
  // Legacy-shaped history (matches the owner's real persisted index): the
  // stored startEventIndex points at the record PRECEDING the owner turn, so
  // proveAnchor resolves it via the +1 fallback. The retrofit must read text
  // from the actual owner message, not the "done"/boundary record the ref
  // literally points at (which has no .text at all).
  var legacyHistory = [
    { type: "done", _ts: 0 }, // 0 boundary record the stored ref points at
    ownerMsg("Ghost binding fix is now implemented in the worktree"), // 1 real owner turn start
    { type: "delta", text: "reply", _ts: 2 },
    { type: "done", _ts: 3 },
  ];
  var t = automaticTopic("Out All Topics Currently Open", []);
  t.turnRefs = [{ sessionStorageId: "s1", startEventIndex: 0, endEventIndex: 2 }];
  var idx = indexWith([t, uncategorisedTopic()]);
  var report = retrofit.retrofitTitles(idx, { historyFor: function () { return legacyHistory; } });
  assert.equal(report.retitled, 1);
  assert.match(t.title, /Ghost|Binding|Implemented/);
});

// --- identity and explicit-title preservation --------------------------------

test("the topicId never changes -- existing links keep working", function () {
  var built = historyOf(["What do you mean by checking whether it should be delegated"]);
  var t = automaticTopic("What Mean Checking Should Delegated", built.starts);
  var id = t.topicRef.topicId;
  var idx = indexWith([t, uncategorisedTopic()]);
  retrofit.retrofitTitles(idx, { historyFor: function () { return built.history; } });
  assert.equal(t.topicRef.topicId, id, "a task's coopTopicRef pointing at this id must still resolve");
});

test("a title the owner (or anything else) changed since creation is never overwritten", function () {
  var built = historyOf(["What do you mean by checking whether it should be delegated"]);
  var t = automaticTopic("What Mean Checking Should Delegated", built.starts);
  t.title = "My own name for this"; // renamed after creation; topicId now mismatches its fingerprint
  var idx = indexWith([t, uncategorisedTopic()]);
  var report = retrofit.retrofitTitles(idx, { historyFor: function () { return built.history; } });
  assert.equal(t.title, "My own name for this");
  assert.equal(report.skippedOwnerModified, 1);
  assert.equal(t.titleRetrofitAudit.action, "skipped_owner_modified");
});

test("manual, split and seed topics are never touched, even with a fragment-shaped title", function () {
  var built = historyOf(["hi"]);
  var seedLike = uncategorisedTopic();
  var manual = {
    topicRef: { topicId: "legacy-manual-topic" }, title: "Ledger Reconciliation Rollout",
    group: { kind: "uncategorised" }, source: "manual", status: "open",
    createdAt: 1, updatedAt: 1, keywords: [], eventRefs: [], turnRefs: turnRefsFor(built.starts), relatedExecutions: [],
  };
  var idx = indexWith([manual, seedLike]);
  var report = retrofit.retrofitTitles(idx, { historyFor: function () { return built.history; } });
  assert.equal(report.checked, 0, "only source:automatic topics are ever considered");
  assert.equal(manual.title, "Ledger Reconciliation Rollout");
});

test("closed or merged automatic topics are never re-touched", function () {
  var built = historyOf(["What do you mean by checking whether it should be delegated"]);
  var t = automaticTopic("What Mean Checking Should Delegated", built.starts);
  t.status = "closed";
  var idx = indexWith([t, uncategorisedTopic()]);
  var report = retrofit.retrofitTitles(idx, { historyFor: function () { return built.history; } });
  assert.equal(report.checked, 0);
  assert.equal(t.title, "What Mean Checking Should Delegated");
});

// --- no proven anchor ---------------------------------------------------------

test("a topic with no proven anchor is left alone and recorded, not guessed at", function () {
  var t = automaticTopic("Resuming After Restart", [0]);
  // History does not contain an owner turn start at index 0 at all.
  var driftedHistory = [{ type: "done", _ts: 1 }, { type: "delta", text: "x", _ts: 2 }];
  var idx = indexWith([t, uncategorisedTopic()]);
  var report = retrofit.retrofitTitles(idx, { historyFor: function () { return driftedHistory; } });
  assert.equal(report.skippedNoProvenAnchor, 1);
  assert.equal(t.title, "Resuming After Restart");
  assert.equal(t.titleRetrofitAudit.action, "skipped_no_proven_anchor");
});

// --- low-information fragment routing -----------------------------------------

test("a low-information single-turn fragment is merged into uncategorised, not retitled", function () {
  var built = historyOf(["Where are we now"]);
  var t = automaticTopic("Where Arre Now", built.starts);
  var uncategorised = uncategorisedTopic();
  var idx = indexWith([t, uncategorised]);
  var report = retrofit.retrofitTitles(idx, { historyFor: function () { return built.history; }, now: function () { return 99; } });

  assert.equal(report.mergedToUncategorised, 1);
  assert.equal(t.status, "merged");
  assert.deepEqual(t.mergedInto, { topicId: "uncategorised-conversations" });
  assert.equal(t.titleRetrofitAudit.action, "merged_uncategorised");
  assert.equal(uncategorised.turnRefs.length, 1);
  assert.deepEqual(uncategorised.turnRefs[0], turnRefsFor(built.starts)[0]);
  assert.equal(t.title, "Where Arre Now", "the fragment's own title is left as-is; it just stops rendering");
});

test("a low-information fragment does not absorb unrelated conversation -- only its own membership moves", function () {
  var built = historyOf(["Where are we now"]);
  var t = automaticTopic("Where Arre Now", built.starts);
  var uncategorised = uncategorisedTopic();
  uncategorised.turnRefs = [{ sessionStorageId: "s1", startEventIndex: 900, endEventIndex: 902 }];
  var idx = indexWith([t, uncategorised]);
  retrofit.retrofitTitles(idx, { historyFor: function () { return built.history; } });
  assert.equal(uncategorised.turnRefs.length, 2, "the pre-existing unrelated membership is preserved, not replaced");
  var indices = uncategorised.turnRefs.map(function (r) { return r.startEventIndex; }).sort(function (a, b) { return a - b; });
  assert.deepEqual(indices, [0, 900]);
});

test("a substantive multi-word topic is retitled, not merged, even with few turns", function () {
  var built = historyOf(["Renderer caching regression details in Workbench Alpha must be verified"]);
  var t = automaticTopic("Renderer Caching Regression Details Workbench", built.starts);
  var uncategorised = uncategorisedTopic();
  var idx = indexWith([t, uncategorised]);
  var report = retrofit.retrofitTitles(idx, { historyFor: function () { return built.history; } });
  assert.equal(report.mergedToUncategorised, 0);
  assert.equal(t.status, "open");
});

// --- idempotency and restart stability ----------------------------------------

test("running the retrofit twice is a no-op the second time", function () {
  var built = historyOf(["What do you mean by checking whether it should be delegated"]);
  var t = automaticTopic("What Mean Checking Should Delegated", built.starts);
  var idx = indexWith([t, uncategorisedTopic()]);
  var deps = { historyFor: function () { return built.history; }, now: function () { return 1; } };

  retrofit.retrofitTitles(idx, deps);
  var titleAfterFirst = t.title;
  var auditAfterFirst = JSON.parse(JSON.stringify(t.titleRetrofitAudit));

  var second = retrofit.retrofitTitles(idx, { historyFor: function () { return built.history; }, now: function () { return 2; } });
  assert.equal(t.title, titleAfterFirst, "title must not churn on repeat");
  assert.deepEqual(t.titleRetrofitAudit, auditAfterFirst, "audit must not be rewritten by a later run");
  assert.equal(second.retitled, 0);
  assert.equal(second.unchanged, 1);
});

test("a merge is also permanently idempotent across repeated runs", function () {
  var built = historyOf(["Where are we now"]);
  var t = automaticTopic("Where Arre Now", built.starts);
  var uncategorised = uncategorisedTopic();
  var idx = indexWith([t, uncategorised]);
  var deps = { historyFor: function () { return built.history; } };

  retrofit.retrofitTitles(idx, deps);
  assert.equal(uncategorised.turnRefs.length, 1);

  var second = retrofit.retrofitTitles(idx, deps);
  assert.equal(uncategorised.turnRefs.length, 1, "no duplicate turnRefs from a repeat run");
  assert.equal(second.mergedToUncategorised, 0);
  assert.equal(second.checked, 0, "a merged topic is no longer open, so it is not even considered again");
});

test("idempotent and restart-stable across a JSON round trip", function () {
  var built = historyOf(["Don't create a project, just categorise them"]);
  var t = automaticTopic("Don Create Project Categorised Them", built.starts);
  var idx = indexWith([t, uncategorisedTopic()]);
  var deps = { historyFor: function () { return built.history; } };

  retrofit.retrofitTitles(idx, deps);
  var titleAfterFirst = idx.topics[t.topicRef.topicId].title;
  var serialized = JSON.parse(JSON.stringify(idx));
  var report = retrofit.retrofitTitles(serialized, deps);

  assert.equal(report.retitled, 0, "restart must not re-retitle a topic already fixed before the restart");
  assert.equal(report.unchanged, 1);
  assert.equal(serialized.topics[t.topicRef.topicId].title, titleAfterFirst);
});

// --- canonical history is read-only -------------------------------------------

test("canonical session history is never mutated by the retrofit", function () {
  var built = historyOf(["What do you mean by checking whether it should be delegated", "Where are we now"]);
  var snapshot = JSON.parse(JSON.stringify(built.history));
  var t1 = automaticTopic("What Mean Checking Should Delegated", [built.starts[0]]);
  var t2 = automaticTopic("Where Arre Now", [built.starts[1]]);
  var idx = indexWith([t1, t2, uncategorisedTopic()]);
  retrofit.retrofitTitles(idx, { historyFor: function () { return built.history; } });
  assert.deepEqual(built.history, snapshot);
});

// --- before/after inventory ----------------------------------------------------

test("the report is a complete before/after inventory across every outcome", function () {
  var built = historyOf([
    "What do you mean by checking whether it should be delegated",
    "Where are we now",
  ]);
  var retitleCandidate = automaticTopic("What Mean Checking Should Delegated", [built.starts[0]]);
  var mergeCandidate = automaticTopic("Where Arre Now", [built.starts[1]]);
  var renamedByOwner = automaticTopic("Some Auto Title", []);
  renamedByOwner.title = "Owner's Own Name";
  renamedByOwner.turnRefs = turnRefsFor([built.starts[0]]);
  var driftedNoAnchor = automaticTopic("Resuming After Restart", [500]);

  var idx = indexWith([retitleCandidate, mergeCandidate, renamedByOwner, driftedNoAnchor, uncategorisedTopic()]);
  var report = retrofit.retrofitTitles(idx, { historyFor: function () { return built.history; } });

  assert.equal(report.checked, 4);
  assert.equal(report.retitled, 1);
  assert.equal(report.mergedToUncategorised, 1);
  assert.equal(report.skippedOwnerModified, 1);
  assert.equal(report.skippedNoProvenAnchor, 1);
  assert.equal(report.entries.length, 4);
  var actions = report.entries.map(function (e) { return e.action; }).sort();
  assert.deepEqual(actions, ["merged_uncategorised", "retitled", "skipped_no_proven_anchor", "skipped_owner_modified"]);
});
