// Lead backlog aggregation (CTO orchestrator brick 3 — roadmap §3.3).
//
// Builds the Lead's portfolio: one normalized, classified, priority-ordered
// list of work items across projects. Sources:
//   - GitHub issues, discovered through the projects' task-launcher configs
//     (.clay/tasks/*.json with source.provider === "github") or passed
//     explicitly. A repository is owned by exactly one project — see
//     resolveGithubSources, which validates ownership against git origin and
//     fails closed rather than guessing.
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
var projectIdentity = require("./project-identity");

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
// Returns [{ repo, ghAccount, filters }] with launcher-parity filters.
function filtersFromRecipe(filter) {
  return {
    state: filter.state || "open",
    assigned: filter.assigned || null,
    type: filter.type || null,
    excludeLabels: (filter.labels && filter.labels.exclude) || [],
    titleExcludePrefixes: filter.titleExcludePrefixes || [],
    skipProjectStatuses: filter.skipProjectStatuses || [],
  };
}

// --- Repository-source ownership -----------------------------------------------
//
// One repository must belong to exactly ONE project. Two projects can easily
// declare the same repo — a launcher recipe is just a JSON file, and copying a
// project directory copies its recipes with it.
//
// Boss incident 2026-08-06: the Clay project carried stale copies of the Webapp
// launchers (both pointing at trialview/v2, while Clay's own origin is
// bojanx100/clay). The old extractor deduped by `seen[src.repo]` — FIRST FILE
// WINS — so the surviving source depended on directory scan order, and the same
// live issue #2507 entered the portfolio twice: once as clay#2507 and once as
// webapp#2507. Two portfolio items, two candidate staffings, two possible
// external actions, one real issue.
//
// Ownership is therefore decided by EVIDENCE, never by scan order: the owning
// project is the one whose git origin IS the repository. Every other outcome —
// no origin match, several origin matches, an unusable ProjectRef, or one
// project declaring the same repo through conflicting recipes — FAILS CLOSED.
// A failed-closed repo yields no source, so nothing is fetched, nothing is
// scored, nothing is staffed and nothing external happens; the reason is
// returned as an observable conflict for the tick log.
//
// There is deliberately no fallback. "Pick the first one" is exactly the bug.

// Reduce any GitHub repo reference (bare slug, https URL, ssh URL, scp-style
// remote, optional port, trailing .git) to a comparable lowercase "owner/name"
// slug. "" means unusable, and unusable ALWAYS fails closed — an origin we
// cannot parse with certainty must never be accepted as ownership evidence.
//
// The host is matched by PARSING, never by substring: pattern matching on
// "github.com" lets both "evilgithub.com/trialview/v2" and
// "https://evil.example/github.com/trialview/v2" compare EQUAL to the real
// repository, which is forged ownership — a foreign remote would be handed the
// genuine repo's issues. The host must parse out as exactly github.com.
var GITHUB_HOSTS = { "github.com": true, "www.github.com": true };
var BARE_SLUG_RE = /^([\w.-]+)\/([\w.-]+)$/;
var SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
// scp-style: [user@]host:path — the only remote form that is not a URL.
var SCP_RE = /^(?:[^/@\s]+@)?([^/:\s]+):(.+)$/;
// host-qualified path without a scheme, e.g. "github.com/owner/repo".
var HOST_PATH_RE = /^([^/:\s]+)\/(.+)$/;

// A single trailing dot is the fully-qualified form of the same DNS name, so
// "github.com." IS github.com. Stripping it cannot admit a foreign host —
// "evil.example." still fails the exact-name check.
function isGithubHost(host) {
  return GITHUB_HOSTS[String(host || "").toLowerCase().replace(/\.$/, "")] === true;
}

// A GitHub repo path is exactly two segments; anything deeper or shallower is
// not a repository reference.
function slugFromPath(pathname) {
  var parts = String(pathname || "").replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) return "";
  var match = (parts[0] + "/" + parts[1]).match(BARE_SLUG_RE);
  return match ? (match[1] + "/" + match[2]).toLowerCase() : "";
}

function normalizeRepoSlug(value) {
  if (typeof value !== "string") return "";
  var trimmed = value.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!trimmed) return "";

  var bare = trimmed.match(BARE_SLUG_RE);
  if (bare) return (bare[1] + "/" + bare[2]).toLowerCase();

  // Real URL: let the URL parser decide the host, so userinfo ("user@"), an
  // explicit port (":22") and query/fragment noise cannot smuggle a host past
  // us. url.hostname excludes both userinfo and port by construction.
  if (SCHEME_RE.test(trimmed)) {
    var url;
    try { url = new URL(trimmed); } catch (e) { return ""; }
    return isGithubHost(url.hostname) ? slugFromPath(url.pathname) : "";
  }

  var scp = trimmed.match(SCP_RE);
  if (scp) return isGithubHost(scp[1]) ? slugFromPath(scp[2]) : "";

  var hostPath = trimmed.match(HOST_PATH_RE);
  if (hostPath) return isGithubHost(hostPath[1]) ? slugFromPath(hostPath[2]) : "";

  return "";
}

