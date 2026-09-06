// Tests for Lead backlog aggregation (CTO orchestrator brick 3).
// Fixtures mirror real shapes: gh issue list --json output and the
// .clay/tasks/*.json launcher configs observed in production.
var test = require("node:test");
var assert = require("node:assert");

var backlog = require("../lib/lead-backlog");
var githubBacklog = require("../lib/lead-backlog-github");
var automationCandidates = require("../lib/project-automation-candidates");
var policyModule = require("../lib/project-automation-policy");
var boardEvidence = require("../lib/lead-backlog-github-evidence");

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

function policyFor(ref, configs) {
  var recipes = [];
  var exclusions = [];
  var seen = {};
  for (var i = 0; i < configs.length; i++) {
    var recipe = configs[i] || {};
    if (!recipe.source || typeof recipe.source !== "object") continue;
    var filter = recipe.filter || {};
    var statuses = filter.skipProjectStatuses || [];
    for (var s = 0; s < statuses.length; s++) {
      var status = String(statuses[s]).toLowerCase();
      if (!seen[status]) { seen[status] = true; exclusions.push(status); }
    }
    recipes.push({
      id: recipe.id || null,
      kind: recipe.source.kind === "pr-reviews" ? "pr_review" : "issue",
      repo: recipe.source.repo || "",
      type: filter.type || "",
      digest: policyModule.recipeDigest(recipe),
    });
  }
  recipes.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  exclusions.sort();
  var policy = {
    projectRef: ref,
    derived: true,
    autonomy: { bug: "propose", feature: "propose", ambiguous: "propose", pr_review: "propose", default: "propose" },
    externalActions: { comment: "approval", done_workflow: "approval", merge: "approval", close: "approval" },
    boardExclusions: exclusions,
    qualification: {
      version: 1,
      normalIssueIntake: {
        issueStates: ["open"],
        boardStatuses: ["Backlog", "Ready for development"],
        requireAllBoardItems: true,
        assignment: "owner",
        classification: { autonomous: ["bug"], ownerApproval: ["feature", "ambiguous"] },
      },
    },
    providerRules: { vendors: {} },
    recipes: recipes,
    sources: [],
  };
  policy.digest = policyModule.policyDigest(policy);
  return { ok: true, policy: policy };
}

function candidateEligibility(itemKey, assignedToOwner, recipeAllowsUnassigned) {
  return {
    ok: true,
    eligible: assignedToOwner === true || recipeAllowsUnassigned === true,
    reason: assignedToOwner === true ? "assigned_to_owner" :
      recipeAllowsUnassigned === true ? "recipe_allows_unassigned" : "not_assigned_to_owner",
  };
}

var WEBAPP_ASSIGNED = {
  id: "assigned-to-me",
  source: { provider: "github", kind: "issue", repo: "trialview/v2", ghAccount: "bojantv", includeProjectItems: true },
  filter: { state: "open", assigned: "me", type: "bug", skipProjectStatuses: ["In progress", "Done"] },
};

function graphQlPage(items, pageInfo) {
  var nodes = (items || []).map(function (item) {
    return {
      id: item.id,
      project: { id: item.projectId || "PVT_project_webapp" },
      fieldValueByName: item.status === null ? null : {
        name: item.status,
        optionId: item.optionId || "PVTSSO_" + item.id,
        field: { id: item.statusFieldId || "PVTSSF_status", name: "Status" },
      },
    };
  });
  return JSON.stringify({ data: { repository: { issue: { projectItems: {
    nodes: nodes,
    pageInfo: Object.assign({ hasNextPage: false, endCursor: null }, pageInfo || {}),
  } } } } });
}

function graphQlNumber(args) {
  for (var i = 0; i < args.length; i++) {
    if (String(args[i]).indexOf("number=") === 0) return Number(String(args[i]).slice(7));
  }
  return 0;
}

