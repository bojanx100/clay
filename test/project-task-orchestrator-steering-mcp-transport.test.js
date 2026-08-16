var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
require("./helpers/isolated-clay-home");
var attachTaskOrchestrator = require("../lib/project-task-orchestrator").attachTaskOrchestrator;
var orchestrationMcp = require("../lib/orchestration-mcp-server");
var createCrossProjectRouter = require("../lib/server-cross-project").createCrossProjectRouter;
var CallToolResultSchema = require("@modelcontextprotocol/sdk/types.js").CallToolResultSchema;

var LEAD_PROJECT_ID = "system-lead";
var TARGET_PROJECT_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var COOP_ID = "coop-steering-transport";
var ROOT_ID = "coop-control-plane-root";
var TASK_ID = "steering-binding-pending-transport";

function testContext(router) {
  var sessions = new Map();
  var starts = [];
  var sm = {
    sessions: sessions,
    getProjectId: function () { return LEAD_PROJECT_ID; },
    createSessionRaw: function (opts) {
      var session = Object.assign({ localId: sessions.size + 2, history: [] }, opts);
      sessions.set(session.localId, session);
      return session;
    },
    appendToSessionFile: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    hideSession: function () {},
    subscribeSession: function () { return function () {}; },
  };
  var api = attachTaskOrchestrator({
    crossProject: router,
    slug: "lead",
    sm: sm,
    sdk: {
      startQuery: function (session) { starts.push(session); },
      pushMessage: function () {},
    },
    sendToSession: function () {},
    onProcessingChanged: function () {},
    ensureProjectAccessForSession: function () {},
  });
  var coop = {
    localId: 1,
    storageId: COOP_ID,
    coopHome: true,
    coordinationMode: true,
    orchestrationTasks: [],
    orchestrationEvents: [],
    history: [],
    isProcessing: false,
  };
  sessions.set(coop.localId, coop);
  return { api: api, coop: coop, sessions: sessions, starts: starts };
}

function pendingBinding() {
  return {
    portfolioTaskId: TASK_ID,
    mode: "project_coordinator",
    targetProject: { projectId: TARGET_PROJECT_ID },
    bindingRevision: 1,
    idempotencyKey: "steering-binding-pending-r1",
    source: { projectId: LEAD_PROJECT_ID, sessionStorageId: COOP_ID },
    projectCoordinator: { projectId: LEAD_PROJECT_ID, sessionStorageId: ROOT_ID },
    status: "unrouted",
    statusReason: "pre_task_failure: delivery_error",
    createdAt: 1786804088786,
    updatedAt: 1786804088805,
    unroutedAt: 1786804088805,
  };
}

function steeringInput() {
  return {
    coordinatorSessionId: COOP_ID,
    targetProject: { projectId: TARGET_PROJECT_ID },
    targetCoordinator: { projectId: LEAD_PROJECT_ID, sessionStorageId: ROOT_ID },
    portfolioTaskId: TASK_ID,
    bindingRevision: 1,
    idempotencyKey: "steer-while-child-pending",
    message: "Continue once the project coordinator child is available.",
  };
}

function steeringDefinition(ctx) {
  var noop = function () {};
  return orchestrationMcp.getToolDefs(
    noop, noop, noop, noop, noop, noop, noop, noop, noop,
    function (input) { return ctx.api.steerProjectCoordinatorFromTool(input); }
  ).find(function (definition) {
    return definition.name === "steer_project_coordinator";
  });
}

function steeringHandler(ctx) {
  return steeringDefinition(ctx).handler;
}

test("MCP steering preserves retryable binding_pending without creating duplicate execution state", async function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-steering-transport-"));
  t.after(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  var bindingFile = path.join(dir, "bindings.json");
  fs.writeFileSync(bindingFile, JSON.stringify({
    schema: "clay.portfolio_execution_bindings",
    version: 2,
    bindings: [pendingBinding()],
  }, null, 2) + "\n");
  var router = createCrossProjectRouter({
    bindingFile: bindingFile,
    deliveryFile: path.join(dir, "delivery.json"),
  });
  var ctx = testContext(router);
  var definition = steeringDefinition(ctx);
  var handler = definition.handler;
  var beforeBinding = router.getExecutionBinding(TASK_ID, 1);
  var beforeBytes = fs.readFileSync(bindingFile, "utf8");
  var beforeSessions = ctx.sessions.size;
  var beforeTasks = ctx.coop.orchestrationTasks.length;
  var beforeFanIn = ctx.coop.orchestrationEvents.length;

  var first = await handler(steeringInput());
  assert.equal(first.isError, true);
  assert.equal(first.reason, "binding_pending");
  assert.equal(first.retryable, true);
  assert.deepEqual(first.binding, beforeBinding);
  assert.match(first.content[0].text, /requires attention: binding_pending/);
  // The real MCP CallToolResult schema is loose, so these transport fields
  // survive without structuredContent. That field is required only when a
  // tool declares an outputSchema, which this text-compatible tool does not.
  assert.equal(Object.hasOwn(definition, "outputSchema"), false);
  var protocolResult = CallToolResultSchema.parse(first);
  assert.deepEqual(protocolResult, first);
  assert.equal(protocolResult.structuredContent, undefined);

  var retry = await handler(steeringInput());
  assert.deepEqual(retry, first);
  assert.equal(fs.readFileSync(bindingFile, "utf8"), beforeBytes);
  assert.equal(router.bindingStore.list().length, 1);
  assert.equal(ctx.sessions.size, beforeSessions);
  assert.equal(ctx.starts.length, 0);
  assert.equal(ctx.coop.orchestrationTasks.length, beforeTasks);
  assert.equal(ctx.coop.orchestrationEvents.length, beforeFanIn);

  var mismatch = await handler(Object.assign({}, steeringInput(), {
    targetCoordinator: { projectId: LEAD_PROJECT_ID, sessionStorageId: "wrong-root" },
    idempotencyKey: "steer-wrong-coordinator",
  }));
  assert.equal(mismatch.isError, true);
  assert.equal(Object.hasOwn(mismatch, "reason"), false);
  assert.equal(Object.hasOwn(mismatch, "retryable"), false);
  assert.equal(Object.hasOwn(mismatch, "binding"), false);
  assert.match(mismatch.content[0].text, /requires attention: coordinator_ref_mismatch/);
});

test("MCP steering keeps successful results unchanged", async function () {
  var calls = [];
  var ctx = testContext({
    messageProjectExecution: function (input) {
      calls.push(input);
      return { ok: true };
    },
  });
  var result = await steeringHandler(ctx)(steeringInput());

  assert.equal(result.isError, undefined);
  assert.equal(Object.hasOwn(result, "retryable"), false);
  assert.equal(Object.hasOwn(result, "binding"), false);
  assert.deepEqual(calls[0].targetCoordinator,
    { projectId: LEAD_PROJECT_ID, sessionStorageId: ROOT_ID });
  assert.match(result.content[0].text, /Steered Coop project coordinator/);
});
