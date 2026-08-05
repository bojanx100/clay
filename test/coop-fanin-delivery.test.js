var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

function createScratchDir(name) {
  var base = path.join(__dirname, ".scratch");
  fs.mkdirSync(base, { recursive: true });
  var dir = path.join(base, name + "-" + process.pid + "-" + Date.now() + "-" +
    Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function withDeliveryHarness(fn) {
  var clayHome = createScratchDir("coop-fanin-home");
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = clayHome;
  delete require.cache[require.resolve("../lib/config")];
  delete require.cache[require.resolve("../lib/coop-fanin-delivery")];
  try {
    fn({
      clayHome: clayHome,
      attach: require("../lib/coop-fanin-delivery").attachCoopFanIn,
    });
  } finally {
    if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
    else delete process.env.CLAY_HOME;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/coop-fanin-delivery")];
    fs.rmSync(clayHome, { recursive: true, force: true });
  }
}

test("fan-in delivery queues an event once and persists the delivered id", function () {
  withDeliveryHarness(function (h) {
    var coopSession = {
      localId: 1,
      storageId: "coop-home",
      pendingCoordinatorUpdates: [],
    };
    var sm = { sessions: new Map([[1, coopSession]]) };
    var queued = [];
    var api = h.attach({
      sm: sm,
      slug: "lead",
      now: function () { return 1000; },
      queueCoordinatorUpdate: function (session, text) {
        queued.push(text);
        session.pendingCoordinatorUpdates.push({ text: text, queuedAt: 1000 });
      },
    });
    var event = {
      eventId: "event-1",
      coopSessionStorageId: "coop-home",
      sessionStorageId: "worker-1",
      taskId: "task-1",
      status: "completed",
      summary: "Done",
      occurredAt: 123,
      schemaVersion: 1,
      type: "coop_task_transition",
    };

    assert.deepEqual(api.deliverEvent(event), { ok: true, delivered: true });
    assert.equal(api.hasDelivered("event-1"), true);
    assert.equal(queued.length, 1);
    assert.match(queued[0], /coop_fanin_event/);

    var duplicate = api.deliverEvent(event);
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(queued.length, 1);

    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/coop-fanin-delivery")];
    var persistedApi = require("../lib/coop-fanin-delivery").attachCoopFanIn({
      sm: sm,
      slug: "lead",
      now: function () { return 1001; },
      queueCoordinatorUpdate: function () {
        assert.fail("persisted delivery state should block duplicate apply");
      },
    });
    assert.equal(persistedApi.hasDelivered("event-1"), true);
    var saved = JSON.parse(fs.readFileSync(path.join(h.clayHome, "coop-fanin", "lead.json"), "utf8"));
    assert.equal(saved.delivered.length, 1);
    assert.equal(saved.delivered[0].eventId, "event-1");
  });
});
