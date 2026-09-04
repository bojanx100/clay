var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var files = require("../lib/project-loop-files");
var handlers = require("../lib/project-loop-handlers");

function makeHarness() {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-loop-handlers-"));
  var sent = [];
  var targeted = [];
  var sessions = new Map();
  var nextSessionId = 1;
  var records = new Map();
  var state = {
    active: false, phase: "idle", promptText: "", judgeText: "", iteration: 0, maxIterations: 20,
    baseCommit: null, currentSessionId: null, judgeSessionId: null, results: [], stopping: false,
    wizardData: null, craftingSessionId: null, startedAt: null, loopId: null, loopFilesId: null,
  };
  var sm = {
    sessions: sessions,
    createSession: function () {
      var session = { localId: nextSessionId++, history: [], sentToolResults: {} };
      sessions.set(session.localId, session);
      return session;
    },
    saveSessionFile: function () {},
    switchSession: function () {},
    appendToSessionFile: function () {},
    broadcastSessionList: function () { sent.push({ type: "session_list" }); },
    deleteSessionQuiet: function (id) { sessions.delete(id); },
  };
  var registry = {
    register: function (data) {
      var record = Object.assign({ id: data.id || "record" }, data);
      records.set(record.id, record);
      return record;
    },
    updateRecord: function (id, data) {
      var record = records.get(id);
      if (!record) return null;
      Object.assign(record, data);
      return record;
    },
    getById: function (id) { return records.get(id) || null; },
    update: function (id) { return records.get(id) || null; },
    remove: function (id) { return records.delete(id); },
    toggleEnabled: function (id) {
      var record = records.get(id);
      if (!record || !record.cron) return null;
      record.enabled = !record.enabled;
      return record;
    },
  };
  var stateSaveCount = 0;
  var started = [];
  var stopped = 0;
  var watched = 0;
  var cleared = 0;
  var options = {
    cwd: cwd, fs: fs, path: path, files: files, loopState: state,
    loopDir: function () { return state.loopId ? path.join(cwd, ".claude", "loops", state.loopFilesId || state.loopId) : null; },
    saveLoopState: function () { stateSaveCount++; },
    clearLoopState: function () { cleared++; state.phase = "idle"; state.loopId = null; },
    send: function (payload) { sent.push(payload); },
    sendTo: function (ws, payload) { targeted.push({ ws: ws, payload: payload }); },
    sendToSession: function (id, payload) { sent.push({ sessionId: id, payload: payload }); },
    sm: sm, sdk: { startQuery: function (session, prompt) { sent.push({ query: session.localId, prompt: prompt }); } },
    loopRegistry: registry, getHubSchedules: function () { return Array.from(records.values()); },
    getLinuxUserForSession: function () { return null; }, onProcessingChanged: function () {},
    hydrateImageRefs: function () {}, startLoop: function (opts) { started.push(opts); },
    stopLoop: function () { stopped++; }, generateLoopId: function () { return "loop_test"; },
    startClaudeDirWatch: function () { watched++; }, stopClaudeDirWatch: function () {},
    setActiveRegistryId: function () {},
  };
  return {
    cwd: cwd, state: state, sent: sent, targeted: targeted, sessions: sessions, records: records,
    options: options, handle: handlers.createLoopMessageHandler(options),
    stats: function () { return { stateSaveCount: stateSaveCount, started: started, stopped: stopped, watched: watched, cleared: cleared }; },
    cleanup: function () { fs.rmSync(cwd, { recursive: true, force: true }); },
  };
}

test("unknown loop messages fall through without side effects", function () {
  var h = makeHarness();
  try {
    assert.strictEqual(h.handle({}, { type: "loop_not_known" }), false);
    assert.strictEqual(h.sent.length, 0);
  } finally { h.cleanup(); }
});

test("inherited message names fall through without invoking prototype functions", function () {
  var h = makeHarness();
  try {
    var inheritedTypes = ["toString", "constructor", "__proto__"];
    for (var i = 0; i < inheritedTypes.length; i++) {
      assert.strictEqual(h.handle({}, { type: inheritedTypes[i] }), false);
    }
    assert.deepStrictEqual(h.stats(), { stateSaveCount: 0, started: [], stopped: 0, watched: 0, cleared: 0 });
    assert.strictEqual(h.sent.length, 0);
    assert.strictEqual(h.targeted.length, 0);
    assert.strictEqual(h.sessions.size, 0);
  } finally { h.cleanup(); }
});

test("wizard own simple path writes files and enters approval", function () {
  var h = makeHarness();
  try {
    assert.strictEqual(h.handle({}, { type: "ralph_wizard_complete", data: {
      name: "Simple task", task: "do it", source: "ralph", mode: "own", loopMode: "simple", promptText: "PROMPT",
    } }), true);
    var dir = path.join(h.cwd, ".claude", "loops", "loop_test");
    assert.strictEqual(fs.readFileSync(path.join(dir, "PROMPT.md"), "utf8"), "PROMPT");
    assert.strictEqual(h.state.phase, "approval");
    assert.strictEqual(h.stats().started.length, 0);
    var status = h.sent.find(function (p) { return p.type === "ralph_files_status"; });
    assert.deepStrictEqual({ promptReady: status.promptReady, judgeReady: status.judgeReady, bothReady: status.bothReady }, { promptReady: true, judgeReady: false, bothReady: true });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(h.state.wizardData, "loopId"), false);
  } finally { h.cleanup(); }
});