test("authoritative board query uses real GraphQL line breaks", function () {
  var args = boardEvidence.graphQlArgs("trialview/v2", 2800, "");
  var query = "";
  for (var i = 0; i < args.length; i++) {
    if (String(args[i]).indexOf("query=") === 0) query = String(args[i]).slice(6);
  }
  assert.ok(query.indexOf("\n") !== -1, "query preserves GraphQL line breaks");
  assert.strictEqual(query.indexOf("\\n"), -1, "query never sends literal slash-n tokens");
});
// The misplaced Clay copy: same repo, no pinned account, no board exclusions.
var CLAY_STALE_COPY = {
  id: "assigned-to-me",
  source: { provider: "github", kind: "issue", repo: "trialview/v2" },
  filter: { state: "open", assigned: "me", type: "bug" },
};

function webappEntry(configs) {
  return {
    project: "webapp", projectRef: WEBAPP_REF,
    originRepo: "https://bojantv@github.com/trialview/v2.git", configs: configs,
    automationPolicy: policyFor(WEBAPP_REF, configs), candidateEligibility: candidateEligibility,
  };
}
function clayEntry(configs) {
  return {
    project: "clay", projectRef: CLAY_REF,
    originRepo: "https://bojanx100@github.com/bojanx100/clay.git", configs: configs,
    automationPolicy: policyFor(CLAY_REF, configs), candidateEligibility: candidateEligibility,
  };
}

function qualifiedWebappSource() {
  var resolved = backlog.resolveGithubSources([webappEntry([WEBAPP_ASSIGNED])]);
  assert.deepStrictEqual(resolved.conflicts, []);
  return resolved.sources[0];
}

function configuredWebappSource() {
  var source = qualifiedWebappSource();
  source.policy.qualification = {
    version: 2,
    normalIssueIntake: {
      issueStates: ["open"],
      boardStatuses: ["Backlog", "Ready for development"],
      requireAllBoardItems: true,
      assignment: "owner",
      classification: { autonomous: ["bug"], ownerApproval: ["feature", "ambiguous"] },
      configuredBoard: { projectId: "PVT_unified", statusFieldId: "PVTSSF_unified_status" },
    },
  };
  source.policy.digest = policyModule.policyDigest(source.policy);
  source.policyDigest = source.policy.digest;
  return source;
}

