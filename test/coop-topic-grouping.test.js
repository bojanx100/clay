var test = require("node:test");
var assert = require("node:assert/strict");
var os = require("node:os");
var fs = require("node:fs");
var path = require("node:path");

var classification = require("../lib/coop-topic-classification");
var consolidation = require("../lib/coop-topic-consolidation");
var closure = require("../lib/coop-topic-closure");
var topics = require("../lib/coop-topic-index");

// Owner complaints this file pins, verbatim from the transcript:
//   "ok SO WHY DO I HAVE |THIS MUCH TOPICS?!??"           (ingress 148)
//   "Topics are not good enough, it's not grouped..."      (ingress 149)
//   "we can't have 7 topics for one session"               (ingress 150)
//   "topics don't look good at all"                        (ingress 166)
//   "close all open topic except ones that have matching
//    session in one of the projects"                       (ingress 134)
//
// The defect: classifyIngress minted a brand-new automatic topic whenever a
// turn scored fewer than two keyword overlaps against every existing topic.
// Ordinary follow-ups ("topics don't look good at all") share exactly one word
// with the conversation they belong to, so each one bought its own sidebar row.

var SEEDS = topics.SEEDS;

function makeTopic(id, title, group, source, now, keywords) {
  return {
    topicRef: { topicId: id }, title: title, group: group, source: source,
    keywords: Array.isArray(keywords) ? keywords.slice(0, 8) : [],
    status: "open", createdAt: now, updatedAt: now, eventRefs: [], turnRefs: [], relatedExecutions: [],
  };
}

function matchesSeed(text, seed) {
  var value = String(text || "").toLowerCase();
  if (!value || seed.catchAll) return false;
  for (var i = 0; i < seed.words.length; i++) if (value.indexOf(seed.words[i]) !== -1) return true;
  return false;
}

// The same option seam coop-topic-index.js builds in classifier(), so these
// unit tests exercise the real production wiring rather than a lookalike.
function options(recentTopic, projects) {
  return {
    seeds: SEEDS, matchesSeed: matchesSeed, normalizeGroup: topics.normalizeGroup,
    makeTopic: makeTopic, now: function () { return 1000; }, topicRef: topics.topicRef,
    canAccessProject: function () { return true; }, projects: projects || [],
    recentTopic: recentTopic || null,
  };
}

function turnRefs(count, start) {
  var refs = [];
  for (var i = 0; i < count; i++) {
    refs.push({ projectId: "system-lead", sessionStorageId: "canonical-home", startEventIndex: (start || 0) + i * 3, endEventIndex: (start || 0) + i * 3 + 2 });
  }
  return refs;
}

// A realistic slice of the live owner index: one genuine conversation about
// topic grouping plus the single-turn fragments the old rule split off it.
function ownerFixture() {
  var index = { schemaVersion: 1, canonicalSessionStorageId: "canonical-home", topics: {}, retro: { version: 3, completedEventCount: 100 } };
  index.topics["uncategorised-conversations"] = makeTopic("uncategorised-conversations", "Uncategorised conversations", { kind: "uncategorised" }, "automatic", 1, []);
  index.topics["auto-a7daa4cc660639337d144d93"] = makeTopic(
    "auto-a7daa4cc660639337d144d93", "Maybe topics should match session names once created…",
    { kind: "uncategorised" }, "automatic", 1, ["maybe", "topics", "match", "session", "names"]);
  index.topics["auto-a7daa4cc660639337d144d93"].turnRefs = turnRefs(6, 0);
  return index;
}

// ---------------------------------------------------------------------------
// Deliverable 1: minting a new automatic topic is now genuinely exceptional.
// ---------------------------------------------------------------------------

test("a follow-up turn about an existing conversation reuses that topic instead of minting", function () {
  var index = ownerFixture();
  var before = Object.keys(index.topics).length;
  // Owner ingress 166. Shares exactly ONE keyword ("topics") with the
  // conversation it belongs to, so the old >=2 rule minted a fresh row.
  var result = classification.classifyIngress(index, "Topics don't look good at all", null, options());
  assert.equal(result.ok, true);
  assert.equal(result.created, false, "an ordinary follow-up must not mint a topic");
  assert.equal(result.topic.topicRef.topicId, "auto-a7daa4cc660639337d144d93");
  assert.equal(Object.keys(index.topics).length, before, "no new row was added to the index");
});

test("a one-word overlap folds into the established conversation, not the smallest id", function () {
  var index = ownerFixture();
  // Two rival single-overlap hosts. The established conversation (more turn
  // spans) must win, and the tie-break must not be lexical id order or a
  // timestamp.
  index.topics["auto-000000000000000000000000"] = makeTopic(
    "auto-000000000000000000000000", "Sidebar topics row spacing", { kind: "uncategorised" },
    "automatic", 1, ["sidebar", "topics", "row", "spacing"]);
  index.topics["auto-000000000000000000000000"].turnRefs = turnRefs(1, 90);
  index.topics["auto-000000000000000000000000"].updatedAt = 9999999;
  var result = classification.classifyIngress(index, "Topics don't look good at all", null, options());
  assert.equal(result.topic.topicRef.topicId, "auto-a7daa4cc660639337d144d93",
    "the six-turn conversation outranks a one-turn fragment with a newer updatedAt");
});

test("a genuinely new subject still mints its own topic", function () {
  var index = ownerFixture();
  var before = Object.keys(index.topics).length;
  var result = classification.classifyIngress(index, "The provider catalog refuses to fall back when copilot quota is exhausted", null, options());
  assert.equal(result.ok, true);
  assert.equal(result.created, true, "a subject that overlaps nothing existing is still a new topic");
  assert.match(result.topic.topicRef.topicId, /^auto-[a-f0-9]{24}$/);
  assert.equal(Object.keys(index.topics).length, before + 1);
});

test("a bare identifier is never a topic of its own", function () {
  var index = ownerFixture();
  var before = Object.keys(index.topics).length;
  // Live index row auto-e2375348589c4419c3e2e8b5 was titled with a raw session
  // uuid: five "content" tokens, zero words. A throwaway fragment pinned in the
  // sidebar forever, exactly the regression the module header warns about.
  var result = classification.classifyIngress(index, "019ff342-2aff-7be2-8295-f1a0a0565e3c", null, options(index.topics["auto-a7daa4cc660639337d144d93"]));
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(Object.keys(index.topics).length, before, "an identifier mints nothing");
});

test("a vague remark with nothing recent lands in the catch-all rather than a new row", function () {
  var index = ownerFixture();
  var before = Object.keys(index.topics).length;
  var result = classification.classifyIngress(index, "Now what about the stuff you never answered", null, options());
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(Object.keys(index.topics).length, before);
});

