// Tests for Lead backlog aggregation (CTO orchestrator brick 3).
// Fixtures mirror real shapes: gh issue list --json output and the
// .clay/tasks/*.json launcher configs observed in production.
var test = require("node:test");
var assert = require("node:assert");

var backlog = require("../lib/lead-backlog");

var NOW = 1785700000000;

var GH_FIXTURE = [
  { number: 12, title: "Crash in daemon restart path", body: "daemon dies", labels: [{ name: "bug" }, { name: "P0" }], state: "OPEN", updatedAt: "2026-07-20T10:00:00Z", url: "https://x/12" },
  { number: 15, title: "Fix typo in README", body: "", labels: [], state: "OPEN", updatedAt: "2026-08-01T10:00:00Z", url: "https://x/15" },
  { number: 9, title: "Old closed thing", body: "", labels: [], state: "CLOSED", updatedAt: "2026-06-01T10:00:00Z", url: "https://x/9" },
];

test("normalizeGithubIssue lowercases labels and parses dates", function () {
  var item = backlog.normalizeGithubIssue(GH_FIXTURE[0], "trialview");
  assert.strictEqual(item.id, "trialview#12");
  assert.deepStrictEqual(item.labels, ["bug", "p0"]);
  assert.strictEqual(item.state, "open");
  assert.ok(item.updatedAt > 0);
});

test("githubSourcesFromTaskConfigs extracts repos and filters, dedupes", function () {
  var configs = [
    { id: "assigned-to-me", source: { provider: "github", kind: "issue", repo: "trialview/v2", ghAccount: "bojantv" }, filter: { state: "open", assigned: "me", type: "bug" } },
    { id: "dup", source: { provider: "github", repo: "trialview/v2" } },
    { id: "not-github", source: { provider: "linear", repo: "x" } },
    { id: "no-source" },
  ];
  var sources = backlog.githubSourcesFromTaskConfigs(configs);
  assert.strictEqual(sources.length, 1);
  assert.strictEqual(sources[0].repo, "trialview/v2");
  assert.strictEqual(sources[0].filters.assigned, "me");
  // ghAccount must survive extraction — lead-exec needs it for repos
  // invisible to the globally active gh account.
  assert.strictEqual(sources[0].ghAccount, "bojantv");
});

test("githubSourcesFromTaskConfigs defaults ghAccount to null", function () {
  var sources = backlog.githubSourcesFromTaskConfigs([
    { id: "a", source: { provider: "github", repo: "o/r" } },
  ]);
  assert.strictEqual(sources[0].ghAccount, null);
});

test("ghIssueArgs builds the exact gh invocation", function () {
  var args = backlog.ghIssueArgs({ repo: "trialview/v2", filters: { state: "open", assigned: "me", type: "bug" } });
  // type "bug" is NOT a label filter (launcher semantics: bug = not
  // feature/legacy, applied post-fetch); no --label here.
  assert.deepStrictEqual(args, ["issue", "list", "--repo", "trialview/v2",
    "--json", "number,title,body,labels,state,updatedAt,url", "--limit", "100",
    "--state", "open", "--assignee", "@me"]);
});

test("ghIssueArgs maps concrete types to a label filter", function () {
  var args = backlog.ghIssueArgs({ repo: "o/r", filters: { type: "feature" } });
  assert.ok(args.indexOf("--label") !== -1);
  assert.strictEqual(args[args.indexOf("--label") + 1], "feature");
});

test("collectGithubIssues bug type excludes feature/legacy labels post-fetch", function (t, done) {
  var fakeExec = function (cmd, args, cb) {
    cb(null, JSON.stringify([
      { number: 1, title: "Crash on save", state: "OPEN", labels: [], updatedAt: "2026-08-01T00:00:00Z", url: "u1" },
      { number: 2, title: "New widget", state: "OPEN", labels: [{ name: "feature" }], updatedAt: "2026-08-01T00:00:00Z", url: "u2" },
      { number: 3, title: "Old flow", state: "OPEN", labels: [{ name: "Legacy" }], updatedAt: "2026-08-01T00:00:00Z", url: "u3" },
    ]));
  };
  backlog.collectGithubIssues(fakeExec, { repo: "o/r", filters: { type: "bug" } }, "webapp", function (err, items) {
    assert.strictEqual(err, null);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].title, "Crash on save");
    done();
  });
});

