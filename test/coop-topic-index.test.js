var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var assert = require("node:assert/strict");

var topics = require("../lib/coop-topic-index");
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
    assert.equal(state.topics[automaticId].title.includes("quiet unmatched"), false);
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
    assert.equal(h.index.linkExecution(selected.topicRef, {
      projectRef: { projectId: CLAY },
      children: [{ sessionRef: { projectId: CLAY, sessionStorageId: "project-coordinator" }, children: [{
        taskRef: { projectId: CLAY, coordinatorSessionStorageId: "project-coordinator", taskId: "child-task" },
      }] }],
    }).ok, true);
    assert.equal(h.index.merge(selected.topicRef, [mergeSource.topicRef]).ok, true);
    assert.equal(h.index.resolve(mergeSource.topicRef, true).topic.status, "merged");
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
    var visible = h.index.project({
      actor: { id: "owner" },
      canAccessProject: function (_, ref) { return ref.projectId === CLAY; },
    });
    assert.ok(visible.groups.some(function (group) { return group.kind === "project" && group.projectRef.projectId === CLAY; }));
    assert.ok(visible.groups.some(function (group) { return group.kind === "cross_project"; }));
    assert.ok(visible.groups.some(function (group) { return group.kind === "uncategorised"; }));
    assert.equal(JSON.stringify(visible).includes(WEBAPP), false);
    var revoked = h.index.project({ canAccessProject: function () { return false; } });
    assert.equal(revoked.groups.some(function (group) { return group.kind === "project"; }), false);
  } finally { h.cleanup(); }
});

test("closed topics leave the server projection and empty groups disappear", function () {
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
    h.index.save();

    var before = h.index.project({ canAccessProject: function () { return true; } });
    assert.ok(before.groups.some(function (group) {
      return group.projectRef && group.projectRef.projectId === CLOSED_PROJECT;
    }));

    assert.equal(h.index.close({ topicId: "closed-project-only-topic" }).ok, true);
    var after = h.index.project({ canAccessProject: function () { return true; } });
    assert.equal(after.groups.some(function (group) {
      return group.projectRef && group.projectRef.projectId === CLOSED_PROJECT;
    }), false, "the group disappears when its last open topic closes");
    assert.equal(JSON.stringify(after).includes("Close this topic"), false);
    assert.equal(JSON.stringify(after).includes("closed-project-only-topic"), false);
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
    assert.deepEqual(seed, {
      ok: true, topicRef: { topicId: "navigation-session-restoration" },
      projectRef: { projectId: CLAY }, created: false,
    });

    var before = Object.keys(h.index.load().topics).length;
    var firstText = "Renderer caching regression details in Workbench Alpha must be verified";
    var first = h.index.classifyCanonicalIngress(session, { text: firstText }, options);
    assert.equal(first.created, true);
    assert.match(first.topicRef.topicId, /^auto-[a-f0-9]{24}$/);
    assert.deepEqual(first.projectRef, { projectId: CLAY });
    assert.equal(h.index.resolve(first.topicRef).topic.title, "Renderer Caching Regression Details Workbench");
    assert.deepEqual(h.index.resolve(first.topicRef).topic.keywords, ["renderer", "caching", "regression", "details", "workbench"]);
    assert.equal(fs.readFileSync(h.index.file, "utf8").includes(firstText), false);

    var related = h.index.classifyCanonicalIngress(session, {
      text: "Renderer caching regression details need another verification",
    }, options);
    assert.deepEqual(related.topicRef, first.topicRef);
    assert.equal(related.created, false);
    assert.deepEqual(h.index.classifyCanonicalIngress(session, { text: firstText }, options), Object.assign({}, first, { created: false }));
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
        session: ref.sessionStorageId === "worker-now"
          ? { localId: 9, orchestrationParent: { sessionStorageId: "coordinator", taskId: "t1" } }
          : { localId: 4 },
      };
    },
  };

  var workerRef = { projectId: CLAY, sessionStorageId: "worker-now" };
  assert.equal(topicConnection.handleCoopMessage(ctx, {}, { type: "resolve_session_ref", sessionRef: workerRef }), true);
  assert.deepEqual(sent[0], { type: "session_ref_resolved", ok: false, code: "worker_session_denied" });
  assert.equal(JSON.stringify(sent).includes("worker-now"), false, "no worker reference is echoed back");

  sent.length = 0;
  var topRef = { projectId: CLAY, sessionStorageId: "still-top" };
  topicConnection.handleCoopMessage(ctx, {}, { type: "resolve_session_ref", sessionRef: topRef });
  assert.equal(sent[0].ok, true);
  assert.equal(sent[0].localId, 4);
});