test("a shared filler word is not evidence two turns are the same conversation", function () {
  var index = ownerFixture();
  // Measured on the live index: "Now what about the stuff you never answered"
  // was folding into "Theres's a bunch of coop sessions now" purely because both
  // contain "now". Reuse must key on subject words, never on shared phrasing.
  index.topics["auto-666666666666666666666666"] = makeTopic("auto-666666666666666666666666",
    "Theres's a bunch of coop sessions now…", { kind: "uncategorised" }, "automatic", 1,
    ["theress", "bunch", "coop", "sessions", "now"]);
  index.topics["auto-666666666666666666666666"].turnRefs = turnRefs(3, 80);
  var result = classification.classifyIngress(index, "Now what about the stuff you never answered", null, options());
  assert.notEqual(result.topic.topicRef.topicId, "auto-666666666666666666666666",
    "\"now\" is shared phrasing, not a shared subject");
  assert.equal(result.topic.topicRef.topicId, "uncategorised-conversations");
  assert.equal(result.created, false);
});

test("the retro pass does not group fragments on filler words either", function () {
  var index = ownerFixture();
  var host = index.topics["auto-a7daa4cc660639337d144d93"];
  host.keywords = ["theress", "bunch", "coop", "sessions", "now"];
  var fragment = authenticAuto(index, "Now what about the stuff you never answered", ["now", "stuff", "never", "answered"]);
  fragment.turnRefs = turnRefs(1, 80);
  var report = consolidation.consolidateTopics(index, { now: function () { return 2000; } });
  assert.equal(report.merged, 0);
  assert.equal(report.keptNoHost, 1, "a filler-word overlap is not a host match");
  assert.equal(index.topics[fragment.topicRef.topicId].status, "open");
});

test("classification stays deterministic: same input, same topic id", function () {
  // Acceptance criterion 3. Neither insertion order, nor updatedAt, nor a
  // clock may change which topic a turn lands in.
  var forward = ownerFixture();
  forward.topics["auto-111111111111111111111111"] = makeTopic("auto-111111111111111111111111", "Session recovery after reconnect", { kind: "uncategorised" }, "automatic", 1, ["session", "recovery", "reconnect"]);
  forward.topics["auto-111111111111111111111111"].turnRefs = turnRefs(2, 60);

  var reversed = { schemaVersion: 1, canonicalSessionStorageId: "canonical-home", topics: {}, retro: forward.retro };
  var ids = Object.keys(forward.topics).reverse();
  for (var i = 0; i < ids.length; i++) {
    reversed.topics[ids[i]] = JSON.parse(JSON.stringify(forward.topics[ids[i]]));
    // Wall-clock skew in the opposite direction to the insertion order.
    reversed.topics[ids[i]].updatedAt = 5000 - i;
  }

  var text = "Topics and session names should line up";
  var a = classification.classifyIngress(forward, text, null, options());
  var b = classification.classifyIngress(reversed, text, null, options());
  assert.equal(a.topic.topicRef.topicId, b.topic.topicRef.topicId,
    "iteration order and updatedAt must not decide the landing topic");
  var again = classification.classifyIngress(forward, text, null, options());
  assert.equal(again.topic.topicRef.topicId, a.topic.topicRef.topicId);
});

test("sealed topics still never gain a turn under the relaxed reuse rule", function () {
  var index = ownerFixture();
  index.topics["auto-a7daa4cc660639337d144d93"].status = "closed";
  var before = Object.keys(index.topics).length;
  var result = classification.classifyIngress(index, "Topics don't look good at all", null, options());
  assert.equal(result.ok, true);
  assert.equal(result.topic.topicRef.topicId, "uncategorised-conversations",
    "a closed conversation is not a reuse candidate; the catch-all takes the turn");
  assert.equal(Object.keys(index.topics).length, before);
});

test("the relaxed reuse rule never crosses a project boundary on weak evidence", function () {
  var index = ownerFixture();
  var CLAY = topics.CLAY_PROJECT_ID;
  index.topics["auto-222222222222222222222222"] = makeTopic("auto-222222222222222222222222",
    "Renderer caching in Workbench Alpha", { kind: "project", projectRef: { projectId: CLAY } },
    "automatic", 1, ["renderer", "caching", "workbench"]);
  index.topics["auto-222222222222222222222222"].turnRefs = turnRefs(4, 30);
  var projects = [
    { projectId: CLAY, slug: "alpha", title: "Workbench Alpha" },
    { projectId: "6332aafc-31e7-5cb1-ba96-c8d90e78260e", slug: "beta", title: "Beta Platform" },
  ];
  // Two projects named at once infers cross_project. A single shared keyword
  // ("workbench") must not drag the turn into the Clay-scoped lens.
  var result = classification.classifyIngress(index, "Workbench Alpha and Beta Platform boundary review", null, options(null, projects));
  assert.equal(result.created, true);
  assert.equal(result.topic.group.kind, "cross_project");
});

// ---------------------------------------------------------------------------
// Deliverable 2: the retro consolidation pass.
// ---------------------------------------------------------------------------

// Every id here must be recomputed so isUnmodifiedAutomaticTitle agrees the
// title is still exactly what auto-creation derived.
function authenticAuto(index, title, keywords, group) {
  var id = classification.automaticTopicId(title, group || { kind: "uncategorised" });
  var topic = makeTopic(id, classification.derivedMetadata(title).title, group || { kind: "uncategorised" }, "automatic", 1, keywords);
  index.topics[id] = topic;
  return topic;
}

function consolidationFixture() {
  var index = ownerFixture();
  // Single-turn automatic fragments split off the same conversation.
  index.topics["auto-1f681760afd2b639fca4a7bb"] = makeTopic("auto-1f681760afd2b639fca4a7bb",
    "And now you closed topics, and somehow webapp…", { kind: "uncategorised" }, "automatic", 1,
    ["now", "closed", "topics", "somehow", "webapp"]);
  index.topics["auto-1f681760afd2b639fca4a7bb"].turnRefs = turnRefs(1, 40);
  index.topics["auto-d57a2f02a744eaa96d9507e8"] = makeTopic("auto-d57a2f02a744eaa96d9507e8",
    "Topics don't look good at all", { kind: "uncategorised" }, "automatic", 1, ["topics", "look", "good"]);
  index.topics["auto-d57a2f02a744eaa96d9507e8"].turnRefs = turnRefs(1, 43);
  // Unrelated single-turn fragment: shares nothing, so it keeps its row.
  var unrelated = authenticAuto(index, "Codex quota exhausted overnight", ["codex", "quota", "exhausted", "overnight"]);
  unrelated.turnRefs = turnRefs(1, 46);
  index.unrelatedFragmentId = unrelated.topicRef.topicId;
  return index;
}

