var test = require("node:test");
var assert = require("node:assert");
var config = require("../lib/config");

// A control-kernel section is authoritative over the shell for every switch it
// governs, and an omitted switch reads as off rather than as "leave whatever the
// shell had". CLAY_COOP_HANDOFF_TRIGGER appears here as "0" for exactly that
// reason: activating store/executions/recovery is not a request to let the
// daemon move live work between sessions on its own.
test("control-kernel daemon configuration overrides inherited activation flags", function () {
  var inherited = {
    CLAY_COOP_CONTROL_STORE: "1",
    CLAY_COOP_CONTROL_EXECUTIONS: "1",
    CLAY_COOP_CONTROL_RECOVERY: "1",
    CLAY_COOP_HANDOFF_TRIGGER: "1",
    KEEP: "value",
  };
  var environment = config.coopControlEnvironment({
    coop: { controlKernel: { store: true, executions: true, recovery: true } },
  }, inherited);

  assert.deepStrictEqual(environment, {
    CLAY_COOP_CONTROL_STORE: "1",
    CLAY_COOP_CONTROL_EXECUTIONS: "1",
    CLAY_COOP_CONTROL_RECOVERY: "1",
    CLAY_COOP_HANDOFF_TRIGGER: "0",
    KEEP: "value",
  });
  // coopControlEnvironment returns a copy; the caller's inherited map is intact.
  assert.equal(inherited.CLAY_COOP_HANDOFF_TRIGGER, "1");
});

test("control-kernel rollback values turn every flag off despite inherited state", function () {
  var environment = config.coopControlEnvironment({
    coop: { controlKernel: { store: false, executions: false, recovery: false,
      handoffTrigger: false } },
  }, {
    CLAY_COOP_CONTROL_STORE: "1",
    CLAY_COOP_CONTROL_EXECUTIONS: "1",
    CLAY_COOP_CONTROL_RECOVERY: "1",
    CLAY_COOP_HANDOFF_TRIGGER: "1",
  });

  assert.deepStrictEqual(environment, {
    CLAY_COOP_CONTROL_STORE: "0",
    CLAY_COOP_CONTROL_EXECUTIONS: "0",
    CLAY_COOP_CONTROL_RECOVERY: "0",
    CLAY_COOP_HANDOFF_TRIGGER: "0",
  });
});

// The trigger is the one switch an owner may reasonably want on while leaving
// everything else at its activated defaults, so the projection has to carry a
// true value through, not just enforce the off case above.
test("control-kernel configuration can arm the handoff trigger explicitly", function () {
  var environment = config.coopControlEnvironment({
    coop: { controlKernel: { store: true, executions: true, recovery: true,
      handoffTrigger: true } },
  }, {});

  assert.equal(environment.CLAY_COOP_HANDOFF_TRIGGER, "1");
  var trigger = require("../lib/coop-control-handoff-trigger");
  assert.equal(trigger.isHandoffTriggerEnabled({ env: environment }), true,
    "the projected environment must be one the trigger itself reads as enabled");
});

test("absent control-kernel configuration preserves inherited state", function () {
  var inherited = {
    CLAY_COOP_CONTROL_STORE: "1",
    KEEP: "value",
  };

  assert.deepStrictEqual(config.coopControlEnvironment({}, inherited), inherited);
});
