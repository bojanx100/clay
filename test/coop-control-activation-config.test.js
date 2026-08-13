var test = require("node:test");
var assert = require("node:assert");
var config = require("../lib/config");

test("control-kernel daemon configuration overrides inherited activation flags", function () {
  var inherited = {
    CLAY_COOP_CONTROL_STORE: "1",
    CLAY_COOP_CONTROL_EXECUTIONS: "1",
    CLAY_COOP_CONTROL_RECOVERY: "1",
    KEEP: "value",
  };
  var environment = config.coopControlEnvironment({
    coop: { controlKernel: { store: true, executions: true, recovery: true } },
  }, inherited);

  assert.deepStrictEqual(environment, {
    CLAY_COOP_CONTROL_STORE: "1",
    CLAY_COOP_CONTROL_EXECUTIONS: "1",
    CLAY_COOP_CONTROL_RECOVERY: "1",
    KEEP: "value",
  });
});

test("control-kernel rollback values turn every flag off despite inherited state", function () {
  var environment = config.coopControlEnvironment({
    coop: { controlKernel: { store: false, executions: false, recovery: false } },
  }, {
    CLAY_COOP_CONTROL_STORE: "1",
    CLAY_COOP_CONTROL_EXECUTIONS: "1",
    CLAY_COOP_CONTROL_RECOVERY: "1",
  });

  assert.deepStrictEqual(environment, {
    CLAY_COOP_CONTROL_STORE: "0",
    CLAY_COOP_CONTROL_EXECUTIONS: "0",
    CLAY_COOP_CONTROL_RECOVERY: "0",
  });
});

test("absent control-kernel configuration preserves inherited state", function () {
  var inherited = {
    CLAY_COOP_CONTROL_STORE: "1",
    KEEP: "value",
  };

  assert.deepStrictEqual(config.coopControlEnvironment({}, inherited), inherited);
});