test("the consolidation pass merges single-turn fragments into the conversation they belong to", function () {
  var index = consolidationFixture();
  var openBefore = consolidation.openTopicCount(index);
  var report = consolidation.consolidateTopics(index, { now: function () { return 2000; } });
  var openAfter = consolidation.openTopicCount(index);

  assert.equal(report.merged, 2, "both fragments folded into the six-turn conversation");
  assert.equal(index.topics["auto-1f681760afd2b639fca4a7bb"].status, "merged");
  assert.deepEqual(index.topics["auto-1f681760afd2b639fca4a7bb"].mergedInto, { topicId: "auto-a7daa4cc660639337d144d93" });
  assert.equal(index.topics["auto-d57a2f02a744eaa96d9507e8"].status, "merged");
  assert.equal(index.topics[index.unrelatedFragmentId].status, "open", "an unrelated fragment keeps its own row");
  assert.equal(openAfter, openBefore - 2);
  // Membership is preserved, never dropped: the host now owns the turn spans.
  assert.equal(index.topics["auto-a7daa4cc660639337d144d93"].turnRefs.length, 8);
});

test("the consolidation pass never touches manual, split, seeded, renamed, closed or merged topics", function () {
  var index = ownerFixture();
  var CLAY = topics.CLAY_PROJECT_ID;

  index.topics["manual-thread"] = makeTopic("manual-thread", "Topics manual thread", { kind: "uncategorised" }, "manual", 1, ["topics", "manual"]);
  index.topics["manual-thread"].turnRefs = turnRefs(1, 10);
  index.topics["split-thread"] = makeTopic("split-thread", "Topics split thread", { kind: "uncategorised" }, "split", 1, ["topics", "split"]);
  index.topics["split-thread"].turnRefs = turnRefs(1, 13);
  // A seed shares source "automatic" but keeps a readable, stable id.
  index.topics["clay-sidebar-hierarchy"] = makeTopic("clay-sidebar-hierarchy", "Clay sidebar hierarchy", { kind: "project", projectRef: { projectId: CLAY } }, "automatic", 1, ["sidebar", "topics"]);
  index.topics["clay-sidebar-hierarchy"].turnRefs = turnRefs(1, 16);
  // Owner-renamed: an authentic auto id whose title has since drifted.
  var renamed = authenticAuto(index, "Topics grouping needs rework everywhere", ["topics", "grouping", "rework"]);
  renamed.title = "Owner's own name for this thread";
  renamed.turnRefs = turnRefs(1, 19);
  var closed = authenticAuto(index, "Topics closed conversation thread", ["topics", "closed", "conversation"]);
  closed.status = "closed";
  closed.turnRefs = turnRefs(1, 22);
  var merged = authenticAuto(index, "Topics merged conversation thread", ["topics", "merged", "conversation"]);
  merged.status = "merged";
  merged.mergedInto = { topicId: "auto-a7daa4cc660639337d144d93" };
  merged.turnRefs = turnRefs(1, 25);
  // Owner routed a message at this exact lens, and this one carries work.
  var routed = authenticAuto(index, "Topics routing evidence thread", ["topics", "routing", "evidence"]);
  routed.explicitlyRouted = true;
  routed.turnRefs = turnRefs(1, 28);
  var linked = authenticAuto(index, "Topics linked execution thread", ["topics", "linked", "execution"]);
  linked.relatedExecutions = [{ projectRef: { projectId: CLAY } }];
  linked.turnRefs = turnRefs(1, 31);
  var ruled = authenticAuto(index, "Topics owner disposition thread", ["topics", "disposition", "ruled"]);
  ruled.ownerDisposition = { status: "needs_input" };
  ruled.turnRefs = turnRefs(1, 34);

  var report = consolidation.consolidateTopics(index, { now: function () { return 2000; } });

  assert.equal(report.merged, 0, "nothing in this fixture is eligible");
  assert.equal(index.topics["manual-thread"].status, "open");
  assert.equal(index.topics["split-thread"].status, "open");
  assert.equal(index.topics["clay-sidebar-hierarchy"].status, "open");
  assert.equal(index.topics[renamed.topicRef.topicId].status, "open");
  assert.equal(index.topics[renamed.topicRef.topicId].title, "Owner's own name for this thread");
  assert.equal(index.topics[closed.topicRef.topicId].status, "closed", "a closed topic is never reopened or re-merged");
  assert.equal(index.topics[merged.topicRef.topicId].status, "merged");
  assert.equal(index.topics[routed.topicRef.topicId].status, "open");
  assert.equal(index.topics[linked.topicRef.topicId].status, "open");
  assert.equal(index.topics[ruled.topicRef.topicId].status, "open");
});

test("a fragment is never merged into another fragment, so consolidation cannot chain", function () {
  var index = ownerFixture();
  delete index.topics["auto-a7daa4cc660639337d144d93"];
  var a = authenticAuto(index, "Topics sidebar fragment one here", ["topics", "sidebar", "fragment"]);
  a.turnRefs = turnRefs(1, 40);
  var b = authenticAuto(index, "Topics sidebar fragment two here", ["topics", "sidebar", "fragment"]);
  b.turnRefs = turnRefs(1, 43);
  var report = consolidation.consolidateTopics(index, { now: function () { return 2000; } });
  assert.equal(report.merged, 0, "with no established host, both fragments stay put");
  assert.equal(index.topics[a.topicRef.topicId].status, "open");
  assert.equal(index.topics[b.topicRef.topicId].status, "open");
});

test("the consolidation pass is idempotent in memory and across a restart", function () {
  var index = consolidationFixture();
  var first = consolidation.consolidateTopics(index, { now: function () { return 2000; } });
  assert.equal(first.merged, 2);
  var second = consolidation.consolidateTopics(index, { now: function () { return 3000; } });
  assert.equal(second.merged, 0, "a second in-memory pass changes nothing");
  // Simulated restart: serialise and reload exactly as the index file does.
  var reloaded = JSON.parse(JSON.stringify(index));
  var third = consolidation.consolidateTopics(reloaded, { now: function () { return 4000; } });
  assert.equal(third.merged, 0, "the result persisted, so a restart never re-runs the merge");
  assert.equal(reloaded.topics["auto-a7daa4cc660639337d144d93"].turnRefs.length, 8,
    "membership is not duplicated on the second pass");
});

