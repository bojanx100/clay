var test = require("node:test");
var assert = require("node:assert/strict");
var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");
var attachRuntime =
  require("../lib/coop-execution-reaper-runtime").attachExecutionReaperRuntime;
var createBindings =
  require("../lib/portfolio-execution-bindings").createPortfolioExecutionBindings;

var PROJECT = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var DAY = 24 * 60 * 60 * 1000;

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-reaper-runtime-" + label + "-"));
}

function writeLog(file, at) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: "done", code: 1, _ts: at }) + "\n");
}

function harness() {
  var dir = tempDir("case");
  var sessionsDir = path.join(dir, "sessions");
  var storageId = "runtime-session";
  var taskId = "runtime-reaper-task";
  var clock = 1000000;
  var store = createBindings({ file: path.join(dir, "bindings.json"),
    now: function () { return clock; }, reconcileOnLoad: false });
  store.reserve({ portfolioTaskId: taskId, bindingRevision: 1,
    idempotencyKey: taskId + ":1", mode: "project_coordinator",
    targetProject: { projectId: PROJECT } });
  store.commit(taskId, 1, { projectId: PROJECT, sessionStorageId: storageId });
  var session = { storageId: storageId, isProcessing: true,
    orchestrationPolicy: { portfolioExecution: { portfolioTaskId: taskId,
      bindingRevision: 1, status: "active" } } };
  var manager = { sessions: new Map([[1, session]]), sessionsDir: sessionsDir,
    sessionFilePath: function (id) { return path.join(sessionsDir, id + ".jsonl"); } };
  writeLog(manager.sessionFilePath(storageId), clock);
  var runtime = attachRuntime({ bindings: store, now: function () { return clock; },
    readLedgerEvents: function () { return []; }, appendLedgerEvent: function () { return true; },
    resolveProjectContextById: function (projectId) {
      return projectId === PROJECT ? { getSessionManager: function () { return manager; } } : null;
    },
    sessionManagerForContext: function (context) { return context.getSessionManager(); } });
  return { cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
    manager: manager, runtime: runtime, session: session,
    setNow: function (value) { clock = value; }, store: store, taskId: taskId };
}

test("runtime adapter discovers the real bound session and vetoes a live reap", function () {
  var h = harness();
  try {
    h.setNow(1000000 + 30 * DAY);
    var report = h.runtime.run({ dryRun: true });
    var finding = report.findings.filter(function (item) {
      return item.portfolioTaskId === h.taskId;
    })[0];
    assert.equal(finding.kind, "runtime_active");
    assert.equal(report.reapable.length, 0);
    assert.equal(h.store.get(h.taskId, 1).status, "active");
  } finally { h.cleanup(); }
});

test("runtime adapter reaps the same binding only after durable death evidence", function () {
  var h = harness();
  try {
    h.session.isProcessing = false;
    h.setNow(1000000 + 4 * DAY);
    var report = h.runtime.run({ dryRun: false });
    assert.equal(report.applied.length, 1);
    assert.equal(report.applied[0].outcome.applied, true);
    assert.equal(h.store.get(h.taskId, 1).status, "failed");
  } finally { h.cleanup(); }
});

test("daemon owns a switch-gated, unrefed execution-reaper timer", function () {
  var source = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");
  assert.match(source, /CLAY_COOP_EXECUTION_REAPER\s*===\s*["']1["']/);
  assert.match(source, /setInterval\(function \(\) \{[\s\S]*runCoopExecutionReaper\(\{ dryRun: false \}\)/);
  assert.match(source, /executionReaperHandle\.unref\(\)/);
  assert.match(source, /clearInterval\(executionReaperHandle\)/);
});

test("offline CLI refuses apply instead of pretending to observe daemon runtime", function () {
  var result = childProcess.spawnSync(process.execPath,
    [path.join(__dirname, "..", "scripts", "run-coop-execution-reaper.js"), "--apply"],
    { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Offline apply is forbidden/);
});
