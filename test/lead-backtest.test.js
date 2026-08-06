var test = require("node:test");
var assert = require("node:assert");
var backtest = require("../lib/lead-backtest");

test("prIssueNumber extracts from branch convention", function () {
  assert.strictEqual(backtest.prIssueNumber({ headRefName: "fix/2296-remove-old-flows" }), 2296);
  assert.strictEqual(backtest.prIssueNumber({ headRefName: "feat/101" }), 101);
});

test("prIssueNumber falls back to title reference", function () {
  assert.strictEqual(backtest.prIssueNumber({ headRefName: "some-branch", title: "fix(#2208): keep state" }), 2208);
  assert.strictEqual(backtest.prIssueNumber({ headRefName: "chore/deps", title: "no ref here" }), null);
});

test("joinGroundTruth pairs issues and prefers the largest PR", function () {
  var issues = [{ number: 10, title: "A" }, { number: 11, title: "B" }];
  var prs = [
    { headRefName: "fix/10-first", additions: 5, deletions: 0 },
    { headRefName: "fix/10-followup", additions: 300, deletions: 40 },
    { headRefName: "fix/99-unrelated", additions: 1, deletions: 0 },
  ];
  var pairs = backtest.joinGroundTruth(issues, prs);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].issue.number, 10);
  assert.strictEqual(pairs[0].pr.additions, 300);
});

test("effortBucket boundaries", function () {
  assert.strictEqual(backtest.effortBucket({ changedFiles: 1, additions: 9, deletions: 0 }), "small");
  assert.strictEqual(backtest.effortBucket({ changedFiles: 2, additions: 30, deletions: 30 }), "small");
  assert.strictEqual(backtest.effortBucket({ changedFiles: 5, additions: 200, deletions: 50 }), "medium");
  assert.strictEqual(backtest.effortBucket({ changedFiles: 20, additions: 500, deletions: 500 }), "large");
  assert.strictEqual(backtest.effortBucket({ changedFiles: 3, additions: 700, deletions: 0 }), "large");
});

test("compareRouting verdicts over/under/aligned", function () {
  var pairs = [
    { issue: { number: 1, title: "small tweak" }, pr: { changedFiles: 1, additions: 5, deletions: 1 } },
    { issue: { number: 2, title: "big rework" }, pr: { changedFiles: 30, additions: 2000, deletions: 900 } },
  ];
  var classifyFn = function () { return { taskClass: "implementation", risk: "low", effort: "small" }; };
  var tiers = { 1: 4, 2: 1 };
  var routeFn = function () { return null; };
  var rows = backtest.compareRouting(pairs, classifyFn, function () {
    routeFn.calls = (routeFn.calls || 0) + 1;
    return { tier: tiers[routeFn.calls === 1 ? 1 : 2] };
  });
  assert.strictEqual(rows[0].verdict, "over");   // t4 for a small fix
  assert.strictEqual(rows[1].verdict, "under");  // t1 for a large fix
});

test("compareRouting flags unroutable", function () {
  var pairs = [{ issue: { number: 1, title: "x" }, pr: { changedFiles: 1, additions: 1, deletions: 0 } }];
  var rows = backtest.compareRouting(pairs,
    function () { return { taskClass: "implementation", risk: "low" }; },
    function () { return null; });
  assert.strictEqual(rows[0].verdict, "unroutable");
});

test("composeBacktestReport aggregates and computes alignment pct", function () {
  var rows = [
    { verdict: "aligned" }, { verdict: "aligned" }, { verdict: "over" }, { verdict: "under" },
  ];
  var report = backtest.composeBacktestReport(rows, { at: 123, repo: "o/r" });
  assert.strictEqual(report.type, "backtest_report");
  assert.strictEqual(report.total, 4);
  assert.strictEqual(report.aligned, 2);
  assert.strictEqual(report.alignmentPct, 50);
  assert.strictEqual(report.at, 123);
});

