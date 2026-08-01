var test = require("node:test");
var assert = require("node:assert");
var EventEmitter = require("node:events");
var { createKeepAwakeController } = require("../lib/keep-awake");

function createFakeProcess() {
  var proc = new EventEmitter();
  proc.killCount = 0;
  proc.kill = function () {
    proc.killCount++;
  };
  return proc;
}

test("Keep Awake requests display, idle, and AC system sleep prevention on macOS", function () {
  var calls = [];
  var proc = createFakeProcess();
  var controller = createKeepAwakeController({
    platform: "darwin",
    spawn: function (command, args, options) {
      calls.push({ command: command, args: args, options: options });
      return proc;
    },
  });

  controller.setEnabled(true);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].command, "/usr/bin/caffeinate");
  assert.deepStrictEqual(calls[0].args, ["-dis"]);
  assert.deepStrictEqual(calls[0].options, { stdio: "ignore", detached: false });
  assert.strictEqual(controller.isActive(), true);
});

test("Keep Awake starts once, stops its assertion, and can restart", function () {
  var processes = [];
  var controller = createKeepAwakeController({
    platform: "darwin",
    spawn: function () {
      var proc = createFakeProcess();
      processes.push(proc);
      return proc;
    },
  });

  controller.setEnabled(true);
  controller.setEnabled(true);
  assert.strictEqual(processes.length, 1);

  controller.setEnabled(false);
  assert.strictEqual(processes[0].killCount, 1);
  assert.strictEqual(controller.isActive(), false);

  controller.setEnabled(true);
  assert.strictEqual(processes.length, 2);
  processes[1].emit("exit", 1);
  assert.strictEqual(controller.isActive(), false);
});

test("Keep Awake drives SetThreadExecutionState via hidden PowerShell on Windows", function () {
  var calls = [];
  var proc = createFakeProcess();
  var controller = createKeepAwakeController({
    platform: "win32",
    spawn: function (command, args, options) {
      calls.push({ command: command, args: args, options: options });
      return proc;
    },
  });

  controller.setEnabled(true);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].command, "powershell.exe");
  assert.ok(calls[0].args.indexOf("-WindowStyle") !== -1);
  assert.ok(calls[0].args.indexOf("Hidden") !== -1);
  var scriptArg = calls[0].args[calls[0].args.length - 1];
  assert.ok(scriptArg.indexOf("SetThreadExecutionState") !== -1);
  assert.ok(scriptArg.indexOf("0x80000003") !== -1);
  assert.deepStrictEqual(calls[0].options, { stdio: "ignore", detached: false, windowsHide: true });
  assert.strictEqual(controller.isActive(), true);
});

test("Keep Awake is a no-op on unsupported platforms", function () {
  var spawnCount = 0;
  var controller = createKeepAwakeController({
    platform: "linux",
    spawn: function () {
      spawnCount++;
      return createFakeProcess();
    },
  });

  controller.setEnabled(true);

  assert.strictEqual(spawnCount, 0);
  assert.strictEqual(controller.isActive(), false);
});
