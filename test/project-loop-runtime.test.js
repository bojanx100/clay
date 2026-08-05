var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var clayHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-loop-runtime-home-"));
process.env.CLAY_HOME = clayHome;
var attachLoop = require("../lib/project-loop").attachLoop;

function makeRuntime() {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-loop-runtime-"));
  var sent = [];
  var sessions = new Map();
  var nextSessionId = 1;
  var sm = {
    sessions: sessions,
    createSession: function () {
      var session = { localId: nextSessionId++, history: [], sentToolResults: {} };
      sessions.set(session.localId, session);
      return session;
    },
    saveSessionFile: function () {},
    appendToSessionFile: function () {},
    switchSession: function () {},
    broadcastSessionList: function () {},
    setResolveLoopInfo: function () {},
    deleteSessionQuiet: function (id) { sessions.delete(id); },
  };
  var runtime = attachLoop({
    cwd: cwd, slug: "runtime-test", sm: sm,
    sdk: { startQuery: function () {} },
    send: function (payload) { sent.push(payload); },
    sendTo: function (ws, payload) { sent.push(payload); },
    sendToSession: function () {},
    pushModule: null, notificationsModule: null,
    getHubSchedules: function () { return []; },
    getLinuxUserForSession: function () { return null; },
    onProcessingChanged: function () {}, hydrateImageRefs: function () {},
  });
  return {
    cwd: cwd, sent: sent, sessions: sessions, runtime: runtime,
    cleanup: function () {
      runtime.stopClaudeDirWatch();
      runtime.stopTimer();
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test("attachLoop reconnect preserves loop availability, phase, and file status payloads", function () {
  var h = makeRuntime();
  try {
    var dir = path.join(h.cwd, ".claude", "loops", "loop_runtime");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "PROMPT.md"), "prompt");
    h.runtime.loopState.loopId = "loop_runtime";
    h.runtime.loopState.phase = "approval";
    h.runtime.loopState.wizardData = { loopMode: "simple", source: "ralph" };
    h.runtime.sendConnectionState({});
    var available = h.sent.find(function (p) { return p.type === "loop_available"; });
    var phase = h.sent.find(function (p) { return p.type === "ralph_phase"; });
    var status = h.sent.find(function (p) { return p.type === "ralph_files_status"; });
    assert.strictEqual(available.available, true);
    assert.strictEqual(phase.phase, "approval");
    assert.strictEqual(status.bothReady, true);
    assert.strictEqual(status.taskId, "loop_runtime");
  } finally { h.cleanup(); }
});

test("scheduled loop_start defers execution and stop/timer cleanup remains callable", function () {
  var h = makeRuntime();
  try {
    h.runtime.loopState.loopId = "loop_scheduled";
    h.runtime.loopState.wizardData = { cron: "0 * * * *" };
    assert.strictEqual(h.runtime.handleLoopMessage({}, { type: "loop_start" }), true);
    assert.ok(h.sent.some(function (p) { return p.type === "loop_finished" && p.reason === "scheduled"; }));
    assert.ok(h.sent.some(function (p) { return p.type === "loop_scheduled"; }));
    h.runtime.stopClaudeDirWatch();
    h.runtime.stopTimer();
  } finally { h.cleanup(); }
});

test("crafting cancellation stops the watcher, removes files, and clears loop state", function () {
  var h = makeRuntime();
  try {
    h.runtime.handleLoopMessage({}, { type: "ralph_wizard_complete", data: {
      name: "Cancel me", task: "cancel", source: "ralph", mode: "own", loopMode: "judge", promptText: "PROMPT",
    } });
    var loopId = h.runtime.loopState.loopId;
    var loopDir = path.join(h.cwd, ".claude", "loops", loopId);
    assert.strictEqual(h.runtime.loopState.phase, "crafting");
    assert.strictEqual(fs.existsSync(loopDir), true);
    h.runtime.handleLoopMessage({}, { type: "ralph_cancel_crafting" });
    assert.strictEqual(h.runtime.loopState.phase, "idle");
    assert.strictEqual(h.runtime.loopState.loopId, null);
    assert.strictEqual(fs.existsSync(loopDir), false);
  } finally { h.cleanup(); }
});

test.after(function () {
  fs.rmSync(clayHome, { recursive: true, force: true });
});