function qualifiedIssue(number) {
  return {
    number: number,
    title: "Qualified issue " + number,
    state: "OPEN",
    labels: [{ name: "bug" }],
    assignees: [{ login: "bojantv" }],
    // This is the incomplete shape returned by `gh issue list --json
    // projectItems`: a status value but no stable ProjectV2 item node ID.
    projectItems: [{ status: { name: "Backlog" } }],
  };
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
    {
      project: "webapp", projectRef: WEBAPP_REF,
      originRepo: "https://github.com./trialview/v2.git", configs: [WEBAPP_ASSIGNED],
      automationPolicy: policyFor(WEBAPP_REF, [WEBAPP_ASSIGNED]), candidateEligibility: candidateEligibility,
    },
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
    {
      project: "webapp", projectRef: WEBAPP_REF,
      originRepo: "git@github.com:trialview/v2.git", configs: [WEBAPP_ASSIGNED],
      automationPolicy: policyFor(WEBAPP_REF, [WEBAPP_ASSIGNED]), candidateEligibility: candidateEligibility,
    },
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
  var issue2507 = [{ number: 2507, title: "Editor crash on paste", body: "", labels: [], assignees: [{ login: "bojantv" }], projectItems: [{ id: "PVT_item_2507", status: { name: "Backlog" } }], state: "OPEN", updatedAt: "2026-08-05T10:00:00Z", url: "https://x/2507" }];
  var fakeExec = function (cmd, args, cb) {
    if (args[0] === "api" && args[1] === "user") return cb(null, JSON.stringify({ login: "bojantv" }));
    if (args[0] === "api" && args[1] === "graphql") {
      return cb(null, graphQlPage([{ id: "PVT_item_2507", status: "Backlog" }]));
    }
    cb(null, JSON.stringify(issue2507));
  };
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

test("missing, stale, mismatched, or unresolvable policy evidence fails closed", function () {
  var missing = {
    project: "webapp", projectRef: WEBAPP_REF, originRepo: "trialview/v2",
    configs: [WEBAPP_ASSIGNED], candidateEligibility: candidateEligibility,
  };
  assert.strictEqual(backlog.resolveGithubSources([missing]).conflicts[0].reason, "policy_missing");

  var stalePolicy = policyFor(WEBAPP_REF, [WEBAPP_ASSIGNED]);
  stalePolicy.policy.digest = "stale";
  var stale = Object.assign({}, missing, { automationPolicy: stalePolicy });
  assert.strictEqual(backlog.resolveGithubSources([stale]).conflicts[0].reason, "policy_stale");

  var mismatchedPolicy = policyFor(WEBAPP_REF, [WEBAPP_ASSIGNED]);
  mismatchedPolicy.policy.recipes[0].digest = "other-recipe";
  mismatchedPolicy.policy.digest = policyModule.policyDigest(mismatchedPolicy.policy);
  var mismatched = Object.assign({}, missing, { automationPolicy: mismatchedPolicy });
  assert.strictEqual(backlog.resolveGithubSources([mismatched]).conflicts[0].reason, "policy_recipe_mismatch");

  var noCandidateEligibility = Object.assign({}, missing, {
    automationPolicy: policyFor(WEBAPP_REF, [WEBAPP_ASSIGNED]),
    candidateEligibility: null,
  });
  assert.strictEqual(backlog.resolveGithubSources([noCandidateEligibility]).conflicts[0].reason,
    "candidate_eligibility_missing");
});

test("an incomplete gh issue-list projectItems payload cannot mint a qualification receipt", function (t, done) {
  var source = qualifiedWebappSource();
  var raw = qualifiedIssue(2871);
  var graphCalls = 0;
  var fakeExec = function (cmd, args, cb) {
    if (args[0] === "api" && args[1] === "user") return cb(null, JSON.stringify({ login: "bojantv" }));
    if (args[0] === "api" && args[1] === "graphql") {
      graphCalls++;
      return cb(new Error("temporary GitHub read failure"), "");
    }
    cb(null, JSON.stringify([raw]));
  };
  backlog.collectGithubIssues(fakeExec, source, "webapp", function (err, items, metadata) {
    assert.strictEqual(err, null);
    assert.strictEqual(graphCalls, 1, "qualification must attempt the authoritative API");
    assert.deepStrictEqual(items, []);
    assert.deepStrictEqual(metadata.exclusions, [{
      number: 2871,
      reason: "qualification_board_evidence_unavailable",
    }]);
    done();
  });
});

test("authoritative GraphQL board evidence pages and binds every exact item ID and Status", function (t, done) {
  var source = qualifiedWebappSource();
  var raw = qualifiedIssue(2872);
  var graphCalls = [];
  var fakeExec = function (cmd, args, cb) {
    if (args[0] === "api" && args[1] === "user") return cb(null, JSON.stringify({ login: "bojantv" }));
    if (args[0] === "api" && args[1] === "graphql") {
      graphCalls.push(args.slice());
      if (graphCalls.length === 1) {
        return cb(null, graphQlPage([{ id: "PVT_item_backlog_2872", status: "Backlog" }], {
          hasNextPage: true, endCursor: "cursor-2872",
        }));
      }
      return cb(null, graphQlPage([{ id: "PVT_item_ready_2872", status: "Ready for development" }]));
    }
    cb(null, JSON.stringify([raw]));
  };
  backlog.collectGithubIssues(fakeExec, source, "webapp", function (err, items) {
    assert.strictEqual(err, null);
    assert.strictEqual(graphCalls.length, 2, "the next GraphQL page is fetched exactly once");
    assert.match(graphCalls[0].join(" "), /projectItems\(first: 100/);
    assert.match(graphCalls[0].join(" "), /fieldValueByName\(name: "Status"\)/);
    assert.match(graphCalls[0].join(" "), /\bid\b/);
    assert.ok(graphCalls[1].indexOf("after=cursor-2872") !== -1, "cursor is explicit and bounded");
    assert.strictEqual(items.length, 1);
    assert.deepStrictEqual(items[0].automationQualification.item.boardItems, [
      { id: "PVT_item_backlog_2872", status: "backlog" },
      { id: "PVT_item_ready_2872", status: "ready for development" },
    ]);
    done();
  });
});

test("configured Unified Board accepts its valid pages while an unrelated board has null Status", function (t, done) {
  var source = configuredWebappSource();
  var raw = qualifiedIssue(2881);
  var graphCalls = 0;
  var fakeExec = function (cmd, args, cb) {
    if (args[0] === "api" && args[1] === "user") return cb(null, JSON.stringify({ login: "bojantv" }));
    if (args[0] !== "api" || args[1] !== "graphql") return cb(null, JSON.stringify([raw]));
    graphCalls++;
    if (graphCalls === 1) {
      return cb(null, graphQlPage([
        { id: "PVTI_unified_backlog", projectId: "PVT_unified", status: "Backlog",
          statusFieldId: "PVTSSF_unified_status" },
        { id: "PVTI_planning_null", projectId: "PVT_planning", status: null },
      ], { hasNextPage: true, endCursor: "cursor-unified" }));
    }
    return cb(null, graphQlPage([
      { id: "PVTI_unified_ready", projectId: "PVT_unified", status: "Ready for development",
        statusFieldId: "PVTSSF_unified_status" },
      { id: "PVTI_planning_null_again", projectId: "PVT_planning", status: null },
    ]));
  };
  backlog.collectGithubIssues(fakeExec, source, "webapp", function (err, items, metadata) {
    assert.strictEqual(err, null);
    assert.strictEqual(graphCalls, 2, "configured-board collection traverses every page");
    assert.deepStrictEqual(metadata.exclusions, []);
    assert.strictEqual(items.length, 1);
    assert.deepStrictEqual(items[0].automationQualification.item.boardItems, [
      { id: "PVTI_unified_backlog", projectId: "PVT_unified", status: "backlog",
        statusFieldId: "PVTSSF_unified_status" },
      { id: "PVTI_unified_ready", projectId: "PVT_unified", status: "ready for development",
        statusFieldId: "PVTSSF_unified_status" },
    ]);
    done();
  });
});

test("authoritative status-policy mismatch is reported separately from missing board evidence", function (t, done) {
  var source = qualifiedWebappSource();
  var raw = qualifiedIssue(2873);
  var fakeExec = function (cmd, args, cb) {
    if (args[0] === "api" && args[1] === "user") return cb(null, JSON.stringify({ login: "bojantv" }));
    if (args[0] === "api" && args[1] === "graphql") {
      return cb(null, graphQlPage([{ id: "PVT_item_2873", status: "Ready for production" }]));
    }
    cb(null, JSON.stringify([raw]));
  };
  backlog.collectGithubIssues(fakeExec, source, "webapp", function (err, items, metadata) {
    assert.strictEqual(err, null);
    assert.deepStrictEqual(items, []);
    assert.deepStrictEqual(metadata.exclusions, [{
      number: 2873,
      reason: "qualification_board_status_ineligible",
    }]);
    done();
  });
});

test("board evidence rejects partial, ambiguous, multi-board, and unbounded GraphQL pages", function () {
  var partial;
  boardEvidence.collectBoardItemEvidence(function (cmd, args, cb) {
    cb(null, JSON.stringify({ data: { repository: { issue: { projectItems: {
      nodes: [], pageInfo: { hasNextPage: true, endCursor: null },
    } } } } }));
  }, "trialview/v2", 2874, function (result) { partial = result; });
  assert.deepStrictEqual(partial, { ok: false, reason: "qualification_board_evidence_partial" });

  var ambiguous;
  boardEvidence.collectBoardItemEvidence(function (cmd, args, cb) {
    cb(null, graphQlPage([
      { id: "PVT_item_duplicate", status: "Backlog" },
      { id: "PVT_item_duplicate", status: "Ready for development" },
    ]));
  }, "trialview/v2", 2875, function (result) { ambiguous = result; });
  assert.deepStrictEqual(ambiguous, { ok: false, reason: "qualification_board_evidence_ambiguous" });

  var multiBoard;
  boardEvidence.collectBoardItemEvidence(function (cmd, args, cb) {
    cb(null, graphQlPage([
      { id: "PVT_item_board_one", projectId: "PVT_project_one", status: "Backlog" },
      { id: "PVT_item_board_two", projectId: "PVT_project_two", status: "Backlog" },
    ]));
  }, "trialview/v2", 2876, function (result) { multiBoard = result; });
  assert.deepStrictEqual(multiBoard, { ok: false, reason: "qualification_board_evidence_multi_board" });

  var calls = 0;
  var paged;
  boardEvidence.collectBoardItemEvidence(function (cmd, args, cb) {
    calls++;
    cb(null, graphQlPage([{ id: "PVT_item_page_" + calls, status: "Backlog" }], {
      hasNextPage: true, endCursor: "cursor-" + calls,
    }));
  }, "trialview/v2", 2877, function (result) { paged = result; });
  assert.strictEqual(calls, boardEvidence.MAX_PROJECT_ITEM_PAGES);
  assert.deepStrictEqual(paged, {
    ok: false,
    reason: "qualification_board_evidence_pagination_exhausted",
  });
});

test("configured board evidence fails closed for missing, wrong, or conflicting configured entries", function () {
  var configured = { projectId: "PVT_unified", statusFieldId: "PVTSSF_unified_status" };
  var missing;
  boardEvidence.collectBoardItemEvidence(function (cmd, args, cb) {
    cb(null, graphQlPage([{ id: "PVTI_planning", projectId: "PVT_planning", status: null }]));
  }, "trialview/v2", 2882, configured, function (result) { missing = result; });
  assert.deepStrictEqual(missing, {
    ok: false, reason: "qualification_board_evidence_configured_board_missing",
  });

  var wrongField;
  boardEvidence.collectBoardItemEvidence(function (cmd, args, cb) {
    cb(null, graphQlPage([{ id: "PVTI_unified", projectId: "PVT_unified", status: "Backlog",
      statusFieldId: "PVTSSF_wrong" }]));
  }, "trialview/v2", 2883, configured, function (result) { wrongField = result; });
  assert.deepStrictEqual(wrongField, {
    ok: false, reason: "qualification_board_evidence_configured_field_invalid",
  });

  var conflicting;
  boardEvidence.collectBoardItemEvidence(function (cmd, args, cb) {
    cb(null, graphQlPage([
      { id: "PVTI_duplicate", projectId: "PVT_unified", status: "Backlog",
        statusFieldId: "PVTSSF_unified_status" },
      { id: "PVTI_duplicate", projectId: "PVT_unified", status: "Ready for development",
        statusFieldId: "PVTSSF_unified_status" },
    ]));
  }, "trialview/v2", 2884, configured, function (result) { conflicting = result; });
  assert.deepStrictEqual(conflicting, {
    ok: false, reason: "qualification_board_evidence_configured_field_invalid",
  });
});

test("collector caps GraphQL evidence reads and excludes unsampled candidates", function (t, done) {
  var source = qualifiedWebappSource();
  var raw = [];
  for (var i = 0; i <= githubBacklog.MAX_QUALIFICATION_EVIDENCE_ISSUES; i++) raw.push(qualifiedIssue(2900 + i));
  var graphCalls = 0;
  var fakeExec = function (cmd, args, cb) {
    if (args[0] === "api" && args[1] === "user") return cb(null, JSON.stringify({ login: "bojantv" }));
    if (args[0] === "api" && args[1] === "graphql") {
      graphCalls++;
      var number = graphQlNumber(args);
      return cb(null, graphQlPage([{ id: "PVT_item_" + number, status: "Backlog" }]));
    }
    cb(null, JSON.stringify(raw));
  };
  backlog.collectGithubIssues(fakeExec, source, "webapp", function (err, items, metadata) {
    assert.strictEqual(err, null);
    assert.strictEqual(graphCalls, githubBacklog.MAX_QUALIFICATION_EVIDENCE_ISSUES);
    assert.strictEqual(items.length, githubBacklog.MAX_QUALIFICATION_EVIDENCE_ISSUES);
    assert.deepStrictEqual(metadata.exclusions, [{
      number: 2900 + githubBacklog.MAX_QUALIFICATION_EVIDENCE_ISSUES,
      reason: "qualification_board_evidence_rate_limited",
    }]);
    done();
  });
});

test("Lead excludes policy-board and completed candidates before deterministic scoring", function (t, done) {
  var recipe = Object.assign({}, WEBAPP_ASSIGNED, {
    filter: Object.assign({}, WEBAPP_ASSIGNED.filter, {
      skipProjectStatuses: ["Dev Complete", "Done"],
    }),
  });
  var policy = policyFor(WEBAPP_REF, [recipe]);
  // This is the bounded migration path for Webapp's Ready for production rule:
  // it is machine-readable policy, never a Lead parse of TRIAGE.local.md.
  policy.policy.boardExclusions.push("ready for production");
  policy.policy.boardExclusions.sort();
  policy.policy.digest = policyModule.policyDigest(policy.policy);
  var resolved = backlog.resolveGithubSources([{
    project: "webapp", projectRef: WEBAPP_REF, originRepo: "trialview/v2", configs: [recipe],
    automationPolicy: policy,
    candidateEligibility: function (itemKey, assignedToOwner) {
      if (itemKey === "trialview/v2#1262") {
        return { ok: true, eligible: false, reason: "already_completed_or_in_flight" };
      }
      return {
        ok: true, eligible: assignedToOwner === true,
        reason: assignedToOwner === true ? "assigned_to_owner" : "not_assigned_to_owner",
      };
    },
  }]);
  assert.deepStrictEqual(resolved.conflicts, []);

  var fakeExec = function (cmd, args, cb) {
    if (args[0] === "api" && args[1] === "user") return cb(null, JSON.stringify({ login: "bojantv" }));
    if (args[0] === "api" && args[1] === "graphql") {
      var statuses = {
        1259: "Ready for production",
        1260: "Dev Complete",
        1261: "Done",
        1262: "Backlog",
        1263: "Backlog",
      };
      var number = graphQlNumber(args);
      return cb(null, graphQlPage([{ id: "PVT_item_" + number, status: statuses[number] }]));
    }
    cb(null, JSON.stringify([
      { number: 1259, title: "Urgent but ready for production", state: "OPEN", labels: [{ name: "P0" }], assignees: [{ login: "bojantv" }], projectItems: [{ id: "PVT_item_1259", status: { name: "Ready for production" } }] },
      { number: 1260, title: "Dev complete", state: "OPEN", labels: [{ name: "P0" }], assignees: [{ login: "bojantv" }], projectItems: [{ id: "PVT_item_1260", status: { name: "Dev Complete" } }] },
      { number: 1261, title: "Done", state: "OPEN", labels: [{ name: "P0" }], assignees: [{ login: "bojantv" }], projectItems: [{ id: "PVT_item_1261", status: { name: "Done" } }] },
      { number: 1262, title: "Already completed", state: "OPEN", labels: [{ name: "P0" }], assignees: [{ login: "bojantv" }], projectItems: [{ id: "PVT_item_1262", status: { name: "Backlog" } }] },
      { number: 1263, title: "Next eligible candidate", state: "OPEN", labels: [{ name: "P2" }], assignees: [{ login: "bojantv" }], projectItems: [{ id: "PVT_item_1263", status: { name: "Backlog" } }] },
    ]));
  };
  backlog.collectGithubIssues(fakeExec, resolved.sources[0], "webapp", function (err, items, metadata) {
    assert.strictEqual(err, null);
    assert.deepStrictEqual(items.map(function (item) { return item.number; }), [1263]);
    assert.deepStrictEqual(metadata.exclusions.map(function (entry) { return entry.reason; }).sort(), [
      "already_completed_or_in_flight", "launcher_recipe_ineligible", "launcher_recipe_ineligible", "policy_board_excluded",
    ].sort());
    var portfolio = backlog.buildPortfolio([{ project: "webapp", items: items }], { now: NOW });
    assert.strictEqual(portfolio.items.length, 1);
    assert.strictEqual(portfolio.summary.top.id, "webapp#1263");
    done();
  });
});

test("an attested ineligible candidate is never classified or scored", function () {
  var blocked = backlog.normalizeGithubIssue(GH_FIXTURE[0], "webapp");
  blocked.automationEligibility = { eligible: false, reason: "already_completed_or_in_flight" };
  var portfolio = backlog.buildPortfolio([{ project: "webapp", items: [blocked] }], { now: NOW });
  assert.deepStrictEqual(portfolio.items, []);
  assert.strictEqual(portfolio.summary.ineligible, 1);
});

test("live Webapp #2517 completed binding excludes the issue before scoring", function (t, done) {
  var noIssueEntry = {
    hasEntry: function () { return false; },
    shouldRelaunch: function () { return false; },
  };
  var bindings = [{
    portfolioTaskId: "portfolio-webapp-2517",
    bindingRevision: 1,
    idempotencyKey: "staff-portfolio-webapp-2517-r1",
    targetProject: WEBAPP_REF,
    mode: "project_coordinator",
    status: "completed",
    coordinator: { projectId: WEBAPP_REF.projectId, sessionStorageId: "webapp-2517-r1" },
    createdAt: 1787000000001,
    updatedAt: 1787000001001,
  }];
  var resolved = backlog.resolveGithubSources([{
    project: "webapp",
    projectRef: WEBAPP_REF,
    originRepo: "https://bojantv@github.com/trialview/v2.git",
    configs: [WEBAPP_ASSIGNED],
    automationPolicy: policyFor(WEBAPP_REF, [WEBAPP_ASSIGNED]),
    candidateEligibility: function (itemKey) {
      return automationCandidates.completionEligibility(noIssueEntry, {
        source: "github",
        project: "webapp",
        projectRef: WEBAPP_REF,
        itemKey: itemKey,
      }, bindings);
    },
  }]);
  assert.deepStrictEqual(resolved.conflicts, []);

  var fakeExec = function (cmd, args, cb) {
    if (args[0] === "api" && args[1] === "user") return cb(null, JSON.stringify({ login: "bojantv" }));
    if (args[0] === "api" && args[1] === "graphql") {
      return cb(null, graphQlPage([{ id: "PVT_item_2517", status: "Backlog" }]));
    }
    cb(null, JSON.stringify([{
      number: 2517,
      title: "Live completed issue resurfaced",
      state: "OPEN",
      labels: [{ name: "P0" }],
      assignees: [{ login: "bojantv" }],
      projectItems: [{ id: "PVT_item_2517", status: { name: "Backlog" } }],
    }]));
  };
  backlog.collectGithubIssues(fakeExec, resolved.sources[0], "webapp", function (err, items, metadata) {
    assert.strictEqual(err, null);
    assert.deepStrictEqual(items, []);
    assert.deepStrictEqual(metadata.exclusions, [{
      number: 2517,
      reason: "already_completed_or_in_flight",
    }]);
    var portfolio = backlog.buildPortfolio([{ project: "webapp", items: items }], { now: NOW });
    assert.strictEqual(portfolio.summary.total, 0);
    assert.strictEqual(portfolio.summary.top, null);
    done();
  });
});
