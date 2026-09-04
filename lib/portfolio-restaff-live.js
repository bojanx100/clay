// Live board/assignee revalidation shared by portfolio restaff and the target
// launch boundary. The pure predicate owns the policy decision; this adapter
// owns the one fresh source read needed to establish its observation.

var fs = require("fs");
var path = require("path");
var taskSources = require("./project-task-sources");
var createOverrideStore = require("./project-automation-overrides").createOverrideStore;
var revalidation = require("./portfolio-restaff-revalidation");

var DEFAULT_BOARD_EXCLUSIONS = ["Dev Complete", "Ready for production", "Done"];

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function itemKeyFor(recipe, item, fallback) {
  var source = recipe && recipe.source || {};
  var repo = text(source.repo).toLowerCase();
  var number = item && item.number != null ? String(item.number).trim() : "";
  if (repo && /^[1-9][0-9]*$/.test(number)) return repo + "#" + number;
  return text(fallback);
}

function issueKeyParts(itemKey) {
  var match = text(itemKey).match(/^([^\s/#]+\/[^\s/#]+)#([1-9][0-9]*)$/);
  if (!match) return null;
  return { repo: match[1].toLowerCase(), number: match[2] };
}

function projectItemsStatuses(item) {
  var projectItems = item && item.projectItems;
  if (!Array.isArray(projectItems) || !projectItems.length) return null;
  var statuses = [];
  for (var i = 0; i < projectItems.length; i++) {
    var status = projectItems[i] && projectItems[i].status && projectItems[i].status.name;
    if (!text(status)) return null;
    statuses.push(status);
  }
  return statuses;
}

function recipeOwner(recipe, args, currentLogin) {
  var filter = recipe && recipe.filter || {};
  var assigned = text(args && args.assigned) || text(filter.assigned);
  if (assigned === "me" || assigned === "@me") return text(currentLogin).toLowerCase();
  if (assigned && assigned !== "any") return assigned.toLowerCase();
  return text(currentLogin).toLowerCase();
}

function recipeAllowsUnassigned(recipe, args) {
  if (typeof taskSources.recipeAllowsUnassigned === "function") {
    return taskSources.recipeAllowsUnassigned(recipe, args || {}) === true;
  }
  var filter = recipe && recipe.filter || {};
  return (args && args.assigned || filter.assigned || "") === "any";
}

function sourceStampedInclude(cwd, itemKey, fsImpl, now) {
  // The intake path continues to interpret an include as an assignment
  // exception only. Restaff is a separate, explicit owner action: its durable
  // include record is converted into the source-stamped exception required by
  // the restaff predicate, without changing intake qualification semantics.
  var store = createOverrideStore({ cwd: cwd, fs: fsImpl, now: now });
  var found = store.decisionFor(itemKey);
  if (!found.ok) return { ok: false, reason: "override_state_unresolvable" };
  if (found.decision !== "include") return { ok: true, override: null };
  var record = found.override;
  if (!plainObject(record) || !text(record.by) ||
      !Number.isFinite(record.at) || record.at <= 0) {
    return { ok: false, reason: "source_stamped_include_unresolvable" };
  }
  return {
    ok: true,
    override: {
      itemKey: itemKey,
      source: "automation-override:" + text(record.by) + ":" + String(record.at),
    },
  };
}

function loadRecipe(cwd, recipeId, fsImpl) {
  var safeId = text(recipeId).replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safeId) return null;
  try {
    var recipe = JSON.parse(fsImpl.readFileSync(path.join(cwd, ".clay", "tasks", safeId + ".json"), "utf8"));
    if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) return null;
    recipe.id = recipe.id || safeId;
    return recipe;
  } catch (error) {
    return null;
  }
}

function attachPortfolioRestaffLive(ctx) {
  var options = ctx || {};
  var cwd = text(options.cwd) || ".";
  var fsImpl = options.fs || fs;
  var fetchItems = options.fetchItems || taskSources.fetchItems;
  var now = typeof options.now === "function" ? options.now : Date.now;
  var boardExclusions = Array.isArray(options.boardExclusions) ?
    options.boardExclusions.slice() : DEFAULT_BOARD_EXCLUSIONS.slice();

  function currentLogin(recipe, args) {
    if (typeof options.ownerLogin === "function") {
      try { return text(options.ownerLogin(recipe, args)); } catch (error) { return ""; }
    }
    if (options.ownerLogin) return text(options.ownerLogin);
    try {
      var account = taskSources.resolveGhAccount(cwd, recipe, args || {});
      var env = taskSources.ghEnv(cwd, account);
      return text(taskSources.ghLogin(cwd, env));
    } catch (error) {
      return "";
    }
  }

  function recipeForLiveRead(recipe) {
    if (!plainObject(recipe) || !plainObject(recipe.source)) return null;
    return Object.assign({}, recipe, {
      source: Object.assign({}, recipe.source, { includeProjectItems: true }),
    });
  }

  function revalidate(input) {
    var value = plainObject(input) ? input : {};
    var binding = plainObject(value.binding) ? value.binding : value;
    var authorization = plainObject(binding.automationAuthorization) ?
      binding.automationAuthorization : null;
    var itemKey = text(value.itemKey) || text(authorization && authorization.itemKey) ||
      text(binding.workIdentity);
    var parts = issueKeyParts(itemKey);
    if (!authorization || !itemKey || !parts) {
      return { ok: false, eligible: false, reason: "revalidation_item_identity_missing" };
    }
    var recipeId = authorization.source && authorization.source.recipeId;
    var recipe = plainObject(value.recipe) ? value.recipe : loadRecipe(cwd, recipeId, fsImpl);
    if (!recipe) return { ok: false, eligible: false, reason: "revalidation_recipe_unresolvable" };
    var liveRecipe = recipeForLiveRead(recipe);
    var args = { issue: parts.number, repo: parts.repo };
    var items;
    try { items = fetchItems(cwd, liveRecipe, args); }
    catch (error) { return { ok: false, eligible: false, reason: "live_issue_fetch_failed" }; }
    if (!Array.isArray(items) || items.length !== 1 || !items[0]) {
      return { ok: false, eligible: false, reason: "live_issue_unresolvable" };
    }
    var item = items[0];
    var observedKey = itemKeyFor(liveRecipe, item, itemKey);
    if (observedKey.toLowerCase() !== itemKey.toLowerCase() ||
        Number(item.number) !== Number(parts.number)) {
      return { ok: false, eligible: false, reason: "live_issue_identity_mismatch" };
    }
    var current = now();
    var include = sourceStampedInclude(cwd, itemKey, fsImpl, now);
    if (!include.ok) return { ok: false, eligible: false, reason: include.reason };
    var login = currentLogin(recipe, args);
    var statuses = projectItemsStatuses(item);
    var verdict = revalidation.restaffEligibility({
      observation: {
        itemKey: itemKey,
        assignees: Array.isArray(item.assignees) ? item.assignees : null,
        boardStatuses: statuses,
        boardStatus: statuses && statuses.length ? statuses[0] : null,
        state: item.state,
        observedAt: current,
      },
      policy: {
        ownerLogin: login,
        boardExclusions: boardExclusions,
        recipeAllowsUnassigned: recipeAllowsUnassigned(recipe, args),
      },
      override: include.override,
      now: current,
    });
    return Object.assign({}, verdict, {
      itemKey: itemKey,
      observedAt: current,
      item: clone(item),
    });
  }

  function shouldCheck(binding) {
    return !!(plainObject(binding) && binding.bindingRevision > 1 &&
      plainObject(binding.automationAuthorization));
  }

  return {
    revalidate: revalidate,
    shouldCheck: shouldCheck,
  };
}

module.exports = {
  DEFAULT_BOARD_EXCLUSIONS: DEFAULT_BOARD_EXCLUSIONS,
  attachPortfolioRestaffLive: attachPortfolioRestaffLive,
};
