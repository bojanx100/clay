// Tests for the per-project automation policy loader.
//
// Fixtures mirror real shapes: .clay/tasks/config.json (autoLaunch block as
// observed in production) and .clay/tasks/<recipe>.json launcher recipes.
// Everything runs against a REAL filesystem under os.tmpdir() so the ENOENT /
// unreadable / malformed branches are exercised for real.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var policyModule = require("../lib/project-automation-policy");

var REF_A = { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" };
var REF_B = { projectId: "11111111-2222-5333-8444-555555555555" };

var tmpRoots = [];

// Create an isolated project directory. `files` maps a .clay/tasks file name to
// either an object (JSON.stringified) or a raw string (written verbatim, so we
// can plant malformed JSON).
function makeProject(files) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-policy-"));
  tmpRoots.push(root);
  if (files) {
    var dir = path.join(root, ".clay", "tasks");
    fs.mkdirSync(dir, { recursive: true });
    var names = Object.keys(files);
    for (var i = 0; i < names.length; i++) {
      var body = files[names[i]];
      fs.writeFileSync(path.join(dir, names[i]),
        typeof body === "string" ? body : JSON.stringify(body, null, 2));
    }
  }
  return root;
}

test.after(function () {
  for (var i = 0; i < tmpRoots.length; i++) {
    try { fs.rmSync(tmpRoots[i], { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
});

function load(cwd, ref) {
  return policyModule.loadProjectAutomationPolicy({
    fs: fs,
    cwd: cwd,
    projectRef: ref || REF_A,
  });
}

var BUG_RECIPE = {
  id: "assigned-to-me",
  source: { provider: "github", kind: "issue", repo: "trialview/v2", ghAccount: "bojantv" },
  filter: { state: "open", assigned: "me", type: "bug", skipProjectStatuses: ["In progress", "Done"] },
};
var UNSCOPED_RECIPE = {
  id: "everything",
  source: { provider: "github", kind: "issue", repo: "trialview/v2" },
  filter: { state: "open", assigned: "me" },
};
var FEATURE_RECIPE = {
  id: "features",
  source: { provider: "github", kind: "issue", repo: "trialview/v2" },
  filter: { state: "open", type: "feature" },
};
var LEGACY_RECIPE = {
  id: "legacy",
  source: { provider: "github", repo: "trialview/v2" },
  filter: { state: "open", type: "legacy" },
};
var PR_RECIPE = {
  id: "pr-reviews",
  source: { provider: "github", kind: "pr-reviews", repo: "trialview/v2" },
  filter: { state: "open", skipProjectStatuses: ["blocked"] },
};

// --- Explicit policy ---------------------------------------------------------

test("explicit automation block wins and marks the policy as not derived", function () {
  var cwd = makeProject({
    "config.json": {
      autoLaunch: { enabled: true, vendorWeights: { claude: 70, codex: 30 } },
      automation: {
        autonomy: { bug: "autonomous", feature: "deny", ambiguous: "owner_approval", pr_review: "propose", default: "deny" },
        externalActions: { comment: "claim", done_workflow: "approval", merge: "deny", close: "approval" },
      },
    },
    // A bug recipe would DERIVE bug:autonomous anyway; the explicit block must
    // be what decides every other class.
    "assigned-to-me.json": BUG_RECIPE,
  });
  var result = load(cwd);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.policy.derived, false);
  assert.deepStrictEqual(result.policy.autonomy, {
    bug: "autonomous", feature: "deny", ambiguous: "owner_approval", pr_review: "propose", default: "deny",
  });
  assert.deepStrictEqual(result.policy.externalActions, { comment: "claim", done_workflow: "approval", merge: "deny", close: "approval" });
  assert.deepStrictEqual(result.policy.projectRef, REF_A);
  assert.deepStrictEqual(result.policy.providerRules, { vendors: { claude: 70, codex: 30 } });
  assert.deepStrictEqual(result.policy.recipes, [
    { id: "assigned-to-me", kind: "issue", repo: "trialview/v2", type: "bug" },
  ]);
  assert.deepStrictEqual(result.policy.sources,
    [".clay/tasks/assigned-to-me.json", ".clay/tasks/config.json"]);
  assert.match(result.policy.digest, /^[0-9a-f]{64}$/);
});

test("a partial explicit block falls back to the restrictive baseline, not to derivation", function () {
  var cwd = makeProject({
    "config.json": { automation: { autonomy: { feature: "deny" } } },
    "assigned-to-me.json": BUG_RECIPE,
  });
  var result = load(cwd);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.policy.derived, false);
  assert.strictEqual(result.policy.autonomy.feature, "deny");
  // Derivation would have granted bug:autonomous - an explicit block must not
  // inherit it silently.
  assert.strictEqual(result.policy.autonomy.bug, "propose");
  assert.deepStrictEqual(result.policy.externalActions,
    { comment: "approval", done_workflow: "approval", merge: "approval", close: "approval" });
});

test("unknown key inside automation is policy_malformed", function () {
  var cwd = makeProject({ "config.json": { automation: { autonomy: { bug: "deny" }, boardExclusions: ["done"] } } });
  assert.deepStrictEqual(load(cwd), { ok: false, reason: "policy_malformed", projectRef: REF_A });
});

test("unknown class name inside automation.autonomy is policy_malformed", function () {
  var cwd = makeProject({ "config.json": { automation: { autonomy: { chore: "deny" } } } });
  assert.deepStrictEqual(load(cwd), { ok: false, reason: "policy_malformed", projectRef: REF_A });
});

test("unknown autonomy value is policy_malformed", function () {
  var cwd = makeProject({ "config.json": { automation: { autonomy: { bug: "yolo" } } } });
  assert.deepStrictEqual(load(cwd), { ok: false, reason: "policy_malformed", projectRef: REF_A });
});

test("unknown external action or value is policy_malformed", function () {
  var badAction = makeProject({ "config.json": { automation: { externalActions: { force_push: "deny" } } } });
  assert.strictEqual(load(badAction).reason, "policy_malformed");
  var badValue = makeProject({ "config.json": { automation: { externalActions: { merge: "autonomous" } } } });
  assert.strictEqual(load(badValue).reason, "policy_malformed");
});

test("non-object automation blocks are policy_malformed", function () {
  var asString = makeProject({ "config.json": { automation: "autonomous" } });
  assert.strictEqual(load(asString).reason, "policy_malformed");
  var asArray = makeProject({ "config.json": { automation: [] } });
  assert.strictEqual(load(asArray).reason, "policy_malformed");
  var asNull = makeProject({ "config.json": { automation: null } });
  assert.strictEqual(load(asNull).reason, "policy_malformed");
  var nestedNonObject = makeProject({ "config.json": { automation: { autonomy: ["bug"] } } });
  assert.strictEqual(load(nestedNonObject).reason, "policy_malformed");
});

// --- Derivation --------------------------------------------------------------

test("a bug-scoped issue recipe derives autonomy.bug === autonomous", function () {
  var cwd = makeProject({ "assigned-to-me.json": BUG_RECIPE });
  var result = load(cwd);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.policy.derived, true);
  // The preserved-autonomy case: an existing bug launcher keeps its authority.
  assert.strictEqual(result.policy.autonomy.bug, "autonomous");
  assert.strictEqual(result.policy.autonomy.feature, "propose");
  assert.strictEqual(result.policy.autonomy.ambiguous, "propose");
  assert.strictEqual(result.policy.autonomy.pr_review, "propose");
  assert.strictEqual(result.policy.autonomy.default, "propose");
});

test("an unscoped issue recipe derives ambiguous === owner_approval and leaves bug alone", function () {
  var cwd = makeProject({ "everything.json": UNSCOPED_RECIPE });
  var result = load(cwd);
  assert.strictEqual(result.policy.autonomy.ambiguous, "owner_approval");
  assert.strictEqual(result.policy.autonomy.bug, "propose");
});

test("feature and legacy recipes derive autonomy.feature === owner_approval", function () {
  var featureCwd = makeProject({ "features.json": FEATURE_RECIPE });
  assert.strictEqual(load(featureCwd).policy.autonomy.feature, "owner_approval");
  var legacyCwd = makeProject({ "legacy.json": LEGACY_RECIPE });
  assert.strictEqual(load(legacyCwd).policy.autonomy.feature, "owner_approval");
  // Neither may leak autonomy into another class.
  assert.strictEqual(load(featureCwd).policy.autonomy.bug, "propose");
});

test("a pr-review recipe derives pr_review === propose and never autonomous", function () {
  var kinds = ["pr-reviews", "pr-review", "prs"];
  for (var i = 0; i < kinds.length; i++) {
    var recipe = { id: "pr", source: { provider: "github", kind: kinds[i], repo: "trialview/v2" }, filter: { type: "bug" } };
    var cwd = makeProject({ "pr.json": recipe });
    var policy = load(cwd).policy;
    assert.strictEqual(policy.autonomy.pr_review, "propose");
    assert.notStrictEqual(policy.autonomy.pr_review, "autonomous");
    // A PR recipe carrying a stray filter.type must not grant bug autonomy.
    assert.strictEqual(policy.autonomy.bug, "propose");
    assert.deepStrictEqual(policy.recipes, [{ id: "pr", kind: "pr_review", repo: "trialview/v2", type: "bug" }]);
  }
});

test("derivation never yields an external action other than approval", function () {
  var cwd = makeProject({
    "assigned-to-me.json": BUG_RECIPE,
    "everything.json": UNSCOPED_RECIPE,
    "features.json": FEATURE_RECIPE,
    "pr-reviews.json": PR_RECIPE,
  });
  var policy = load(cwd).policy;
  assert.strictEqual(policy.derived, true);
  var actions = Object.keys(policy.externalActions);
  assert.deepStrictEqual(actions.sort(), ["close", "comment", "done_workflow", "merge"]);
  for (var i = 0; i < actions.length; i++) {
    assert.strictEqual(policy.externalActions[actions[i]], "approval");
  }
});

test("boardExclusions union across recipes is lowercased, de-duplicated and sorted", function () {
  var cwd = makeProject({
    "assigned-to-me.json": BUG_RECIPE,           // In progress, Done
    "pr-reviews.json": PR_RECIPE,                // blocked
    "extra.json": {
      id: "extra",
      source: { provider: "github", kind: "issue", repo: "trialview/v2" },
      filter: { type: "bug", skipProjectStatuses: ["DONE", "Backlog"] },
    },
  });
  var policy = load(cwd).policy;
  assert.deepStrictEqual(policy.boardExclusions, ["backlog", "blocked", "done", "in progress"]);
});

test("providerRules.vendors keeps only positive integer weights", function () {
  var cwd = makeProject({
    "config.json": { autoLaunch: { vendorWeights: { claude: 70, codex: "30", gemini: 0, cursor: -5, junk: "abc" } } },
  });
  assert.deepStrictEqual(load(cwd).policy.providerRules, { vendors: { claude: 70, codex: 30 } });
});

test("recipes inventory is normalized and sorted by id", function () {
  var cwd = makeProject({
    "pr-reviews.json": PR_RECIPE,
    "assigned-to-me.json": BUG_RECIPE,
    "everything.json": UNSCOPED_RECIPE,
  });
  assert.deepStrictEqual(load(cwd).policy.recipes, [
    { id: "assigned-to-me", kind: "issue", repo: "trialview/v2", type: "bug" },
    { id: "everything", kind: "issue", repo: "trialview/v2", type: "" },
    { id: "pr-reviews", kind: "pr_review", repo: "trialview/v2", type: "" },
  ]);
});

// --- Missing directory -------------------------------------------------------

test("missing .clay/tasks yields the restrictive default and is not an error", function () {
  var cwd = makeProject(null);
  var result = load(cwd);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.policy.derived, true);
  assert.deepStrictEqual(result.policy.autonomy, {
    bug: "propose", feature: "propose", ambiguous: "propose", pr_review: "propose", default: "propose",
  });
  assert.deepStrictEqual(result.policy.externalActions,
    { comment: "approval", done_workflow: "approval", merge: "approval", close: "approval" });
  assert.deepStrictEqual(result.policy.sources, []);
  assert.deepStrictEqual(result.policy.recipes, []);
  assert.deepStrictEqual(result.policy.boardExclusions, []);
  assert.deepStrictEqual(result.policy.providerRules, { vendors: {} });
});

