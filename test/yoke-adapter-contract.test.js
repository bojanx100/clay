var test = require("node:test");
var assert = require("node:assert");

var iface = require("../lib/yoke/interface");
var fixtures = require("./helpers/yoke-adapter-fixtures").createFixtures();

var SNAPSHOT_KEYS = [
  "yokeType",
  "blockId",
  "text",
  "toolId",
  "toolName",
  "content",
  "isError",
  "sessionId",
];

function projectEvent(event) {
  var projected = {};
  for (var i = 0; i < SNAPSHOT_KEYS.length; i++) {
    var key = SNAPSHOT_KEYS[i];
    if (event[key] !== undefined) projected[key] = event[key];
  }
  return projected;
}

function normalizeFixture(fixture) {
  var state = fixture.createState();
  var events = [];
  for (var i = 0; i < fixture.rawEvents.length; i++) {
    var normalized = fixture.normalize(fixture.rawEvents[i], state);
    var batch = Array.isArray(normalized) ? normalized : [normalized];
    for (var j = 0; j < batch.length; j++) {
      if (batch[j]) events.push(projectEvent(batch[j]));
    }
  }
  return events;
}

for (var i = 0; i < fixtures.length; i++) {
  (function(fixture) {
    test(fixture.vendor + " adapter satisfies the shared YOKE contract", function() {
      var adapter = fixture.createAdapter();
      var handle = fixture.createHandle();
      iface.validateAdapter(adapter);
      iface.validateQueryHandle(handle);
      handle.close();
      assert.strictEqual(handle.pushMessage("closed handle probe"), false);
    });

    test(fixture.vendor + " protocol snapshot normalizes to stable YOKE events", function() {
      assert.deepStrictEqual(normalizeFixture(fixture), fixture.expectedEvents);
    });

    test(fixture.vendor + " runtime dependency exposes the required surface", async function() {
      await fixture.verifyDependency();
    });
  })(fixtures[i]);
}

test("Claude query handles reject messages after their input queue closes", function() {
  var claudeModule = require("../lib/yoke/adapters/claude");
  var kit = claudeModule.contractTestKit;
  var queue = kit.createMessageQueue();
  var handle = kit.createQueryHandle({
    [Symbol.asyncIterator]: function() {
      return { next: function() { return new Promise(function() {}); } };
    },
    close: function() {},
  }, queue, new AbortController());

  assert.strictEqual(handle.pushMessage("first"), true);
  handle.close();
  assert.strictEqual(handle.pushMessage("must not be dropped silently"), false);
  assert.strictEqual(queue.push({ type: "user" }), false);
});
