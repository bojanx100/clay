// project-automation-policy.js - Loads ONE project's own authoritative
// automation policy, fail-closed, bound to a typed ProjectRef.
//
// Why this exists: today a project's automation rules are scattered across its
// launcher recipes (.clay/tasks/*.json), its .clay/tasks/config.json autoLaunch
// block, and prose in localAIConfig/TRIAGE.local.md. The Coop/Lead routing layer
// needs ONE typed, digestible view per project before it may act.
//
// Hard rule: there is NO global default policy that flattens per-project rules.
// Every read is scoped to the caller-supplied cwd; this module never looks at
// another project's directory and never at a machine-wide config file. Two
// projects with different recipes MUST produce different policies.
//
// TRIAGE.local.md is deliberately NOT parsed - it is prose injected verbatim
// into agent prompts and carries no machine-readable authority.
//
// Resolution order (project's own files only):
//   1. .clay/tasks/config.json `automation` block -> EXPLICIT policy (derived:false)
//   2. otherwise derive a legacy-compatible policy from that project's recipes
//   3. no .clay/tasks directory -> restrictive default ("no automation authority")
//
// Anything unexpected fails closed with { ok:false, reason, projectRef }.
// A permissive fallback is never produced.

var nodeFs = require("fs");
var path = require("path");
var crypto = require("crypto");
var projectIdentity = require("./project-identity");

var CLASSES = ["bug", "feature", "ambiguous", "pr_review"];
var AUTONOMY_VALUES = ["autonomous", "propose", "owner_approval", "deny"];
var EXTERNAL_VALUES = ["approval", "claim", "deny"];
var EXTERNAL_ACTIONS = ["comment", "done_workflow", "merge", "close"];

// Only these keys may appear inside the explicit `automation` block. Board
// exclusions, provider rules and the recipe inventory are always evidence from
// the project's own files, never hand-declared.
var AUTOMATION_KEYS = ["autonomy", "externalActions"];

// Least authority we can express: propose everything, ask before anything
// leaves the machine.
var RESTRICTIVE_AUTONOMY = "propose";
var RESTRICTIVE_EXTERNAL = "approval";

var PR_KINDS = ["pr-reviews", "pr-review", "prs"];
var ISSUE_KINDS = ["issue", "issues"];

var TASKS_REL = ".clay/tasks";

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function contains(list, value) {
  return list.indexOf(value) !== -1;
}

function fail(reason, ref) {
  return { ok: false, reason: reason, projectRef: ref || null };
}

// --- Canonical digest --------------------------------------------------------

// Sort object keys recursively so an identical policy always serializes to the
// same bytes, and any change to any field is detectable.
function canonical(value) {
  if (Array.isArray(value)) {
    var arr = [];
    for (var i = 0; i < value.length; i++) arr.push(canonical(value[i]));
    return arr;
  }
  if (isPlainObject(value)) {
    var out = {};
    var keys = Object.keys(value).sort();
    for (var k = 0; k < keys.length; k++) out[keys[k]] = canonical(value[keys[k]]);
    return out;
  }
  return value;
}

function digestSubject(policy) {
  return {
    projectId: (policy && policy.projectRef && policy.projectRef.projectId) || "",
    derived: !!(policy && policy.derived),
    autonomy: (policy && policy.autonomy) || {},
    externalActions: (policy && policy.externalActions) || {},
    boardExclusions: (policy && policy.boardExclusions) || [],
    providerRules: (policy && policy.providerRules) || {},
    recipes: (policy && policy.recipes) || [],
  };
}

function policyDigest(policy) {
  var json = JSON.stringify(canonical(digestSubject(policy)));
  return crypto.createHash("sha256").update(json).digest("hex");
}

// --- Restrictive baseline ----------------------------------------------------

function restrictiveAutonomy() {
  var autonomy = {};
  for (var i = 0; i < CLASSES.length; i++) autonomy[CLASSES[i]] = RESTRICTIVE_AUTONOMY;
  autonomy.default = RESTRICTIVE_AUTONOMY;
  return autonomy;
}

function restrictiveExternalActions() {
  var external = {};
  for (var i = 0; i < EXTERNAL_ACTIONS.length; i++) external[EXTERNAL_ACTIONS[i]] = RESTRICTIVE_EXTERNAL;
  return external;
}

function buildPolicy(ref, derived, autonomy, externalActions, boardExclusions, vendors, recipes, sources) {
  var policy = {
    projectRef: { projectId: ref.projectId },
    derived: !!derived,
    autonomy: autonomy,
    externalActions: externalActions,
    boardExclusions: boardExclusions,
    providerRules: { vendors: vendors },
    recipes: recipes,
    sources: sources,
  };
  policy.digest = policyDigest(policy);
  return policy;
}