// Only issue-kind recipes describe the ISSUE backlog. PR-review recipes
// (kind "pr-reviews") declare the same repo but carry no issue filters, so
// letting them into this resolution is how an unfiltered source used to be
// able to displace the real one.
function isIssueRecipe(source) {
  var kind = source && source.kind;
  return !kind || kind === "issue" || kind === "issues";
}

// Stable signature for "these two recipes request the same issue feed".
// Byte-identical duplicates inside one project collapse; genuinely different
// filters for one repo are a conflict, not a coin flip.
function sourceSignature(candidate) {
  return JSON.stringify([candidate.ghAccount, candidate.filters]);
}

function conflict(repo, reason, candidates) {
  var listed = [];
  for (var i = 0; i < candidates.length; i++) {
    listed.push({
      project: candidates[i].project,
      projectId: candidates[i].projectRef ? candidates[i].projectRef.projectId : null,
      originRepo: candidates[i].originRepo || null,
      recipeId: candidates[i].recipeId,
    });
  }
  return { repo: repo, reason: reason, candidates: listed };
}

// One recipe -> one candidate, or null when the recipe does not describe a
// GitHub issue feed. `owner` carries the declaring project's resolved identity.
function candidateFromRecipe(cfg, owner) {
  var src = cfg && cfg.source;
  if (!src || src.provider !== "github" || !src.repo) return null;
  if (!isIssueRecipe(src)) return null;
  var repoSlug = normalizeRepoSlug(src.repo);
  if (!repoSlug) return null;
  return {
    repoSlug: repoSlug,
    repo: src.repo,
    project: owner.project,
    projectRef: owner.projectRef,
    originRepo: owner.originRepo,
    originSlug: owner.originSlug,
    recipeId: cfg.id || null,
    ghAccount: src.ghAccount || null,
    filters: filtersFromRecipe(cfg.filter || {}),
  };
}

// Flatten project entries into one candidate per github issue recipe, keeping
// each candidate bound to the project that declared it.
function candidatesFromProjectEntries(entries) {
  var candidates = [];
  for (var e = 0; e < (entries || []).length; e++) {
    var entry = entries[e] || {};
    var owner = {
      project: entry.project || null,
      projectRef: projectIdentity.normalizeProjectRef(entry.projectRef),
      originRepo: entry.originRepo || null,
      originSlug: normalizeRepoSlug(entry.originRepo),
    };
    var configs = entry.configs || [];
    for (var c = 0; c < configs.length; c++) {
      var candidate = candidateFromRecipe(configs[c], owner);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

// Resolve one repo's candidates to a single owning project, or to a conflict.
function resolveRepoOwner(repoSlug, candidates) {
  var owners = [];
  var ownerIds = {};
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i].originSlug !== repoSlug) continue;
    if (!candidates[i].projectRef) {
      return { conflict: conflict(repoSlug, "invalid_project_ref", candidates) };
    }
    owners.push(candidates[i]);
    ownerIds[candidates[i].projectRef.projectId] = true;
  }

  // Nobody's origin is this repo: the declaring project only borrowed it.
  if (!owners.length) return { conflict: conflict(repoSlug, "unowned_repository_source", candidates) };
  // More than one project claims the same origin — unresolvable without a human.
  if (Object.keys(ownerIds).length > 1) {
    return { conflict: conflict(repoSlug, "ambiguous_repository_owner", owners) };
  }

  // One owner, but it declares the repo through recipes that disagree.
  var signature = sourceSignature(owners[0]);
  for (var s = 1; s < owners.length; s++) {
    if (sourceSignature(owners[s]) !== signature) {
      return { conflict: conflict(repoSlug, "conflicting_repository_recipes", owners) };
    }
  }
  return { owner: owners[0] };
}

