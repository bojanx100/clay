var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

async function loadState() {
  var file = path.join(__dirname, "..", "lib", "public", "modules",
    "workspace-panel-state.js");
  return await import(pathToFileURL(file).href);
}

// The skeleton the server sends first on every (re)fetch: local data only, with
// the GitHub half deliberately emptied.
function skeleton(extra) {
  return Object.assign({
    type: "workspace_state",
    sessionId: 7,
    partial: true,
    branch: "bojan",
    worktree: null,
    dev: { running: true, port: 5173 },
    board: null,
    pr: null,
    items: [],
    truncatedItems: 0,
  }, extra || {});
}

function loaded(extra) {
  return Object.assign({
    type: "workspace_state",
    sessionId: 7,
    partial: false,
    branch: "bojan",
    worktree: null,
    dev: { running: true, port: 5173 },
    board: { name: "Roadmap" },
    pr: { number: 42, title: "Fix the thing" },
    items: [{ number: 201, title: "On hover owner should see data" }],
    truncatedItems: 0,
  }, extra || {});
}

test("a refetch skeleton does not wipe the GitHub half already on screen", async function () {
  var mod = await loadState();
  var current = loaded();
  // This is the regression: session activity advances, the panel refetches, and
  // the skeleton arrives seconds before the GitHub enrichment. Storing it as-is
  // blanked the issues, PR and board the owner was looking at.
  var merged = mod.mergeWorkspaceState(current, skeleton());
  assert.deepEqual(merged.items, current.items);
  assert.deepEqual(merged.pr, current.pr);
  assert.deepEqual(merged.board, current.board);
  assert.equal(merged.truncatedItems, 0);
  // Local fields from the skeleton still win -- that is what the refetch is for.
  assert.equal(merged.branch, "bojan");
  assert.deepEqual(merged.dev, { running: true, port: 5173 });
  // Still partial: the GitHub half is genuinely in flight, so the panel must
  // keep loading it rather than treating this as a finished state.
  assert.equal(merged.partial, true);
});

test("a skeleton carrying new local context still applies it", async function () {
  var mod = await loadState();
  var merged = mod.mergeWorkspaceState(loaded(), skeleton({
    branch: "feature-branch",
    worktree: { path: "/tmp/wt", branch: "feature-branch" },
    dev: { running: false },
  }));
  assert.equal(merged.branch, "feature-branch");
  assert.deepEqual(merged.worktree, { path: "/tmp/wt", branch: "feature-branch" });
  assert.deepEqual(merged.dev, { running: false });
  assert.equal(merged.items.length, 1, "the loaded GitHub half survives the switch");
});

test("the full state replaces the merged skeleton wholesale", async function () {
  var mod = await loadState();
  // An enrichment that legitimately returns nothing must be able to clear the
  // panel, otherwise stale issues would outlive the refs that produced them.
  var empty = loaded({ items: [], pr: null, board: null });
  var merged = mod.mergeWorkspaceState(loaded(), empty);
  assert.equal(merged, empty);
  assert.deepEqual(merged.items, []);
  assert.equal(merged.pr, null);
});

test("merging is a no-op without a loaded state to protect", async function () {
  var mod = await loadState();
  var first = skeleton();
  // Nothing cached yet: the skeleton is the state.
  assert.equal(mod.mergeWorkspaceState(null, first), first);
  assert.equal(mod.mergeWorkspaceState(undefined, first), first);
  // A cached skeleton has no GitHub half worth keeping either.
  assert.equal(mod.mergeWorkspaceState(skeleton(), first), first);
  // A missing message is passed straight through rather than fabricated.
  assert.equal(mod.mergeWorkspaceState(loaded(), null), null);
});
