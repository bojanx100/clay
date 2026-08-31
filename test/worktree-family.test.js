var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

async function familyModule() {
  var file = path.join(__dirname, "..", "lib", "public", "modules", "worktree-family.js");
  return await import(pathToFileURL(file).href);
}

test("connection metadata hydrates a project icon before its project list arrives", async function () {
  var family = await familyModule();
  var initial = family.displayProjectIdentity([], "clay", "Clay", "🧱");
  assert.deepEqual(initial, { name: "Clay", icon: "🧱" });

  // Once the list is present, a worktree keeps its parent identity rather than
  // trusting its own stale copy of the icon.
  var hydrated = family.displayProjectIdentity([
    { slug: "clay", title: "Clay", icon: "🧱" },
    { slug: "clay--feature", title: "Feature", icon: "old", isWorktree: true, parentSlug: "clay" },
  ], "clay--feature", "Feature", "old");
  assert.deepEqual(hydrated, { name: "Clay", icon: "🧱" });
});