// resolveGithubSources(projectEntries) -> { sources, conflicts }
//   projectEntries: [{ project, projectRef, originRepo, configs }]
//     project    — display label used for portfolio item ids ("webapp#2507")
//     projectRef — { projectId } for the project that owns those configs
//     originRepo — that project's git origin (remote.origin.url or a slug)
//     configs    — the parsed .clay/tasks/*.json recipes read from it
//   sources: [{ repo, project, projectRef, ghAccount, filters }] — at most one
//     per repository, each carrying the validated ProjectRef of its sole owner.
//   conflicts: [{ repo, reason, candidates }] — repos that failed closed.
//   Both arrays are sorted by repo so a tick is byte-reproducible.
function resolveGithubSources(projectEntries) {
  var candidates = candidatesFromProjectEntries(projectEntries);
  var byRepo = {};
  var order = [];
  for (var i = 0; i < candidates.length; i++) {
    var slug = candidates[i].repoSlug;
    if (!byRepo[slug]) { byRepo[slug] = []; order.push(slug); }
    byRepo[slug].push(candidates[i]);
  }
  order.sort();

  var sources = [];
  var conflicts = [];
  for (var r = 0; r < order.length; r++) {
    var resolved = resolveRepoOwner(order[r], byRepo[order[r]]);
    if (resolved.conflict) { conflicts.push(resolved.conflict); continue; }
    var owner = resolved.owner;
    sources.push({
      // The CANONICAL slug, not the raw string the winning recipe happened to
      // spell. Two recipes may write the same repo as "trialview/v2" and
      // "https://github.com/trialview/v2.git"; emitting the raw form would make
      // the output depend on which one was read first, which is the same
      // scan-order dependence this module exists to remove.
      repo: owner.repoSlug,
      // The ONLY project this repo's items may be attributed to. Carried into
      // collectGithubIssues so an item can never be projected under a
      // non-owning project.
      project: owner.project,
      projectRef: owner.projectRef,
      // Carried through to the exec wrapper (lead-exec): repos invisible to
      // the globally active gh account need their pinned account's token.
      ghAccount: owner.ghAccount,
      filters: owner.filters,
    });
  }
  return { sources: sources, conflicts: conflicts };
}

// --- GitHub collection (injected exec) ----------------------------------------

var GH_ISSUE_FIELDS = "number,title,body,labels,state,updatedAt,url";

function splitList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(",").map(function (v) { return v.trim(); }).filter(function (v) { return !!v; });
}

function ghIssueFields(sourceSpec) {
  var filters = (sourceSpec && sourceSpec.filters) || {};
  var fields = GH_ISSUE_FIELDS;
  if (splitList(filters.skipProjectStatuses).length > 0) fields += ",projectItems";
  return fields;
}

function ghIssueArgs(sourceSpec) {
  var args = ["issue", "list", "--repo", sourceSpec.repo, "--json", ghIssueFields(sourceSpec), "--limit", "100"];
  var f = sourceSpec.filters || {};
  if (f.state) args.push("--state", f.state);
  if (f.assigned === "me" || f.assigned === "@me") args.push("--assignee", "@me");
  else if (f.assigned) args.push("--assignee", f.assigned);
  // "bug" mirrors the task launcher's semantics (project-task-sources.js):
  // bug = NOT labeled feature/legacy — a label few repos actually apply.
  // That exclusion happens post-fetch in typeFilterAccepts; only concrete
  // type values map to a label filter here.
  if (f.type && f.type !== "bug") args.push("--label", f.type);
  return args;
}

// Post-fetch filters mirroring the task launcher (project-task-sources.js):
// type "bug" excludes feature/legacy-labeled items; excludeLabels and
// titleExcludePrefixes drop items the launcher would never touch (e.g.
// backend-only or blocked work).
function typeAccepts(item, type) {
  if (type !== "bug") return true;
  var labels = item.labels || [];
  for (var i = 0; i < labels.length; i++) {
    var name = String(labels[i]).toLowerCase();
    if (name === "feature" || name === "legacy") return false;
  }
  return true;
}

function filterAccepts(item, filters) {
  var f = filters || {};
  if (f.type && !typeAccepts(item, f.type)) return false;
  var excl = f.excludeLabels || [];
  var labels = item.labels || [];
  for (var i = 0; i < excl.length; i++) {
    for (var j = 0; j < labels.length; j++) {
      if (String(labels[j]).toLowerCase() === String(excl[i]).toLowerCase()) return false;
    }
  }
  var prefixes = f.titleExcludePrefixes || [];
  for (var p = 0; p < prefixes.length; p++) {
    if (String(item.title || "").indexOf(prefixes[p]) === 0) return false;
  }
  return true;
}

function projectStatusAccepts(issue, filters) {
  var skipStatuses = splitList(filters && filters.skipProjectStatuses);
  if (!skipStatuses.length) return true;
  var projectItems = (issue && issue.projectItems) || [];
  for (var pi = 0; pi < projectItems.length; pi++) {
    var statusName = projectItems[pi] && projectItems[pi].status && projectItems[pi].status.name;
    if (!statusName) continue;
    for (var si = 0; si < skipStatuses.length; si++) {
      if (String(statusName).toLowerCase() === String(skipStatuses[si]).toLowerCase()) return false;
    }
  }
  return true;
}

