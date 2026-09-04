var test = require("node:test");
var assert = require("node:assert/strict");

var ownerThread = require("../lib/coop-owner-thread");
var coopTopicIndex = require("../lib/coop-topic-index");

var CLAY_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var INGRESS = "coop:871a194b-8879-40f7-a1fe-656e48e722af:430";

// Minimal in-memory stand-in for the topic-index seam.
function seam(topics) {
  var state = { topics: topics || {} };
  var saves = 0;
  return {
    state: state,
    saves: function () { return saves; },
    load: function () { return state; },
    save: function () { saves++; },
    now: function () { return 5000; },
    makeTopic: function (id, title, group, source, at) {
      return {
        topicRef: { topicId: id },
        threadRef: { threadId: id },
        title: title,
        group: group,
        source: source,
        status: "open",
        threadState: "exploring",
        createdAt: at,
        updatedAt: at,
      };
    },
  };
}

test("an owner request with a ProjectRef but no ThreadRef gets a deterministic Thread", function () {
  var store = seam();
  var created = ownerThread.ensure(store, {
    ingressId: INGRESS,
    projectRef: { projectId: CLAY_ID },
    title: "Create a fresh canonical Clay coordinator",
  });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.threadRef.threadId, created.topicRef.topicId);
  assert.equal(store.saves(), 1);

  var topic = store.state.topics[created.topicRef.topicId];
  assert.equal(topic.source, "owner_request");
  assert.equal(topic.group.kind, "project");
  assert.equal(topic.group.projectRef.projectId, CLAY_ID);
  assert.equal(topic.ownerProvenance.schema, ownerThread.PROVENANCE_SCHEMA);
  assert.equal(topic.ownerProvenance.ingressId, INGRESS);

  // Deterministic: the same request resolves to the same Thread and writes
  // nothing, so a retry cannot create a second container for one request.
  var again = ownerThread.ensure(store, {
    ingressId: INGRESS, projectRef: { projectId: CLAY_ID },
  });
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.unchanged, true);
  assert.equal(again.topicRef.topicId, created.topicRef.topicId);
  assert.equal(store.saves(), 1, "an existing Thread must not be rewritten");

  // A different ingress or a different project is a different Thread.
  var otherIngress = ownerThread.threadIdFor(INGRESS + "1", { projectId: CLAY_ID });
  var otherProject = ownerThread.threadIdFor(INGRESS,
    { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" });
  assert.notEqual(otherIngress, created.topicRef.topicId);
  assert.notEqual(otherProject, created.topicRef.topicId);
});

test("owner Thread creation fails closed on malformed or impossible requests", function () {
  var store = seam();
  assert.equal(ownerThread.ensure(store, {
    projectRef: { projectId: CLAY_ID } }).code, "owner_thread_request_malformed");
  assert.equal(ownerThread.ensure(store, { ingressId: INGRESS }).code,
    "owner_thread_request_malformed");
  assert.equal(ownerThread.ensure(store, {
    ingressId: INGRESS, projectRef: { projectId: "not-a-project" } }).code,
    "owner_thread_request_malformed");
  // Lead is the staffing side, never an execution target.
  assert.equal(ownerThread.ensure(store, {
    ingressId: INGRESS, projectRef: { projectId: "system-lead" } }).code,
    "owner_thread_request_malformed");
  assert.equal(ownerThread.ensure(null, {
    ingressId: INGRESS, projectRef: { projectId: CLAY_ID } }).code,
    "owner_thread_store_unavailable");
  assert.equal(store.saves(), 0);
});

test("an existing Thread with drifted identity is a conflict, never reused", function () {
  var id = ownerThread.threadIdFor(INGRESS, { projectId: CLAY_ID });
  // Same id, but automation provenance: this is not the owner Thread it claims.
  var hijacked = {};
  hijacked[id] = {
    topicRef: { topicId: id }, threadRef: { threadId: id },
    source: "project_automation", group: { kind: "project", projectRef: { projectId: CLAY_ID } },
    status: "open", threadState: "exploring",
  };
  var store = seam(hijacked);
  assert.equal(ownerThread.ensure(store, {
    ingressId: INGRESS, projectRef: { projectId: CLAY_ID } }).code,
    "owner_thread_identity_conflict");
  assert.equal(store.saves(), 0);

  // A closed Thread is not silently reopened either.
  var closed = {};
  closed[id] = {
    topicRef: { topicId: id }, threadRef: { threadId: id },
    source: "owner_request",
    group: { kind: "project", projectRef: { projectId: CLAY_ID } },
    ownerProvenance: ownerThread.provenanceFor(INGRESS, { projectId: CLAY_ID }),
    status: "closed", threadState: "closed",
  };
  var closedStore = seam(closed);
  assert.equal(ownerThread.ensure(closedStore, {
    ingressId: INGRESS, projectRef: { projectId: CLAY_ID } }).code,
    "owner_thread_closed");
  assert.equal(closedStore.saves(), 0);
});

test("the topic index exposes owner Thread creation alongside automation", function () {
  var index = coopTopicIndex.createTopicIndex({
    fs: {
      readFileSync: function () { var e = new Error("nope"); e.code = "ENOENT"; throw e; },
      writeFileSync: function () {},
      renameSync: function () {},
      mkdirSync: function () {},
      existsSync: function () { return false; },
    },
    file: "/tmp/does-not-matter-owner-thread.json",
    now: function () { return 7000; },
  });
  assert.equal(typeof index.ensureOwnerThread, "function");
  var result = index.ensureOwnerThread({
    ingressId: INGRESS,
    projectRef: { projectId: CLAY_ID },
    title: "Owner requested coordinator",
  });
  assert.equal(result.ok, true);
  assert.equal(result.threadRef.threadId, result.topicRef.topicId);
});
