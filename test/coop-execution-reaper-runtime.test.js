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

var CLI = path.join(__dirname, "..", "scripts", "run-coop-execution-reaper.js");

// A self-contained CLAY_HOME so the CLI resolves its config, sessions root and
// binding store entirely inside the fixture. One genuinely dead coordinator
// (log ends on the terminal `done` marker, well past the quiescence window) and
// one cut off mid-turn, which must survive every run.
function cliFixture() {
  var home = tempDir("cli");
  var projectPath = path.join(home, "project");
  var sessionsDir = path.join(home, "sessions", projectPath.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  var configFile = path.join(home, "daemon-dev.json");
  fs.writeFileSync(configFile, JSON.stringify({
    projects: [{ path: projectPath, slug: "fixture", projectId: PROJECT }],
  }));

  var bindingFile = path.join(home, "bindings.json");
  var now = Date.now();
  var store = createBindings({ file: bindingFile, reconcileOnLoad: false });
  [["dead-coordinator", "done"], ["midturn-coordinator", "tool_executing"]].forEach(function (pair) {
    var storageId = pair[0] + "-session";
    store.reserve({
      portfolioTaskId: pair[0],
      mode: "project_coordinator",
      targetProject: { projectId: PROJECT },
      bindingRevision: 1,
      idempotencyKey: pair[0] + "-r1",
    });
    store.commit(pair[0], 1, { projectId: PROJECT, sessionStorageId: storageId });
    fs.writeFileSync(path.join(sessionsDir, storageId + ".jsonl"),
      JSON.stringify({ type: "session", _ts: now - 30 * DAY }) + "\n" +
      JSON.stringify({ type: pair[1], code: 0, _ts: now - 30 * DAY }) + "\n");
  });
  return { home: home, configFile: configFile, bindingFile: bindingFile };
}

function runCli(fixture, extraArgs) {
  var args = [CLI, "--config", fixture.configFile, "--bindings", fixture.bindingFile]
    .concat(extraArgs || []);
  var result = childProcess.spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: Object.assign({}, process.env, { CLAY_HOME: fixture.home, CLAY_CONFIG: fixture.configFile }),
  });
  assert.equal(result.status, 0, "CLI failed: " + result.stderr);
  return JSON.parse(result.stdout);
}

// The default report's "0 reapable" is indistinguishable from the output of a
// completely broken predicate, so on its own it is not evidence the predicate
// works. This pins that the two runs disagree, and that the disagreement is
// attributable to the runtime observation alone -- same store, same logs.
test("offline CLI reports nothing reapable until runtime observation is supplied", function () {
  var fixture = cliFixture();

  var unobserved = runCli(fixture);
  assert.equal(unobserved.runtimeObservation, "unobserved");
  assert.equal(unobserved.totals.reapable, 0);
  assert.equal(unobserved.disclaimer, undefined);
  var vetoed = unobserved.findings.filter(function (item) {
    return item.portfolioTaskId === "dead-coordinator";
  })[0];
  assert.equal(vetoed.decision, "exempt");
  assert.equal(vetoed.kind, "runtime_unobserved");

  var simulated = runCli(fixture, ["--simulate-runtime"]);
  assert.equal(simulated.runtimeObservation, "simulated");
  assert.match(simulated.disclaimer, /SUPPLIED, not observed/);
  assert.equal(simulated.totals.reapable, 1);
  var reaped = simulated.findings.filter(function (item) {
    return item.decision === "reap";
  });
  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].portfolioTaskId, "dead-coordinator");
  assert.equal(reaped[0].kind, "session_log_quiescent");
  assert.equal(reaped[0].evidence.lastEventType, "done");

  // The mid-turn coordinator is unreapable in BOTH runs. Supplying runtime
  // observation must relax exactly one veto, not open the gate generally.
  ["midturn-coordinator"].forEach(function (taskId) {
    var still = simulated.findings.filter(function (item) {
      return item.portfolioTaskId === taskId;
    })[0];
    assert.equal(still.decision, "skip");
    assert.match(still.kind, /^session_log_mid_turn/);
  });
});

// The flag makes the report more informative; it must not make the script an
// apply path, and it must not touch the store it read.
test("simulated runtime stays a read-only diagnostic", function () {
  var fixture = cliFixture();
  var before = fs.readFileSync(fixture.bindingFile, "utf8");

  var refused = childProcess.spawnSync(process.execPath,
    [CLI, "--config", fixture.configFile, "--bindings", fixture.bindingFile,
      "--simulate-runtime", "--apply"],
    { encoding: "utf8", env: Object.assign({}, process.env, { CLAY_HOME: fixture.home }) });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Offline apply is forbidden/);

  var report = runCli(fixture, ["--simulate-runtime"]);
  assert.equal(report.dryRun, true);
  assert.equal(report.totals.reapable, 1);
  assert.equal(fs.readFileSync(fixture.bindingFile, "utf8"), before);
  var reloaded = createBindings({ file: fixture.bindingFile, reconcileOnLoad: false });
  assert.equal(reloaded.get("dead-coordinator", 1).status, "active");
  assert.equal(reloaded.get("dead-coordinator", 1).reapEvidence, undefined);
});
