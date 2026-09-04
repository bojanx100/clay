// Policy-attested GitHub collection for the Lead backlog.

var projectIdentity = require("./project-identity");
var automationPolicy = require("./project-automation-policy");
var automationAuthority = require("./project-automation-authority");
var qualification = require("./project-automation-qualification");
var taskSources = require("./project-task-sources");
var normalizeRepoSlug = require("./lead-backlog-sources").normalizeRepoSlug;
var boardEvidence = require("./lead-backlog-github-evidence");

var GH_ISSUE_FIELDS = "number,title,body,labels,state,updatedAt,url";
var MAX_QUALIFICATION_EVIDENCE_ISSUES = 25;

function splitList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(",").map(function (v) { return v.trim(); }).filter(function (v) { return !!v; });
}

function ghIssueFields(sourceSpec) {
  var filters = sourceSpec && sourceSpec.recipe ? sourceSpec.recipe.filter || {} :
    sourceSpec && sourceSpec.filters || {};
  var fields = GH_ISSUE_FIELDS;
  var policyStatuses = sourceSpec && sourceSpec.policy && sourceSpec.policy.boardExclusions;
  if (splitList(filters.skipProjectStatuses).length > 0 ||
      Array.isArray(policyStatuses) && policyStatuses.length > 0 ||
      qualification.policyProfile(sourceSpec && sourceSpec.policy)) fields += ",projectItems";
  if (sourceSpec && sourceSpec.recipe) fields += ",assignees";
  return fields;
}

function ghIssueArgs(sourceSpec) {
  var args = ["issue", "list", "--repo", sourceSpec.repo, "--json", ghIssueFields(sourceSpec), "--limit", "100"];
  var filters = sourceSpec.recipe ? sourceSpec.recipe.filter || {} : sourceSpec.filters || {};
  if (filters.state) args.push("--state", filters.state);
  var assigned = filters.assigned || "";
  if (assigned && assigned !== "any") {
    args.push("--assignee", assigned === "me" || assigned === "@me" ? "@me" : assigned);
  }
  if (filters.type && filters.type !== "bug") args.push("--label", filters.type);
  return args;
}