// --- Fail-closed -------------------------------------------------------------

test("malformed config.json is policy_malformed", function () {
  var unparseable = makeProject({ "config.json": "{ not json" });
  assert.deepStrictEqual(load(unparseable), { ok: false, reason: "policy_malformed", projectRef: REF_A });
  var notAnObject = makeProject({ "config.json": "[]" });
  assert.strictEqual(load(notAnObject).reason, "policy_malformed");
});

test("a malformed recipe json is policy_malformed and never falls back to permissive", function () {
  var cwd = makeProject({ "assigned-to-me.json": BUG_RECIPE, "broken.json": "{{{" });
  var result = load(cwd);
  assert.deepStrictEqual(result, { ok: false, reason: "policy_malformed", projectRef: REF_A });
  assert.strictEqual(result.policy, undefined);
});

test("a recipe file without a source object is skipped, not an error", function () {
  var cwd = makeProject({
    "assigned-to-me.json": BUG_RECIPE,
    "auto-launch-activity.json": { events: [] },
    "notes.json": { id: "notes", source: "github" },
  });
  var result = load(cwd);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.policy.recipes, [
    { id: "assigned-to-me", kind: "issue", repo: "trialview/v2", type: "bug" },
  ]);
  assert.strictEqual(result.policy.autonomy.bug, "autonomous");
});