test("wizard own judge path starts exact judge-crafting prompt and session", function () {
  var h = makeHarness();
  try {
    h.handle({}, { type: "ralph_wizard_complete", data: {
      name: "Judge task", task: "evaluate it", source: "ralph", mode: "own", loopMode: "judge", promptText: "PROMPT",
    } });
    var session = h.sessions.get(h.state.craftingSessionId);
    assert.ok(session);
    assert.match(session.history[0].text, /design ONLY a JUDGE\.md/);
    assert.match(session.history[0].text, /PROMPT/);
    assert.strictEqual(h.stats().watched, 1);
    assert.ok(h.sent.some(function (p) { return p.type === "ralph_crafting_started"; }));
    assert.strictEqual(h.records.get("loop_test").craftingSessionId, session.localId);
  } finally { h.cleanup(); }
});

test("draft crafting preserves user judge and prompt/session effects", function () {
  var h = makeHarness();
  try {
    h.handle({}, { type: "ralph_wizard_complete", data: {
      name: "Draft task", task: "draft it", source: "task", loopMode: "judge",
      judgeAuthor: "me", judgeText: "USER JUDGE",
    } });
    var dir = path.join(h.cwd, ".claude", "loops", "loop_test");
    assert.strictEqual(fs.readFileSync(path.join(dir, "JUDGE.md"), "utf8"), "USER JUDGE");
    var session = h.sessions.get(h.state.craftingSessionId);
    assert.match(session.history[0].text, /create ONLY a PROMPT\.md/);
    assert.match(session.history[0].text, /draft it/);
    assert.strictEqual(session.loop.source, null);
    assert.match(session.title, /^Task Draft task Crafting$/);
  } finally { h.cleanup(); }
});

test("loop_start persists settings and scheduled starts emit the deferred protocol", function () {
  var h = makeHarness();
  try {
    h.state.loopId = "loop_settings";
    fs.mkdirSync(h.options.loopDir(), { recursive: true });
    fs.writeFileSync(path.join(h.options.loopDir(), "LOOP.json"), "{}");
    h.handle({}, { type: "loop_start", maxIterations: 4, settings: { effort: "high" } });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(h.options.loopDir(), "LOOP.json"), "utf8")).settings, { effort: "high" });
    assert.deepStrictEqual(h.stats().started, [{ maxIterations: 4 }]);
    h.state.wizardData = { cron: "* * * * *" };
    h.handle({}, { type: "loop_start" });
    assert.ok(h.sent.some(function (p) { return p.type === "loop_scheduled"; }));
    assert.strictEqual(h.stats().started.length, 1);
    h.handle({}, { type: "loop_stop" });
    assert.strictEqual(h.stats().stopped, 1);
  } finally { h.cleanup(); }
});

test("registry file, delete, toggle, and rerun paths preserve errors and success", function () {
  var h = makeHarness();
  try {
    h.handle({}, { type: "loop_registry_update", id: "missing", data: {} });
    h.handle({}, { type: "loop_registry_remove", id: "missing" });
    h.handle({}, { type: "loop_registry_toggle", id: "missing" });
    var errors = h.targeted.map(function (x) { return x.payload.text; });
    assert.ok(errors.some(function (text) { return text === "Record not found"; }));
    assert.ok(errors.some(function (text) { return text === "Record not found or not scheduled"; }));

    h.records.set("loop_rerun", { id: "loop_rerun", name: "Rerun", prompt: true });
    h.state.active = true;
    h.handle({}, { type: "loop_registry_rerun", id: "loop_rerun" });
    assert.ok(h.targeted.some(function (x) { return x.payload.text === "A loop is already running"; }));
    h.state.active = false;
    var rerunDir = path.join(h.cwd, ".claude", "loops", "loop_rerun");
    fs.mkdirSync(rerunDir, { recursive: true });
    fs.writeFileSync(path.join(rerunDir, "PROMPT.md"), "run");
    h.handle({}, { type: "loop_registry_rerun", id: "loop_rerun" });
    assert.deepStrictEqual(h.stats().started, [undefined]);
    assert.ok(h.sent.some(function (p) { return p.type === "loop_rerun_started"; }));

    var group = h.options.sm.createSession();
    group.loop = { loopId: "loop_delete" };
    h.records.set("loop_delete", { id: "loop_delete" });
    h.handle({}, { type: "delete_loop_group", loopId: "loop_delete" });
    assert.strictEqual(h.sessions.has(group.localId), false);
    assert.strictEqual(h.records.has("loop_delete"), false);
  } finally { h.cleanup(); }
});

test("registry file reads and saves broadcast exact content, including save errors", function () {
  var h = makeHarness();
  var originalWrite = h.options.fs.writeFileSync;
  try {
    h.handle({}, { type: "loop_registry_save_files", id: "loop_files", prompt: "P", judge: "J", settings: { x: 1 } });
    var dir = path.join(h.cwd, ".claude", "loops", "loop_files");
    assert.strictEqual(fs.readFileSync(path.join(dir, "PROMPT.md"), "utf8"), "P");
    assert.strictEqual(fs.readFileSync(path.join(dir, "JUDGE.md"), "utf8"), "J");
    h.handle({}, { type: "loop_registry_files", id: "loop_files" });
    var content = h.sent.find(function (p) { return p.type === "loop_registry_files_content" && p.id === "loop_files"; });
    assert.deepStrictEqual({ prompt: content.prompt, judge: content.judge, settings: content.settings }, { prompt: "P", judge: "J", settings: { x: 1 } });
    h.options.fs.writeFileSync = function () { throw new Error("disk full"); };
    h.handle({}, { type: "loop_registry_save_files", id: "loop_files", prompt: "new" });
    assert.ok(h.sent.some(function (p) { return p.type === "loop_registry_save_files_result" && p.ok === false && p.error === "disk full"; }));
  } finally {
    h.options.fs.writeFileSync = originalWrite;
    h.cleanup();
  }
});
