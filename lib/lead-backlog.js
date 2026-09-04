// Lead backlog aggregation (CTO orchestrator brick 3 — roadmap §3.3).
//
// This module owns normalization, scoring and portfolio assembly. GitHub source
// resolution and policy-attested collection live in focused sibling modules so
// no scorer can grow a second interpretation of project automation authority.

var routing = require("./lead-routing");
var sources = require("./lead-backlog-sources");
var github = require("./lead-backlog-github");

function normalizeLooseItem(raw, project) {
  if (!raw || !raw.title) return null;
  return {
    source: raw.source || "clay",
    project: project || raw.project || "",
    id: raw.id || ((project || "clay") + ":" + raw.title.slice(0, 40)),
    number: raw.number || null,
    title: raw.title,
    body: raw.body || "",
    labels: (raw.labels || []).map(function (label) { return String(label).toLowerCase(); }),
    state: (raw.state || "open").toLowerCase(),
    updatedAt: raw.updatedAt || 0,
    url: raw.url || null,
  };
}

var LABEL_PRIORITY = {
  "p0": 400, "urgent": 400, "critical": 400,
  "p1": 200, "priority:high": 200, "high priority": 200,
  "p2": 50,
};
var RISK_WEIGHT = { high: 150, medium: 60, low: 0 };
var CLASS_WEIGHT = { security: 120, debugging: 80, design: 40, implementation: 20, review: 20, research: 10, mechanical: 0 };

function scoreItem(item, classification, now) {
  var score = 0;
  for (var i = 0; i < item.labels.length; i++) score += LABEL_PRIORITY[item.labels[i]] || 0;
  score += RISK_WEIGHT[classification.risk] || 0;
  score += CLASS_WEIGHT[classification.taskClass] || 0;
  if (item.updatedAt && now > item.updatedAt) {
    var staleDays = (now - item.updatedAt) / 86400000;
    score += Math.min(50, Math.floor(staleDays * 2));
  }
  return score;
}

// Scalar, type-tagged identity encoding. A work item that cannot be compared
// exactly is skipped rather than guessed into a duplicate slot.
function identityToken(value) {
  if (value === null) return "null";
  var type = typeof value;
  if (type === "string") return "s:" + value;
  if (type === "number") return Object.is(value, -0) ? "n:-0" : "n:" + String(value);
  if (type === "boolean") return "b:" + String(value);
  if (type === "bigint") return "g:" + value.toString();
  if (type === "undefined") return "undefined";
  return null;
}

function dedupeKeyFor(item) {
  var projectToken = identityToken(item.project);
  var idToken = identityToken(item.id);
  if (projectToken === null || idToken === null) return null;
  return JSON.stringify([projectToken, idToken]);
}

function collectPortfolioItems(collections, now, health, byProject, seenIds, stats) {
  var items = [];
  for (var ci = 0; ci < (collections || []).length; ci++) {
    var collection = collections[ci];
    var project = collection.project || "";
    for (var ii = 0; ii < (collection.items || []).length; ii++) {
      var raw = collection.items[ii];
      var item = raw && raw.source === "github" && raw.id ? raw : normalizeLooseItem(raw, project);
      if (!item || item.state !== "open") continue;
      // This backstop is before classification and scoring: a pre-fetched
      // policy-attested candidate cannot be restored to a staffing decision by
      // changing collection order or passing it directly to buildPortfolio.
      if (item.source === "github" && item.automationEligibility &&
          item.automationEligibility.eligible !== true) {
        stats.ineligible++;
        continue;
      }
      var key = dedupeKeyFor(item);
      if (key === null) { stats.unidentifiable++; continue; }
      if (seenIds[key]) continue;
      seenIds[key] = true;
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
  var now = opts && opts.now || 0;
  var health = opts && opts.health || {};
  var byProject = {};
  var stats = { unidentifiable: 0, ineligible: 0 };
  var items = collectPortfolioItems(collections, now, health, byProject, {}, stats);
  items.sort(function (left, right) {
    if (right.score !== left.score) return right.score - left.score;
    return String(left.id) < String(right.id) ? -1 : 1;
  });
  var unroutable = 0;
  for (var i = 0; i < items.length; i++) {
    if (!items[i].route) unroutable++;
  }
  return {
    items: items,
    byProject: byProject,
    summary: {
      total: items.length,
      projects: Object.keys(byProject).length,
      unroutable: unroutable,
      unidentifiable: stats.unidentifiable,
      ineligible: stats.ineligible,
      top: items.length ? { id: items[0].id, title: items[0].title, score: items[0].score } : null,
    },
  };
}

module.exports = {
  normalizeGithubIssue: github.normalizeGithubIssue,
  normalizeLooseItem: normalizeLooseItem,
  normalizeRepoSlug: sources.normalizeRepoSlug,
  resolveGithubSources: sources.resolveGithubSources,
  ghIssueArgs: github.ghIssueArgs,
  collectGithubIssues: github.collectGithubIssues,
  scoreItem: scoreItem,
  buildPortfolio: buildPortfolio,
};