test("an invalid projectRef is invalid_project_ref", function () {
  var cwd = makeProject({ "assigned-to-me.json": BUG_RECIPE });
  var bad = [null, undefined, {}, { projectId: "" }, { projectId: "not-a-uuid" }, "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9", []];
  for (var i = 0; i < bad.length; i++) {
    var result = policyModule.loadProjectAutomationPolicy({ fs: fs, cwd: cwd, projectRef: bad[i] });
    assert.deepStrictEqual(result, { ok: false, reason: "invalid_project_ref", projectRef: null });
  }
});

test("an unreadable .clay/tasks is policy_unreadable, never a permissive fallback", function () {
  var cwd = makeProject({ "assigned-to-me.json": BUG_RECIPE });
  var fakeFs = {
    readdirSync: function () { var err = new Error("EACCES"); err.code = "EACCES"; throw err; },
    readFileSync: function () { throw new Error("should not be reached"); },
  };
  var result = policyModule.loadProjectAutomationPolicy({ fs: fakeFs, cwd: cwd, projectRef: REF_A });
  assert.deepStrictEqual(result, { ok: false, reason: "policy_unreadable", projectRef: REF_A });
});

test("an unreadable policy file is policy_unreadable", function () {
  var cwd = makeProject({ "assigned-to-me.json": BUG_RECIPE });
  var fakeFs = {
    readdirSync: function () { return ["assigned-to-me.json"]; },
    readFileSync: function () { var err = new Error("EACCES"); err.code = "EACCES"; throw err; },
  };
  var result = policyModule.loadProjectAutomationPolicy({ fs: fakeFs, cwd: cwd, projectRef: REF_A });
  assert.deepStrictEqual(result, { ok: false, reason: "policy_unreadable", projectRef: REF_A });
});

