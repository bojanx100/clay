var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var files = require("../lib/project-loop-files");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-loop-files-"));
}

test("file readiness distinguishes simple and judge loops and extracts the latest title", function () {
  var cwd = tempDir();
  try {
    fs.writeFileSync(path.join(cwd, "PROMPT.md"), "prompt");
    assert.deepStrictEqual(files.loopFileStatus({ fs: fs, path: path, dir: cwd, isSimple: true }), {
      promptReady: true, judgeReady: false, loopJsonReady: false, bothReady: true,
    });
    assert.strictEqual(files.checkLoopFilesExist({ fs: fs, path: path, dir: cwd, isSimple: false }), false);
    fs.writeFileSync(path.join(cwd, "JUDGE.md"), "judge");
    assert.strictEqual(files.checkLoopFilesExist({ fs: fs, path: path, dir: cwd, isSimple: false }), true);
    assert.strictEqual(files.extractLoopTitle([
      { text: "[[LOOP_TITLE: Old]]" }, { text: "no title" }, { text: "[[LOOP_TITLE: New title]]" },
    ]), "New title");
    assert.strictEqual(files.extractLoopTitle([{ text: "none" }]), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("start preparation preserves simple/judge configuration and reports missing prompt or git errors", function () {
  var cwd = tempDir();
  try {
    fs.writeFileSync(path.join(cwd, "PROMPT.md"), "do the work");
    fs.writeFileSync(path.join(cwd, "LOOP.json"), JSON.stringify({ maxIterations: 6, settings: { effort: "high" } }));
    var simple = files.prepareLoopStart({
      fs: fs, path: path, dir: cwd, cwd: cwd,
      execFileSync: function () { return "head-simple\n"; },
    });
    assert.strictEqual(simple.baseCommit, "head-simple");
    assert.strictEqual(simple.judgeText, null);
    assert.deepStrictEqual(files.executionState({}, simple, true), {
      promptText: "do the work", judgeText: null, maxIterations: 6,
      baseCommit: "head-simple", settings: { effort: "high" },
    });

    fs.writeFileSync(path.join(cwd, "JUDGE.md"), "judge it");
    var judge = files.prepareLoopStart({
      fs: fs, path: path, dir: cwd, cwd: cwd,
      execFileSync: function () { return "head-judge\n"; },
    });
    assert.strictEqual(judge.judgeText, "judge it");
    assert.strictEqual(files.executionState({ maxIterations: 3 }, judge, false).maxIterations, 3);
    fs.unlinkSync(path.join(cwd, "PROMPT.md"));
    assert.match(files.prepareLoopStart({ fs: fs, path: path, dir: cwd, cwd: cwd }).error, /Missing PROMPT/);
    fs.writeFileSync(path.join(cwd, "PROMPT.md"), "prompt");
    assert.match(files.prepareLoopStart({
      fs: fs, path: path, dir: cwd, cwd: cwd,
      execFileSync: function () { throw new Error("not a repo"); },
    }).error, /Failed to get git HEAD: not a repo/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("settings persistence is written into LOOP.json and watcher cleanup is idempotent", function () {
  var cwd = tempDir();
  var watcherClosed = false;
  var watchCount = 0;
  try {
    fs.writeFileSync(path.join(cwd, "LOOP.json"), "{}");
    files.saveLoopSettings({ loopDir: function () { return cwd; }, fs: fs, path: path }, { mode: "fast" });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(cwd, "LOOP.json"), "utf8")).settings, { mode: "fast" });
    var fakeFs = {
      mkdirSync: function () {},
      watch: function () {
        watchCount++;
        return { on: function () {}, close: function () { watcherClosed = true; } };
      },
    };
    var watcher = files.createLoopFileWatcher({ fs: fakeFs, loopDir: function () { return cwd; }, broadcast: function () {} });
    watcher.start();
    watcher.start();
    watcher.stop();
    watcher.stop();
    assert.strictEqual(watchCount, 1);
    assert.strictEqual(watcherClosed, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("broadcast readiness transitions crafting to approval and records the suggested title", function () {
  var cwd = tempDir();
  var sent = [];
  var saved = 0;
  var updated = [];
  try {
    fs.writeFileSync(path.join(cwd, "PROMPT.md"), "prompt");
    fs.writeFileSync(path.join(cwd, "JUDGE.md"), "judge");
    var loopState = { loopId: "loop_title", phase: "crafting", craftingSessionId: 4 };
    files.broadcastLoopFilesStatus({
      fs: fs, path: path, loopDir: function () { return cwd; }, isSimple: function () { return false; },
      loopState: loopState, send: function (payload) { sent.push(payload); },
      saveLoopState: function () { saved++; },
      getCraftingSession: function () { return { history: [{ text: "[[LOOP_TITLE: Useful loop]]" }] }; },
      updateRecord: function (id, data) { updated.push({ id: id, data: data }); },
    });
    assert.strictEqual(sent[0].bothReady, true);
    assert.strictEqual(loopState.phase, "approval");
    assert.strictEqual(saved, 1);
    assert.deepStrictEqual(updated, [{ id: "loop_title", data: { name: "Useful loop" } }]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
