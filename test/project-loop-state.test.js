var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var stateModule = require("../lib/project-loop-state");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-loop-state-"));
}

function makeState() {
  return {
    active: false, phase: "idle", promptText: "", judgeText: "", iteration: 0,
    maxIterations: 20, baseCommit: null, currentSessionId: null,
    judgeSessionId: null, results: [], stopping: false, wizardData: null,
    craftingSessionId: null, startedAt: null, loopId: null, loopFilesId: null,
  };
}

function makeStore(cwd, state) {
  return stateModule.createLoopStateStore({
    cwd: cwd,
    fs: fs,
    path: path,
    statePath: path.join(cwd, "state.json"),
    loopState: state,
    checkLoopFiles: function () {
      var dir = state.loopFilesId || state.loopId;
      if (!dir) return false;
      var loopDir = path.join(cwd, ".claude", "loops", dir);
      var hasPrompt = fs.existsSync(path.join(loopDir, "PROMPT.md"));
      var hasJudge = fs.existsSync(path.join(loopDir, "JUDGE.md"));
      return state.wizardData && state.wizardData.loopMode === "simple" ? hasPrompt : hasPrompt && hasJudge;
    },
  });
}

test("persisted executing state requests a safe SDK resume", function () {
  var cwd = tempDir();
  try {
    var statePath = path.join(cwd, "state.json");
    fs.writeFileSync(statePath, JSON.stringify({
      phase: "executing", active: true, iteration: 3, maxIterations: 7,
      baseCommit: "abc", results: [{ iteration: 1 }], wizardData: { loopMode: "judge" },
      startedAt: 10, loopId: "loop_exec", loopFilesId: null,
    }));
    var state = makeState();
    var store = makeStore(cwd, state);
    store.load();
    assert.strictEqual(state.phase, "executing");
    assert.strictEqual(state._needsResume, true);
    assert.strictEqual(state.currentSessionId, null);
    assert.strictEqual(state.craftingSessionId, null);
    assert.strictEqual(state.iteration, 3);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("finishing a loop session persists its interactive state", function () {
  var saved = [];
  var session = {
    singleTurn: true,
    loop: { active: true, role: "coder" },
  };
  var sm = {
    saveSessionFile: function (value) { saved.push(value); },
  };

  assert.strictEqual(stateModule.finishSession(sm, session), true);
  assert.strictEqual(session.singleTurn, false);
  assert.strictEqual(session.loop.active, false);
  assert.deepStrictEqual(saved, [session]);
});

test("crafting recovery moves ready files to approval and missing files to idle", function () {
  var cwd = tempDir();
  try {
    var loopDir = path.join(cwd, ".claude", "loops", "loop_craft");
    fs.mkdirSync(loopDir, { recursive: true });
    fs.writeFileSync(path.join(loopDir, "PROMPT.md"), "prompt");
    fs.writeFileSync(path.join(loopDir, "JUDGE.md"), "judge");
    var ready = makeState();
    ready.phase = "crafting";
    ready.loopId = "loop_craft";
    ready.wizardData = { loopMode: "judge" };
    makeStore(cwd, ready).load();
    assert.strictEqual(ready.phase, "approval");
    fs.unlinkSync(path.join(loopDir, "JUDGE.md"));
    fs.unlinkSync(path.join(cwd, "state.json"));
    var missing = makeState();
    missing.phase = "crafting";
    missing.loopId = "loop_craft";
    missing.wizardData = { loopMode: "judge" };
    makeStore(cwd, missing).load();
    assert.strictEqual(missing.phase, "idle");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("idle startup discovers orphan simple and judge loops", function () {
  var cwd = tempDir();
  try {
    var simpleDir = path.join(cwd, ".claude", "loops", "loop_orphan_simple");
    fs.mkdirSync(simpleDir, { recursive: true });
    fs.writeFileSync(path.join(simpleDir, "PROMPT.md"), "simple");
    fs.writeFileSync(path.join(simpleDir, "LOOP.json"), JSON.stringify({ loopMode: "simple", maxIterations: 4 }));
    var simple = makeState();
    makeStore(cwd, simple).load();
    assert.strictEqual(simple.phase, "approval");
    assert.strictEqual(simple.loopId, "loop_orphan_simple");
    assert.strictEqual(simple.wizardData.loopMode, "simple");

    fs.unlinkSync(path.join(cwd, "state.json"));
    fs.rmSync(path.join(cwd, ".claude"), { recursive: true, force: true });
    var judgeDir = path.join(cwd, ".claude", "loops", "loop_orphan_judge");
    fs.mkdirSync(judgeDir, { recursive: true });
    fs.writeFileSync(path.join(judgeDir, "PROMPT.md"), "judge prompt");
    fs.writeFileSync(path.join(judgeDir, "JUDGE.md"), "judge criteria");
    fs.writeFileSync(path.join(judgeDir, "LOOP.json"), JSON.stringify({ maxIterations: 9 }));
    var judge = makeState();
    makeStore(cwd, judge).load();
    assert.strictEqual(judge.phase, "approval");
    assert.strictEqual(judge.loopId, "loop_orphan_judge");
    assert.strictEqual(judge.maxIterations, 9);
    assert.strictEqual(judge.wizardData.loopMode, "judge");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("reconnect state emits availability, phase, and file readiness payloads", function () {
  var cwd = tempDir();
  try {
    var loopDir = path.join(cwd, ".claude", "loops", "loop_reconnect");
    fs.mkdirSync(loopDir, { recursive: true });
    fs.writeFileSync(path.join(loopDir, "PROMPT.md"), "prompt");
    var state = makeState();
    state.phase = "approval";
    state.loopId = "loop_reconnect";
    state.wizardData = { loopMode: "simple", source: "ralph" };
    var messages = stateModule.connectionMessages({
      cwd: cwd, fs: fs, path: path, loopState: state,
      loopDir: function () { return loopDir; },
      fileStatus: function (dir, isSimple) {
        return {
          promptReady: fs.existsSync(path.join(dir, "PROMPT.md")),
          judgeReady: fs.existsSync(path.join(dir, "JUDGE.md")),
          bothReady: isSimple,
        };
      },
    });
    assert.deepStrictEqual(messages.map(function (m) { return m.type; }), ["loop_available", "ralph_phase", "ralph_files_status"]);
    assert.strictEqual(messages[0].available, true);
    assert.strictEqual(messages[1].source, "ralph");
    assert.strictEqual(messages[2].bothReady, true);
    assert.strictEqual(messages[2].taskId, "loop_reconnect");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