test("a missing cwd fails closed rather than resolving against the daemon cwd", function () {
  var result = policyModule.loadProjectAutomationPolicy({ fs: fs, projectRef: REF_A });
  assert.deepStrictEqual(result, { ok: false, reason: "policy_unreadable", projectRef: REF_A });
});

// --- Digest ------------------------------------------------------------------

test("digest is stable across reloads and changes when the policy changes", function () {
  var cwd = makeProject({ "assigned-to-me.json": BUG_RECIPE });
  var first = load(cwd).policy;
  var second = load(cwd).policy;
  assert.strictEqual(first.digest, second.digest);
  assert.strictEqual(policyModule.policyDigest(first), first.digest);

  // Key order in the recipe file must not move the digest.
  var reordered = makeProject({
    "assigned-to-me.json": {
      filter: { skipProjectStatuses: ["In progress", "Done"], type: "bug", assigned: "me", state: "open" },
      source: { repo: "trialview/v2", kind: "issue", ghAccount: "bojantv", provider: "github" },
      id: "assigned-to-me",
    },
  });
  assert.strictEqual(load(reordered).policy.digest, first.digest);

  // Any real policy change must be detectable.
  var changed = makeProject({ "assigned-to-me.json": UNSCOPED_RECIPE });
  assert.notStrictEqual(load(changed).policy.digest, first.digest);

  // Same rules, different project -> different digest (the ref is bound in).
  assert.notStrictEqual(load(cwd, REF_B).policy.digest, first.digest);
});

