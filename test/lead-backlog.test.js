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

// --- Repository-source ownership ---------------------------------------------
// Regression fixtures for the 2026-08-06 incident: the Clay project carried
// stale copies of the Webapp launchers, so trialview/v2 was declared by BOTH
// projects and issue #2507 entered the portfolio as clay#2507 AND webapp#2507.
// Ownership must be decided by git origin, and every other outcome must fail
// closed. Webapp's real ProjectRef; Clay's origin is bojanx100/clay.
var WEBAPP_REF = { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" };
var CLAY_REF = { projectId: "11111111-2222-5333-8444-555555555555" };

var WEBAPP_ASSIGNED = {
  id: "assigned-to-me",
  source: { provider: "github", kind: "issue", repo: "trialview/v2", ghAccount: "bojantv" },
  filter: { state: "open", assigned: "me", type: "bug", skipProjectStatuses: ["In progress", "Done"] },
};
// The misplaced Clay copy: same repo, no pinned account, no board exclusions.
var CLAY_STALE_COPY = {
  id: "assigned-to-me",
  source: { provider: "github", kind: "issue", repo: "trialview/v2" },
  filter: { state: "open", assigned: "me", type: "bug" },
};

function webappEntry(configs) {
  return { project: "webapp", projectRef: WEBAPP_REF, originRepo: "https://bojantv@github.com/trialview/v2.git", configs: configs };
}
function clayEntry(configs) {
  return { project: "clay", projectRef: CLAY_REF, originRepo: "https://bojanx100@github.com/bojanx100/clay.git", configs: configs };
}

test("resolveGithubSources binds a repo to the origin-matching project", function () {
  var result = backlog.resolveGithubSources([
    webappEntry([WEBAPP_ASSIGNED, { id: "not-github", source: { provider: "linear", repo: "x" } }, { id: "no-source" }]),
  ]);
  assert.deepStrictEqual(result.conflicts, []);
  assert.strictEqual(result.sources.length, 1);
  assert.strictEqual(result.sources[0].repo, "trialview/v2");
  assert.strictEqual(result.sources[0].project, "webapp");
  assert.deepStrictEqual(result.sources[0].projectRef, WEBAPP_REF);
  assert.strictEqual(result.sources[0].filters.assigned, "me");
  assert.deepStrictEqual(result.sources[0].filters.skipProjectStatuses, ["In progress", "Done"]);
  // ghAccount must survive resolution — lead-exec needs it for repos invisible
  // to the globally active gh account.
  assert.strictEqual(result.sources[0].ghAccount, "bojantv");
});

test("trialview/v2 resolves only under Webapp, never under Clay", function () {
  // Both orderings, because the old bug was pure scan-order luck.
  var forward = backlog.resolveGithubSources([clayEntry([CLAY_STALE_COPY]), webappEntry([WEBAPP_ASSIGNED])]);
  var reverse = backlog.resolveGithubSources([webappEntry([WEBAPP_ASSIGNED]), clayEntry([CLAY_STALE_COPY])]);
  [forward, reverse].forEach(function (result) {
    assert.strictEqual(result.sources.length, 1);
    assert.strictEqual(result.sources[0].project, "webapp");
    assert.deepStrictEqual(result.sources[0].projectRef, WEBAPP_REF);
    // Clay's stale copy must not survive in any form.
    assert.strictEqual(result.sources[0].ghAccount, "bojantv");
    assert.deepStrictEqual(result.sources[0].filters.skipProjectStatuses, ["In progress", "Done"]);
    assert.deepStrictEqual(result.conflicts, []);
  });
  assert.deepStrictEqual(forward.sources, reverse.sources);
});

test("a repo no project owns fails closed instead of picking the first", function () {
  var result = backlog.resolveGithubSources([clayEntry([CLAY_STALE_COPY])]);
  assert.deepStrictEqual(result.sources, []);
  assert.strictEqual(result.conflicts.length, 1);
  assert.strictEqual(result.conflicts[0].repo, "trialview/v2");
  assert.strictEqual(result.conflicts[0].reason, "unowned_repository_source");
  assert.strictEqual(result.conflicts[0].candidates[0].project, "clay");
});

test("two projects claiming the same origin fail closed as ambiguous", function () {
  var impostor = { project: "webapp-clone", projectRef: CLAY_REF, originRepo: "trialview/v2", configs: [CLAY_STALE_COPY] };
  var result = backlog.resolveGithubSources([webappEntry([WEBAPP_ASSIGNED]), impostor]);
  assert.deepStrictEqual(result.sources, []);
  assert.strictEqual(result.conflicts[0].reason, "ambiguous_repository_owner");
});

test("an unusable ProjectRef fails closed rather than resolving unowned", function () {
  var result = backlog.resolveGithubSources([
    { project: "webapp", projectRef: { projectId: "not-a-uuid" }, originRepo: "trialview/v2", configs: [WEBAPP_ASSIGNED] },
  ]);
  assert.deepStrictEqual(result.sources, []);
  assert.strictEqual(result.conflicts[0].reason, "invalid_project_ref");
  assert.strictEqual(result.conflicts[0].candidates[0].projectId, null);
});

test("the owner's disagreeing recipes for one repo fail closed", function () {
  var narrower = { id: "second", source: { provider: "github", kind: "issue", repo: "trialview/v2", ghAccount: "bojantv" }, filter: { type: "feature" } };
  var result = backlog.resolveGithubSources([webappEntry([WEBAPP_ASSIGNED, narrower])]);
  assert.deepStrictEqual(result.sources, []);
  assert.strictEqual(result.conflicts[0].reason, "conflicting_repository_recipes");
});

test("identical duplicate recipes in the owner collapse to one source", function () {
  var result = backlog.resolveGithubSources([webappEntry([WEBAPP_ASSIGNED, Object.assign({}, WEBAPP_ASSIGNED, { id: "copy" })])]);
  assert.deepStrictEqual(result.conflicts, []);
  assert.strictEqual(result.sources.length, 1);
});

test("pr-review recipes never displace the issue source for a repo", function () {
  var prReview = { id: "pr-review", source: { provider: "github", kind: "pr-reviews", repo: "trialview/v2", ghAccount: "bojantv" } };
  var result = backlog.resolveGithubSources([webappEntry([prReview, WEBAPP_ASSIGNED])]);
  assert.strictEqual(result.sources.length, 1);
  // The issue recipe's filters survive — a kind-blind extractor would have let
  // the unfiltered pr-review source win on order and widen the backlog.
  assert.strictEqual(result.sources[0].filters.type, "bug");
  assert.deepStrictEqual(result.conflicts, []);
});

test("origin forms (ssh, https, .git, case) compare as one repo", function () {
  assert.strictEqual(backlog.normalizeRepoSlug("git@github.com:trialview/v2.git"), "trialview/v2");
  assert.strictEqual(backlog.normalizeRepoSlug("https://bojantv@github.com/TrialView/V2"), "trialview/v2");
  assert.strictEqual(backlog.normalizeRepoSlug("trialview/v2"), "trialview/v2");
  assert.strictEqual(backlog.normalizeRepoSlug("nonsense"), "");
  assert.strictEqual(backlog.normalizeRepoSlug(null), "");
  assert.notStrictEqual(backlog.normalizeRepoSlug("git@github.com:trialview/v2.git"), "");
  // Real GitHub remotes that must still resolve, including an explicit port.
  assert.strictEqual(backlog.normalizeRepoSlug("ssh://git@github.com:22/trialview/v2.git"), "trialview/v2");
  assert.strictEqual(backlog.normalizeRepoSlug("ssh://git@github.com/trialview/v2.git"), "trialview/v2");
  assert.strictEqual(backlog.normalizeRepoSlug("github.com/trialview/v2"), "trialview/v2");
  assert.strictEqual(backlog.normalizeRepoSlug("https://www.github.com/trialview/v2"), "trialview/v2");
  assert.strictEqual(backlog.normalizeRepoSlug("https://user:pw@github.com/trialview/v2.git"), "trialview/v2");
});

test("a foreign host can never forge ownership of a GitHub repo", function () {
  // Every one of these embeds the literal string "github.com" but is NOT
  // hosted on GitHub. A substring/prefix match would hand the real
  // trialview/v2 backlog to a foreign remote.
  var forgeries = [
    "https://evilgithub.com/trialview/v2",
    "https://evil.example/github.com/trialview/v2.git",
    "https://github.com.evil.example/trialview/v2",
    "git@evil.example:github.com/trialview/v2.git",
    "https://gitlab.com/trialview/v2",
    "evil.example/github.com/trialview/v2",
  ];
  forgeries.forEach(function (origin) {
    assert.strictEqual(backlog.normalizeRepoSlug(origin), "",
      origin + " must not normalize to a GitHub slug");
    // ...and end to end: such a project must never own the repo.
    var result = backlog.resolveGithubSources([
      { project: "foreign", projectRef: CLAY_REF, originRepo: origin, configs: [WEBAPP_ASSIGNED] },
    ]);
    assert.deepStrictEqual(result.sources, [], origin + " must not resolve to a source");
    assert.strictEqual(result.conflicts[0].reason, "unowned_repository_source");
  });
});

test("equivalent repo spellings resolve to one canonical slug, order-free", function () {
  var bare = { id: "bare", source: { provider: "github", kind: "issue", repo: "trialview/v2" } };
  var url = { id: "url", source: { provider: "github", kind: "issue", repo: "https://github.com/trialview/v2.git" } };
  var forward = backlog.resolveGithubSources([webappEntry([bare, url])]);
  var reverse = backlog.resolveGithubSources([webappEntry([url, bare])]);
  // One repo, one source, and the SAME emitted repo string either way.
  assert.strictEqual(forward.sources.length, 1);
  assert.strictEqual(reverse.sources.length, 1);
  assert.strictEqual(forward.sources[0].repo, "trialview/v2");
  assert.deepStrictEqual(forward.sources, reverse.sources);
});

test("a trailing DNS dot is the same GitHub host, not a foreign one", function () {
  // "github.com." is the fully-qualified form of github.com — a legitimate
  // remote that must resolve, not fail closed.
  assert.strictEqual(backlog.normalizeRepoSlug("https://github.com./trialview/v2.git"), "trialview/v2");
  assert.strictEqual(backlog.normalizeRepoSlug("git@github.com.:trialview/v2.git"), "trialview/v2");
  assert.strictEqual(backlog.normalizeRepoSlug("github.com./trialview/v2"), "trialview/v2");
  // ...and the anti-forgery check still holds with a trailing dot attached.
  assert.strictEqual(backlog.normalizeRepoSlug("https://evil.example./github.com/trialview/v2"), "");
  assert.strictEqual(backlog.normalizeRepoSlug("https://evilgithub.com./trialview/v2"), "");
  assert.strictEqual(backlog.normalizeRepoSlug("https://github.com.evil.example./trialview/v2"), "");
  // A trailing-dot origin owns the repo end to end.
  var result = backlog.resolveGithubSources([
    { project: "webapp", projectRef: WEBAPP_REF, originRepo: "https://github.com./trialview/v2.git", configs: [WEBAPP_ASSIGNED] },
  ]);
  assert.strictEqual(result.sources.length, 1);
  assert.strictEqual(result.sources[0].project, "webapp");
});

test("the dedupe key cannot be forged across the project/id boundary", function () {
  var NUL = String.fromCharCode(0);
  // Joining on a delimiter — any delimiter — lets one pair impersonate
  // another: "a<NUL>b" + "c" and "a" + "b<NUL>c" join to the same string.
  var forged = backlog.buildPortfolio([
    { project: "a" + NUL + "b", items: [{ id: "c", title: "first" }] },
    { project: "a", items: [{ id: "b" + NUL + "c", title: "second" }] },
  ], { now: NOW });
  assert.strictEqual(forged.summary.total, 2);
  assert.deepStrictEqual(forged.items.map(function (i) { return i.title; }).sort(), ["first", "second"]);

  // String() coercion must not merge distinct typed ids/projects either.
  var typed = backlog.buildPortfolio([
    { project: "clay", items: [{ id: 1, title: "numeric id" }] },
    { project: "clay", items: [{ id: "1", title: "string id" }] },
  ], { now: NOW });
  assert.strictEqual(typed.summary.total, 2);

  // The real duplicate still collapses.
  var dupe = backlog.buildPortfolio([
    { project: "clay", items: [{ id: "x", title: "same" }] },
    { project: "clay", items: [{ id: "x", title: "same" }] },
  ], { now: NOW });
  assert.strictEqual(dupe.summary.total, 1);
});

// Pre-normalized github items pass straight through buildPortfolio, so their
// project/id are whatever the caller supplied — the dedupe key must cope.
function ghItem(project, id, title) {
  return { source: "github", id: id, project: project, number: 1, title: title, body: "", labels: [], state: "open", updatedAt: 0, url: null };
}

test("the dedupe key preserves scalar identity types", function () {
  // number 1, string "1", boolean true and BigInt 1n are four distinct ids.
  // Plain JSON.stringify THROWS on a BigInt, which would abort the whole
  // portfolio build over one odd item.
  var typed = backlog.buildPortfolio([
    { project: "clay", items: [ghItem("clay", 1, "number"), ghItem("clay", "1", "string"), ghItem("clay", true, "boolean"), ghItem("clay", BigInt(1), "bigint")] },
  ], { now: NOW });
  assert.strictEqual(typed.summary.total, 4);
  assert.strictEqual(typed.summary.unidentifiable, 0);

  // null and undefined are distinct, and neither folds into the other.
  var nullish = backlog.buildPortfolio([
    { project: null, items: [ghItem(null, "x", "null project")] },
    { project: "u", items: [ghItem(undefined, "x", "undefined project")] },
  ], { now: NOW });
  assert.strictEqual(nullish.summary.total, 2);
});

test("numeric identities follow Object.is, including 0 vs -0", function () {
  // String(-0) is "0", so a String()-based token merged 0 and -0 and dropped
  // one item. The token's whole contract is that no two distinct supported
  // values encode alike, so the numeric edges have to hold too.
  var portfolio = backlog.buildPortfolio([
    { project: "x", items: [
      ghItem(0, "same", "zero"),
      ghItem(-0, "same", "negative zero"),
      ghItem(Infinity, "same", "infinity"),
      ghItem(-Infinity, "same", "negative infinity"),
      ghItem(NaN, "same", "nan first"),
      ghItem(NaN, "same", "nan second"),
    ] },
  ], { now: NOW });
  // 0, -0, Infinity, -Infinity are four identities; the two NaNs are one,
  // because Object.is(NaN, NaN) is true.
  assert.strictEqual(portfolio.summary.total, 5);
  assert.strictEqual(portfolio.summary.unidentifiable, 0);
  var titles = portfolio.items.map(function (i) { return i.title; });
  ["zero", "negative zero", "infinity", "negative infinity"].forEach(function (t) {
    assert.ok(titles.indexOf(t) !== -1, t + " must survive as its own identity");
  });
});

test("items without a scalar identity are skipped and counted, never guessed", function () {
  // Two structurally equal objects are indistinguishable once encoded, so
  // using them as keys would silently merge unrelated work. Fail closed and
  // report, rather than guess — and never throw.
  var portfolio = backlog.buildPortfolio([
    { project: "clay", items: [ghItem("clay", { a: 1 }, "object id"), ghItem("clay", { a: 1 }, "other object id"), ghItem("clay", "ok", "valid")] },
  ], { now: NOW });
  assert.strictEqual(portfolio.summary.total, 1);
  assert.strictEqual(portfolio.items[0].title, "valid");
  assert.strictEqual(portfolio.summary.unidentifiable, 2);

  // A symbol or function project is equally unusable, and must not throw.
  var exotic = backlog.buildPortfolio([
    { project: "clay", items: [ghItem(Symbol("s"), "a", "symbol project"), ghItem(function () {}, "b", "function project")] },
  ], { now: NOW });
  assert.strictEqual(exotic.summary.total, 0);
  assert.strictEqual(exotic.summary.unidentifiable, 2);
});

test("loose items with the same id in different projects both survive", function () {
  // Boss directives are ad-hoc; two projects can each carry "directive-1".
  // An id-only dedupe key silently dropped one project's real work.
  var portfolio = backlog.buildPortfolio([
    { project: "clay", items: [{ id: "directive-1", title: "Clay directive" }] },
    { project: "webapp", items: [{ id: "directive-1", title: "Webapp directive" }] },
  ], { now: NOW });
  assert.strictEqual(portfolio.summary.total, 2);
  assert.strictEqual(portfolio.byProject.clay.length, 1);
  assert.strictEqual(portfolio.byProject.webapp.length, 1);
  // ...while a true duplicate inside ONE project still collapses.
  var duped = backlog.buildPortfolio([
    { project: "clay", items: [{ id: "directive-1", title: "Clay directive" }] },
    { project: "clay", items: [{ id: "directive-1", title: "Clay directive" }] },
  ], { now: NOW });
  assert.strictEqual(duped.summary.total, 1);
  var result = backlog.resolveGithubSources([
    { project: "webapp", projectRef: WEBAPP_REF, originRepo: "git@github.com:trialview/v2.git", configs: [WEBAPP_ASSIGNED] },
  ]);
  assert.strictEqual(result.sources.length, 1);
  assert.strictEqual(result.sources[0].project, "webapp");
});

test("the removed first-file extractor is gone, not merely renamed", function () {
  assert.strictEqual(backlog.githubSourcesFromTaskConfigs, undefined);
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

test("ghIssueArgs requests projectItems when recipe status exclusions require them", function () {
  var args = backlog.ghIssueArgs({ repo: "o/r", filters: { skipProjectStatuses: ["In progress", "Done"] } });
  var jsonIndex = args.indexOf("--json");
  assert.ok(jsonIndex !== -1);
  assert.strictEqual(args[jsonIndex + 1], "number,title,body,labels,state,updatedAt,url,projectItems");
});

test("collectGithubIssues rejects any issue with a skipped project item status", function (t, done) {
  var calls = 0;
  var fakeExec = function (cmd, args, cb) {
    calls++;
    assert.ok(args[args.indexOf("--json") + 1].indexOf("projectItems") !== -1, "status-filtered recipes must request projectItems");
    cb(null, JSON.stringify([
      { number: 1453, title: "In progress issue", state: "OPEN", labels: [], projectItems: [
        { status: { name: "Backlog" } },
        { status: { name: "In progress" } },
      ] },
      { number: 1933, title: "Done issue", state: "OPEN", labels: [], projectItems: [
        { status: { name: "Done" } },
        { status: { name: "DONE" } },
      ] },
      { number: 2001, title: "Ready issue", state: "OPEN", labels: [], projectItems: [
        { status: { name: "Backlog" } },
        { status: { name: "Ready" } },
      ] },
      { number: 2002, title: "No board issue", state: "OPEN", labels: [] },
    ]));
  };
  backlog.collectGithubIssues(fakeExec, {
    repo: "o/r",
    filters: { skipProjectStatuses: ["in progress", "done"] },
  }, "webapp", function (err, items) {
    assert.strictEqual(err, null);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(items.map(function (item) { return item.number; }), [2001, 2002]);
    done();
  });
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

test("issue #2507 cannot be projected as clay#2507", function (t, done) {
  var issue2507 = [{ number: 2507, title: "Editor crash on paste", body: "", labels: [], state: "OPEN", updatedAt: "2026-08-05T10:00:00Z", url: "https://x/2507" }];
  var fakeExec = function (cmd, args, cb) { cb(null, JSON.stringify(issue2507)); };
  var owned = backlog.resolveGithubSources([webappEntry([WEBAPP_ASSIGNED])]).sources[0];

  // The owning project labels the item, whatever the caller passes.
  backlog.collectGithubIssues(fakeExec, owned, "webapp", function (err, items) {
    assert.strictEqual(err, null);
    assert.strictEqual(items[0].id, "webapp#2507");
    // A caller trying to relabel the same repo under Clay fails closed.
    backlog.collectGithubIssues(fakeExec, owned, "clay", function (mismatchErr, mismatchItems) {
      assert.ok(mismatchErr, "relabelling an owned repo must fail");
      assert.match(mismatchErr.message, /owned by project webapp/);
      assert.deepStrictEqual(mismatchItems, []);
      done();
    });
  });
});

test("a duplicated collection cannot become two portfolio items or launches", function () {
  var issue = backlog.normalizeGithubIssue(
    { number: 2507, title: "Editor crash on paste", body: "", labels: [{ name: "P0" }], state: "OPEN", updatedAt: "2026-08-05T10:00:00Z", url: "https://x/2507" },
    "webapp");
  var portfolio = backlog.buildPortfolio([
    { project: "webapp", items: [issue] },
    { project: "webapp", items: [issue] },
  ], { now: NOW });
  assert.strictEqual(portfolio.items.length, 1);
  assert.strictEqual(portfolio.items[0].id, "webapp#2507");
  assert.strictEqual(portfolio.byProject.webapp.length, 1);
  assert.strictEqual(portfolio.summary.total, 1);
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
