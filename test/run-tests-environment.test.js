var test = require("node:test");
var assert = require("node:assert/strict");

var sanitizedTestEnvironment = require("../scripts/run-tests").sanitizedTestEnvironment;

test("test runner removes live Coop control flags without mutating its source", function () {
  var source = {
    PATH: "/bin",
    CLAY_COOP_CONTROL_STORE: "1",
    CLAY_COOP_CONTROL_EXECUTIONS: "1",
    CLAY_COOP_CONTROL_RECOVERY: "1",
    CLAY_UNRELATED: "keep",
  };
  var result = sanitizedTestEnvironment(source);

  assert.strictEqual(result.CLAY_COOP_CONTROL_STORE, undefined);
  assert.strictEqual(result.CLAY_COOP_CONTROL_EXECUTIONS, undefined);
  assert.strictEqual(result.CLAY_COOP_CONTROL_RECOVERY, undefined);
  assert.strictEqual(result.CLAY_UNRELATED, "keep");
  assert.strictEqual(source.CLAY_COOP_CONTROL_STORE, "1");
});
