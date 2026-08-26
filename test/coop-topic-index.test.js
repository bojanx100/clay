var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var assert = require("node:assert/strict");

var topics = require("../lib/coop-topic-index");
var topicLineage = require("../lib/coop-topic-lineage");
var classification = require("../lib/coop-topic-classification");

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var WEBAPP = "44444444-4444-5444-8444-444444444444";
var CLOSED_PROJECT = "66666666-6666-5666-8666-666666666666";

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-topic-index-"));
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

function canonicalSession() {
  return {
    coopHome: true,
    storageId: "canonical-topic-home",
    history: [
      { type: "user_message", text: "Codex auth secret-body-should-never-persist and queued ingress recovery", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" },
      { type: "delta_replace", text: "Final assistant authentication and recovery reply" },
      { type: "done" },
      { type: "user_message", text: "An unrelated design discussion", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" },
      { type: "delta_replace", text: "Final assistant: Coop canonical conversation architecture uses a ProjectRef channel" },
      { type: "done" },
      { type: "user_message", text: "Navigation session restoration and sidebar hierarchy for desktop mobile", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" },
      { type: "delta_replace", text: "Final assistant navigation reply" },
      { type: "done" },
      { type: "user_message", text: "Worker lifecycle binding completion remains project owned", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" },
      { type: "delta_replace", text: "Final assistant lifecycle reply" },
      { type: "done" },
      { type: "user_message", text: "Webapp triage and session cleanup", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" },
      { type: "delta_replace", text: "Final assistant webapp reply" },
      { type: "done" },
      { type: "user_message", text: "A quiet unmatched turn", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" },
      { type: "delta_replace", text: "Final assistant unmatched reply" },
      { type: "done" },
    ],
  };
}

function retroOptions() {
  return {
    clayProjectRef: { projectId: CLAY },
    projects: [{ projectId: WEBAPP, slug: "webapp" }],
  };
}

function compactedAuthSessions() {
  var predecessor = {
    coopHome: true,
    storageId: "canonical-topic-home-predecessor",
    history: [
      { type: "user_message", text: "Codex auth predecessor turn", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner-1" },
      { type: "delta_replace", text: "Initial auth reply" },
      { type: "done" },
    ],
  };
  var successor = {
    coopHome: true,
    storageId: "canonical-topic-home-successor",
    compactedFromStorageId: predecessor.storageId,
    history: [
      { type: "user_message", text: "Codex auth successor follow-up", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner-2" },
      { type: "delta_replace", text: "Successor auth reply" },
      { type: "done" },
    ],
  };
  return {
    predecessor: predecessor,
    successor: successor,
    replaySession: topicLineage.buildReplaySession(successor, [predecessor, successor]),
  };
}

test("retro extraction is complete, deterministic, idempotent, and reference-only", function () {
  var h = harness();
  try {
    var session = canonicalSession();
    var first = h.index.ensureRetro(session, retroOptions());
    var saved = fs.readFileSync(h.index.file, "utf8");
    assert.equal(first.ok, true);
    assert.equal(first.topics, 9);
    assert.equal(first.eventCount, session.history.length);
    assert.equal(saved.includes("secret-body-should-never-persist"), false);
    assert.equal(saved.includes("Final assistant authentication and recovery reply"), false);
    assert.equal(saved.includes('"text"'), false);

    var state = h.index.load();
    var automaticId = classification.automaticTopicId("A quiet unmatched turn", { kind: "uncategorised" });
    assert.deepEqual(Object.keys(state.topics).sort(), [
      automaticId,
      "clay-sidebar-hierarchy", "codex-authentication", "coop-conversation-architecture",
      "navigation-session-restoration", "queued-message-recovery", "uncategorised-conversations",
      "webapp-triage-session-cleanup", "worker-lifecycle-completion",
    ]);
    assert.deepEqual(state.topics["codex-authentication"].eventRefs[0], {
      projectId: "system-lead", sessionStorageId: "canonical-topic-home", eventIndex: 0,
    });
    assert.ok(state.topics["codex-authentication"].eventRefs.length > 0);
    assert.ok(state.topics["queued-message-recovery"].eventRefs.length > 0,
      "one canonical event may belong to multiple topics");
    assert.deepEqual(state.topics["codex-authentication"].turnRefs, [{
      projectId: "system-lead", sessionStorageId: "canonical-topic-home", startEventIndex: 0, endEventIndex: 2,
    }]);
    assert.deepEqual(state.topics["queued-message-recovery"].turnRefs, [{
      projectId: "system-lead", sessionStorageId: "canonical-topic-home", startEventIndex: 0, endEventIndex: 2,
    }]);
    assert.deepEqual(state.topics["uncategorised-conversations"].turnRefs, [{
      projectId: "system-lead", sessionStorageId: "canonical-topic-home", startEventIndex: 15, endEventIndex: 17,
    }]);
    assert.deepEqual(state.topics[automaticId].turnRefs, [{
      projectId: "system-lead", sessionStorageId: "canonical-topic-home", startEventIndex: 15, endEventIndex: 17,
    }]);
    assert.equal(state.topics[automaticId].title, "A quiet unmatched turn",
      "the automatic title is the owner's readable phrase, order preserved");
    var indexedTurnStarts = Object.keys(state.topics).reduce(function (starts, id) {
      return starts.concat(state.topics[id].turnRefs.map(function (ref) { return ref.startEventIndex; }));
    }, []).sort(function (a, b) { return a - b; }).filter(function (value, index, values) {
      return index === 0 || values[index - 1] !== value;
    });
    assert.deepEqual(indexedTurnStarts, [0, 3, 6, 9, 12, 15],
      "every completed canonical user-to-done turn has a topic membership");
    assert.equal(state.topics["navigation-session-restoration"].group.projectRef.projectId, CLAY);
    assert.equal(state.topics["coop-conversation-architecture"].group.kind, "cross_project");
    assert.equal(state.topics["codex-authentication"].group.kind, "uncategorised");
    assert.equal(state.topics["webapp-triage-session-cleanup"].group.projectRef.projectId, WEBAPP);

    assert.equal(h.index.ensureRetro(session, retroOptions()).changed, false);
    var restarted = topics.createTopicIndex({ file: h.index.file, now: function () { return 999; } });
    assert.equal(restarted.ensureRetro(session, retroOptions()).changed, false);
    assert.equal(fs.readFileSync(h.index.file, "utf8"), saved);
  } finally { h.cleanup(); }
});

test("two live topic-index instances preserve disjoint topic mutations", function () {
  var h = harness();
  try {
    var session = canonicalSession();
    h.index.ensureRetro(session, retroOptions());
    var second = topics.createTopicIndex({ file: h.index.file, now: function () { return 500; } });
    var ref = { topicId: "codex-authentication" };
    second.load();

    second.applyTopicDisposition(ref, { verb: "accept_done", note: "Completed.",
      expectedRevision: 0, requestId: "two-instance-disposition" });
    second.close(ref);
    var created = h.index.classifyCanonicalIngress(session,
      { text: "Zephyr observatory calibration matrix" },
      { projects: [], isProjectAvailable: function () { return false; } });

    var reloaded = topics.createTopicIndex({ file: h.index.file });
    var topic = reloaded.resolve(ref, true).topic;
    assert.equal(topic.status, "closed");
    assert.equal(topic.ownerDisposition.status, "done");
    assert.equal(reloaded.resolve(created.topicRef, true).ok, true);
    assert.equal(reloaded.load().dispositionRequests.some(function (request) {
      return request.requestId === "two-instance-disposition";
    }), true);
  } finally { h.cleanup(); }
});

test("an explicit implementation Thread route promotes its automatic project topic", function () {
  var h = harness();
  try {
    var session = canonicalSession();
    h.index.ensureRetro(session, retroOptions());
    var result = h.index.classifyCanonicalIngress(session, {
      text: "Urban Stay auto-launch regression", coopProjectRef: { projectId: CLAY },
    }, {
      projects: [{ projectId: CLAY, slug: "clay", title: "Clay" }],
      isProjectAvailable: function (ref) { return ref && ref.projectId === CLAY; },
      recordExplicitRoute: true,
    });
    var topic = h.index.resolve(result.topicRef, true).topic;
    assert.equal(result.ok, true);
    assert.equal(topic.group.projectRef.projectId, CLAY);
    assert.equal(topic.explicitlyRouted, true,
      "a strict owner request is not hidden as a passing automatic remark");
  } finally { h.cleanup(); }
});

test("a stale direct topic snapshot is rejected by revision and digest CAS", function () {
  var h = harness();
  try {
    h.index.ensureRetro(canonicalSession(), retroOptions());
    var stale = topics.createTopicIndex({ file: h.index.file });
    var fresh = topics.createTopicIndex({ file: h.index.file });
    var staleState = stale.load();
    staleState.topics["codex-authentication"].title = "Stale overwrite";

    fresh.rename({ topicId: "codex-authentication" }, "Fresh title");

    assert.throws(function () { stale.save(); }, function (error) {
      return error && error.code === "ledger_conflict";
    });
    assert.equal(topics.createTopicIndex({ file: h.index.file })
      .resolve({ topicId: "codex-authentication" }, true).topic.title, "Fresh title");
  } finally { h.cleanup(); }
});

test("topic metadata operations preserve references and nested execution links", function () {
  var h = harness();
  try {
    var session = canonicalSession();
    h.index.ensureRetro(session, retroOptions());
    var available = { isProjectAvailable: function () { return true; } };
    var selected = h.index.classifyCanonicalIngress(session, { text: "Quartz cedar poppy" }, available);
    var mergeSource = h.index.classifyCanonicalIngress(session, { text: "Vellum lichen quasar" }, available);
    assert.equal(h.index.resolve(selected.topicRef).topic.source, "automatic");
    assert.equal(h.index.resolve(mergeSource.topicRef).topic.source, "automatic");
    session.history.push(
      { type: "user_message", text: "owner-selected body is never copied", coopTopicRef: selected.topicRef, from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" },
      { type: "delta_replace", text: "final response body is never copied" },
      { type: "done" }
    );
    h.index.ensureRetro(session, retroOptions());
    assert.deepEqual(h.index.resolve(selected.topicRef).topic.eventRefs, [{
      projectId: "system-lead", sessionStorageId: "canonical-topic-home", eventIndex: 18,
    }]);
    assert.equal(h.index.rename(selected.topicRef, "Renamed follow up").ok, true);
    assert.equal(h.index.move(selected.topicRef, { projectRef: { projectId: CLAY } }).ok, true);
    assert.equal(h.index.addEventMembership(selected.topicRef, [{ eventIndex: 0 }]).ok, true);
    var linkedExecution = {
      projectRef: { projectId: CLAY },
      children: [{ sessionRef: { projectId: CLAY, sessionStorageId: "project-coordinator" }, children: [{
        taskRef: { projectId: CLAY, coordinatorSessionStorageId: "project-coordinator", taskId: "child-task" },
      }] }],
    };
    assert.equal(h.index.linkExecution(selected.topicRef, linkedExecution).ok, true);
    assert.equal(h.index.linkExecution(selected.topicRef, linkedExecution).unchanged, true);
    assert.equal(h.index.merge(selected.topicRef, [mergeSource.topicRef]).ok, true);
    assert.equal(h.index.resolve(mergeSource.topicRef, true).topic.status, "merged");
    assert.equal(h.index.resolve(selected.topicRef).topic.relatedExecutions.length, 1);
    assert.equal(h.index.resolve(selected.topicRef).topic.relatedExecutions[0].children[0].children[0].taskRef.taskId, "child-task");

    var split = h.index.split(selected.topicRef, [{
      topicId: "split-follow-up", title: "Split follow up", eventRefs: [{ eventIndex: 0 }],
    }]);
    assert.deepEqual(split, { ok: true, topicRefs: [{ topicId: "split-follow-up" }] });
    assert.equal(h.index.resolve({ topicId: "split-follow-up" }).topic.eventRefs[0].eventIndex, 0);
    assert.equal(h.index.resolve({ topicId: "split-follow-up" }).topic.source, "split");
    assert.equal(h.index.close(selected.topicRef).ok, true);
    assert.equal(h.index.resolve(selected.topicRef).code, "topic_closed");
    assert.equal(h.index.reopen(selected.topicRef).ok, true);
  } finally { h.cleanup(); }
});

test("ACL projection revokes project topic metadata while retaining safe shared groups", function () {
  var h = harness();
  try {
    h.index.ensureRetro(canonicalSession(), retroOptions());
    h.index.linkExecution({ topicId: "coop-conversation-architecture" }, {
      projectRef: { projectId: WEBAPP },
      children: [{ sessionRef: { projectId: WEBAPP, sessionStorageId: "webapp-worker" } }],
    });
    h.index.linkExecution({ topicId: "coop-conversation-architecture" }, {
      projectRef: { projectId: CLAY },
      sessionRef: { projectId: CLAY, sessionStorageId: "clay-task-coordinator" },
    });
    var visible = h.index.project({
      actor: { id: "owner" },
      canAccessProject: function (_, ref) { return ref.projectId === CLAY; },
    });
    assert.ok(visible.groups.some(function (group) { return group.kind === "project" && group.projectRef.projectId === CLAY; }));
    assert.ok(visible.groups.some(function (group) { return group.kind === "cross_project"; }));
    assert.ok(visible.groups.some(function (group) { return group.kind === "uncategorised"; }));
    var shared = visible.groups.find(function (group) { return group.kind === "cross_project"; });
    var architecture = shared.topics.find(function (topic) {
      return topic.topicRef.topicId === "coop-conversation-architecture";
    });
    assert.deepEqual(architecture.executionProjectRefs, [{ projectId: CLAY }],
      "Thread-container targets are durable, deduplicated, and ACL-filtered");
    assert.equal(JSON.stringify(visible).includes(WEBAPP), false);
    var revoked = h.index.project({ canAccessProject: function () { return false; } });
    assert.equal(revoked.groups.some(function (group) { return group.kind === "project"; }), false);
  } finally { h.cleanup(); }
});

test("handoff projection retains every accessible execution project", function () {
  var h = harness();
  try {
    h.index.ensureRetro(canonicalSession(), retroOptions());
    var topicRef = { topicId: "coop-conversation-architecture" };
    for (var i = 0; i < 13; i++) {
      assert.equal(h.index.linkExecution(topicRef, {
        projectRef: { projectId: "system-execution-" + i },
      }).ok, true);
    }

    var visible = h.index.project({ canAccessProject: function () { return true; } });
    var shared = visible.groups.find(function (group) { return group.kind === "cross_project"; });
    var architecture = shared.topics.find(function (topic) {
      return topic.topicRef.topicId === topicRef.topicId;
    });
    assert.equal(architecture.executionProjectRefs.length, 13,
      "a Thread container is not silently dropped after twelve execution projects");
    assert.equal(architecture.executionProjectRefs[12].projectId, "system-execution-12");
  } finally { h.cleanup(); }
});

test("closed topics stay projectable as Done evidence; merged topics leave", function () {
  var h = harness();
  try {
    var state = h.index.load();
    state.canonicalSessionStorageId = "canonical-topic-home";
    state.topics["closed-project-only-topic"] = {
      topicRef: { topicId: "closed-project-only-topic" },
      title: "Close this topic",
      keywords: [],
      group: { kind: "project", projectRef: { projectId: CLOSED_PROJECT } },
      source: "automatic",
      status: "open",
      createdAt: 1,
      updatedAt: 1,
      eventRefs: [],
      turnRefs: [],
      relatedExecutions: [],
    };
    state.topics["merged-away-topic"] = {
      topicRef: { topicId: "merged-away-topic" },
      title: "Merged away fragment",
      keywords: [],
      group: { kind: "uncategorised" },
      source: "automatic",
      status: "merged",
      createdAt: 1,
      updatedAt: 1,
      eventRefs: [],
      turnRefs: [],
      relatedExecutions: [],
    };
    h.index.save();

    var before = h.index.project({ canAccessProject: function () { return true; } });
    assert.ok(before.groups.some(function (group) {
      return group.projectRef && group.projectRef.projectId === CLOSED_PROJECT;
    }));

    assert.equal(h.index.close({ topicId: "closed-project-only-topic" }).ok, true);
    var after = h.index.project({ canAccessProject: function () { return true; } });
    // An explicit close is a confirmed owner resolution -- Done -- and Done
    // topics must remain discoverable rather than disappearing. The projection
    // keeps the topic, carrying status "closed" so the client can collapse it
    // into the compact Done section instead of the live list.
    var closedTopic = null;
    after.groups.forEach(function (group) {
      (group.topics || []).forEach(function (topic) {
        if (topic.topicRef.topicId === "closed-project-only-topic") closedTopic = topic;
      });
    });
    assert.ok(closedTopic, "the closed topic stays projectable");
    assert.equal(closedTopic.status, "closed");
    // Merged topics are gone for good: their membership lives on in the merge
    // target, so projecting the husk would duplicate the conversation.
    assert.equal(JSON.stringify(after).includes("merged-away-topic"), false);
  } finally { h.cleanup(); }
});

test("retro extraction binds canonical Coop identity without a production storage-id gate", function () {
  var h = harness();
  try {
    var session = canonicalSession();
    session.storageId = "another-canonical-coop-home";
    assert.equal(h.index.ensureRetro(session, retroOptions()).ok, true);

    var expected = topics.createTopicIndex({
      file: path.join(h.dir, "expected.json"),
      expectedCanonicalStorageId: "expected-canonical-coop-home",
    });
    assert.equal(expected.ensureRetro(session, retroOptions()).code, "canonical_session_mismatch");
    session.storageId = "expected-canonical-coop-home";
    assert.equal(expected.ensureRetro(session, retroOptions()).ok, true);
  } finally { h.cleanup(); }
});

test("projection and ingress accept a compacted Coop continuation as canonical lineage", function () {
  var h = harness();
  try {
    var predecessor = canonicalSession();
    predecessor.storageId = "canonical-topic-home-predecessor";
    assert.equal(h.index.ensureRetro(predecessor, retroOptions()).ok, true);

    var successor = {
      coopHome: true,
      storageId: "canonical-topic-home-successor",
      compactedFromStorageId: predecessor.storageId,
      history: [
        { type: "user_message", text: "Compacted continuation follow-up", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" },
        { type: "delta_replace", text: "Continuation reply" },
        { type: "done" },
      ],
    };
    var replaySession = topicLineage.buildReplaySession(successor, [predecessor, successor]);
    var projection = h.index.project({
      history: replaySession,
      canAccessProject: function () { return true; },
    });
    var auth = projection.groups.reduce(function (found, group) {
      if (found) return found;
      return (group.topics || []).find(function (topic) { return topic.topicRef.topicId === "codex-authentication"; }) || null;
    }, null);

    assert.ok(auth, "predecessor-owned topic stays projectable after compaction");
    assert.equal(h.index.validateIngress(replaySession, {
      coopTopicRef: { topicId: "codex-authentication" },
    }, {
      includeClosedTopics: true,
      isProjectAvailable: function () { return true; },
    }).ok, true);
  } finally { h.cleanup(); }
});

test("split preserves successor-segment refs after compaction", function () {
  var h = harness();
  try {
    var sessions = compactedAuthSessions();
    assert.equal(h.index.ensureRetro(sessions.predecessor, retroOptions()).ok, true);
    assert.equal(h.index.ensureRetro(sessions.replaySession, retroOptions()).ok, true);

    var split = h.index.split({ topicId: "codex-authentication" }, [{
      topicId: "split-successor-follow-up",
      title: "Successor follow up",
      eventRefs: [{ sessionStorageId: sessions.successor.storageId, eventIndex: 0 }],
    }]);
    assert.deepEqual(split, { ok: true, topicRefs: [{ topicId: "split-successor-follow-up" }] });
    assert.deepEqual(h.index.resolve({ topicId: "split-successor-follow-up" }).topic.eventRefs, [{
      projectId: "system-lead", sessionStorageId: sessions.successor.storageId, eventIndex: 0,
    }]);
    assert.equal(h.index.split({ topicId: "codex-authentication" }, [{
      title: "Invalid follow up",
      eventRefs: [{ sessionStorageId: "foreign-successor", eventIndex: 0 }],
    }]).code, "invalid_event_ref");
  } finally { h.cleanup(); }
});

test("canonical event resolution keeps the exact lineage segment after compaction", function () {
  var h = harness();
  try {
    var sessions = compactedAuthSessions();
    assert.equal(h.index.ensureRetro(sessions.predecessor, retroOptions()).ok, true);
    assert.equal(h.index.ensureRetro(sessions.replaySession, retroOptions()).ok, true);

    assert.deepEqual(h.index.resolveCanonicalEvent({ topicId: "codex-authentication" }, {
      sessionStorageId: sessions.predecessor.storageId, eventIndex: 0,
    }), {
      ok: true,
      topicRef: { topicId: "codex-authentication" },
      threadRef: { threadId: "codex-authentication" },
      eventRef: {
        projectId: "system-lead", sessionStorageId: sessions.predecessor.storageId, eventIndex: 0,
      },
      turnRef: {
        projectId: "system-lead", sessionStorageId: sessions.predecessor.storageId, startEventIndex: 0, endEventIndex: 2,
      },
    });
    assert.deepEqual(h.index.resolveCanonicalEvent({ topicId: "codex-authentication" }, {
      sessionStorageId: sessions.successor.storageId, eventIndex: 0,
    }), {
      ok: true,
      topicRef: { topicId: "codex-authentication" },
      threadRef: { threadId: "codex-authentication" },
      eventRef: {
        projectId: "system-lead", sessionStorageId: sessions.successor.storageId, eventIndex: 0,
      },
      turnRef: {
        projectId: "system-lead", sessionStorageId: sessions.successor.storageId, startEventIndex: 0, endEventIndex: 2,
      },
    });
  } finally { h.cleanup(); }
});

test("projection keeps lineage order when successor local indexes reset after compaction", function () {
  var h = harness();
  try {
    function turn(textUser, textAssistant, clientId) {
      return [
        { type: "user_message", text: textUser, from: "a66ce4a1", fromName: "Admin", clientMessageId: clientId },
        { type: "delta_replace", text: textAssistant },
        { type: "done" },
      ];
    }
    var predecessor = {
      coopHome: true,
      storageId: "canonical-topic-home-predecessor",
      history: turn("Unrelated design discussion", "Initial design reply", "cm-design")
        .concat(turn("Codex auth predecessor turn", "Initial auth reply", "cm-auth-predecessor")),
    };
    var successor = {
      coopHome: true,
      storageId: "canonical-topic-home-successor",
      compactedFromStorageId: predecessor.storageId,
      history: turn("Codex auth successor follow-up", "Successor auth reply", "cm-auth-successor"),
    };
    var replaySession = topicLineage.buildReplaySession(successor, [predecessor, successor]);
    assert.equal(h.index.ensureRetro(predecessor, retroOptions()).ok, true);
    assert.equal(h.index.ensureRetro(replaySession, retroOptions()).ok, true);

    var projection = h.index.project({
      history: replaySession,
      canAccessProject: function () { return true; },
    });
    var auth = projection.groups.reduce(function (found, group) {
      return found || (group.topics || []).find(function (topic) {
        return topic.topicRef.topicId === "codex-authentication";
      }) || null;
    }, null);

    assert.ok(auth);
    assert.deepEqual(auth.eventRefs, [
      { projectId: "system-lead", sessionStorageId: predecessor.storageId, eventIndex: 3 },
      { projectId: "system-lead", sessionStorageId: successor.storageId, eventIndex: 0 },
    ]);
    assert.deepEqual(auth.turnRefs, [
      { projectId: "system-lead", sessionStorageId: predecessor.storageId, startEventIndex: 3, endEventIndex: 5 },
      { projectId: "system-lead", sessionStorageId: successor.storageId, startEventIndex: 0, endEventIndex: 2 },
    ]);
    assert.deepEqual(auth.firstEventRef, {
      projectId: "system-lead", sessionStorageId: predecessor.storageId, eventIndex: 3,
    });
    assert.deepEqual(auth.lastEventRef, {
      projectId: "system-lead", sessionStorageId: successor.storageId, eventIndex: 0,
    });
    assert.deepEqual(auth.lastTurnRef, {
      projectId: "system-lead", sessionStorageId: successor.storageId, startEventIndex: 0, endEventIndex: 2,
    });
  } finally { h.cleanup(); }
});

test("projection computes bounded activity metadata without persisting it", function () {
  var h = harness();
  try {
    h.index.ensureRetro(canonicalSession(), retroOptions());
    var projection = h.index.project({
      computeTopicState: function (ref) {
        if (ref.topicId !== "codex-authentication") return null;
        return {
          status: "active", rollingSummary: "Awaiting owner confirmation",
          decisions: ["Use the canonical transcript"], unreadCount: 2,
          attention: true, currentActivity: "Validating topic ingress",
        };
      },
    });
    var auth = projection.groups.reduce(function (found, group) {
      return found || group.topics.find(function (topic) { return topic.topicRef.topicId === "codex-authentication"; });
    }, null);
    assert.deepEqual({
      status: auth.status, rollingSummary: auth.rollingSummary, decisions: auth.decisions,
      unreadCount: auth.unreadCount, attention: auth.attention, currentActivity: auth.currentActivity,
    }, {
      status: "active", rollingSummary: "Awaiting owner confirmation", decisions: ["Use the canonical transcript"],
      unreadCount: 2, attention: true, currentActivity: "Validating topic ingress",
    });
    assert.equal(fs.readFileSync(h.index.file, "utf8").includes("Awaiting owner confirmation"), false);
  } finally { h.cleanup(); }
});

test("canonical topic ingress rejects stale, deleted, mismatched, and unavailable targets", function () {
  var h = harness();
  try {
    var session = canonicalSession();
    h.index.ensureRetro(session, retroOptions());
    var valid = h.index.validateIngress(session, {
      coopTopicRef: { topicId: "navigation-session-restoration" }, coopProjectRef: { projectId: CLAY },
    }, { isProjectAvailable: function (ref) { return ref.projectId === CLAY; } });
    assert.equal(valid.ok, true);
    assert.deepEqual(valid.topicRef, { topicId: "navigation-session-restoration" });
    assert.equal(h.index.validateIngress(session, {
      coopTopicRef: { topicId: "navigation-session-restoration" }, coopProjectRef: { projectId: WEBAPP },
    }, { isProjectAvailable: function () { return true; } }).code, "topic_project_mismatch");
    assert.equal(h.index.validateIngress(session, {
      coopTopicRef: { topicId: "codex-authentication" }, coopProjectRef: { projectId: CLAY },
    }, { isProjectAvailable: function () { return true; } }).code, "topic_project_mismatch");
    assert.deepEqual(h.index.resolveCanonicalEvent({ topicId: "navigation-session-restoration" }, { eventIndex: 6 }), {
      ok: true,
      topicRef: { topicId: "navigation-session-restoration" },
      threadRef: { threadId: "navigation-session-restoration" },
      eventRef: { projectId: "system-lead", sessionStorageId: "canonical-topic-home", eventIndex: 6 },
      turnRef: { projectId: "system-lead", sessionStorageId: "canonical-topic-home", startEventIndex: 6, endEventIndex: 8 },
    });
    assert.equal(h.index.resolveCanonicalEvent({ topicId: "navigation-session-restoration" }, { eventIndex: 3 }).code, "event_not_in_topic");
    assert.equal(h.index.validateIngress(session, {
      coopTopicRef: { topicId: "navigation-session-restoration" }, coopProjectRef: { projectId: CLAY },
    }, { isProjectAvailable: function () { return false; } }).code, "project_target_unavailable");
    assert.equal(h.index.close({ topicId: "navigation-session-restoration" }).ok, true);
    assert.equal(h.index.validateIngress(session, { coopTopicRef: { topicId: "navigation-session-restoration" }, coopProjectRef: { projectId: CLAY } }).code, "topic_closed");
    delete h.index.load().topics["navigation-session-restoration"];
    h.index.save();
    assert.equal(h.index.validateIngress(session, { coopTopicRef: { topicId: "navigation-session-restoration" }, coopProjectRef: { projectId: CLAY } }).code, "topic_not_found");
    assert.equal(h.index.validateIngress({ coopHome: true, storageId: "stale-topic-home", history: [] }, {
      coopTopicRef: { topicId: "codex-authentication" },
    }).code, "canonical_coop_required");
  } finally { h.cleanup(); }
});

test("automatic classification reuses durable topics and infers a bounded project group", function () {
  var h = harness();
  try {
    var session = canonicalSession();
    h.index.ensureRetro(session, retroOptions());
    var options = {
      projects: [
        { projectId: CLAY, slug: "alpha", title: "Workbench Alpha" },
        { projectId: WEBAPP, slug: "beta", title: "Beta Platform" },
      ],
      isProjectAvailable: function (ref) { return ref.projectId === CLAY || ref.projectId === WEBAPP; },
    };
    var seed = h.index.classifyCanonicalIngress(session, {
      text: "Navigation session restoration needs another pass",
    }, options);
    // `classification` names the routing decision for the owner-request
    // ledger: reusing a durable topic is existing_topic, never new_topic.
    assert.deepEqual(seed, {
      ok: true, topicRef: { topicId: "navigation-session-restoration" },
      threadRef: { threadId: "navigation-session-restoration" },
      threadState: "exploring", threadTitle: "Navigation and session restoration",
      projectRef: { projectId: CLAY }, created: false, classification: "existing_topic",
    });

    var before = Object.keys(h.index.load().topics).length;
    var firstText = "Renderer caching regression details in Workbench Alpha must be verified";
    var first = h.index.classifyCanonicalIngress(session, { text: firstText }, options);
    assert.equal(first.created, true);
    assert.match(first.topicRef.topicId, /^auto-[a-f0-9]{24}$/);
    assert.deepEqual(first.projectRef, { projectId: CLAY });
    assert.equal(h.index.resolve(first.topicRef).topic.title,
      "Renderer caching regression details in Workbench Alpha");
    assert.deepEqual(h.index.resolve(first.topicRef).topic.keywords, ["renderer", "caching", "regression", "details", "workbench"]);
    assert.equal(fs.readFileSync(h.index.file, "utf8").includes(firstText), false);

    var related = h.index.classifyCanonicalIngress(session, {
      text: "Renderer caching regression details need another verification",
    }, options);
    assert.deepEqual(related.topicRef, first.topicRef);
    assert.equal(related.created, false);
    // Re-sending the same text reuses the topic it already minted, so it is a
    // reuse both by `created` and by the routing decision the ledger records.
    assert.deepEqual(h.index.classifyCanonicalIngress(session, { text: firstText }, options),
      Object.assign({}, first, { created: false, classification: "existing_topic" }));
    assert.equal(Object.keys(h.index.load().topics).length, before + 1, "related and duplicate ingress do not create a topic per turn");

    session.history.push({ type: "user_message", text: firstText, coopTopicRef: first.topicRef, from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" }, { type: "done" });
    var followUp = h.index.classifyCanonicalIngress(session, { text: "yes, continue" }, options);
    assert.deepEqual(followUp.topicRef, first.topicRef, "low-information follow-up keeps the recent durable topic");

    var multiple = h.index.classifyCanonicalIngress(session, {
      text: "Workbench Alpha and Beta Platform boundary review",
    }, options);
    assert.equal(h.index.resolve(multiple.topicRef).topic.group.kind, "cross_project");
    var none = h.index.classifyCanonicalIngress(session, { text: "Saffron heliotrope ledger review" }, options);
    assert.equal(h.index.resolve(none.topicRef).topic.group.kind, "uncategorised");
    var exactLens = h.index.classifyCanonicalIngress(session, {
      text: "Saffron heliotrope ledger review", coopProjectRef: { projectId: WEBAPP },
    }, options);
    assert.deepEqual(exactLens.projectRef, { projectId: WEBAPP });

    h.index.load().topics["legacy-manual-topic"] = {
      topicRef: { topicId: "legacy-manual-topic" }, title: "Ledger Reconciliation Rollout",
      keywords: [], group: { kind: "uncategorised" },
      source: "manual", status: "open", createdAt: 1, updatedAt: 1, eventRefs: [], turnRefs: [], relatedExecutions: [],
    };
    h.index.save();
    var manual = h.index.classifyCanonicalIngress(session, { text: "Ledger reconciliation rollout status" }, options);
    assert.deepEqual(manual.topicRef, { topicId: "legacy-manual-topic" });
  } finally { h.cleanup(); }
});

test("automatic titles do not garble contractions into orphan fragments", function () {
  // "don't" used to split into "don" + a dropped "t", leaving stray tokens
  // like "Don" in the derived title. Titles are now a verbatim readable
  // excerpt: the contraction survives intact and word order is preserved.
  var title = classification.readableTitle("Don't create a project, just categorise them");
  assert.equal(title, "Don't create a project, just categorise them");
  assert.equal(classification.automaticTopicId("Don't create a project, just categorise them", { kind: "uncategorised" }),
    classification.automaticTopicId("Don't create a project, just categorise them", { kind: "uncategorised" }),
    "the derivation is deterministic");
});

test("automatic titles preserve the owner's word order instead of keyword salad", function () {
  var session = canonicalSession();
  var h = harness();
  try {
    h.index.ensureRetro(session, retroOptions());
    var options = { projects: [], isProjectAvailable: function () { return false; } };
    var result = h.index.classifyCanonicalIngress(session, {
      text: "What do you mean by checking whether it should be delegated",
    }, options);
    assert.equal(result.ok, true);
    var title = h.index.resolve(result.topicRef).topic.title;
    // A complete initial clause in the owner's own order, not a raw prefix.
    assert.equal(title, "Checking whether it should be delegated");
  } finally { h.cleanup(); }
});

test("a low-information turn with no recent topic lands in the catch-all, not a fresh single-turn topic", function () {
  var session = canonicalSession();
  var h = harness();
  try {
    h.index.ensureRetro(session, retroOptions());
    var options = { projects: [], isProjectAvailable: function () { return false; } };
    var before = Object.keys(h.index.load().topics).length;
    var result = h.index.classifyCanonicalIngress(session, { text: "Where are we now" }, options);
    assert.equal(result.ok, true);
    assert.deepEqual(result.topicRef, { topicId: "uncategorised-conversations" });
    assert.equal(Object.keys(h.index.load().topics).length, before,
      "a throwaway low-information turn must not mint its own permanent topic");
  } finally { h.cleanup(); }
});

test("a low-information turn still reuses a recent open topic instead of falling to the catch-all", function () {
  var session = canonicalSession();
  var h = harness();
  try {
    h.index.ensureRetro(session, retroOptions());
    var options = { projects: [], isProjectAvailable: function () { return false; } };
    var first = h.index.classifyCanonicalIngress(session, {
      text: "Renderer caching regression details in Workbench Alpha must be verified",
    }, options);
    session.history.push({ type: "user_message", text: "x", coopTopicRef: first.topicRef }, { type: "done" });
    var followUp = h.index.classifyCanonicalIngress(session, { text: "yes, continue" }, options);
    assert.deepEqual(followUp.topicRef, first.topicRef);
  } finally { h.cleanup(); }
});

test("the title retrofit fixes an already-minted garbled topic and is idempotent across restarts", function () {
  var session = canonicalSession();
  var h = harness();
  try {
    h.index.ensureRetro(session, retroOptions());
    // Simulate a topic minted by the OLD, buggy classifier: contraction split
    // into an orphan fragment, with a turnRef anchored to a real owner turn
    // already present in the canonical history (index 6, "Navigation session
    // restoration...").
    var crypto = require("node:crypto");
    var groupKey = "uncategorised";
    var garbledTitle = "Don Session Restoration Sidebar";
    var digest = crypto.createHash("sha256").update(groupKey + "\n" + garbledTitle.toLowerCase()).digest("hex");
    var topicId = "auto-" + digest.slice(0, 24);
    var index = h.index.load();
    index.topics[topicId] = {
      topicRef: { topicId: topicId }, title: garbledTitle, group: { kind: "uncategorised" },
      source: "automatic", status: "open", createdAt: 1, updatedAt: 1,
      keywords: [], eventRefs: [], relatedExecutions: [],
      turnRefs: [{ sessionStorageId: session.storageId, startEventIndex: 6, endEventIndex: 8 }],
    };
    h.index.save();

    var report = h.index.retrofitTopicTitles(session);
    assert.equal(report.ok, true);
    assert.equal(report.changed, true);
    assert.equal(report.report.retitled, 1);
    var fixed = h.index.load().topics[topicId];
    assert.notEqual(fixed.title, garbledTitle);
    assert.doesNotMatch(fixed.title, /\bDon\b/);
    assert.equal(fixed.topicRef.topicId, topicId, "identity is preserved so existing links keep resolving");

    var again = h.index.retrofitTopicTitles(session);
    assert.equal(again.changed, false, "a second run against the same in-memory index is a no-op");

    var restarted = topics.createTopicIndex({ file: h.index.file, now: function () { return 500; } });
    var afterRestart = restarted.retrofitTopicTitles(session);
    assert.equal(afterRestart.changed, false, "the fix persisted across a fresh load and is never re-applied");
    assert.equal(restarted.load().topics[topicId].title, fixed.title);
  } finally { h.cleanup(); }
});

test("a real legacy-shaped canonical index still projects valid topics after migration and restart", function () {
  // Owner regression 2026-08-09 ~14:34: the phone sheet showed zero topics.
  // Production turnRefs are legacy-shaped (startEventIndex points at the
  // boundary record BEFORE the owner message), so any projection or migration
  // pass that only accepts canonical offsets suppresses every valid topic at
  // once. This proves the full pipeline -- reconcile, retrofit, save, fresh
  // process load -- keeps legacy-anchored topics owner-visible while a
  // genuinely drifted fragment stays suppressed.
  var session = canonicalSession();
  var h = harness();
  try {
    h.index.ensureRetro(session, retroOptions());
    var state = h.index.load();
    var ids = Object.keys(state.topics);
    for (var i = 0; i < ids.length; i++) {
      var refs = state.topics[ids[i]].turnRefs || [];
      for (var j = 0; j < refs.length; j++) {
        if (refs[j].startEventIndex > 0) refs[j].startEventIndex -= 1;
      }
    }
    state.topics["auto-bbbbbbbbbbbbbbbbbbbbbbbb"] = {
      topicRef: { topicId: "auto-bbbbbbbbbbbbbbbbbbbbbbbb" },
      title: "Drifted fragment", group: { kind: "uncategorised" },
      source: "automatic", status: "open", createdAt: 1, updatedAt: 1,
      keywords: [], eventRefs: [], relatedExecutions: [],
      // Anchored at an assistant record: neither offset 0 nor +1 reaches an
      // owner message, so this row must never render.
      turnRefs: [{ sessionStorageId: session.storageId, startEventIndex: 4, endEventIndex: 5 }],
    };
    h.index.save();

    h.index.reconcileTopicAnchors(session);
    h.index.retrofitTopicTitles(session);

    var restarted = topics.createTopicIndex({ file: h.index.file, now: function () { return 900; } });
    var projection = restarted.project({
      history: session.history,
      canAccessProject: function () { return true; },
    });
    var titles = [];
    projection.groups.forEach(function (group) {
      group.topics.forEach(function (t) { titles.push(t.title); });
    });
    assert.ok(titles.length > 0, "legacy-anchored topics must survive migration and restart, not vanish");
    assert.ok(titles.indexOf("Codex authentication") !== -1);
    assert.equal(titles.indexOf("Drifted fragment"), -1, "unprovable fragments stay suppressed");
    // Idempotent: the same migration on the restarted index changes nothing.
    var again = restarted.retrofitTopicTitles(session);
    assert.equal(again.changed, false);
  } finally { h.cleanup(); }
});

test("retro version upgrades replace stale derived memberships and preserve managed topics", function () {
  var h = harness();
  try {
    var session = canonicalSession();
    h.index.ensureRetro(session, retroOptions());
    var state = h.index.load();
    state.retro = { version: 2, completedEventCount: session.history.length };
    state.topics["codex-authentication"].eventRefs.push({
      projectId: "system-lead", sessionStorageId: session.storageId, eventIndex: 5,
    });
    state.topics["codex-authentication"].turnRefs = [];
    state.topics["auto-aaaaaaaaaaaaaaaaaaaaaaaa"] = {
      topicRef: { topicId: "auto-aaaaaaaaaaaaaaaaaaaaaaaa" },
      title: "Automatic conversation aaaaaaaaaa", group: { kind: "uncategorised" },
      source: "automatic", status: "open", createdAt: 1, updatedAt: 1,
      keywords: [], eventRefs: [{ projectId: "system-lead", sessionStorageId: session.storageId, eventIndex: 3 }],
      turnRefs: [], relatedExecutions: [],
    };
    state.topics["managed-split"] = {
      topicRef: { topicId: "managed-split" }, title: "Managed split",
      group: { kind: "uncategorised" }, source: "split", status: "closed",
      createdAt: 1, updatedAt: 2, keywords: [],
      eventRefs: [{ projectId: "system-lead", sessionStorageId: session.storageId, eventIndex: 0 }],
      turnRefs: [], relatedExecutions: [],
    };
    h.index.save();

    var restarted = topics.createTopicIndex({ file: h.index.file, now: function () { return 500; } });
    var migrated = restarted.ensureRetro(session, retroOptions());
    var saved = fs.readFileSync(h.index.file, "utf8");
    assert.equal(migrated.changed, true);
    assert.equal(restarted.load().retro.version, 3);
    assert.equal(restarted.resolve({ topicId: "auto-aaaaaaaaaaaaaaaaaaaaaaaa" }, true).code, "topic_not_found");
    assert.equal(restarted.resolve({ topicId: "codex-authentication" }).topic.eventRefs.some(function (ref) {
      return ref.eventIndex === 5;
    }), false);
    assert.deepEqual(restarted.resolve({ topicId: "managed-split" }, true).topic.eventRefs, [{
      projectId: "system-lead", sessionStorageId: session.storageId, eventIndex: 0,
    }]);
    assert.equal(restarted.resolve({ topicId: "managed-split" }, true).topic.status, "closed");
    assert.equal(restarted.ensureRetro(session, retroOptions()).changed, false);
    assert.equal(fs.readFileSync(h.index.file, "utf8"), saved);
  } finally { h.cleanup(); }
});

test("retro version upgrades preserve settled automatic topic membership", function () {
  // Every live topic is source:'automatic', so the retro reset is the only
  // thing standing between a settled topic and an empty one. Open automatic
  // topics are safe to clear because the extraction pass re-derives them from
  // the canonical history; closed and merged topics are not -- they no longer
  // accrete, so clearing their refs empties them permanently and drops them
  // out of Done and out of replay. This pins the status guard.
  var topicRelevance = require("../lib/coop-topic-relevance");
  var topicAnchors = require("../lib/coop-topic-anchors");
  var h = harness();
  try {
    var session = canonicalSession();
    h.index.ensureRetro(session, retroOptions());
    var state = h.index.load();
    state.retro = { version: 2, completedEventCount: session.history.length };
    // Stale membership on an OPEN automatic topic must still be reset.
    state.topics["codex-authentication"].eventRefs.push({
      projectId: "system-lead", sessionStorageId: session.storageId, eventIndex: 5,
    });
    var closedRefs = [{ projectId: "system-lead", sessionStorageId: session.storageId, eventIndex: 6 }];
    var closedTurns = [{
      projectId: "system-lead", sessionStorageId: session.storageId,
      startEventIndex: 6, endEventIndex: 8,
    }];
    state.topics["closed-automatic"] = {
      topicRef: { topicId: "closed-automatic" }, title: "Closed automatic topic",
      group: { kind: "uncategorised" }, source: "automatic", status: "closed",
      createdAt: 1, updatedAt: 2, keywords: [],
      eventRefs: closedRefs.map(function (ref) { return Object.assign({}, ref); }),
      turnRefs: closedTurns.map(function (ref) { return Object.assign({}, ref); }),
      relatedExecutions: [],
    };
    var mergedRefs = [{ projectId: "system-lead", sessionStorageId: session.storageId, eventIndex: 9 }];
    var mergedTurns = [{
      projectId: "system-lead", sessionStorageId: session.storageId,
      startEventIndex: 9, endEventIndex: 11,
    }];
    state.topics["merged-automatic"] = {
      topicRef: { topicId: "merged-automatic" }, title: "Merged automatic topic",
      group: { kind: "uncategorised" }, source: "automatic", status: "merged",
      mergedInto: { topicId: "codex-authentication" },
      createdAt: 1, updatedAt: 2, keywords: [],
      eventRefs: mergedRefs.map(function (ref) { return Object.assign({}, ref); }),
      turnRefs: mergedTurns.map(function (ref) { return Object.assign({}, ref); }),
      relatedExecutions: [],
    };
    // A closed topic wearing the legacy opaque id and title is still settled
    // membership: the legacy purge only ever removes OPEN opaque fragments.
    state.topics["auto-cccccccccccccccccccccccc"] = {
      topicRef: { topicId: "auto-cccccccccccccccccccccccc" },
      title: "Automatic conversation cccccccccc", group: { kind: "uncategorised" },
      source: "automatic", status: "closed", createdAt: 1, updatedAt: 2, keywords: [],
      eventRefs: [{ projectId: "system-lead", sessionStorageId: session.storageId, eventIndex: 12 }],
      turnRefs: [{
        projectId: "system-lead", sessionStorageId: session.storageId,
        startEventIndex: 12, endEventIndex: 14,
      }],
      relatedExecutions: [],
    };
    h.index.save();

    var restarted = topics.createTopicIndex({ file: h.index.file, now: function () { return 500; } });
    var migrated = restarted.ensureRetro(session, retroOptions());
    assert.equal(migrated.changed, true);
    assert.equal(restarted.load().retro.version, 3);

    // Open automatic topics keep the existing reset-and-re-derive behavior.
    var open = restarted.resolve({ topicId: "codex-authentication" }).topic;
    assert.equal(open.eventRefs.some(function (ref) { return ref.eventIndex === 5; }), false,
      "open automatic topics must still be reset and re-derived");
    assert.ok(open.eventRefs.length > 0, "the extraction pass re-derives open automatic membership");

    // Closed membership survives byte-for-byte.
    var closed = restarted.resolve({ topicId: "closed-automatic" }, true).topic;
    assert.deepEqual(closed.eventRefs, closedRefs);
    assert.deepEqual(closed.turnRefs, closedTurns);
    assert.equal(closed.status, "closed");

    // Merged membership survives too, so the merge target's history is intact.
    var merged = restarted.resolve({ topicId: "merged-automatic" }, true).topic;
    assert.deepEqual(merged.eventRefs, mergedRefs);
    assert.deepEqual(merged.turnRefs, mergedTurns);
    assert.equal(merged.status, "merged");

    var legacyClosed = restarted.resolve({ topicId: "auto-cccccccccccccccccccccccc" }, true);
    assert.equal(legacyClosed.ok, true, "the legacy opaque purge must not reach closed topics");
    assert.equal(legacyClosed.topic.turnRefs.length, 1);

    // Surviving refs are not inert: the closed topic stays projectable and
    // replayable, so it still renders in Done and opens onto a real transcript.
    assert.equal(topicRelevance.topicHasRelevantTurn(closed, session.history), true);
    assert.equal(topicAnchors.isProjectable(closed, session.history), true);
    assert.equal(topicRelevance.topicHasRelevantTurn(merged, session.history), true);
    assert.equal(topicAnchors.isProjectable(merged, session.history), true);
    var projection = restarted.project({
      history: session.history,
      canAccessProject: function () { return true; },
    });
    var titles = [];
    projection.groups.forEach(function (group) {
      group.topics.forEach(function (t) { titles.push(t.title); });
    });
    assert.notEqual(titles.indexOf("Closed automatic topic"), -1,
      "a closed automatic topic must still project into Done after a retro upgrade");

    // Still idempotent: a second pass at the current version changes nothing.
    var saved = fs.readFileSync(h.index.file, "utf8");
    assert.equal(restarted.ensureRetro(session, retroOptions()).changed, false);
    assert.equal(fs.readFileSync(h.index.file, "utf8"), saved);
  } finally { h.cleanup(); }
});

test("Coop session-ref resolution refuses a session that became a worker", function () {
  var topicConnection = require("../lib/coop-topic-connection");

  // The projection only ever links parentless sessions, but a link can go stale:
  // the session may be adopted as a worker before the owner clicks it.
  assert.equal(topicConnection.isTopLevelSession({ storageId: "top" }), true);
  assert.equal(topicConnection.isTopLevelSession({
    storageId: "worker", orchestrationParent: { sessionStorageId: "coordinator", taskId: "t1" },
  }), false);
  assert.equal(topicConnection.isTopLevelSession({
    storageId: "worker", orchestrationGroupParent: { sessionStorageId: "coordinator" },
  }), false);
  // A parent record with no session reference does not make a session a worker.
  assert.equal(topicConnection.isTopLevelSession({ storageId: "top", orchestrationParent: {} }), true);

  var sent = [];
  var ctx = {
    slug: "lead",
    sendTo: function (ws, msg) { sent.push(msg); },
    resolveGlobalSessionRef: function (ref) {
      return {
        ok: true,
        ref: ref,
        project: { slug: "clay" },
        session: /^worker/.test(ref.sessionStorageId)
          ? { localId: 9, orchestrationParent: { sessionStorageId: "coordinator", taskId: "t1" } }
          : { localId: 4 },
      };
    },
  };

  var workerRef = { projectId: CLAY, sessionStorageId: "worker-now" };
  assert.equal(topicConnection.handleCoopMessage(ctx, {}, { type: "resolve_session_ref", sessionRef: workerRef }), true);
  assert.deepEqual(sent[0], { type: "session_ref_resolved", ok: false, code: "worker_session_denied" });
  assert.equal(JSON.stringify(sent).includes("worker-now"), false, "no worker reference is echoed back");

  ctx.coopOwnerRequests = {
    list: function () {
      return [{
        ingressId: "coop:test:1", ingressSequence: 1, ingressKind: "user_message",
        receivedAt: 1, requestRef: null, topicRef: { topicId: "topic-1" },
        projectRefs: [{ projectId: CLAY }], expectsExecution: true, state: "working",
        response: { state: "unanswered", answeredAt: null },
      }];
    },
    listCoordinators: function () {
      return [{ topicId: "topic-1", projectId: CLAY,
        coordinator: { projectId: CLAY, sessionStorageId: "coordinator" } }];
    },
  };
  ctx.coopSessionLedger = {
    list: function () {
      return [{
        sessionRef: { projectId: CLAY, sessionStorageId: "coordinator" },
        sessionPresent: true, hidden: false, role: "project_coordinator", workState: "working",
      }, {
        sessionRef: workerRef,
        parentSessionRef: { projectId: CLAY, sessionStorageId: "coordinator" },
        sessionPresent: true, hidden: false, role: "worker", workState: "working",
      }];
    },
  };
  ctx.coopTopicIndex = { load: function () { return { topics: {} }; } };
  ctx.isCoopTopicOwner = function () { return true; };

  sent.length = 0;
  topicConnection.handleCoopMessage(ctx, {}, {
    type: "resolve_session_ref", sessionRef: workerRef, scope: "owner_request_hierarchy",
  });
  assert.equal(sent[0].ok, true, "an ACL-scoped hierarchy member resolves directly");
  assert.deepEqual(sent[0].sessionRef, workerRef);

  sent.length = 0;
  topicConnection.handleCoopMessage(ctx, {}, {
    type: "resolve_session_ref",
    sessionRef: { projectId: CLAY, sessionStorageId: "worker-not-projected" },
    scope: "owner_request_hierarchy",
  });
  assert.deepEqual(sent[0], { type: "session_ref_resolved", ok: false, code: "worker_session_denied" });

  sent.length = 0;
  var topRef = { projectId: CLAY, sessionStorageId: "still-top" };
  topicConnection.handleCoopMessage(ctx, {}, { type: "resolve_session_ref", sessionRef: topRef });
  assert.equal(sent[0].ok, true);
  assert.equal(sent[0].localId, 4);
});
