var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { attachTaskSetup } = require("../lib/project-task-setup");

function makeSetup() {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-setup-"));
  fs.mkdirSync(path.join(cwd, ".clay", "tasks"), { recursive: true });
  var replies = [];
  var setup = attachTaskSetup({
    cwd: cwd,
    slug: "test",
    sendTo: function (ws, payload) { replies.push(payload); },
    send: function () {},
  });
  return { setup: setup, cwd: cwd, replies: replies };
}

function readRecipe(cwd, id) {
  return JSON.parse(fs.readFileSync(path.join(cwd, ".clay", "tasks", id + ".json"), "utf8"));
}

test("setup wizard refuses to overwrite a PR-review recipe", function () {
  var h = makeSetup();
  var prPath = path.join(h.cwd, ".clay", "tasks", "pr-review.json");
  var original = {
    id: "pr-review",
    name: "Auto-fix my PRs",
    source: { provider: "github", kind: "pr-reviews", repo: "acme/app" },
  };
  fs.writeFileSync(prPath, JSON.stringify(original, null, 2));

  h.setup.handleMessage({}, {
    type: "task_setup_update",
    config: { repo: "acme/app", recipeId: "pr-review" },
  });

  var result = h.replies.find(function (r) { return r.type === "task_setup_result"; });
  assert.ok(result, "expected a task_setup_result reply");
  assert.strictEqual(result.ok, false, "save should be refused");
  assert.match(result.error, /PR-review recipe/);

  // The PR recipe on disk must be untouched (still kind: pr-reviews).
  var after = readRecipe(h.cwd, "pr-review");
  assert.strictEqual(after.source.kind, "pr-reviews");
  fs.rmSync(h.cwd, { recursive: true, force: true });
});

test("setup wizard still writes a normal issue recipe", function () {
  var h = makeSetup();
  h.setup.handleMessage({}, {
    type: "task_setup_update",
    config: { repo: "acme/app", recipeId: "assigned-to-me" },
  });
  var result = h.replies.find(function (r) { return r.type === "task_setup_result"; });
  assert.ok(result && result.ok, "issue recipe save should succeed: " + (result && result.error));
  var recipe = readRecipe(h.cwd, "assigned-to-me");
  assert.strictEqual(recipe.source.kind, "issue");
  fs.rmSync(h.cwd, { recursive: true, force: true });
});
