var test = require("node:test");
var assert = require("node:assert/strict");
var getToolDefs = require("../lib/scheduler-mcp-server").getToolDefs;
var createProjectLocalMcpServers =
  require("../lib/project-local-mcp-servers").createProjectLocalMcpServers;
var attachBridgePermissions =
  require("../lib/sdk-bridge-permissions").attachBridgePermissions;
var CLAY_MANAGED_ALLOW = require("../lib/claude-hook-installer").CLAY_MANAGED_ALLOW;

function toolMap(handler) {
  var tools = getToolDefs(handler);
  var mapped = {};
  for (var i = 0; i < tools.length; i++) mapped[tools[i].name] = tools[i];
  return mapped;
}

function parsed(result) {
  return JSON.parse(result.content[0].text);
}

test("scheduler MCP exposes the complete typed operation surface", function () {
  var tools = getToolDefs(function () { return { ok: true }; });
  assert.deepEqual(tools.map(function (tool) { return tool.name; }), [
    "scheduler_list", "scheduler_get", "scheduler_create", "scheduler_update",
    "scheduler_pause", "scheduler_resume", "scheduler_run_now", "scheduler_history",
    "scheduler_delete",
  ]);
});

test("scheduler MCP routes typed inputs and preserves structured errors", async function () {
  var calls = [];
  var tools = toolMap(function (action, input) {
    calls.push({ action: action, input: input });
    if (action === "remove") return { ok: false, code: "confirmation_required" };
    return { ok: true, action: action };
  });
  var listed = await tools.scheduler_list.handler({ enabledOnly: true });
  var removed = await tools.scheduler_delete.handler({ id: "loop_1", confirmName: "Wrong" });
  assert.deepEqual(parsed(listed), { ok: true, action: "list" });
  assert.equal(listed.isError, false);
  assert.equal(parsed(removed).code, "confirmation_required");
  assert.equal(removed.isError, true);
  assert.deepEqual(calls, [
    { action: "list", input: { enabledOnly: true } },
    { action: "remove", input: { id: "loop_1", confirmName: "Wrong" } },
  ]);
});

test("scheduler MCP turns handler failures into tool errors", async function () {
  var tools = toolMap(function () { throw new Error("not ready"); });
  var response = await tools.scheduler_get.handler({ id: "loop_1" });
  assert.equal(response.isError, true);
  assert.deepEqual(parsed(response), {
    ok: false,
    code: "scheduler_unavailable",
    message: "not ready",
  });
});

test("project sessions receive scheduler tools while autonomous runs do not", async function () {
  var schedulerGate = {
    service: {
      list: function () { return { ok: true, schedules: [] }; },
    },
  };
  var local = createProjectLocalMcpServers({
    adapter: { createToolServer: function (config) { return config; } },
    isMate: false,
    isHostAgent: false,
    slug: "test",
    sm: {},
    clients: new Set(),
    browserState: {},
    sendExtensionCommandAny: function () { return Promise.reject(new Error("not connected")); },
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    getAllProjectsWithSessions: function () { return []; },
    pendingDebateProposals: {},
    email: {
      createMcpDeps: function () { return {}; },
      hasEmailCapability: function () { return false; },
    },
    mateDatastore: {},
    schedulerGate: schedulerGate,
  });
  var interactive = local.getLocalMcpServers({});
  assert.ok(interactive["clay-scheduler"]);
  assert.equal(interactive["clay-scheduler"].tools.length, 9);
  var listTool = interactive["clay-scheduler"].tools.find(function (tool) {
    return tool.name === "scheduler_list";
  });
  assert.deepEqual(parsed(await listTool.handler({})), { ok: true, schedules: [] });
  var autonomous = local.getLocalMcpServers({ loop: { active: true, role: "coder" } });
  assert.equal(autonomous["clay-scheduler"], undefined);
  assert.ok(autonomous["clay-browser"]);
});

test("only scheduler read operations bypass the interactive permission prompt", function () {
  var permissions = attachBridgePermissions({
    sm: {},
    sendAndRecord: function () {},
    onProcessingChanged: function () {},
    pushModule: null,
    getNotificationsModule: function () { return null; },
    getRemoteMcpServers: function () { return null; },
    slug: "test",
    adapter: { vendor: "claude" },
  });
  assert.deepEqual(permissions.checkToolWhitelist(
    "mcp__clay-scheduler__scheduler_list", {}), { behavior: "allow", updatedInput: {} });
  assert.equal(permissions.checkToolWhitelist(
    "mcp__clay-scheduler__scheduler_create", {}), null);
  assert.ok(CLAY_MANAGED_ALLOW.indexOf("mcp__clay-scheduler__scheduler_get") !== -1);
  assert.equal(CLAY_MANAGED_ALLOW.indexOf("mcp__clay-scheduler__scheduler_delete"), -1);
});