test("formatBacktestReport is printable and carries the summary", function () {
  var report = backtest.composeBacktestReport([
    { verdict: "aligned", number: 7, predictedTier: 2, taskClass: "debugging", risk: "low", bucket: "medium", files: 3, lines: 80, title: "Some bug" },
  ], { at: 1, repo: "o/r" });
  var text = backtest.formatBacktestReport(report);
  assert.ok(text.indexOf("alignment 100%") !== -1);
  assert.ok(text.indexOf("#7 [aligned] t2") !== -1);
});

// --- scripts/lead-backtest.js CLI ---------------------------------------------
// The runner is a real caller of lead-backlog's source resolution. When the
// first-file-wins extractor was removed, this script still called it and died
// with "githubSourcesFromTaskConfigs is not a function" before it could reach
// its own error handling. These drive the actual script end to end, in a real
// git repo, so a removed or renamed export can never break it unnoticed again.
var childProcess = require("node:child_process");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var SCRIPT = path.join(__dirname, "..", "scripts", "lead-backtest.js");

function makeProject(originUrl, recipe) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lead-backtest-"));
  childProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
  if (originUrl) childProcess.execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: dir });
  var tasksDir = path.join(dir, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  var configPath = path.join(tasksDir, "assigned-to-me.json");
  fs.writeFileSync(configPath, JSON.stringify(recipe));
  return { dir: dir, configPath: configPath };
}

function runScript(configPath) {
  var result = childProcess.spawnSync(process.execPath, [SCRIPT, configPath], { encoding: "utf8", timeout: 30000 });
  return { status: result.status, stderr: String(result.stderr || "") };
}

function assertNoCrash(stderr) {
  assert.ok(stderr.indexOf("is not a function") === -1, "must not crash on a missing export: " + stderr);
  assert.ok(stderr.indexOf("TypeError") === -1, "must not throw a TypeError: " + stderr);
}

