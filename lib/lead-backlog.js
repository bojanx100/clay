// Lead backlog aggregation (CTO orchestrator brick 3 — roadmap §3.3).
//
// Builds the Lead's portfolio: one normalized, classified, priority-ordered
// list of work items across projects. Sources:
//   - GitHub issues, discovered through the projects' task-launcher configs
//     (.clay/tasks/*.json with source.provider === "github") or passed
//     explicitly.
//   - Any pre-fetched item collections the caller supplies (Clay-internal
//     backlogs, doc carry-over lists, chat directives turned into items).
//
// Purity contract (same as lead-routing): normalization, scoring and
// portfolio assembly are pure and fixture-testable. The only I/O lives in
// collectGithubIssues, which takes an INJECTED exec function — tests hand it
// a fake, the Lead hands it child_process.execFile.
//
// Deliberately unwired: nothing requires this module yet (§1.1).

var routing = require("./lead-routing");

// --- Normalization -----------------------------------------------------------

// gh issue list --json number,title,body,labels,state,updatedAt,url
function normalizeGithubIssue(raw, project) {
  if (!raw || typeof raw.number !== "number") return null;
  var labels = [];
  var rawLabels = raw.labels || [];
  for (var i = 0; i < rawLabels.length; i++) {
    var name = typeof rawLabels[i] === "string" ? rawLabels[i] : (rawLabels[i] && rawLabels[i].name);
    if (name) labels.push(String(name).toLowerCase());
  }
  return {
    source: "github",
    project: project || "",
    id: project + "#" + raw.number,
    number: raw.number,
    title: raw.title || "",
    body: raw.body || "",
    labels: labels,
    state: (raw.state || "open").toLowerCase(),
    updatedAt: raw.updatedAt ? Date.parse(raw.updatedAt) || 0 : 0,
    url: raw.url || null,
  };
}

// A caller-supplied plain item (chat directive, doc backlog entry, ...).
function normalizeLooseItem(raw, project) {
  if (!raw || !raw.title) return null;
  return {
    source: raw.source || "clay",
    project: project || raw.project || "",
    id: raw.id || ((project || "clay") + ":" + raw.title.slice(0, 40)),
    number: raw.number || null,
    title: raw.title,
    body: raw.body || "",
    labels: (raw.labels || []).map(function (l) { return String(l).toLowerCase(); }),
    state: (raw.state || "open").toLowerCase(),
    updatedAt: raw.updatedAt || 0,
    url: raw.url || null,
  };
}

// --- Task-launcher source discovery ------------------------------------------

// Extract GitHub backlog sources from .clay/tasks/*.json launcher configs.
// Returns [{ repo, filters: { state, assigned, type } }].
function githubSourcesFromTaskConfigs(configs) {
  var out = [];
  var seen = {};
  for (var i = 0; i < (configs || []).length; i++) {
    var cfg = configs[i];
    var src = cfg && cfg.source;
    if (!src || src.provider !== "github" || !src.repo) continue;
    if (seen[src.repo]) continue;
    seen[src.repo] = true;
    var filter = cfg.filter || {};
    out.push({
      repo: src.repo,
      filters: {
        state: filter.state || "open",
        assigned: filter.assigned || null,
        type: filter.type || null,
      },
    });
  }
  return out;
}

// --- GitHub collection (injected exec) ----------------------------------------

var GH_ISSUE_FIELDS = "number,title,body,labels,state,updatedAt,url";

function ghIssueArgs(sourceSpec) {
  var args = ["issue", "list", "--repo", sourceSpec.repo, "--json", GH_ISSUE_FIELDS, "--limit", "100"];
  var f = sourceSpec.filters || {};
  if (f.state) args.push("--state", f.state);
  if (f.assigned === "me" || f.assigned === "@me") args.push("--assignee", "@me");
  else if (f.assigned) args.push("--assignee", f.assigned);
  if (f.type) args.push("--label", f.type);
  return args;
}