test("the exactly-once migration stamps the index so a restart does not re-run it", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "coop-consolidate-"));
  var file = path.join(dir, "coop-topic-index.json");
  try {
    var seeded = consolidationFixture();
    seeded.canonicalSessionStorageId = "canonical-home";
    fs.writeFileSync(file, JSON.stringify(seeded, null, 2));
    var session = {
      coopHome: true, storageId: "canonical-home",
      history: [{ type: "user_message", text: "topics should group", from: "a66ce4a1", fromName: "Admin" }, { type: "done" }],
    };
    var index = topics.createTopicIndex({ file: file, now: function () { return 2000; } });
    var run = index.ensureTopicConsolidation(session);
    assert.equal(run.ok, true);
    assert.equal(run.changed, true);
    assert.equal(run.report.merged, 2);
    assert.equal(index.load().topicConsolidation.schemaVersion, consolidation.CONSOLIDATION_SCHEMA_VERSION);

    var again = index.ensureTopicConsolidation(session);
    assert.equal(again.alreadyComplete, true);
    assert.equal(again.changed, false);

    var restarted = topics.createTopicIndex({ file: file, now: function () { return 5000; } });
    var afterRestart = restarted.ensureTopicConsolidation(session);
    assert.equal(afterRestart.alreadyComplete, true, "the stamp survived the restart");
    assert.equal(afterRestart.changed, false);
    assert.equal(restarted.load().topics["auto-a7daa4cc660639337d144d93"].turnRefs.length, 8);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the consolidation migration is reachable from the projection path, not just callable", function () {
  // The two sibling migrations run from lib/global-coop-projection.js because
  // that is the one daemon path proven to execute with the real cached canonical
  // session. A migration nothing calls fixes nothing, so this pins the wiring.
  var source = fs.readFileSync(path.join(__dirname, "..", "lib", "global-coop-projection.js"), "utf8");
  assert.match(source, /index\.ensureTopicConsolidation\(session\)/);
  // Ordered after the title retrofit (settled titles) and before the disposition
  // backfill (so a folded fragment never gets its own needs-input row).
  assert.ok(source.indexOf("ensureTitleRetrofit(session)") < source.indexOf("ensureTopicConsolidation(session)"));
  assert.ok(source.indexOf("ensureTopicConsolidation(session)") < source.indexOf("ensureDispositionBackfill(session)"));
});

test("the migration fails closed without stamping when the canonical history is unavailable", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "coop-consolidate-empty-"));
  var file = path.join(dir, "coop-topic-index.json");
  try {
    var seeded = consolidationFixture();
    seeded.canonicalSessionStorageId = "canonical-home";
    fs.writeFileSync(file, JSON.stringify(seeded, null, 2));
    var index = topics.createTopicIndex({ file: file, now: function () { return 2000; } });
    var run = index.ensureTopicConsolidation({ coopHome: true, storageId: "canonical-home", history: [] });
    assert.equal(run.ok, false);
    assert.equal(run.code, "canonical_history_unavailable");
    assert.equal(index.load().topicConsolidation, undefined, "the once-only stamp was not burned");
    assert.equal(index.load().topics["auto-d57a2f02a744eaa96d9507e8"].status, "open");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("consolidation measurably cuts the owner-visible topic count on a realistic fixture", function () {
  var index = consolidationFixture();
  // Add the rest of the live single-turn fragments that share the subject.
  authenticAuto(index, "Analyse all topics and close what needs closing", ["analyse", "topics", "close", "needs", "closing"]).turnRefs = turnRefs(1, 50);
  authenticAuto(index, "Session topics sidebar still shows too many", ["session", "topics", "sidebar", "shows"]).turnRefs = turnRefs(1, 53);
  var before = consolidation.openTopicCount(index);
  consolidation.consolidateTopics(index, { now: function () { return 2000; } });
  var after = consolidation.openTopicCount(index);
  assert.equal(before, 7);
  assert.equal(after, 3, "seven open rows become three: the conversation, the catch-all, one unrelated subject");
});

// ---------------------------------------------------------------------------
// Deliverable 3: ingress 134, as an owner-confirmable action.
// ---------------------------------------------------------------------------

function closureFixture() {
  var index = ownerFixture();
  var CLAY = topics.CLAY_PROJECT_ID;
  index.topics["auto-444444444444444444444444"] = makeTopic("auto-444444444444444444444444",
    "Provider fallback rework", { kind: "uncategorised" }, "automatic", 1, ["provider", "fallback"]);
  index.topics["auto-444444444444444444444444"].turnRefs = turnRefs(2, 70);
  index.topics["auto-444444444444444444444444"].relatedExecutions = [{ projectRef: { projectId: CLAY } }];
  index.topics["auto-555555555555555555555555"] = makeTopic("auto-555555555555555555555555",
    "Sidebar hierarchy rebuild", { kind: "uncategorised" }, "automatic", 1, ["sidebar", "hierarchy"]);
  index.topics["auto-555555555555555555555555"].turnRefs = turnRefs(2, 76);
  return index;
}

test("closure selection keeps topics with a matching session or linked execution", function () {
  var index = closureFixture();
  var proposal = closure.selectClosureCandidates(index, {
    sessions: [{ name: "Sidebar hierarchy rebuild" }],
  });
  var ids = proposal.map(function (entry) { return entry.topicId; });
  assert.equal(ids.indexOf("auto-444444444444444444444444"), -1, "a linked execution keeps a topic open");
  assert.equal(ids.indexOf("auto-555555555555555555555555"), -1, "a matching session name keeps a topic open");
  assert.equal(ids.indexOf("uncategorised-conversations"), -1, "the catch-all is never a closure candidate");
  assert.deepEqual(ids, ["auto-a7daa4cc660639337d144d93"]);
  assert.equal(proposal[0].reason, "no_matching_session_or_execution");
});

test("proposing closures closes nothing until the owner confirms", function () {
  var index = closureFixture();
  var proposed = closure.proposeClosures(index, { sessions: [], now: function () { return 2000; } });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.candidates.length, 2, "the catch-all and the execution-linked topic are never candidates");
  assert.match(proposed.proposalId, /^close-[a-f0-9]{16}$/);
  var stillOpen = Object.keys(index.topics).filter(function (id) { return index.topics[id].status === "open"; });
  assert.equal(stillOpen.length, 4, "a proposal is a question, not a bulk close");

  var declined = closure.applyClosureProposal(index, { proposalId: proposed.proposalId, confirmed: false }, { now: function () { return 3000; } });
  assert.equal(declined.ok, true);
  assert.equal(declined.closed, 0);
  assert.equal(Object.keys(index.topics).filter(function (id) { return index.topics[id].status === "open"; }).length, 4);
});