test("lead-backtest CLI fails closed when the project does not own the repo", function () {
  // The exact misplaced-launcher shape: a project whose origin is its own repo
  // carrying a recipe that points at somebody else's.
  var project = makeProject("https://github.com/bojanx100/clay.git", {
    id: "assigned-to-me",
    source: { provider: "github", kind: "issue", repo: "trialview/v2" },
  });
  var run = runScript(project.configPath);
  assertNoCrash(run.stderr);
  assert.strictEqual(run.status, 2);
  assert.match(run.stderr, /unresolved repository ownership/);
  assert.match(run.stderr, /unowned_repository_source/);
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test("lead-backtest CLI reports a config with no github issue source", function () {
  var project = makeProject("https://github.com/bojanx100/clay.git", {
    id: "sentry-fix",
    source: { provider: "sentry", kind: "findings" },
  });
  var run = runScript(project.configPath);
  assertNoCrash(run.stderr);
  assert.strictEqual(run.status, 2);
  assert.match(run.stderr, /no github issue source/);
  fs.rmSync(project.dir, { recursive: true, force: true });
});

test("lead-backtest CLI rejects a config outside <project>/.clay/tasks", function () {
  // git config walks UP to the enclosing repo, so a config at
  // <repo>/deep/nested/x.json would inherit <repo>'s origin, "own" the repo
  // under a bogus label, and reach real gh fetches and ledger writes. The
  // canonical path must be validated BEFORE any of that.
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lead-backtest-"));
  childProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
  childProcess.execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: dir });
  var nested = path.join(dir, "deep", "nested");
  fs.mkdirSync(nested, { recursive: true });
  var configPath = path.join(nested, "cfg.json");
  fs.writeFileSync(configPath, JSON.stringify({ id: "x", source: { provider: "github", kind: "issue", repo: "acme/widgets" } }));

  var run = runScript(configPath);
  assertNoCrash(run.stderr);
  assert.strictEqual(run.status, 2);
  assert.match(run.stderr, /must live at <project>\/\.clay\/tasks/);
  // Rejected BEFORE any GitHub access.
  assert.ok(run.stderr.indexOf("issue fetch failed") === -1, "must not reach a gh fetch: " + run.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("lead-backtest CLI rejects a .clay/tasks below the repository root", function () {
  // A name check alone is not enough: <repo>/sub/.clay/tasks/x.json has the
  // canonical parents but derives <repo>/sub as the project, which inherits
  // <repo>'s origin through git's upward walk and would "own" the repository
  // under a bogus label and ProjectRef. The project dir must BE the repo root.
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lead-backtest-"));
  childProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
  childProcess.execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: dir });
  var tasksDir = path.join(dir, "sub", ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  var configPath = path.join(tasksDir, "x.json");
  fs.writeFileSync(configPath, JSON.stringify({ id: "x", source: { provider: "github", kind: "issue", repo: "acme/widgets" } }));

  var run = runScript(configPath);
  assertNoCrash(run.stderr);
  assert.strictEqual(run.status, 2);
  assert.match(run.stderr, /root of the git repository/);
  assert.ok(run.stderr.indexOf("issue fetch failed") === -1, "must not reach a gh fetch: " + run.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("lead-backtest CLI rejects a config outside any git repository", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lead-backtest-"));
  var tasksDir = path.join(dir, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  var configPath = path.join(tasksDir, "x.json");
  fs.writeFileSync(configPath, JSON.stringify({ id: "x", source: { provider: "github", kind: "issue", repo: "acme/widgets" } }));

  var run = runScript(configPath);
  assertNoCrash(run.stderr);
  assert.strictEqual(run.status, 2);
  // git's own "fatal: not a git repository" noise must not reach the operator.
  assert.ok(run.stderr.indexOf("fatal:") === -1, "git stderr must be suppressed: " + run.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Repository-root validation must depend only on the path on disk.
function makeRepo(originUrl) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lead-backtest-"));
  childProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
  if (originUrl) childProcess.execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: dir });
  return dir;
}

function writeRecipe(dir, relDir) {
  var full = path.join(dir, relDir);
  fs.mkdirSync(full, { recursive: true });
  var configPath = path.join(full, "x.json");
  fs.writeFileSync(configPath, JSON.stringify({ id: "x", source: { provider: "github", kind: "issue", repo: "acme/widgets" } }));
  return configPath;
}

test("lead-backtest CLI ignores GIT_DIR/GIT_WORK_TREE when validating the root", function () {
  // An inherited GIT_DIR/GIT_WORK_TREE must not be able to redefine which
  // repository the root check sees; otherwise a nested config could be
  // validated against an unrelated repository.
  var real = makeRepo("https://github.com/acme/widgets.git");
  var other = makeRepo("https://github.com/acme/widgets.git");
  var nested = writeRecipe(real, path.join("sub", ".clay", "tasks"));

  var env = Object.assign({}, process.env, {
    GIT_DIR: path.join(other, ".git"),
    GIT_WORK_TREE: path.join(real, "sub"),
  });
  var run = childProcess.spawnSync(process.execPath, [SCRIPT, nested], { encoding: "utf8", timeout: 30000, env: env });
  assertNoCrash(String(run.stderr || ""));
  assert.strictEqual(run.status, 2);
  assert.match(String(run.stderr), /root of the git repository/);
  assert.ok(String(run.stderr).indexOf("issue fetch failed") === -1, "must not reach a gh fetch");
  fs.rmSync(real, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

test("lead-backtest CLI accepts a symlinked project root", function () {
  // Reaching the project through a symlink is the same project; it must
  // validate, not be rejected as a different directory.
  var real = makeRepo("https://github.com/acme/widgets.git");
  writeRecipe(real, path.join(".clay", "tasks"));
  var aliasDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lead-alias-")), "alias");
  fs.symlinkSync(real, aliasDir);

  var run = runScript(path.join(aliasDir, ".clay", "tasks", "x.json"));
  assertNoCrash(run.stderr);
  // Passes validation and proceeds to the gh fetch (which fails on a repo that
  // does not exist) rather than being rejected on the path.
  assert.ok(run.stderr.indexOf("must live at") === -1, "symlinked root must not be rejected: " + run.stderr);
  fs.rmSync(real, { recursive: true, force: true });
});

test("lead-backtest CLI accepts a case variant only when the filesystem resolves it", function () {
  var real = makeRepo("https://github.com/acme/widgets.git");
  writeRecipe(real, path.join(".clay", "tasks"));
  var variant = path.join(real, ".CLAY", "TASKS", "x.json");
  var caseInsensitive = fs.existsSync(variant);

  var run = runScript(variant);
  assertNoCrash(run.stderr);
  if (caseInsensitive) {
    // The spelling resolves to the real .clay/tasks, so it must be accepted.
    assert.ok(run.stderr.indexOf("must live at") === -1,
      "a readable case variant must not be rejected: " + run.stderr);
  } else {
    // Case-sensitive filesystem: the path does not exist, so it must reject.
    assert.strictEqual(run.status, 2);
    assert.match(run.stderr, /must live at/);
  }
  fs.rmSync(real, { recursive: true, force: true });
});

test("lead-backtest CLI ignores injected git config when reading the origin", function () {
  // GIT_CONFIG_COUNT + indexed KEY/VALUE pairs inject config at the highest
  // precedence — including remote.origin.url, the single value the whole
  // ownership decision rests on. git sets config-injection variables itself,
  // so a run from inside a hook or `git -c ...` inherits them by accident.
  var repo = makeRepo("https://github.com/real/repo.git");
  var configPath = writeRecipe(repo, path.join(".clay", "tasks"));

  var env = Object.assign({}, process.env, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "remote.origin.url",
    GIT_CONFIG_VALUE_0: "https://github.com/acme/widgets",
  });
  var run = childProcess.spawnSync(process.execPath, [SCRIPT, configPath], { encoding: "utf8", timeout: 30000, env: env });
  assertNoCrash(String(run.stderr || ""));
  // The real origin is real/repo, which does not own acme/widgets, so this
  // must fail closed rather than accept the forged origin.
  assert.strictEqual(run.status, 2);
  assert.match(String(run.stderr), /unresolved repository ownership/);
  assert.ok(String(run.stderr).indexOf("issue fetch failed") === -1, "must not reach a gh fetch");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("lead-backtest CLI ignores GIT_CONFIG_PARAMETERS when reading the origin", function () {
  var repo = makeRepo("https://github.com/real/repo.git");
  var configPath = writeRecipe(repo, path.join(".clay", "tasks"));

  var env = Object.assign({}, process.env, {
    GIT_CONFIG_PARAMETERS: "'remote.origin.url=https://github.com/acme/widgets'",
  });
  var run = childProcess.spawnSync(process.execPath, [SCRIPT, configPath], { encoding: "utf8", timeout: 30000, env: env });
  assertNoCrash(String(run.stderr || ""));
  assert.strictEqual(run.status, 2);
  assert.match(String(run.stderr), /unresolved repository ownership/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("lead-backtest CLI reports one canonical identity through a symlinked root", function () {
  // The audit line makes the ownership decision observable: reaching the same
  // project through a symlink must report the REAL project label and the same
  // deterministic ProjectRef, never the alias.
  var repo = makeRepo("https://github.com/acme/widgets.git");
  writeRecipe(repo, path.join(".clay", "tasks"));
  var aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), "lead-alias-"));
  var aliasDir = path.join(aliasParent, "some-other-name");
  fs.symlinkSync(repo, aliasDir);

  var direct = runScript(path.join(repo, ".clay", "tasks", "x.json"));
  var viaAlias = runScript(path.join(aliasDir, ".clay", "tasks", "x.json"));
  var line = /resolved acme\/widgets -> project (\S+) \((\S+)\)/;
  var a = direct.stderr.match(line);
  var b = viaAlias.stderr.match(line);
  assert.ok(a && b, "both runs must report a resolution: " + direct.stderr + " | " + viaAlias.stderr);
  assert.strictEqual(a[1], b[1], "project label must be canonical, not the alias");
  assert.strictEqual(a[2], b[2], "ProjectRef must be canonical, not derived from the alias");
  assert.ok(b[1].indexOf("some-other-name") === -1, "must not report the alias name");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(aliasParent, { recursive: true, force: true });
});
