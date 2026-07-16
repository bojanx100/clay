// project-task-sentry-source.js - Sentry issue source for task launch recipes.
// Keeps Sentry API and GitHub relation matching out of project-task-sources.js.

var { execFileSync } = require("child_process");

function splitList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(",").map(function (v) { return v.trim(); }).filter(function (v) { return !!v; });
}

function truthy(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function envValue(name) {
  if (!name) return "";
  return process.env[String(name)] || "";
}

function cfgValue(args, source, keys, fallback) {
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (args && args[k] !== undefined && args[k] !== "") return args[k];
    if (source && source[k] !== undefined && source[k] !== "") return source[k];
  }
  return fallback;
}

function encodePathPart(value) {
  return encodeURIComponent(String(value || ""));
}

function sentryToken(source, args) {
  if (args && args.sentryToken) return args.sentryToken;
  if (source && source.authToken) return source.authToken;
  var envName = (source && source.tokenEnv) || "SENTRY_AUTH_TOKEN";
  return envValue(envName);
}

function sentryApiGet(url, token) {
  var out = execFileSync("curl", ["-fsSL", url, "-H", "Authorization: Bearer " + token], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function appendRepeated(params, key, values) {
  for (var i = 0; i < values.length; i++) {
    if (values[i] !== undefined && values[i] !== "") params.push([key, String(values[i])]);
  }
}

function sentryIssuesUrl(source, args) {
  var baseUrl = String(cfgValue(args, source, ["baseUrl"], "https://sentry.io")).replace(/\/+$/, "");
  var org = cfgValue(args, source, ["organization", "org"], envValue("SENTRY_ORG"));
  if (!org) throw new Error("Sentry source is missing organization (set source.organization or SENTRY_ORG)");
  var projects = splitList(cfgValue(args, source, ["projects", "project"], envValue("SENTRY_PROJECT")));
  var query = cfgValue(args, source, ["query"], (source && source.query) || "is:unresolved");
  var sort = cfgValue(args, source, ["sort"], "date");
  var statsPeriod = cfgValue(args, source, ["statsPeriod"], "24h");
  var limit = parseInt(cfgValue(args, source, ["fetchLimit", "limit"], 100), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  if (limit > 100) limit = 100;

  var params = [];
  appendRepeated(params, "project", projects);
  if (query !== undefined) params.push(["query", String(query)]);
  if (sort) params.push(["sort", String(sort)]);
  if (statsPeriod) params.push(["statsPeriod", String(statsPeriod)]);
  params.push(["limit", String(limit)]);
  params.push(["expand", "integrationIssues"]);

  var qs = params.map(function (pair) {
    return encodeURIComponent(pair[0]) + "=" + encodeURIComponent(pair[1]);
  }).join("&");
  return baseUrl + "/api/0/organizations/" + encodePathPart(org) + "/issues/?" + qs;
}

function walkStrings(value, out) {
  if (value == null) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) walkStrings(value[i], out);
    return;
  }
  if (typeof value === "object") {
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) walkStrings(value[keys[k]], out);
  }
}

function addRef(refs, kind, number) {
  var n = String(number || "").trim();
  if (!n) return;
  refs[kind + ":" + n] = true;
}

function extractGithubRefs(issue, repo, includeTextMatches) {
  var refs = {};
  var strings = [];
  walkStrings(issue && issue.integrationIssues ? issue.integrationIssues : [], strings);
  if (includeTextMatches) {
    walkStrings({
      annotations: issue && issue.annotations,
      culprit: issue && issue.culprit,
      metadata: issue && issue.metadata,
      title: issue && issue.title,
    }, strings);
  }
  var escapedRepo = repo ? repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "[\\w.-]+\\/[\\w.-]+";
  var urlRe = new RegExp("github\\.com/" + escapedRepo + "/(issues|pull)/(\\d+)", "ig");
  var shorthandRe = repo ? new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "#(\\d+)", "ig") : null;
  for (var i = 0; i < strings.length; i++) {
    var text = strings[i];
    var m;
    while ((m = urlRe.exec(text))) {
      addRef(refs, m[1] === "pull" ? "pr" : "issue", m[2]);
    }
    if (shorthandRe) {
      while ((m = shorthandRe.exec(text))) addRef(refs, "any", m[1]);
    }
  }
  return refs;
}

function refKey(kind, number) {
  return kind + ":" + String(number || "").trim();
}

