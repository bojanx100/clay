var test = require("node:test");
var assert = require("node:assert");
var os = require("os");
var path = require("path");
var fs = require("fs");

process.env.CLAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clay-xproj-"));

var config = require("../lib/config");
var { createCrossProjectRouter } = require("../lib/server-cross-project");

function readDeadLetters() {
  var file = config.recoveryLogPath();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map(function (line) { return JSON.parse(line); })
    .filter(function (e) { return e.kind === "cross_project_dead_letter"; });
}

function createRecoveryEventSink() {
  var events = [];
  return {
    events: events,
    record: function (event) { events.push(event); },
  };
}

test("deliver routes an update into the target project context", function () {
  var delivered = [];
  var router = createCrossProjectRouter({
    getProjectContext: function (slug) {
      if (slug !== "lead") return null;
      return {
        deliverCoordinatorUpdate: function (storageId, text) {
          delivered.push({ storageId: storageId, text: text });
          return true;
        },
      };
    },
  });
  var result = router.deliver("lead", "sess-1", "[Clay worker update] hello");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(delivered.length, 1);
  assert.strictEqual(delivered[0].storageId, "sess-1");
  assert.strictEqual(delivered[0].text, "[Clay worker update] hello");
});

test("unknown project slug dead-letters instead of throwing", function () {
  var before = readDeadLetters().length;
  var router = createCrossProjectRouter({
    getProjectContext: function () { return null; },
  });
  var result = router.deliver("ghost", "sess-2", "text");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "unknown-project");
  var events = readDeadLetters();
  assert.strictEqual(events.length, before + 1);
  assert.strictEqual(events[events.length - 1].targetSlug, "ghost");
  assert.strictEqual(events[events.length - 1].sessionStorageId, "sess-2");
  assert.strictEqual(events[events.length - 1].reason, "unknown-project");
});

test("missing target session dead-letters as session-not-found", function () {
  var sink = createRecoveryEventSink();
  var router = createCrossProjectRouter({
    recordRecoveryEvent: sink.record,
    getProjectContext: function () {
      return { deliverCoordinatorUpdate: function () { return false; } };
    },
  });
  var result = router.deliver("lead", "gone", "text");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "session-not-found");
  assert.deepStrictEqual(sink.events, [{
    kind: "cross_project_dead_letter",
    targetSlug: "lead",
    sessionStorageId: "gone",
    reason: "session-not-found",
  }]);
});

test("delivery exceptions are contained and dead-lettered", function () {
  var sink = createRecoveryEventSink();
  var router = createCrossProjectRouter({
    recordRecoveryEvent: sink.record,
    getProjectContext: function () {
      return { deliverCoordinatorUpdate: function () { throw new Error("boom"); } };
    },
  });
  var result = router.deliver("lead", "sess-3", "text");
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /delivery-error: boom/);
  assert.deepStrictEqual(sink.events, [{
    kind: "cross_project_dead_letter",
    targetSlug: "lead",
    sessionStorageId: "sess-3",
    reason: "delivery-error: boom",
  }]);
});

test("missing slug or session id dead-letters as missing-target", function () {
  var sink = createRecoveryEventSink();
  var router = createCrossProjectRouter({
    recordRecoveryEvent: sink.record,
    getProjectContext: function () {
      throw new Error("should not be called");
    },
  });
  assert.strictEqual(router.deliver("", "sess", "t").reason, "missing-target");
  assert.strictEqual(router.deliver("lead", "", "t").reason, "missing-target");
  assert.deepStrictEqual(sink.events, [{
    kind: "cross_project_dead_letter",
    targetSlug: null,
    sessionStorageId: "sess",
    reason: "missing-target",
  }, {
    kind: "cross_project_dead_letter",
    targetSlug: "lead",
    sessionStorageId: null,
    reason: "missing-target",
  }]);
});

test("typed delivery resolves a dynamically registered project by ProjectRef", function () {
  var delivered = [];
  var projectId = "system-target";
  var router = createCrossProjectRouter({
    getProjectContext: function () { return null; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return projectId; },
    deliverCrossProjectEnvelope: function (envelope) {
      delivered.push(envelope.eventId);
      return { ok: true };
    },
  });
  var envelope = router.createEnvelope({
    eventId: "resolver-project-ref",
    source: { projectId: "system-source", sessionStorageId: "source" },
    destination: { projectId: "system-target", sessionStorageId: "target" },
    bindingRevision: 1,
    createdAt: 1,
    payload: { type: "coordinator_update", text: "hello" },
  });

  assert.equal(router.deliverEnvelope(envelope).acknowledged, true);
  assert.deepEqual(delivered, ["resolver-project-ref"]);
});