// collectGithubIssues(execFn, sourceSpec, project, cb)
//   execFn(cmd, args, cb(err, stdout)) — injected; production passes a
//   child_process.execFile wrapper, tests pass a fake.
//   Auth note (observed 2026-08-02): gh multi-account means a repo may be
//   invisible to the globally-active account (trialview/v2 vs bojanx100).
//   The Lead must wrap execFn with per-repo credentials (GH_TOKEN from
//   `gh auth token --user <owner-account>`) rather than switching the
//   global gh account, which other sessions rely on. That wrapper lives in
//   lib/lead-exec.js (createGhExecFn) — kept in its own module so the
//   credentials/token-handling boundary is auditable; this collector stays
//   pure and simply calls whatever execFn it is handed.
//   cb(err, items[]) — items already normalized; a repo with issues disabled
//   or any gh failure yields an empty list plus the error for the caller's
//   log (the Lead must degrade per-source, never die on one bad repo).
//
//   `project` labels every item (id = "<project>#<number>"). When the spec came
//   from resolveGithubSources it already carries the owning project, and that
//   owner WINS: a caller cannot relabel trialview/v2 issues as "clay", because
//   a mismatch fails closed rather than emitting misattributed items. This is
//   the second half of the 2026-08-06 fix — resolveGithubSources stops the
//   duplicate source, this stops a duplicate label.
function collectGithubIssues(execFn, sourceSpec, project, cb) {
  var owner = sourceSpec && sourceSpec.project;
  if (owner && project && project !== owner) {
    return cb(new Error("repository " + (sourceSpec.repo || "?") + " is owned by project " +
      owner + "; refusing to project its items as " + project), []);
  }
  var label = owner || project;
  execFn("gh", ghIssueArgs(sourceSpec), function (err, stdout) {
    if (err) return cb(err, []);
    var parsed;
    try { parsed = JSON.parse(stdout || "[]"); } catch (e) { return cb(e, []); }
    var items = [];
    for (var i = 0; i < parsed.length; i++) {
      var item = normalizeGithubIssue(parsed[i], label);
      if (item && projectStatusAccepts(parsed[i], sourceSpec.filters) && filterAccepts(item, sourceSpec.filters)) items.push(item);
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
function collectPortfolioItems(collections, now, health, byProject, seenIds) {
  var items = [];
  for (var ci = 0; ci < (collections || []).length; ci++) {
    var col = collections[ci];
    var project = col.project || "";
    for (var ii = 0; ii < (col.items || []).length; ii++) {
      var raw = col.items[ii];
      var item = raw && raw.source === "github" && raw.id
        ? raw
        : normalizeLooseItem(raw, project);
      if (!item || item.state !== "open") continue;
      // Backstop behind resolveGithubSources: one work item may occupy exactly
      // one portfolio slot. Even if a caller hands the same collection twice,
      // the item can only be scored, routed and staffed once — so a duplicate
      // can never become a duplicate launch or a duplicate external action.
      //
      // The key is (project, id), never id alone. Loose item ids are only
      // unique WITHIN a project — two projects can each carry a directive with
      // id "directive-1", and an id-only key would silently drop one project's
      // real work, never staffing it. Project identity is part of what makes an
      // item distinct, so it is part of what makes it a duplicate.
      //
      // The pair is JSON-encoded, not joined by a delimiter: ANY delimiter can
      // be forged across the boundary. Joining on NUL made ("a<NUL>b", "c") and
      // ("a", "b<NUL>c") collapse to one key, silently dropping a real item.
      // Encoding also preserves types, so id 1 and id "1" stay distinct
      // instead of being coerced together by String().
      var dedupeKey = JSON.stringify([item.project, item.id]);
      if (seenIds[dedupeKey]) continue;
      seenIds[dedupeKey] = true;
      var classification = routing.classifyWorkItem(item);
      item.classification = classification;
      item.route = routing.routeWorkItem(classification, { health: health });
      item.score = scoreItem(item, classification, now);
      items.push(item);
      if (!byProject[item.project]) byProject[item.project] = [];
      byProject[item.project].push(item);
    }
  }
  return items;
}

function buildPortfolio(collections, opts) {
  var now = (opts && opts.now) || 0;
  var health = (opts && opts.health) || {};
  var byProject = {};
  var items = collectPortfolioItems(collections, now, health, byProject, {});

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
  // githubSourcesFromTaskConfigs was REMOVED on 2026-08-06, not renamed: it
  // deduped repos first-file-wins with no project attribution, which is the
  // defect. resolveGithubSources is the only supported entry point.
  normalizeRepoSlug: normalizeRepoSlug,
  resolveGithubSources: resolveGithubSources,
  ghIssueArgs: ghIssueArgs,
  collectGithubIssues: collectGithubIssues,
  scoreItem: scoreItem,
  buildPortfolio: buildPortfolio,
};