test("a confirmed proposal closes exactly the topics the owner saw", function () {
  var index = closureFixture();
  var proposed = closure.proposeClosures(index, { sessions: [{ name: "Sidebar hierarchy rebuild" }], now: function () { return 2000; } });
  assert.deepEqual(proposed.candidates.map(function (c) { return c.topicId; }), ["auto-a7daa4cc660639337d144d93"]);
  var applied = closure.applyClosureProposal(index, { proposalId: proposed.proposalId, confirmed: true }, { now: function () { return 3000; } });
  assert.equal(applied.ok, true);
  assert.equal(applied.closed, 1);
  assert.equal(index.topics["auto-a7daa4cc660639337d144d93"].status, "closed");
  assert.equal(index.topics["auto-555555555555555555555555"].status, "open");
  // Replaying the same confirmation is a no-op, not a second sweep.
  var replay = closure.applyClosureProposal(index, { proposalId: proposed.proposalId, confirmed: true }, { now: function () { return 4000; } });
  assert.equal(replay.ok, true);
  assert.equal(replay.closed, 0);
  assert.equal(replay.duplicate, true);
});

test("a stale or unknown proposal id is refused rather than closing the current set", function () {
  var index = closureFixture();
  closure.proposeClosures(index, { sessions: [], now: function () { return 2000; } });
  var result = closure.applyClosureProposal(index, { proposalId: "close-deadbeefdeadbeef", confirmed: true }, { now: function () { return 3000; } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "closure_proposal_stale");
  assert.equal(Object.keys(index.topics).filter(function (id) { return index.topics[id].status === "open"; }).length, 4);
});

test("the proposal id is deterministic for the same candidate set", function () {
  var a = closure.proposeClosures(closureFixture(), { sessions: [], now: function () { return 2000; } });
  var b = closure.proposeClosures(closureFixture(), { sessions: [], now: function () { return 9999 } });
  assert.equal(a.proposalId, b.proposalId, "no clock or randomness feeds the proposal identity");
});

test("closure proposal and confirmation are reachable through the index and survive a restart", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "coop-closure-"));
  var file = path.join(dir, "coop-topic-index.json");
  try {
    var seeded = closureFixture();
    seeded.canonicalSessionStorageId = "canonical-home";
    fs.writeFileSync(file, JSON.stringify(seeded, null, 2));
    var session = {
      coopHome: true, storageId: "canonical-home",
      history: [{ type: "user_message", text: "close the stale topics", from: "a66ce4a1", fromName: "Admin" }, { type: "done" }],
    };
    var index = topics.createTopicIndex({ file: file, now: function () { return 2000; } });
    var proposed = index.proposeTopicClosures(session, { sessions: [] });
    assert.equal(proposed.ok, true);
    assert.equal(proposed.candidates.length, 2);

    // The owner confirms after a daemon restart: the proposal is durable.
    var restarted = topics.createTopicIndex({ file: file, now: function () { return 5000; } });
    var applied = restarted.confirmTopicClosures({ proposalId: proposed.proposalId, confirmed: true });
    assert.equal(applied.ok, true);
    assert.equal(applied.closed, 2);
    var reloaded = topics.createTopicIndex({ file: file, now: function () { return 6000; } });
    assert.equal(reloaded.load().topics["auto-a7daa4cc660639337d144d93"].status, "closed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- the closure handler against the REAL domain logic ------------------------
//
// Regression, found by independent review: the WS layer sent { confirm: true }
// while applyClosureProposal reads `confirmed`. Every confirmation therefore
// took the declined branch and closed nothing, while still replying ok:true --
// the owner was told their sweep was processed and it silently never happened.
//
// The existing handler test could not see this: its fake index read the WS
// layer's own (wrong) field name, so both sides of the mismatch agreed with
// each other. This test drives the real propose/confirm pair instead.

var connection = require("../lib/coop-topic-connection");

function realClosureHarness() {
  // A real on-disk index seeded from the closure fixture, driven through the
  // real handler -- no stub anywhere, which is the whole point.
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-closure-ws-"));
  var file = path.join(dir, "index.json");
  fs.writeFileSync(file, JSON.stringify(closureFixture()));
  var index = topics.createTopicIndex({ file: file });
  var session = { coopHome: true, storageId: "canonical-home", history: [] };
  var sent = [];
  return {
    index: index,
    sent: sent,
    ctx: {
      slug: "lead",
      coopTopicIndex: index,
      isCoopTopicOwner: function () { return true; },
      getProjectList: function () { return []; },
      getGlobalCoopProjection: function () { return { projects: [] }; },
      sm: { sessions: { forEach: function (fn) { fn(session); } }, saveSessionFile: function () {} },
      sendTo: function (ws, payload) { sent.push(payload); },
    },
  };
}

test("confirming a proposal through the WS handler actually closes the topics", function () {
  var h = realClosureHarness();
  connection.handleTopicClosureMessage(h.ctx, {}, { type: "coop_topic_closure_propose" });
  var proposal = h.sent[0];
  assert.equal(proposal.ok, true);
  assert.ok(proposal.candidates.length > 0, "the fixture must offer something to close");
  var closable = proposal.candidates.length;

  connection.handleTopicClosureMessage(h.ctx, {}, {
    type: "coop_topic_closure_confirm", proposalId: proposal.proposalId, confirm: true,
  });
  var result = h.sent[1];
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true, "the owner's confirmation must reach the domain layer");
  assert.equal(result.closed, closable, "confirming closes the proposed set");
  assert.equal(result.declined, undefined);

  // And the durable index really reflects it.
  var state = h.index.load();
  var stillOpen = proposal.candidates.filter(function (c) {
    return state.topics[c.topicId] && state.topics[c.topicId].status === "open";
  });
  assert.equal(stillOpen.length, 0, "confirmed topics are closed on disk, not just reported");
});

test("declining a proposal through the WS handler closes nothing", function () {
  var h = realClosureHarness();
  connection.handleTopicClosureMessage(h.ctx, {}, { type: "coop_topic_closure_propose" });
  var proposal = h.sent[0];

  connection.handleTopicClosureMessage(h.ctx, {}, {
    type: "coop_topic_closure_confirm", proposalId: proposal.proposalId, confirm: false,
  });
  var result = h.sent[1];
  assert.equal(result.closed, 0);
  assert.equal(result.confirmed, false);

  var state = h.index.load();
  var stillOpen = proposal.candidates.filter(function (c) {
    return state.topics[c.topicId] && state.topics[c.topicId].status === "open";
  });
  assert.equal(stillOpen.length, proposal.candidates.length, "declining leaves every topic open");
});

// --- a merge must carry the owner-request ledger with it -----------------------
//
// P2 from the independent review: coop-topic-management invoked index.merge()
// only, and ledger.retopic() had no production caller at all. Topic membership
// moved while the owner's requests and the coordinator claims stayed under a
// topic id that no longer existed -- so outstanding work vanished from the
// surface and one-coordinator-per-pair was enforced against a dead key.

var ownerRequestsModule = require("../lib/coop-owner-requests");
var management = require("../lib/coop-topic-management");

function mergeHarness(ledgerOverrides) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-merge-ws-"));
  var file = path.join(dir, "index.json");
  fs.writeFileSync(file, JSON.stringify(ownerFixture()));
  var index = topics.createTopicIndex({ file: file });
  var ledger = ledgerOverrides || ownerRequestsModule.attachCoopOwnerRequests({
    file: path.join(dir, "requests.json"),
  });
  var sent = [];
  return {
    index: index, ledger: ledger, sent: sent,
    ctx: {
      slug: "lead",
      coopTopicIndex: index,
      coopOwnerRequests: ledger,
      isCoopTopicOwner: function () { return true; },
      getProjectList: function () { return []; },
      getGlobalCoopProjection: function () { return { projects: [] }; },
      sm: { sessions: { forEach: function (fn) {
        fn({ coopHome: true, storageId: "canonical-home", history: [] });
      } }, saveSessionFile: function () {} },
      sendTo: function (ws, payload) { sent.push(payload); },
    },
    deps: {
      isCoopClient: function (c) { return c.slug === "lead"; },
      globalProjectionProvider: function (c) { return c.getGlobalCoopProjection; },
      topicIndexForContext: function (c) { return c.coopTopicIndex; },
      visibleProjects: function () { return { "5332aafc-31e7-5cb1-ba96-c8d90e78260e": true }; },
    },
  };
}