// collectGithubIssues(execFn, sourceSpec, project, cb)
//   execFn(cmd, args, cb(err, stdout)) — injected; production passes a
//   child_process.execFile wrapper, tests pass a fake.
//   Auth note (observed 2026-08-02): gh multi-account means a repo may be
//   invisible to the globally-active account (trialview/v2 vs bojanx100).
//   The Lead must wrap execFn with per-repo credentials (GH_TOKEN from
//   `gh auth token --user <owner-account>`) rather than switching the
//   global gh account, which other sessions rely on.
//   cb(err, items[]) — items already normalized; a repo with issues disabled
//   or any gh failure yields an empty list plus the error for the caller's
//   log (the Lead must degrade per-source, never die on one bad repo).
function collectGithubIssues(execFn, sourceSpec, project, cb) {
  execFn("gh", ghIssueArgs(sourceSpec), function (err, stdout) {
    if (err) return cb(err, []);
    var parsed;
    try { parsed = JSON.parse(stdout || "[]"); } catch (e) { return cb(e, []); }
    var items = [];
    for (var i = 0; i < parsed.length; i++) {
      var item = normalizeGithubIssue(parsed[i], project);
      if (item) items.push(item);
    }
    cb(null, items);
  });
}

// --- Priority scoring ---------------------------------------------------------

var LABEL_PRIORITY = {
  "p0": 400, "urgent": 400, "critical": 400,
  "p1": 200, "priority:high": 200, "high priority": 200,
  "p2": 50,
};
var RISK_WEIGHT = { high: 150, medium: 60, low: 0 };
var CLASS_WEIGHT = { security: 120, debugging: 80, design: 40, implementation: 20, review: 20, research: 10, mechanical: 0 };

// Deterministic score; higher = work on it sooner. `now` is injected so
// scoring is replayable (staleness: old open items slowly rise, capped).
function scoreItem(item, classification, now) {
  var score = 0;
  for (var i = 0; i < item.labels.length; i++) {
    score += LABEL_PRIORITY[item.labels[i]] || 0;
  }
  score += RISK_WEIGHT[classification.risk] || 0;
  score += CLASS_WEIGHT[classification.taskClass] || 0;
  if (item.updatedAt && now > item.updatedAt) {
    var staleDays = (now - item.updatedAt) / 86400000;
    score += Math.min(50, Math.floor(staleDays * 2));
  }
  return score;
}

// --- Portfolio assembly --------------------------------------------------------

// buildPortfolio(collections, opts) -> portfolio
//   collections: [{ project, items: [normalized or loose raw items] }]
//   opts.now: injected clock (ms) — required for replayable scoring
//   opts.health: provider health snapshot forwarded to routing
// Returns { items, byProject, summary } where each item carries
// { ...normalized, classification, route, score } sorted by score desc.
function buildPortfolio(collections, opts) {
  var now = (opts && opts.now) || 0;
  var health = (opts && opts.health) || {};
  var items = [];
  var byProject = {};

  for (var ci = 0; ci < (collections || []).length; ci++) {
    var col = collections[ci];
    var project = col.project || "";
    for (var ii = 0; ii < (col.items || []).length; ii++) {
      var raw = col.items[ii];
      var item = raw && raw.source === "github" && raw.id
        ? raw
        : normalizeLooseItem(raw, project);
      if (!item || item.state !== "open") continue;
      var classification = routing.classifyWorkItem(item);
      var route = routing.routeWorkItem(classification, { health: health });
      item.classification = classification;
      item.route = route;
      item.score = scoreItem(item, classification, now);
      items.push(item);
      if (!byProject[item.project]) byProject[item.project] = [];
      byProject[item.project].push(item);
    }
  }

  items.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.id) < String(b.id) ? -1 : 1;
  });

  var unroutable = 0;
  for (var ui = 0; ui < items.length; ui++) {
    if (!items[ui].route) unroutable++;
  }

  return {
    items: items,
    byProject: byProject,
    summary: {
      total: items.length,
      projects: Object.keys(byProject).length,
      unroutable: unroutable,
      top: items.length ? { id: items[0].id, title: items[0].title, score: items[0].score } : null,
    },
  };
}

module.exports = {
  normalizeGithubIssue: normalizeGithubIssue,
  normalizeLooseItem: normalizeLooseItem,
  githubSourcesFromTaskConfigs: githubSourcesFromTaskConfigs,
  ghIssueArgs: ghIssueArgs,
  collectGithubIssues: collectGithubIssues,
  scoreItem: scoreItem,
  buildPortfolio: buildPortfolio,
};
