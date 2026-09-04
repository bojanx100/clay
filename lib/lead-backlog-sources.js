// Lead backlog source resolution. Repository ownership and policy evidence are
// kept separate from scoring so this module stays a small, auditable boundary.

var projectIdentity = require("./project-identity");
var automationPolicy = require("./project-automation-policy");

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

var GITHUB_HOSTS = { "github.com": true, "www.github.com": true };
var BARE_SLUG_RE = /^([\w.-]+)\/([\w.-]+)$/;
var SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
var SCP_RE = /^(?:[^/@\s]+@)?([^/:\s]+):(.+)$/;
var HOST_PATH_RE = /^([^/:\s]+)\/(.+)$/;

function isGithubHost(host) {
  return GITHUB_HOSTS[String(host || "").toLowerCase().replace(/\.$/, "")] === true;
}

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

function isIssueRecipe(source) {
  var kind = source && source.kind;
  return !kind || kind === "issue" || kind === "issues";
}

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

function candidateFromRecipe(cfg, owner) {
  var src = cfg && cfg.source;
  if (!src || src.provider !== "github" || !src.repo || !isIssueRecipe(src)) return null;
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
    recipe: { id: cfg.id || null, source: cfg.source || {}, filter: cfg.filter || {} },
    automationPolicy: owner.automationPolicy,
    candidateEligibility: owner.candidateEligibility,
    ghAccount: src.ghAccount || null,
    filters: filtersFromRecipe(cfg.filter || {}),
  };
}

function candidatesFromProjectEntries(entries) {
  var candidates = [];
  for (var e = 0; e < (entries || []).length; e++) {
    var entry = entries[e] || {};
    var owner = {
      project: entry.project || null,
      projectRef: projectIdentity.normalizeProjectRef(entry.projectRef),
      originRepo: entry.originRepo || null,
      originSlug: normalizeRepoSlug(entry.originRepo),
      automationPolicy: entry.automationPolicy || null,
      candidateEligibility: entry.candidateEligibility || null,
    };
    var configs = entry.configs || [];
    for (var c = 0; c < configs.length; c++) {
      var candidate = candidateFromRecipe(configs[c], owner);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function policyEvidenceReason(candidate) {
  var evidence = candidate && candidate.automationPolicy;
  if (!evidence || evidence.ok !== true || !evidence.policy) {
    return evidence && typeof evidence.reason === "string" && evidence.reason ?
      evidence.reason : "policy_missing";
  }
  var policy = evidence.policy;
  var ref = projectIdentity.normalizeProjectRef(policy.projectRef);
  if (!ref || !candidate.projectRef || ref.projectId !== candidate.projectRef.projectId) {
    return "policy_project_ref_mismatch";
  }
  if (typeof policy.digest !== "string" || policy.digest !== automationPolicy.policyDigest(policy)) {
    return "policy_stale";
  }
  if (!Array.isArray(policy.recipes)) return "policy_stale";
  var recipeDigest = automationPolicy.recipeDigest(candidate.recipe);
  var matches = 0;
  for (var i = 0; i < policy.recipes.length; i++) {
    var recipe = policy.recipes[i];
    if (recipe && recipe.id === candidate.recipe.id && recipe.digest === recipeDigest) matches++;
  }
  if (!matches) return "policy_recipe_mismatch";
  if (typeof candidate.candidateEligibility !== "function") return "candidate_eligibility_missing";
  return null;
}

function resolveRepoOwner(repoSlug, candidates) {
  var owners = [];
  var ownerIds = {};
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i].originSlug !== repoSlug) continue;
    if (!candidates[i].projectRef) return { conflict: conflict(repoSlug, "invalid_project_ref", candidates) };
    owners.push(candidates[i]);
    ownerIds[candidates[i].projectRef.projectId] = true;
  }
  if (!owners.length) return { conflict: conflict(repoSlug, "unowned_repository_source", candidates) };
  if (Object.keys(ownerIds).length > 1) return { conflict: conflict(repoSlug, "ambiguous_repository_owner", owners) };
  owners.sort(function (left, right) {
    var leftKey = JSON.stringify([left.recipeId || "", left.repo || ""]);
    var rightKey = JSON.stringify([right.recipeId || "", right.repo || ""]);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return 0;
  });
  var signature = sourceSignature(owners[0]);
  for (var s = 1; s < owners.length; s++) {
    if (sourceSignature(owners[s]) !== signature) {
      return { conflict: conflict(repoSlug, "conflicting_repository_recipes", owners) };
    }
  }
  var policyReason = policyEvidenceReason(owners[0]);
  if (policyReason) return { conflict: conflict(repoSlug, policyReason, owners) };
  return { owner: owners[0] };
}

// resolveGithubSources binds exactly one origin-owning project to each repo.
// Every source carries the recipe and policy evidence collection must attest.
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
      repo: owner.repoSlug,
      project: owner.project,
      projectRef: owner.projectRef,
      recipe: owner.recipe,
      policy: owner.automationPolicy.policy,
      policyDigest: owner.automationPolicy.policy.digest,
      candidateEligibility: owner.candidateEligibility,
      ghAccount: owner.ghAccount,
      filters: owner.filters,
    });
  }
  return { sources: sources, conflicts: conflicts };
}

module.exports = {
  normalizeRepoSlug: normalizeRepoSlug,
  resolveGithubSources: resolveGithubSources,
};
