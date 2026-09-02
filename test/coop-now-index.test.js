var test = require("node:test");
var assert = require("node:assert/strict");
var nowIndex = require("../lib/coop-now-index");
var buildNowIndex = nowIndex.buildNowIndex;

// The owner's "Now" index: one deterministic, bounded, topic-only projection
// of what is genuinely current. These drive the real builder with realistic
// topic projections (the clientTopic shape) and real queue-item shapes.

function topic(id, workState, stateSource, updatedAt, title) {
  return {
    topicRef: { topicId: id },
    projectRef: { projectId: "p1" },
    title: title || ("Topic " + id),
    workState: workState,
    stateSource: stateSource,
    updatedAt: updatedAt || 0,
  };
}

test("a topic with genuinely active linked work appears as Working now", function () {
  var out = buildNowIndex([topic("t1", "working", "task_working", 10)], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].topicRef.topicId, "t1");
  assert.equal(out[0].kind, "working");
  assert.equal(out[0].reason, "Working now");
});

test("foreground work on the exact lens is Working now too", function () {
  var out = buildNowIndex([topic("t1", "working", "foreground", 10)], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, "Working now");
});

test("current task attention appears before working, in that order", function () {
  var out = buildNowIndex([
    topic("t-work", "working", "task_working", 5),
    topic("t-attn", "needs_input", "task_attention", 50),
  ], []);
  assert.deepEqual(out.map(function (e) { return e.topicRef.topicId; }), ["t-attn", "t-work"]);
  assert.equal(out[0].kind, "attention");
  assert.equal(out[1].kind, "working");
});

test("work awaiting acceptance states the truthful next step", function () {
  var out = buildNowIndex([topic("t1", "needs_input", "task_awaiting_acceptance", 10)], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "attention");
  assert.equal(out[0].reason, "Worker finished — review the result");
});

test("quiet unlinked historical topics are excluded", function () {
  var out = buildNowIndex([
    topic("t1", "needs_input", "owner_disposition:unlinked_historical", 10),
    topic("t2", "needs_input", "unlinked_default", 20),
    topic("t3", "needs_input", "task_abandoned", 30),
    topic("t4", "needs_input", "task_indeterminate", 40),
  ], []);
  assert.equal(out.length, 0, "nothing current is asking for the owner");
});

test("terminal accepted and closed work is excluded", function () {
  var out = buildNowIndex([
    topic("t1", "done", "task_accepted", 10),
    topic("t2", "done", "topic_closed", 20),
    topic("t3", "done", "owner_disposition:recorded", 30),
  ], []);
  assert.equal(out.length, 0);
});

test("a live topic-linked queue decision makes its topic an attention entry", function () {
  var out = buildNowIndex(
    [topic("t1", "needs_input", "owner_disposition:unlinked_historical", 10)],
    [{ itemId: "p1|issue#9", topicRef: { topicId: "t1" }, kind: "decision", status: "blocked", updatedAt: 20 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "attention");
  assert.equal(out[0].reason, "Blocked — needs you");
});

test("attention wins when the same topic is both active and actionable", function () {
  var out = buildNowIndex(
    [topic("t1", "working", "task_working", 10)],
    [{ itemId: "p1|issue#9", topicRef: { topicId: "t1" }, kind: "acceptance", status: "completed", updatedAt: 20 }]);
  assert.equal(out.length, 1, "strictly one entry per canonical TopicRef");
  assert.equal(out[0].kind, "attention");
  assert.equal(out[0].reason, "Worker finished — review the result");
});

test("a queue item without a topic link never produces an entry", function () {
  var out = buildNowIndex(
    [topic("t1", "needs_input", "owner_disposition:unlinked_historical", 10)],
    [{ itemId: "p1|issue#9", topicRef: null, kind: "decision", status: "needs_input", updatedAt: 20 }]);
  assert.equal(out.length, 0, "raw task rows are not topics");
});

test("a queue item pointing at a topic outside the projection resolves to nothing", function () {
  var out = buildNowIndex(
    [topic("t1", "working", "task_working", 10)],
    [{ itemId: "p1|issue#9", topicRef: { topicId: "gone" }, kind: "decision", status: "blocked", updatedAt: 20 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].topicRef.topicId, "t1", "only resolvable canonical destinations appear");
});

test("dedup is strict by canonical TopicRef", function () {
  var out = buildNowIndex([
    topic("t1", "working", "task_working", 10),
    topic("t1", "working", "task_working", 20),
    topic("t1", "needs_input", "task_attention", 30),
  ], []);
  assert.equal(out.length, 1);
});

test("ordering is deterministic: oldest first with TopicRef tiebreak, input order irrelevant", function () {
  var topics = [
    topic("b", "working", "task_working", 10),
    topic("a", "working", "task_working", 10),
    topic("c", "working", "task_working", 5),
  ];
  var forward = buildNowIndex(topics, []);
  var reversed = buildNowIndex(topics.slice().reverse(), []);
  assert.deepEqual(forward.map(function (e) { return e.topicRef.topicId; }), ["c", "a", "b"]);
  assert.deepEqual(reversed.map(function (e) { return e.topicRef.topicId; }),
    forward.map(function (e) { return e.topicRef.topicId; }));
});

test("the index is bounded", function () {
  var topics = [];
  for (var i = 0; i < 40; i++) topics.push(topic("t" + (100 + i), "working", "task_working", i));
  var out = buildNowIndex(topics, []);
  assert.equal(out.length, nowIndex.MAX_NOW_ITEMS);
});

test("attention entries survive the bound before working ones", function () {
  var topics = [];
  for (var i = 0; i < 25; i++) topics.push(topic("w" + (100 + i), "working", "task_working", i));
  topics.push(topic("attn", "needs_input", "task_attention", 999));
  var out = buildNowIndex(topics, []);
  assert.equal(out[0].topicRef.topicId, "attn", "attention is never pushed out by working volume");
});

test("entries carry only link-only orientation fields", function () {
  var working = topic("t1", "working", "task_working", 10, "Build it");
  working.relatedSessions = [{
    projectRef: { projectId: "p1" },
    sessionRef: { projectId: "p1", sessionStorageId: "working-context" },
    title: "Working context",
  }];
  var out = buildNowIndex([working], []);
  assert.deepEqual(Object.keys(out[0]).sort(),
    ["kind", "projectRef", "reason", "sessionRef", "title", "topicRef", "updatedAt"]);
  assert.equal(out[0].title, "Build it");
  assert.deepEqual(out[0].sessionRef, { projectId: "p1", sessionStorageId: "working-context" },
    "a working topic retains its existing project-bound navigation context");
});

test("the global projection carries the Now index end to end", function () {
  var projection = require("../lib/global-coop-projection");
  var message = projection.buildGlobalCoopProjection({ projects: [] });
  assert.ok(Array.isArray(message.nowIndex), "nowIndex rides the projection message");
});