function normalizeGithubIssue(raw, project) {
  if (!raw || typeof raw.number !== "number") return null;
  var labels = [];
  var rawLabels = raw.labels || [];
  for (var i = 0; i < rawLabels.length; i++) {
    var name = typeof rawLabels[i] === "string" ? rawLabels[i] : rawLabels[i] && rawLabels[i].name;
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
  var filter = filters || {};
  if (filter.type && !typeAccepts(item, filter.type)) return false;
  var excluded = filter.excludeLabels || [];
  var labels = item.labels || [];
  for (var i = 0; i < excluded.length; i++) {
    for (var j = 0; j < labels.length; j++) {
      if (String(labels[j]).toLowerCase() === String(excluded[i]).toLowerCase()) return false;
    }
  }
  var prefixes = filter.titleExcludePrefixes || [];
  for (var p = 0; p < prefixes.length; p++) {
    if (String(item.title || "").indexOf(prefixes[p]) === 0) return false;
  }
  return true;
}

function projectStatusAccepts(issue, filters) {
  var skipped = splitList(filters && filters.skipProjectStatuses);
  if (!skipped.length) return true;
  var projectItems = issue && issue.projectItems || [];
  for (var pi = 0; pi < projectItems.length; pi++) {
    var name = projectItems[pi] && projectItems[pi].status && projectItems[pi].status.name;
    if (!name) continue;
    for (var si = 0; si < skipped.length; si++) {
      if (String(name).toLowerCase() === String(skipped[si]).toLowerCase()) return false;
    }
  }
  return true;
}

function requiresCurrentLogin(recipe) {
  var assigned = recipe && recipe.filter && recipe.filter.assigned;
  return assigned === "me" || assigned === "@me";
}

function recipeWithoutBoardStatuses(recipe) {
  var filter = Object.assign({}, recipe && recipe.filter || {});
  delete filter.skipProjectStatuses;
  return Object.assign({}, recipe, { filter: filter });
}

function canonicalSourceReason(sourceSpec) {
  if (!sourceSpec || !sourceSpec.recipe) return null;
  var policy = sourceSpec.policy;
  var sourceRef = projectIdentity.normalizeProjectRef(sourceSpec.projectRef);
  if (!sourceRef || !policy) return "policy_missing";
  var policyRef = projectIdentity.normalizeProjectRef(policy.projectRef);
  if (!policyRef || policyRef.projectId !== sourceRef.projectId) return "policy_project_ref_mismatch";
  if (typeof policy.digest !== "string" || sourceSpec.policyDigest !== policy.digest ||
      policy.digest !== automationPolicy.policyDigest(policy)) return "policy_stale";
  if (!Array.isArray(policy.recipes)) return "policy_stale";
  if (!qualification.policyProfile(policy)) return "qualification_policy_missing";
  var digest = automationPolicy.recipeDigest(sourceSpec.recipe);
  var matched = false;
  for (var i = 0; i < policy.recipes.length; i++) {
    if (policy.recipes[i] && policy.recipes[i].id === sourceSpec.recipe.id &&
        policy.recipes[i].digest === digest) { matched = true; break; }
  }
  if (!matched || normalizeRepoSlug(sourceSpec.recipe.source && sourceSpec.recipe.source.repo) !== sourceSpec.repo) {
    return "policy_recipe_mismatch";
  }
  if (typeof sourceSpec.candidateEligibility !== "function") return "candidate_eligibility_missing";
  return null;
}

function policyStatusEligibility(issue, sourceSpec) {
  var exclusions = sourceSpec && sourceSpec.policy && sourceSpec.policy.boardExclusions;
  if (!Array.isArray(exclusions)) return { ok: false, eligible: false, reason: "policy_status_unresolvable" };
  if (!exclusions.length) return { ok: true, eligible: true, reason: "policy_has_no_board_exclusions" };
  if (!issue || !Array.isArray(issue.projectItems)) {
    return { ok: false, eligible: false, reason: "project_status_unresolvable" };
  }
  for (var i = 0; i < issue.projectItems.length; i++) {
    var name = issue.projectItems[i] && issue.projectItems[i].status && issue.projectItems[i].status.name;
    if (typeof name === "string" && exclusions.indexOf(name.toLowerCase()) !== -1) {
      return { ok: true, eligible: false, reason: "policy_board_excluded" };
    }
  }
  return { ok: true, eligible: true, reason: "policy_board_eligible" };
}

function qualificationEligibility(issue, sourceSpec, currentLogin) {
  var recipe = sourceSpec && sourceSpec.recipe;
  var policy = sourceSpec && sourceSpec.policy;
  var profile = qualification.policyProfile(policy);
  if (!profile) return { ok: false, eligible: false, reason: "qualification_policy_missing" };
  var assigned = taskSources.issueAssignedToOwner(recipe, {}, issue, currentLogin);
  var itemClass = automationAuthority.classifyAutomationItem(issue,
    recipe && recipe.source && recipe.source.kind, recipe && recipe.filter && recipe.filter.type);
  var result = qualification.receiptFor({
    policy: policy,
    projectRef: sourceSpec.projectRef,
    recipe: {
      id: recipe && recipe.id,
      digest: automationPolicy.recipeDigest(recipe),
      kind: "issue",
    },
    item: issue,
    itemKey: sourceSpec.repo + "#" + (issue && issue.number),
    itemClass: itemClass,
    assignedToOwner: assigned === true,
    recipeAllowsUnassigned: taskSources.recipeAllowsUnassigned(recipe, {}),
    now: Date.now(),
  });
  return result.ok ? { ok: true, eligible: true, receipt: result.receipt } : {
    ok: false, eligible: false, reason: result.reason,
  };
}

// collectGithubIssues only emits candidates that passed the owning project's
// recipe, automation policy, assignment/override decision, and completion gate.
function collectGithubIssues(execFn, sourceSpec, project, cb) {
  var owner = sourceSpec && sourceSpec.project;
  if (owner && project && project !== owner) {
    return cb(new Error("repository " + (sourceSpec.repo || "?") + " is owned by project " +
      owner + "; refusing to project its items as " + project), []);
  }
  var label = owner || project;
  var sourceReason = canonicalSourceReason(sourceSpec);
  if (sourceReason) {
    return cb(new Error("repository " + (sourceSpec && sourceSpec.repo || "?") +
      " has no current canonical eligibility evidence: " + sourceReason), [], {
      exclusions: [{ reason: sourceReason }],
    });
  }
  function collect(currentLogin) {
    execFn("gh", ghIssueArgs(sourceSpec), function (err, stdout) {
      if (err) return cb(err, []);
      var parsed;
      try { parsed = JSON.parse(stdout || "[]"); } catch (e) { return cb(e, []); }
      var items = [];
      var exclusions = [];
      var evidenceLookups = 0;
      var index = 0;
      function next() {
        if (index >= parsed.length) return cb(null, items, { exclusions: exclusions });
        var raw = parsed[index++];
        var item = normalizeGithubIssue(raw, label);
        if (!item) return next();
        if (!sourceSpec.recipe) {
          if (projectStatusAccepts(raw, sourceSpec.filters) && filterAccepts(item, sourceSpec.filters)) items.push(item);
          return next();
        }
        if (!taskSources.issueMatches(recipeWithoutBoardStatuses(sourceSpec.recipe), {}, raw, currentLogin)) {
          exclusions.push({ number: raw.number, reason: "launcher_recipe_ineligible" });
          return next();
        }
        if (evidenceLookups >= MAX_QUALIFICATION_EVIDENCE_ISSUES) {
          exclusions.push({ number: raw.number, reason: "qualification_board_evidence_rate_limited" });
          return next();
        }
        evidenceLookups++;
        boardEvidence.collectBoardItemEvidence(execFn, sourceSpec.repo, raw.number, function (evidence) {
          if (!evidence.ok) {
            exclusions.push({ number: raw.number, reason: evidence.reason });
            return next();
          }
          var enriched = Object.assign({}, raw, { projectItems: evidence.projectItems });
          if (!taskSources.issueMatches(sourceSpec.recipe, {}, enriched, currentLogin)) {
            exclusions.push({ number: raw.number, reason: "launcher_recipe_ineligible" });
            return next();
          }
          var status = policyStatusEligibility(enriched, sourceSpec);
          if (!status.ok || !status.eligible) {
            exclusions.push({ number: raw.number, reason: status.reason });
            return next();
          }
          var assigned = taskSources.issueAssignedToOwner(sourceSpec.recipe, {}, enriched, currentLogin);
          var qualified = qualificationEligibility(enriched, sourceSpec, currentLogin);
          if (!qualified.ok || !qualified.eligible) {
            exclusions.push({ number: raw.number, reason: qualified.reason ||
              "qualification_unresolvable" });
            return next();
          }
          var decision;
          try {
            decision = sourceSpec.candidateEligibility(sourceSpec.repo + "#" + raw.number,
              assigned === true, taskSources.recipeAllowsUnassigned(sourceSpec.recipe, {}));
          } catch (e2) {
            decision = { ok: false, eligible: false, reason: "candidate_eligibility_unresolvable" };
          }
          if (!decision || decision.ok !== true || decision.eligible !== true) {
            exclusions.push({ number: raw.number, reason: decision && decision.reason ||
              "candidate_eligibility_unresolvable" });
            return next();
          }
          item.projectRef = { projectId: sourceSpec.projectRef.projectId };
          item.automationEligibility = {
            eligible: true,
            reason: decision.reason || status.reason,
            policyDigest: sourceSpec.policyDigest,
            recipeId: sourceSpec.recipe.id,
          };
          item.automationQualification = qualified.receipt;
          items.push(item);
          next();
        });
      }
      next();
    });
  }
  if (sourceSpec && sourceSpec.recipe && requiresCurrentLogin(sourceSpec.recipe)) {
    return execFn("gh", ["api", "user"], function (loginError, loginStdout) {
      if (loginError) return cb(loginError, [], { exclusions: [{ reason: "owner_identity_unresolvable" }] });
      var identity;
      try { identity = JSON.parse(loginStdout || "{}"); } catch (e) {
        return cb(e, [], { exclusions: [{ reason: "owner_identity_unresolvable" }] });
      }
      if (!identity || typeof identity.login !== "string" || !identity.login) {
        return cb(new Error("could not establish launcher owner identity"), [], {
          exclusions: [{ reason: "owner_identity_unresolvable" }],
        });
      }
      collect(identity.login);
    });
  }
  collect(null);
}

module.exports = {
  collectGithubIssues: collectGithubIssues,
  ghIssueArgs: ghIssueArgs,
  normalizeGithubIssue: normalizeGithubIssue,
  MAX_QUALIFICATION_EVIDENCE_ISSUES: MAX_QUALIFICATION_EVIDENCE_ISSUES,
};
