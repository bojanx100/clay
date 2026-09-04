// Guards the single line that activates the Coop control kernel.
//
// The kernel's three flags are read from process.env at call time
// (lib/coop-control-handoff.js isHandoffControlEnabled). The only thing that
// puts them there in production is the top-level
// applyCoopControlEnvironment(config, process.env) call in lib/daemon.js,
// which projects the coop.controlKernel daemon-config section into the
// environment. Delete that one line and every control-kernel module silently
// falls back to its disabled adapter: no SQLite store is opened, no execution
// is recorded, startup recovery becomes a pass-through -- and every existing
// unit test still passes, because they all construct their controls with an
// explicit { enabled: true } or an injected env. That is exactly the
// shipped-but-dark failure mode these assertions defend against, so they check
// that the call site is reached, not merely that the function is exported.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var config = require("../lib/config");

var DAEMON_PATH = path.join(__dirname, "..", "lib", "daemon.js");

function daemonLines() {
  return fs.readFileSync(DAEMON_PATH, "utf8").split("\n");
}

// Column-0 match only: the activation must be an unconditional top-level
// statement, not something tucked inside a branch or a callback that may
// never run.
function topLevelLineIndex(lines, pattern) {
  for (var i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
}

test("daemon.js imports the control-kernel activation helper from config", function () {
  var source = fs.readFileSync(DAEMON_PATH, "utf8");
  var importPattern =
    /applyCoopControlEnvironment[\s\S]{0,400}?=\s*require\(\s*["']\.\/config["']\s*\)/;
  assert.ok(
    importPattern.test(source),
    "lib/daemon.js must destructure applyCoopControlEnvironment from ./config; " +
      "without it the coop.controlKernel config section is never read."
  );
});

test("daemon.js applies the control-kernel configuration at top level on startup", function () {
  var lines = daemonLines();
  var callIndex = topLevelLineIndex(
    lines,
    /^applyCoopControlEnvironment\s*\(\s*config\s*,\s*process\.env\s*\)\s*;/
  );
  assert.notStrictEqual(
    callIndex,
    -1,
    "lib/daemon.js must call applyCoopControlEnvironment(config, process.env) as an " +
      "unconditional top-level statement. Removing it leaves CLAY_COOP_CONTROL_STORE / " +
      "_EXECUTIONS / _RECOVERY unset, so the whole Coop control kernel goes dark silently."
  );
});

test("control-kernel activation runs before the server is constructed", function () {
  var lines = daemonLines();
  var callIndex = topLevelLineIndex(
    lines,
    /^applyCoopControlEnvironment\s*\(\s*config\s*,\s*process\.env\s*\)\s*;/
  );
  var serverIndex = topLevelLineIndex(lines, /=\s*createServer\s*\(/);
  assert.notStrictEqual(callIndex, -1, "activation call site is missing from lib/daemon.js");
  assert.notStrictEqual(serverIndex, -1, "createServer(...) invocation is missing from lib/daemon.js");
  assert.ok(
    callIndex < serverIndex,
    "applyCoopControlEnvironment must run before createServer(...) is invoked (found activation at " +
      "line " + (callIndex + 1) + ", createServer at line " + (serverIndex + 1) + "). The control " +
      "flags are read lazily when the first project context builds its execution control, so " +
      "applying them after the server is constructed would leave the kernel disabled."
  );
});

// Semantics of the projection itself, driven through the real exported helper
// against the daemon-config shape documented in docs/specs/COOP_CONTROL_KERNEL.md.
test("activation projects an enabled control-kernel section onto the environment", function () {
  var environment = {};
  config.applyCoopControlEnvironment(
    { coop: { controlKernel: { store: true, executions: true, recovery: true,
      handoffTrigger: true } } },
    environment
  );
  assert.deepStrictEqual(environment, {
    CLAY_COOP_CONTROL_STORE: "1",
    CLAY_COOP_CONTROL_EXECUTIONS: "1",
    CLAY_COOP_CONTROL_RECOVERY: "1",
    CLAY_COOP_HANDOFF_TRIGGER: "1",
  });
});

test("activation projects a rollback control-kernel section as explicit zeros", function () {
  var environment = {
    CLAY_COOP_CONTROL_STORE: "1",
    CLAY_COOP_CONTROL_EXECUTIONS: "1",
    CLAY_COOP_CONTROL_RECOVERY: "1",
    CLAY_COOP_HANDOFF_TRIGGER: "1",
  };
  config.applyCoopControlEnvironment(
    { coop: { controlKernel: { store: false, executions: false, recovery: false,
      handoffTrigger: false } } },
    environment
  );
  assert.deepStrictEqual(environment, {
    CLAY_COOP_CONTROL_STORE: "0",
    CLAY_COOP_CONTROL_EXECUTIONS: "0",
    CLAY_COOP_CONTROL_RECOVERY: "0",
    CLAY_COOP_HANDOFF_TRIGGER: "0",
  });
});

// The automatic Class B handoff trigger is a narrower switch than the kernel it
// rides on. An owner who activates the kernel has not thereby asked the daemon
// to move live work between sessions on its own, so the trigger must stay off
// until it is named. This is the projection half of that rule; the code half is
// isHandoffTriggerEnabled in lib/coop-control-handoff-trigger.js, which also
// requires all three kernel flags.
test("an activated kernel does not arm the handoff trigger by omission", function () {
  var environment = { CLAY_COOP_HANDOFF_TRIGGER: "1" };
  config.applyCoopControlEnvironment(
    { coop: { controlKernel: { store: true, executions: true, recovery: true } } },
    environment
  );
  assert.equal(environment.CLAY_COOP_HANDOFF_TRIGGER, "0",
    "an inherited shell flag must lose to a config section that does not name it");
  assert.equal(environment.CLAY_COOP_CONTROL_STORE, "1");
});

// Regression: the trigger shipped with its master switch known only to its own
// module, so it was absent from this map. That made it the one control switch
// the owner could not set in daemon config -- the documented, restart-safe
// mechanism -- and the one a developer shell could leak into `npm test`, which
// would have run the whole controlled pass with live handoffs armed. The name
// is read from the trigger module rather than repeated here, so this fails if
// either side is renamed independently.
test("the handoff trigger's master switch is a registered control flag", function () {
  var trigger = require("../lib/coop-control-handoff-trigger");
  assert.equal(config.COOP_CONTROL_ENVIRONMENT.handoffTrigger, trigger.TRIGGER_ENV,
    "COOP_CONTROL_ENVIRONMENT must register the trigger's own env name (" +
    trigger.TRIGGER_ENV + "). Unregistered, applyCoopControlEnvironment never " +
    "projects it and scripts/run-tests.js never strips it.");

  // Driven through the real runner, not a copy of its logic.
  var runner = require("../scripts/run-tests.js");
  var leaked = runner.isolatedTestEnvironment(
    { PATH: "/usr/bin", CLAY_COOP_HANDOFF_TRIGGER: "1" }, "/tmp/clay-test-home");
  assert.equal(leaked[trigger.TRIGGER_ENV], undefined,
    "the hermetic pass must strip the trigger flag out of the developer's shell");
});

// The live daemon-dev.json / daemon.json shape must remain readable by the
// helper. This asserts the contract, not the owner's current flag values.
test("activation leaves the environment untouched when no control-kernel section exists", function () {
  var environment = { CLAY_COOP_CONTROL_STORE: "1", KEEP: "value" };
  config.applyCoopControlEnvironment({ coop: { leadMode: { enabled: true } } }, environment);
  assert.deepStrictEqual(environment, { CLAY_COOP_CONTROL_STORE: "1", KEEP: "value" });
});