// "No automation authority" - not an error, just nothing granted.
function restrictiveDefaultPolicy(ref) {
  return buildPolicy(ref, true, restrictiveAutonomy(), restrictiveExternalActions(), [], {}, [], []);
}

// --- Explicit policy ---------------------------------------------------------

// Strict: unknown keys, unknown class names and out-of-set values are all
// malformed. Missing entries fall back to the restrictive baseline.
function parseExplicit(automation) {
  if (!isPlainObject(automation)) return null;
  var keys = Object.keys(automation);
  var i;
  for (i = 0; i < keys.length; i++) {
    if (!contains(AUTOMATION_KEYS, keys[i])) return null;
  }

  var autonomy = restrictiveAutonomy();
  if (Object.prototype.hasOwnProperty.call(automation, "autonomy")) {
    var rawAutonomy = automation.autonomy;
    if (!isPlainObject(rawAutonomy)) return null;
    var autonomyKeys = Object.keys(rawAutonomy);
    for (i = 0; i < autonomyKeys.length; i++) {
      var cls = autonomyKeys[i];
      if (!contains(CLASSES, cls) && cls !== "default") return null;
      if (!contains(AUTONOMY_VALUES, rawAutonomy[cls])) return null;
      autonomy[cls] = rawAutonomy[cls];
    }
  }

  var externalActions = restrictiveExternalActions();
  if (Object.prototype.hasOwnProperty.call(automation, "externalActions")) {
    var rawExternal = automation.externalActions;
    if (!isPlainObject(rawExternal)) return null;
    var externalKeys = Object.keys(rawExternal);
    for (i = 0; i < externalKeys.length; i++) {
      var action = externalKeys[i];
      if (!contains(EXTERNAL_ACTIONS, action)) return null;
      if (!contains(EXTERNAL_VALUES, rawExternal[action])) return null;
      externalActions[action] = rawExternal[action];
    }
  }

  return { autonomy: autonomy, externalActions: externalActions };
}

// --- Recipe evidence ---------------------------------------------------------

function recipeKind(source) {
  var kind = (source && source.kind) || "";
  if (contains(PR_KINDS, kind)) return "pr_review";
  return "issue";
}

// Mirrors lead-backlog.isIssueRecipe: kind absent or explicitly issue-shaped.
function isIssueKind(source) {
  var kind = (source && source.kind) || "";
  return !kind || contains(ISSUE_KINDS, kind);
}

function isPrKind(source) {
  return contains(PR_KINDS, (source && source.kind) || "");
}

// Keep only positive integer weights keyed by vendor.
// Mirrors normalizeWeights in lib/project-auto-launch.js:69.
function normalizeWeights(weights) {
  var out = {};
  if (isPlainObject(weights)) {
    var keys = Object.keys(weights);
    for (var i = 0; i < keys.length; i++) {
      var value = parseInt(weights[keys[i]], 10);
      if (Number.isFinite(value) && value > 0) out[keys[i]] = value;
    }
  }
  return out;
}

// Evidence-based derivation. These are the ONLY rules; nothing else is invented,
// and derivation never grants an external action beyond "approval".
function deriveAutonomy(recipes) {
  var autonomy = restrictiveAutonomy();
  for (var i = 0; i < recipes.length; i++) {
    var source = recipes[i].source;
    var filter = isPlainObject(recipes[i].filter) ? recipes[i].filter : {};
    var type = typeof filter.type === "string" ? filter.type : "";

    if (isPrKind(source)) {
      // PR review is never autonomous by derivation - only an explicit policy
      // may raise it.
      autonomy.pr_review = "propose";
      continue;
    }

    if (!isIssueKind(source)) continue;

    if (type === "bug") {
      // Preserves an existing bug-scoped launcher's autonomy.
      autonomy.bug = "autonomous";
    } else if (type === "feature" || type === "legacy") {
      autonomy.feature = "owner_approval";
    } else if (!type) {
      // Unscoped capability work: ambiguous, and `bug` is left untouched.
      autonomy.ambiguous = "owner_approval";
    }
  }
  return autonomy;
}

function deriveBoardExclusions(recipes) {
  var seen = {};
  var out = [];
  for (var i = 0; i < recipes.length; i++) {
    var filter = isPlainObject(recipes[i].filter) ? recipes[i].filter : {};
    var list = Array.isArray(filter.skipProjectStatuses) ? filter.skipProjectStatuses : [];
    for (var j = 0; j < list.length; j++) {
      var status = String(list[j] || "").toLowerCase();
      if (!status || seen[status]) continue;
      seen[status] = true;
      out.push(status);
    }
  }
  return out.sort();
}