function buildRelatedRefs(cwd, recipe, args, helpers) {
  var source = recipe.source || {};
  var repo = cfgValue(args, source, ["githubRepo", "repo"], "");
  if (!repo) return null;
  var want = splitList(source.relatedTo || ["issues", "prs"]);
  var refs = {};
  var currentLogin = null;
  var account = helpers.resolveGhAccount(cwd, { source: { repo: repo, ghAccount: source.ghAccount } }, args || {});
  var env = helpers.ghEnv(cwd, account);
  try { currentLogin = helpers.ghLogin(cwd, env); } catch (e) {}

  if (want.indexOf("issues") !== -1 || want.indexOf("issue") !== -1 || want.indexOf("assigned-issues") !== -1) {
    var issueRecipe = {
      source: {
        provider: "github",
        kind: "issue",
        repo: repo,
        fetchLimit: source.githubFetchLimit || source.fetchLimit || 100,
        ghAccount: source.ghAccount,
        includeProjectItems: false,
      },
      filter: Object.assign({ state: "open", assigned: "me" }, source.githubIssueFilter || {}),
    };
    var issues = helpers.githubIssues(cwd, issueRecipe, {});
    for (var i = 0; i < issues.length; i++) {
      refs[refKey("issue", issues[i].number)] = true;
      refs[refKey("any", issues[i].number)] = true;
    }
  }

  if (want.indexOf("prs") !== -1 || want.indexOf("pr") !== -1 || want.indexOf("pulls") !== -1) {
    var fetchLimit = parseInt(source.githubPrFetchLimit || source.fetchLimit || 50, 10);
    if (!Number.isFinite(fetchLimit) || fetchLimit <= 0) fetchLimit = 50;
    var prs = helpers.listCandidatePrs(cwd, repo, env, currentLogin, fetchLimit);
    for (var p = 0; p < prs.length; p++) {
      refs[refKey("pr", prs[p].number)] = true;
      refs[refKey("any", prs[p].number)] = true;
    }
  }
  return refs;
}

function refsIntersect(issueRefs, allowedRefs) {
  if (!allowedRefs) return true;
  var keys = Object.keys(issueRefs || {});
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (allowedRefs[key]) return true;
    var n = key.split(":")[1];
    if (n && allowedRefs["any:" + n]) return true;
  }
  return false;
}

function refList(issueRefs, repo) {
  var keys = Object.keys(issueRefs || {}).sort();
  var out = [];
  for (var i = 0; i < keys.length; i++) {
    var parts = keys[i].split(":");
    if (parts[0] === "any") continue;
    out.push((repo ? repo + " " : "") + (parts[0] === "pr" ? "PR #" : "issue #") + parts[1]);
  }
  return out.join(", ");
}

function sentryIssueBody(issue, repo, refs) {
  var lines = [];
  lines.push("Sentry issue: " + (issue.shortId || issue.id || ""));
  lines.push("URL: " + (issue.permalink || ""));
  lines.push("Project: " + (issue.project && (issue.project.slug || issue.project.name) || ""));
  lines.push("Status: " + (issue.status || "") + (issue.substatus ? " / " + issue.substatus : ""));
  lines.push("Level: " + (issue.level || ""));
  lines.push("Count: " + (issue.count || ""));
  lines.push("Users: " + (issue.userCount || ""));
  lines.push("First seen: " + (issue.firstSeen || ""));
  lines.push("Last seen: " + (issue.lastSeen || ""));
  if (issue.culprit) lines.push("Culprit: " + issue.culprit);
  if (repo) lines.push("Related GitHub refs: " + (refList(refs, repo) || "_none detected_"));
  if (issue.metadata && issue.metadata.value) lines.push("\nMessage:\n" + issue.metadata.value);
  return lines.join("\n");
}

function mapSentryIssue(issue, source, refs) {
  var projectSlug = issue.project && (issue.project.slug || issue.project.name) || "";
  var title = issue.title || (issue.metadata && (issue.metadata.title || issue.metadata.value)) || "Sentry issue";
  var shortId = issue.shortId || issue.id || "";
  var repo = source.githubRepo || source.repo || "";
  var org = source.organization || source.org || envValue("SENTRY_ORG") || "";
  return {
    number: String(issue.id || shortId),
    title: (shortId ? shortId + " " : "") + title,
    url: issue.permalink || "",
    body: sentryIssueBody(issue, repo, refs),
    labels: [],
    assignees: [],
    key: "sentry:" + org + "/" + projectSlug + "#" + (issue.id || shortId),
    sentry_id: String(issue.id || ""),
    sentry_short_id: String(shortId || ""),
    sentry_project: String(projectSlug || ""),
    sentry_level: String(issue.level || ""),
    sentry_status: String(issue.status || ""),
    sentry_count: String(issue.count || ""),
    sentry_user_count: String(issue.userCount || ""),
    sentry_first_seen: String(issue.firstSeen || ""),
    sentry_last_seen: String(issue.lastSeen || ""),
    sentry_culprit: String(issue.culprit || ""),
    sentry_permalink: String(issue.permalink || ""),
    related_github_refs: refList(refs, repo),
  };
}

function sentryFindings(cwd, recipe, args, helpers) {
  var source = recipe.source || {};
  var token = sentryToken(source, args || {});
  if (!token) throw new Error("Sentry source is missing auth token (set SENTRY_AUTH_TOKEN or source.tokenEnv)");
  var url = sentryIssuesUrl(source, args || {});
  var issues = sentryApiGet(url, token);
  if (!Array.isArray(issues)) issues = [];
  var allowedRefs = buildRelatedRefs(cwd, recipe, args || {}, helpers);
  var includeTextMatches = truthy(source.matchText || (args && args.matchText));
  var repo = source.githubRepo || source.repo || "";
  var out = [];
  for (var i = 0; i < issues.length; i++) {
    var refs = extractGithubRefs(issues[i], repo, includeTextMatches);
    if (!refsIntersect(refs, allowedRefs)) continue;
    out.push(mapSentryIssue(issues[i], source, refs));
  }
  return out;
}

module.exports = {
  sentryFindings: sentryFindings,
  extractGithubRefs: extractGithubRefs,
  sentryIssuesUrl: sentryIssuesUrl,
};