var SOURCE = { topicId: "auto-444444444444444444444444" };
var CANON = { topicId: "auto-a7daa4cc660639337d144d93" };
var CLAY_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var A_COORD = { projectId: CLAY_ID, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" };

function seedRequest(ledger, sequence, topicRef) {
  var id = "coop:871a194b-8879-40f7-a1fe-656e48e722af:" + sequence;
  ledger.record({ ingressId: id, ingressSequence: sequence,
    sessionRef: { projectId: "system-lead", sessionStorageId: "871a194b-8879-40f7-a1fe-656e48e722af" } });
  ledger.classify(id, { kind: "existing_topic", topicRef: topicRef, projectRefs: [{ projectId: CLAY_ID }] });
  return id;
}

test("merging a topic moves its owner requests and coordinator claim to the target", function () {
  var h = mergeHarness();
  h.index.load().topics[SOURCE.topicId] = makeTopic(SOURCE.topicId, "Provider fallback rework",
    { kind: "uncategorised" }, "automatic", 1, ["provider", "fallback"]);
  h.index.save();
  var id = seedRequest(h.ledger, 200, SOURCE);
  h.ledger.claimCoordinator({ topicRef: SOURCE, projectRef: { projectId: CLAY_ID },
    coordinator: A_COORD, ingressId: id });

  var handled = management.handleManagement(h.ctx, {}, {
    type: "coop_topic_merge", targetTopicRef: CANON, sourceTopicRefs: [SOURCE],
  }, h.deps);

  assert.equal(handled, true);
  assert.equal(h.sent[0].ok, true, "the merge itself succeeds");
  // The owner's record followed the topic.
  assert.deepEqual(h.ledger.get(id).topicRef, CANON);
  assert.equal(h.ledger.forTopic(CANON).length, 1);
  assert.equal(h.ledger.forTopic(SOURCE).length, 0);
  // And so did cardinality.
  assert.deepEqual(h.ledger.canonicalCoordinator(CANON, { projectId: CLAY_ID }), A_COORD);
  assert.equal(h.ledger.canonicalCoordinator(SOURCE, { projectId: CLAY_ID }), null);
  // The owner is still owed the request; a merge is not an answer.
  assert.equal(h.ledger.get(id).response.state, "unanswered");
});

test("a merge whose ledger move cannot be persisted is reported as failed", function () {
  var stubbed = {
    retopic: function () { return { ok: false, reason: "persistence_failed" }; },
  };
  var h = mergeHarness(stubbed);
  h.index.load().topics[SOURCE.topicId] = makeTopic(SOURCE.topicId, "Provider fallback rework",
    { kind: "uncategorised" }, "automatic", 1, ["provider"]);
  h.index.save();

  management.handleManagement(h.ctx, {}, {
    type: "coop_topic_merge", targetTopicRef: CANON, sourceTopicRefs: [SOURCE],
  }, h.deps);

  assert.equal(h.sent[0].ok, false);
  assert.equal(h.sent[0].code, "owner_request_retopic_failed",
    "a half-moved owner record must surface, not be reported as a clean merge");
});

// --- closure must never sweep evidence the owner still needs -------------------
//
// Re-review P1: the field mismatch was fixed but the SELECTION predicate only
// looked at status, title match and relatedExecutions. A topic the owner is
// still blocked on -- ownerDisposition needs_input, or a live/failed task, or a
// binding, or an owner-direct session -- was selected and closed. Closing is
// destructive to the owner's own view, so the selector must fail SAFE: anything
// it cannot prove is finished stays open.

function topicWith(id, extra) {
  return Object.assign(makeTopic(id, "Provider fallback rework",
    { kind: "uncategorised" }, "automatic", 1, ["provider"]), extra || {});
}

function selectIds(index, options) {
  return closure.selectClosureCandidates(index, options || {}).map(function (c) { return c.topicId; });
}

test("a topic the owner must still decide on is never a closure candidate", function () {
  var index = ownerFixture();
  index.topics["auto-666666666666666666666666"] = topicWith("auto-666666666666666666666666", {
    ownerDisposition: { status: "needs_input", source: "backfill", at: 1 },
  });
  assert.equal(selectIds(index).indexOf("auto-666666666666666666666666"), -1,
    "needs_input is the owner being blocked; closing it hides their own decision");
});

test("an owner disposition of done does not by itself protect a topic", function () {
  var index = ownerFixture();
  index.topics["auto-777777777777777777777777"] = topicWith("auto-777777777777777777777777", {
    ownerDisposition: { status: "done", source: "owner", at: 1 },
  });
  assert.notEqual(selectIds(index).indexOf("auto-777777777777777777777777"), -1,
    "a resolved topic with nothing tracking it is exactly what this sweep is for");
});

test("a topic backed by live, failed or blocked work is never a candidate", function () {
  ["running", "queued", "failed", "blocked", "needs_input", "waiting_user"].forEach(function (status) {
    var index = ownerFixture();
    index.topics["auto-888888888888888888888888"] = topicWith("auto-888888888888888888888888");
    var ids = selectIds(index, {
      tasks: [{ taskId: "t1", status: status, coopTopicRef: { topicId: "auto-888888888888888888888888" } }],
    });
    assert.equal(ids.indexOf("auto-888888888888888888888888"), -1,
      status + " work must protect its topic from the sweep");
  });
});

test("a topic backed by a non-terminal binding is never a candidate", function () {
  var index = ownerFixture();
  index.topics["auto-999999999999999999999999"] = topicWith("auto-999999999999999999999999");
  var ids = selectIds(index, {
    bindings: [{ portfolioTaskId: "p1", status: "active",
      coopTopicRef: { topicId: "auto-999999999999999999999999" } }],
  });
  assert.equal(ids.indexOf("auto-999999999999999999999999"), -1);
});

test("a topic whose session is present in the ledger is never a candidate", function () {
  var index = ownerFixture();
  index.topics["auto-aaaaaaaaaaaaaaaaaaaaaaaa"] = topicWith("auto-aaaaaaaaaaaaaaaaaaaaaaaa");
  var ids = selectIds(index, {
    sessionEvidence: [{ coopTopicRefs: [{ topicId: "auto-aaaaaaaaaaaaaaaaaaaaaaaa" }],
      sessionPresent: true, hidden: false }],
  });
  assert.equal(ids.indexOf("auto-aaaaaaaaaaaaaaaaaaaaaaaa"), -1);
});

test("a hidden or absent session does not protect a topic", function () {
  var index = ownerFixture();
  index.topics["auto-bbbbbbbbbbbbbbbbbbbbbbbb"] = topicWith("auto-bbbbbbbbbbbbbbbbbbbbbbbb");
  var ids = selectIds(index, {
    sessionEvidence: [{ coopTopicRefs: [{ topicId: "auto-bbbbbbbbbbbbbbbbbbbbbbbb" }],
      sessionPresent: false, hidden: true }],
  });
  assert.notEqual(ids.indexOf("auto-bbbbbbbbbbbbbbbbbbbbbbbb"), -1,
    "a dismissed or missing session is not something still tracking the topic");
});

test("the handler resolves real session titles, not a project count", function () {
  // Regression: the handler passed getProjectList() as `sessions`, but a project
  // status carries a numeric session count, never session titles -- so a real
  // matching session never protected its topic.
  var h = realClosureHarness();
  h.ctx.getProjectList = function () { return [{ projectId: "p", sessions: 3 }]; };
  h.ctx.coopSessionEvidence = function () {
    return [{ coopTopicRefs: [{ topicId: "auto-444444444444444444444444" }],
      sessionPresent: true, hidden: false }];
  };
  connection.handleTopicClosureMessage(h.ctx, {}, { type: "coop_topic_closure_propose" });
  var ids = h.sent[0].candidates.map(function (c) { return c.topicId; });
  assert.equal(ids.indexOf("auto-444444444444444444444444"), -1,
    "a topic with a present linked session must not be offered for closure");
});

test("a topic still holding an unanswered owner request is never a candidate", function () {
  // Found by live verification, not by review: 4 of 9 real closure candidates
  // held 9 unanswered owner requests between them. An unanswered request is the
  // strongest possible evidence a topic is unfinished -- closing over it buries
  // a question the owner never got answered, which is the precise failure this
  // whole feature exists to prevent.
  var index = ownerFixture();
  index.topics["auto-dddddddddddddddddddddddd"] = topicWith("auto-dddddddddddddddddddddddd");
  var ids = selectIds(index, {
    outstandingTopicIds: { "auto-dddddddddddddddddddddddd": true },
  });
  assert.equal(ids.indexOf("auto-dddddddddddddddddddddddd"), -1);
});

test("a topic whose owner requests are all answered may still be closed", function () {
  var index = ownerFixture();
  index.topics["auto-eeeeeeeeeeeeeeeeeeeeeeee"] = topicWith("auto-eeeeeeeeeeeeeeeeeeeeeeee");
  var ids = selectIds(index, { outstandingTopicIds: {} });
  assert.notEqual(ids.indexOf("auto-eeeeeeeeeeeeeeeeeeeeeeee"), -1,
    "an answered, untracked topic is exactly what the sweep is for");
});

test("the handler derives outstanding topics from the owner-request ledger", function () {
  var h = realClosureHarness();
  h.ctx.coopOwnerRequests = {
    list: function () {
      return [{ topicRef: { topicId: "auto-444444444444444444444444" },
        response: { state: "unanswered" } }];
    },
  };
  connection.handleTopicClosureMessage(h.ctx, {}, { type: "coop_topic_closure_propose" });
  var ids = h.sent[0].candidates.map(function (c) { return c.topicId; });
  assert.equal(ids.indexOf("auto-444444444444444444444444"), -1,
    "the ledger the owner is shown must also protect what it reports as owed");
});

// --- confirmation must re-check evidence, not just status ---------------------
//
// Review finding: applyClosureProposal only rechecked topic.status === "open".
// Evidence arriving BETWEEN propose and confirm -- the owner asking something
// new, a task failing, a coordinator starting -- was invisible, so a two-touch
// flow closed a topic that had become blocked since the owner saw the list.

function setOf(id) { var m = {}; m[id] = true; return m; }

test("evidence arriving after the proposal blocks the confirmation", function () {
  var index = closureFixture();
  var proposal = closure.proposeClosures(index, { now: function () { return 1; } });
  var target = proposal.candidates[0].topicId;

  // The owner asks something new on that topic before confirming.
  var applied = closure.applyClosureProposal(index,
    { proposalId: proposal.proposalId, confirmed: true },
    { now: function () { return 2; }, outstandingTopicIds: setOf(target) });

  assert.equal(index.topics[target].status, "open",
    "a topic that became blocked after the proposal must not close");
  assert.ok(applied.blocked && applied.blocked.length >= 1,
    "the owner is told which topics were skipped and why");
});

test("confirmation still closes candidates that remain genuinely finished", function () {
  var index = closureFixture();
  var proposal = closure.proposeClosures(index, { now: function () { return 1; } });
  var applied = closure.applyClosureProposal(index,
    { proposalId: proposal.proposalId, confirmed: true }, { now: function () { return 2; } });

  assert.equal(applied.closed, proposal.candidates.length);
  assert.equal(applied.blocked ? applied.blocked.length : 0, 0);
});

test("a task that became blocked after the proposal stops its topic closing", function () {
  var index = closureFixture();
  var proposal = closure.proposeClosures(index, { now: function () { return 1; } });
  var target = proposal.candidates[0].topicId;

  closure.applyClosureProposal(index,
    { proposalId: proposal.proposalId, confirmed: true },
    { now: function () { return 2; },
      tasks: [{ taskId: "t", status: "failed", coopTopicRef: { topicId: target } }] });

  assert.equal(index.topics[target].status, "open");
});

// --- historical references must not protect forever ---------------------------

test("a relatedExecution pointing at a hidden session does not protect a topic", function () {
  var index = ownerFixture();
  index.topics["auto-111111111111111111111111"] = topicWith("auto-111111111111111111111111", {
    relatedExecutions: [{ sessionRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" } }],
  });
  var ids = selectIds(index, {
    sessionEvidence: [{ sessionRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" },
      coopTopicRefs: [{ topicId: "auto-111111111111111111111111" }],
      sessionPresent: true, hidden: true }],
  });
  assert.notEqual(ids.indexOf("auto-111111111111111111111111"), -1,
    "a dismissed session is history, not something still tracking the topic");
});

test("a relatedExecution whose session is genuinely live still protects", function () {
  var index = ownerFixture();
  index.topics["auto-222222222222222222222222"] = topicWith("auto-222222222222222222222222", {
    relatedExecutions: [{ sessionRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" } }],
  });
  var ids = selectIds(index, {
    sessionEvidence: [{ sessionRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" },
      coopTopicRefs: [{ topicId: "auto-222222222222222222222222" }],
      sessionPresent: true, hidden: false }],
  });
  assert.equal(ids.indexOf("auto-222222222222222222222222"), -1);
});

test("with no session evidence at all a linked execution still protects", function () {
  // Fail safe: absent evidence is not proof of absence.
  var index = ownerFixture();
  index.topics["auto-333333333333333333333333"] = topicWith("auto-333333333333333333333333", {
    relatedExecutions: [{ projectRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" } }],
  });
  assert.equal(selectIds(index, {}).indexOf("auto-333333333333333333333333"), -1);
});

// --- historical references must not protect forever ---------------------------

test("a relatedExecution pointing at a hidden or missing session does not protect", function () {
  // hasLinkedExecution ran BEFORE the hidden/terminal evidence checks, so one
  // historical reference excluded a topic permanently -- the sweep could never
  // close it however finished it was.
  var index = ownerFixture();
  var CLAY_P = topics.CLAY_PROJECT_ID;
  index.topics["auto-111111111111111111111111"] = topicWith("auto-111111111111111111111111", {
    relatedExecutions: [{ sessionRef: { projectId: CLAY_P,
      sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" } }],
  });
  var ids = selectIds(index, {
    sessionEvidence: [{ sessionRef: { projectId: CLAY_P,
      sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" },
      sessionPresent: false, hidden: true,
      coopTopicRefs: [{ topicId: "auto-111111111111111111111111" }] }],
  });
  assert.notEqual(ids.indexOf("auto-111111111111111111111111"), -1,
    "a dismissed session is not live work, however it is referenced");
});

test("a relatedExecution whose session is present still protects", function () {
  var index = ownerFixture();
  var CLAY_P = topics.CLAY_PROJECT_ID;
  index.topics["auto-222222222222222222222222"] = topicWith("auto-222222222222222222222222", {
    relatedExecutions: [{ sessionRef: { projectId: CLAY_P,
      sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" } }],
  });
  var ids = selectIds(index, {
    sessionEvidence: [{ sessionRef: { projectId: CLAY_P,
      sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" },
      sessionPresent: true, hidden: false,
      coopTopicRefs: [{ topicId: "auto-222222222222222222222222" }] }],
  });
  assert.equal(ids.indexOf("auto-222222222222222222222222"), -1);
});

test("a relatedExecution with no resolvable evidence still protects, failing safe", function () {
  var index = ownerFixture();
  index.topics["auto-333333333333333333333333"] = topicWith("auto-333333333333333333333333", {
    relatedExecutions: [{ projectRef: { projectId: topics.CLAY_PROJECT_ID } }],
  });
  // Nothing known about it either way -> keep it. Unprovable is not finished.
  assert.equal(selectIds(index, {}).indexOf("auto-333333333333333333333333"), -1);
});

test("merging into a closed target is refused before the ledger moves", function () {
  var h = mergeHarness();
  var state = h.index.load();
  state.topics[SOURCE.topicId] = makeTopic(SOURCE.topicId, "Provider fallback rework",
    { kind: "uncategorised" }, "automatic", 1, ["provider"]);
  state.topics[CANON.topicId].status = "closed";
  h.index.save();
  var id = seedRequest(h.ledger, 210, SOURCE);

  management.handleManagement(h.ctx, {}, {
    type: "coop_topic_merge", targetTopicRef: CANON, sourceTopicRefs: [SOURCE],
  }, h.deps);

  assert.equal(h.sent[0].ok, false);
  assert.equal(h.sent[0].code, "topic_closed");
  // The ledger never moved, so the request is not stranded on a closed topic.
  assert.deepEqual(h.ledger.get(id).topicRef, SOURCE);
  assert.equal(h.index.load().topics[SOURCE.topicId].status, "open");
});

test("a throwing topic merge returns a visible failure instead of escaping", function () {
  var h = mergeHarness();
  var state = h.index.load();
  state.topics[SOURCE.topicId] = makeTopic(SOURCE.topicId, "Provider fallback rework",
    { kind: "uncategorised" }, "automatic", 1, ["provider"]);
  h.index.save();
  h.index.merge = function () { throw new Error("index exploded"); };

  management.handleManagement(h.ctx, {}, {
    type: "coop_topic_merge", targetTopicRef: CANON, sourceTopicRefs: [SOURCE],
  }, h.deps);

  assert.equal(h.sent.length, 1, "the owner always gets a result");
  assert.equal(h.sent[0].ok, false);
  assert.equal(h.sent[0].code, "topic_merge_failed");
});

test("a project title with no sessions does not protect a same-named topic", function () {
  // Review finding: the handler passed getProjectList() as `sessions`, and
  // sessionNames() reads a `title` field -- which a PROJECT status has. So a
  // topic named after a project was treated as matching a live session even
  // when that project had zero sessions, permanently excluding it.
  var h = realClosureHarness();
  h.ctx.getProjectList = function () {
    return [{ projectId: "p", title: "Provider fallback rework", sessions: 0 }];
  };
  h.ctx.coopSessionEvidence = function () { return []; };
  connection.handleTopicClosureMessage(h.ctx, {}, { type: "coop_topic_closure_propose" });

  var ids = h.sent[0].candidates.map(function (c) { return c.topicId; });
  assert.notEqual(ids.indexOf("auto-444444444444444444444444"), -1,
    "a project name is not a session; it must not shield the topic");
});

test("a real session title from the ledger does protect a same-named topic", function () {
  var h = realClosureHarness();
  h.ctx.getProjectList = function () { return []; };
  h.ctx.coopSessionEvidence = function () {
    return [{ title: "Provider fallback rework", sessionPresent: true, hidden: false,
      coopTopicRefs: [] }];
  };
  connection.handleTopicClosureMessage(h.ctx, {}, { type: "coop_topic_closure_propose" });

  var ids = h.sent[0].candidates.map(function (c) { return c.topicId; });
  assert.equal(ids.indexOf("auto-444444444444444444444444"), -1,
    "a genuine session with that name is exactly what should protect it");
});