test("collectGithubIssues honours excludeLabels and titleExcludePrefixes", function (t, done) {
  var fakeExec = function (cmd, args, cb) {
    cb(null, JSON.stringify([
      { number: 1, title: "BE: Server-only fix", state: "OPEN", labels: [], updatedAt: "2026-08-01T00:00:00Z", url: "u1" },
      { number: 2, title: "Blocked thing", state: "OPEN", labels: [{ name: "Blocked" }], updatedAt: "2026-08-01T00:00:00Z", url: "u2" },
      { number: 3, title: "Real frontend bug", state: "OPEN", labels: [], updatedAt: "2026-08-01T00:00:00Z", url: "u3" },
    ]));
  };
  var filters = { excludeLabels: ["blocked", "backend"], titleExcludePrefixes: ["BE:"] };
  backlog.collectGithubIssues(fakeExec, { repo: "o/r", filters: filters }, "webapp", function (err, items) {
    assert.strictEqual(err, null);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].title, "Real frontend bug");
    done();
  });
});

test("collectGithubIssues degrades to empty on gh failure (issues disabled)", function (t, done) {
  var fakeExec = function (cmd, args, cb) { cb(new Error("repository has disabled issues"), ""); };
  backlog.collectGithubIssues(fakeExec, { repo: "bojantv/clay", filters: {} }, "clay", function (err, items) {
    assert.ok(err);
    assert.deepStrictEqual(items, []);
    done();
  });
});

test("collectGithubIssues normalizes successful output", function (t, done) {
  var fakeExec = function (cmd, args, cb) {
    assert.strictEqual(cmd, "gh");
    cb(null, JSON.stringify(GH_FIXTURE));
  };
  backlog.collectGithubIssues(fakeExec, { repo: "t/v2", filters: {} }, "trialview", function (err, items) {
    assert.strictEqual(err, null);
    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0].source, "github");
    done();
  });
});

test("buildPortfolio classifies, routes, scores and orders deterministically", function () {
  var portfolio = backlog.buildPortfolio([
    { project: "trialview", items: GH_FIXTURE.map(function (raw) { return backlog.normalizeGithubIssue(raw, "trialview"); }) },
    { project: "clay", items: [{ title: "Restart with same brief card after a stopped debate", body: "debate ux" }] },
  ], { now: NOW });

  // Closed items excluded
  assert.strictEqual(portfolio.items.length, 3);
  // The P0 daemon crash outranks everything
  assert.strictEqual(portfolio.items[0].id, "trialview#12");
  assert.ok(portfolio.items[0].score > portfolio.items[1].score);
  // Every open item carries classification + route + rationale
  for (var i = 0; i < portfolio.items.length; i++) {
    assert.ok(portfolio.items[i].classification.taskClass);
    assert.ok(portfolio.items[i].route && portfolio.items[i].route.rationale);
  }
  // The crash routes to a high tier with full gate; the typo stays cheap
  var crash = portfolio.items[0];
  assert.strictEqual(crash.classification.risk, "high");
  assert.strictEqual(crash.route.verificationDepth, "full-gate");
  var typo = portfolio.items.filter(function (x) { return x.id === "trialview#15"; })[0];
  assert.strictEqual(typo.route.tier, 1);
  // Summary is honest
  assert.strictEqual(portfolio.summary.total, 3);
  assert.strictEqual(portfolio.summary.projects, 2);
  assert.strictEqual(portfolio.summary.unroutable, 0);
  assert.strictEqual(portfolio.summary.top.id, "trialview#12");
});

test("buildPortfolio counts unroutable items when all vendors are down", function () {
  var portfolio = backlog.buildPortfolio(
    [{ project: "clay", items: [{ title: "Add CSV export" }] }],
    { now: NOW, health: { claude: "unhealthy", codex: "unhealthy" } });
  assert.strictEqual(portfolio.summary.unroutable, 1);
  assert.strictEqual(portfolio.items[0].route, null);
});

test("scoring is replayable: same inputs, same order", function () {
  var build = function () {
    return backlog.buildPortfolio(
      [{ project: "p", items: GH_FIXTURE.map(function (raw) { return backlog.normalizeGithubIssue(raw, "p"); }) }],
      { now: NOW }).items.map(function (x) { return x.id; });
  };
  assert.deepStrictEqual(build(), build());
});
