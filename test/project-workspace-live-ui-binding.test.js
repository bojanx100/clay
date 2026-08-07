var test = require("node:test");
var assert = require("node:assert");
var binding = require("../lib/project-workspace-live-ui-binding");

test("Live UI reconnect ignores a stale server binding and uses the current worktree", function () {
  var root = binding.editableRoot("/repo/clay", {
    devCwd: "/repo/clay-worktrees/current",
  });
  assert.strictEqual(root, "/repo/clay-worktrees/current");
});

test("Live UI reconnect accepts only the exact server origin for the current root", function () {
  var result = binding.reconnectTarget(
    "/repo/clay-worktrees/current",
    "http://localhost:4242/account",
    {
      localUrl: "http://localhost:4242",
      tailscaleUrl: "https://clay-device.example.ts.net:4242",
      running: true,
      portLive: true,
    }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.target.writableRoot,
    "/repo/clay-worktrees/current");

  var remote = binding.reconnectTarget(
    "/repo/clay-worktrees/current",
    "https://clay-device.example.ts.net:4242/account",
    {
      localUrl: "http://localhost:4242",
      tailscaleUrl: "https://clay-device.example.ts.net:4242",
      running: true,
      portLive: true,
    }
  );
  assert.strictEqual(remote.ok, true);
});

test("Live UI reconnect refuses another worktree's server", function () {
  var result = binding.reconnectTarget(
    "/repo/clay-worktrees/current",
    "http://localhost:4243/account",
    {
      localUrl: "http://localhost:4242",
      running: true,
      portLive: true,
    }
  );
  assert.deepStrictEqual(result, {
    ok: false,
    code: "LIVE_UI_SERVER_ROOT_MISMATCH",
    error: "The inspected page is served from a different project root or worktree",
  });
});
