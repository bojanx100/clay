var test = require("node:test");
var assert = require("node:assert");
var EventEmitter = require("node:events");
var { createKeepAwakeController, hasExternalDisplay } = require("../lib/keep-awake");

function createFakeProcess() {
  var proc = new EventEmitter();
  proc.killCount = 0;
  proc.kill = function () {
    proc.killCount++;
  };
  return proc;
}

function createFakeFs() {
  var files = {};
  return {
    files: files,
    mkdirSync: function () {},
    writeFileSync: function (file, value) { files[file] = value; },
    unlinkSync: function (file) {
      if (!Object.prototype.hasOwnProperty.call(files, file)) {
        var err = new Error("missing");
        err.code = "ENOENT";
        throw err;
      }
      delete files[file];
    },
  };
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
    fs: createFakeFs(),
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
    fs: createFakeFs(),
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

test("external display detection distinguishes built-in and connected displays", function () {
  assert.strictEqual(hasExternalDisplay({
    SPDisplaysDataType: [{
      spdisplays_ndrvs: [{ spdisplays_connection_type: "spdisplays_internal" }],
    }],
  }), false);
  assert.strictEqual(hasExternalDisplay({
    SPDisplaysDataType: [{
      spdisplays_ndrvs: [
        { spdisplays_connection_type: "spdisplays_internal" },
        { spdisplays_connection_type: "spdisplays_displayport" },
      ],
    }],
  }), true);
});

test("headless clamshell mode requests admin authorization and restores via sentinel", function () {
  var calls = [];
  var errors = [];
  var fakeFs = createFakeFs();
  var proc = createFakeProcess();
  var controller = createKeepAwakeController({
    platform: "darwin",
    pid: 1234,
    sentinelPath: "/tmp/clay-headless-test",
    fs: fakeFs,
    onHeadlessClamshellError: function (err) { errors.push(err.message); },
    spawn: function (command, args, options) {
      calls.push({ command: command, args: args, options: options });
      return proc;
    },
  });

  assert.strictEqual(controller.enableHeadlessClamshell(), true);
  assert.strictEqual(fakeFs.files["/tmp/clay-headless-test"], "1234");
  assert.strictEqual(calls[0].command, "/usr/bin/osascript");
  assert.ok(calls[0].args[1].indexOf("administrator privileges") !== -1);
  assert.ok(calls[0].args[1].indexOf("disablesleep 1") !== -1);
  assert.ok(calls[0].args[1].indexOf("disablesleep 0") !== -1);

  controller.setEnabled(false);
  assert.strictEqual(fakeFs.files["/tmp/clay-headless-test"], undefined);

  proc.emit("exit", 1);
  assert.deepStrictEqual(errors, ["Headless clamshell authorization was cancelled or failed"]);
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