function recipeInventory(recipes) {
  var out = [];
  for (var i = 0; i < recipes.length; i++) {
    var source = recipes[i].source;
    var filter = isPlainObject(recipes[i].filter) ? recipes[i].filter : {};
    out.push({
      id: recipes[i].id,
      kind: recipeKind(source),
      repo: typeof source.repo === "string" ? source.repo : "",
      type: typeof filter.type === "string" ? filter.type : "",
    });
  }
  out.sort(function (a, b) {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return out;
}

// --- Filesystem reads (all scoped to the given cwd) ---------------------------

function readJsonFile(fsImpl, absPath) {
  var raw;
  try {
    raw = fsImpl.readFileSync(absPath, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { status: "missing" };
    return { status: "unreadable" };
  }
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e2) {
    return { status: "malformed" };
  }
  return { status: "ok", value: parsed };
}

function listTaskFiles(fsImpl, tasksDir) {
  var entries;
  try {
    entries = fsImpl.readdirSync(tasksDir);
  } catch (e) {
    if (e && e.code === "ENOENT") return { status: "missing" };
    return { status: "unreadable" };
  }
  var names = [];
  for (var i = 0; i < entries.length; i++) {
    var name = typeof entries[i] === "string" ? entries[i] : String(entries[i] && entries[i].name);
    if (/\.json$/i.test(name)) names.push(name);
  }
  return { status: "ok", names: names.sort() };
}

// --- Public entry point ------------------------------------------------------

function loadProjectAutomationPolicy(options) {
  var opts = options || {};
  var fsImpl = opts.fs || nodeFs;
  var ref = projectIdentity.normalizeProjectRef(opts.projectRef);
  if (!ref) return fail("invalid_project_ref", null);

  // Without an absolute project directory we would resolve ".clay/tasks"
  // against the daemon's own cwd - i.e. read some OTHER project. Fail closed.
  var cwd = typeof opts.cwd === "string" ? opts.cwd : "";
  if (!cwd) return fail("policy_unreadable", ref);

  var tasksDir = path.join(cwd, ".clay", "tasks");
  var listing = listTaskFiles(fsImpl, tasksDir);
  if (listing.status === "missing") return { ok: true, policy: restrictiveDefaultPolicy(ref) };
  if (listing.status === "unreadable") return fail("policy_unreadable", ref);

  var sources = [];
  var config = null;
  var i;

  if (contains(listing.names, "config.json")) {
    var configRead = readJsonFile(fsImpl, path.join(tasksDir, "config.json"));
    if (configRead.status === "unreadable") return fail("policy_unreadable", ref);
    if (configRead.status === "malformed") return fail("policy_malformed", ref);
    if (configRead.status === "ok") {
      if (!isPlainObject(configRead.value)) return fail("policy_malformed", ref);
      config = configRead.value;
      sources.push(TASKS_REL + "/config.json");
    }
  }

  // Parse every recipe file this project owns. A file that parses but declares
  // no `source` object is not a recipe - skipped, never an error.
  var parsedRecipes = [];
  for (i = 0; i < listing.names.length; i++) {
    var name = listing.names[i];
    if (name === "config.json") continue;
    var read = readJsonFile(fsImpl, path.join(tasksDir, name));
    if (read.status === "unreadable") return fail("policy_unreadable", ref);
    if (read.status === "malformed") return fail("policy_malformed", ref);
    if (read.status === "missing") continue;
    sources.push(TASKS_REL + "/" + name);
    var value = read.value;
    if (!isPlainObject(value) || !isPlainObject(value.source)) continue;
    var id = typeof value.id === "string" && value.id ? value.id : name.replace(/\.json$/i, "");
    parsedRecipes.push({ id: id, source: value.source, filter: value.filter });
  }
  sources.sort();

  var boardExclusions = deriveBoardExclusions(parsedRecipes);
  var vendors = normalizeWeights(config && isPlainObject(config.autoLaunch) ? config.autoLaunch.vendorWeights : null);
  var inventory = recipeInventory(parsedRecipes);

  // 1. Explicit `automation` block is authoritative for autonomy + external actions.
  if (config && Object.prototype.hasOwnProperty.call(config, "automation")) {
    var explicit = parseExplicit(config.automation);
    if (!explicit) return fail("policy_malformed", ref);
    return {
      ok: true,
      policy: buildPolicy(ref, false, explicit.autonomy, explicit.externalActions,
        boardExclusions, vendors, inventory, sources),
    };
  }

  // 2. No explicit block: derive from this project's own recipes.
  return {
    ok: true,
    policy: buildPolicy(ref, true, deriveAutonomy(parsedRecipes), restrictiveExternalActions(),
      boardExclusions, vendors, inventory, sources),
  };
}

module.exports = {
  CLASSES: CLASSES,
  AUTONOMY_VALUES: AUTONOMY_VALUES,
  EXTERNAL_VALUES: EXTERNAL_VALUES,
  EXTERNAL_ACTIONS: EXTERNAL_ACTIONS,
  loadProjectAutomationPolicy: loadProjectAutomationPolicy,
  policyDigest: policyDigest,
};
