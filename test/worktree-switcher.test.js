var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");

var helperPromise = null;
function loadHelpers() {
  if (!helperPromise) {
    var file = path.join(__dirname, "../lib/public/modules/worktree-family.js");
    var source = fs.readFileSync(file, "utf8");
    helperPromise = import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  }
  return helperPromise;
}

var projects = [
  { slug: "clay", project: "Clay", unread: 1, pendingPermissions: 0 },
  { slug: "clay--alpha", project: "alpha", isWorktree: true, parentSlug: "clay", branch: "feat/alpha", unread: 2, isProcessing: true },
  { slug: "clay--beta", project: "beta", isWorktree: true, parentSlug: "clay", branch: "feat/beta", pendingPermissions: 1, worktreeAccessible: false },
  { slug: "missing--orphan", project: "orphan", isWorktree: true, parentSlug: "missing", branch: "fix/orphan" },
];

test("familyOf resolves a parent from a worktree slug", async function() {
  var helpers = await loadHelpers();
  var family = helpers.familyOf(projects, "clay--alpha");
  assert.strictEqual(family.parent.slug, "clay");
  assert.deepStrictEqual(family.worktrees.map(function(p) { return p.slug; }), ["clay--alpha", "clay--beta"]);
});

test("familyOf preserves an orphan worktree without inventing a parent", async function() {
  var helpers = await loadHelpers();
  var family = helpers.familyOf(projects, "missing--orphan");
  assert.strictEqual(family.parent, null);
  assert.deepStrictEqual(family.worktrees.map(function(p) { return p.slug; }), ["missing--orphan"]);
});

test("family aggregation includes worktree activity and badges", async function() {
  var helpers = await loadHelpers();
  var family = helpers.familyOf(projects, "clay");
  var aggregate = helpers.aggregateFamily(family.parent, family.worktrees);
  assert.strictEqual(aggregate.isProcessing, true);
  assert.strictEqual(aggregate.unread, 3);
  assert.strictEqual(aggregate.pendingPermissions, 1);
  assert.strictEqual(family.worktrees[1].worktreeAccessible, false);
});

test("project rail never promotes a temporary worktree into its own tile", async function() {
  var helpers = await loadHelpers();
  var grouped = helpers.groupRailProjects(projects);
  assert.deepStrictEqual(grouped.parents.map(function (project) { return project.slug; }), ["clay"]);
  assert.deepStrictEqual(grouped.worktreesByParent.clay.map(function (project) {
    return project.slug;
  }), ["clay--alpha", "clay--beta"]);
  assert.equal(Object.hasOwn(grouped.worktreesByParent, "missing"), true);
});

test("switcher labels a worktree as parent and branch", async function() {
  var helpers = await loadHelpers();
  assert.strictEqual(helpers.switcherProjectName(projects, projects[1]), "Clay \u2387 feat/alpha");
});

test("worktree rail opens the active family without persisting a preference", async function() {
  var helpers = await loadHelpers();
  assert.strictEqual(helpers.worktreeFamilyExpanded("clay", projects.slice(1, 3), "clay", {}, false), false);
  assert.strictEqual(helpers.worktreeFamilyExpanded("clay", projects.slice(1, 3), "clay--alpha", {}, false), true);
  assert.strictEqual(helpers.worktreeFamilyExpanded("clay", projects.slice(1, 3), "clay--alpha", { clay: false }, false), false);
  assert.strictEqual(helpers.worktreeFamilyExpanded("clay", projects.slice(1, 3), "clay", { clay: false }, true), true);
});

test("desktop project families expose an accessible worktree disclosure", function () {
  var sidebar = fs.readFileSync(path.join(__dirname, "../lib/public/modules/sidebar-projects.js"), "utf8");
  var rail = fs.readFileSync(path.join(__dirname, "../lib/public/modules/sidebar-worktree-rail.js"), "utf8");
  var css = fs.readFileSync(path.join(__dirname, "../lib/public/css/icon-strip.css"), "utf8");

  assert.match(sidebar, /createWorktreeRailGroup\(el, p, worktrees\)/);
  assert.match(rail, /toggle\.setAttribute\("aria-expanded"/);
  assert.match(rail, /items\.hidden = !expanded/);
  assert.match(rail, /switchProject\(worktree\.slug, \{ exactProject: true \}\)/);
  assert.match(rail, /expandedWorktreeFamilies/);
  assert.doesNotMatch(rail, /localStorage/);
  assert.match(css, /\.icon-strip-group-toggle/);
  assert.match(css, /\.icon-strip-group-items\[hidden\]/);
  assert.match(css, /\.icon-strip-wt-item\.active/);
});
