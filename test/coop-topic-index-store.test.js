// The Coop topic index holds irreplaceable owner state (topics, threads,
// corrections). A read that failed or did not validate must never be persisted
// back as a fabricated empty index, because the optimistic-concurrency guard
// happily commits over unparseable content (its identity is a raw digest).
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

// Stub the canary sink before anything can write to the real recovery log.
var recoveryLog = require("../lib/recovery-log");
var canaryEvents = [];
recoveryLog.recordRecoveryEvent = function (event) { canaryEvents.push(event); };

var topicIndexStore = require("../lib/coop-topic-index-store");
var createTopicIndexStore = topicIndexStore.createTopicIndexStore;
var createTopicIndex = require("../lib/coop-topic-index").createTopicIndex;

function reset() {
  canaryEvents.length = 0;
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-topic-index-store-"));
}

function ops() {
  return canaryEvents.map(function (event) { return event.store + ":" + event.op; });
}

function indexFor(file) {
  var clock = 1000;
  return createTopicIndex({ file: file, now: function () { return ++clock; } });
}

// A real index body that a partial write truncated: the JSON is unparseable but
// the file still holds every topic the owner ever created.
var TRUNCATED = '{"schemaVersion":1,"canonicalSessionStorageId":"coop-home","topics":{"coop-conversation-architecture":{"topicRef":{"topicId":"coop';

test("a truncated Coop topic index is never overwritten by a fabricated empty index", function () {
  var file = path.join(reset(), "coop-topic-index.json");
  fs.writeFileSync(file, TRUNCATED);
  var index = indexFor(file);

  // Read-only lenses may serve an empty view, but only after the canary fired.
  assert.deepEqual(index.load().topics, {});
  assert.equal(canaryEvents.length, 1);
  assert.equal(canaryEvents[0].kind, "coop_persistence");
  assert.equal(canaryEvents[0].store, "topic_index");
  assert.equal(canaryEvents[0].op, "parse");
  assert.equal(canaryEvents[0].code, "invalid_json");

  var created = index.createTopic({ title: "Owner topic", group: "uncategorised" });
  assert.equal(created.ok, false);
  assert.equal(created.code, "persistence_unreadable");
  assert.equal(fs.readFileSync(file, "utf8"), TRUNCATED);
  assert.deepEqual(ops(), ["topic_index:parse", "topic_index:mutate_refused"]);
});

test("a future Coop topic index schemaVersion fails closed instead of wiping", function () {
  var file = path.join(reset(), "coop-topic-index.json");
  var future = JSON.stringify({
    schemaVersion: 2, canonicalSessionStorageId: "coop-home",
    topics: { "future-topic": { topicRef: { topicId: "future-topic" }, title: "Future" } },
  });
  fs.writeFileSync(file, future);
  var index = indexFor(file);

  var renamed = index.rename({ topicId: "future-topic" }, "Renamed");
  assert.equal(renamed.ok, false);
  assert.equal(renamed.code, "persistence_unreadable");
  var merged = index.merge({ topicId: "future-topic" }, [{ topicId: "other" }]);
  assert.equal(merged.code, "persistence_unreadable");
  assert.equal(fs.readFileSync(file, "utf8"), future);
  assert.deepEqual(ops(), [
    "topic_index:validate", "topic_index:mutate_refused", "topic_index:mutate_refused",
  ]);
});

test("a missing Coop topic index still initializes a fresh store silently", function () {
  var file = path.join(reset(), "coop-topic-index.json");
  var index = indexFor(file);

  assert.deepEqual(index.load().topics, {});
  var created = index.createTopic({ title: "First topic", group: "uncategorised" });
  assert.equal(created.ok, true);
  assert.deepEqual(canaryEvents, []);
  var written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.schemaVersion, 1);
  assert.equal(Object.keys(written.topics).length, 1);
  assert.equal(written.topics[created.topic.topicRef.topicId].title, "First topic");
});

test("a repaired Coop topic index becomes writable again without a restart", function () {
  var dir = reset();
  var file = path.join(dir, "coop-topic-index.json");
  fs.writeFileSync(file, TRUNCATED);
  var index = indexFor(file);
  assert.equal(index.createTopic({ title: "Blocked", group: "uncategorised" }).ok, false);

  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, canonicalSessionStorageId: "coop-home", topics: {},
    threadLifecycleVersion: 1, threadCorrections: [],
    retro: { version: 3, completedEventCount: 0 },
  }));
  var created = index.createTopic({ title: "Unblocked", group: "uncategorised" });
  assert.equal(created.ok, true);
  var written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.topics[created.topic.topicRef.topicId].title, "Unblocked");
});

test("an unreadable Coop topic index file refuses every write path", function () {
  var dir = reset();
  var file = path.join(dir, "coop-topic-index.json");
  var recorded = [];
  var denied = { readFileSync: function () {
    var error = new Error("permission denied");
    error.code = "EACCES";
    throw error;
  } };
  var store = createTopicIndexStore({
    file: file, fs: denied,
    initialState: function () { return { schemaVersion: 1, topics: {} }; },
    validState: function (value) {
      return !!value && value.schemaVersion === 1 && !!value.topics;
    },
    recordEvent: function (event) { recorded.push(event); },
  });

  assert.deepEqual(store.load().topics, {});
  assert.deepEqual(store.unreadable(), { code: "EACCES" });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, "coop_persistence");
  assert.equal(recorded[0].store, "topic_index");
  assert.equal(recorded[0].code, "EACCES");

  var result = store.mutate({ ok: false, code: "persistence_failed" }, function () {
    throw new Error("the operation must never run while the store is poisoned");
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, topicIndexStore.UNREADABLE_CODE);
  assert.throws(function () { store.save(); }, function (error) {
    return error.code === "persistence_unreadable";
  });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(canaryEvents, []);
});