test("policyDigest recomputes from a policy object and detects field edits", function () {
  var cwd = makeProject({ "assigned-to-me.json": BUG_RECIPE });
  var policy = load(cwd).policy;
  var tampered = JSON.parse(JSON.stringify(policy));
  tampered.externalActions.merge = "claim";
  assert.notStrictEqual(policyModule.policyDigest(tampered), policy.digest);
  // `sources` is provenance, not policy, so it is outside the digest.
  var provenanceOnly = JSON.parse(JSON.stringify(policy));
  provenanceOnly.sources = [];
  assert.strictEqual(policyModule.policyDigest(provenanceOnly), policy.digest);
});

// --- No global flattening ----------------------------------------------------

test("two projects with different recipes produce different policies", function () {
  var bugProject = makeProject({ "assigned-to-me.json": BUG_RECIPE });
  var prProject = makeProject({ "pr-reviews.json": PR_RECIPE });

  var bugPolicy = policyModule.loadProjectAutomationPolicy({ fs: fs, cwd: bugProject, projectRef: REF_A }).policy;
  var prPolicy = policyModule.loadProjectAutomationPolicy({ fs: fs, cwd: prProject, projectRef: REF_B }).policy;

  assert.strictEqual(bugPolicy.autonomy.bug, "autonomous");
  assert.strictEqual(prPolicy.autonomy.bug, "propose");
  assert.deepStrictEqual(bugPolicy.boardExclusions, ["done", "in progress"]);
  assert.deepStrictEqual(prPolicy.boardExclusions, ["blocked"]);
  assert.notStrictEqual(bugPolicy.digest, prPolicy.digest);
  assert.deepStrictEqual(bugPolicy.projectRef, REF_A);
  assert.deepStrictEqual(prPolicy.projectRef, REF_B);

  // Loading one project must not mutate or leak into the other.
  var reloaded = policyModule.loadProjectAutomationPolicy({ fs: fs, cwd: prProject, projectRef: REF_B }).policy;
  assert.strictEqual(reloaded.digest, prPolicy.digest);
  assert.strictEqual(reloaded.autonomy.bug, "propose");
});

// --- Exported constants ------------------------------------------------------

test("exported constants match the declared value sets", function () {
  assert.deepStrictEqual(policyModule.CLASSES, ["bug", "feature", "ambiguous", "pr_review"]);
  assert.deepStrictEqual(policyModule.AUTONOMY_VALUES, ["autonomous", "propose", "owner_approval", "deny"]);
  assert.deepStrictEqual(policyModule.EXTERNAL_VALUES, ["approval", "claim", "deny"]);
});
