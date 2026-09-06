var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var createRequire = require("module").createRequire;
var home = require("./helpers/isolated-clay-home");
var codexFixture = require("./helpers/codex-session-tools-server");
var readOnly = require("../lib/yoke/read-only-query");

function claudeAdapter(sdk) {
  // Evaluate the complete adapter, replacing only its external SDK import.
  // Both real query option builders and the worker IPC builder still execute.
  var file = require.resolve("../lib/yoke/adapters/claude");
  var module = { exports: {} };
  var scope = { module: module, exports: module.exports, require: createRequire(file),
    __filename: file, __dirname: path.dirname(file), process: process, console: console,
    Buffer: Buffer, AbortController: AbortController, setTimeout: setTimeout,
    clearTimeout: clearTimeout, setImmediate: setImmediate, testSDK: sdk };
  vm.runInNewContext(fs.readFileSync(file, "utf8") + "\n_sdkPromise = Promise.resolve(testSDK);", scope);
  return module.exports.createClaudeAdapter({ cwd: home });
}

[false, true].forEach(function (worker) {
  test("Claude " + (worker ? "worker IPC" : "in-process SDK") + " receives actual tool availability and strict MCP restrictions", async function () {
    var captured;
    var fakeSdk = { query: function (input) { captured = input.options; return { close: function () {} }; } };
    var adapter = claudeAdapter(fakeSdk);
    var co = { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      tools: ["Bash", "Edit"], settingSources: ["user", "project"], settings: { disableAllHooks: false } };
    if (worker) co = Object.assign({}, co, { linuxUser: "isolated-fixture-user", _workerState: { worker: {
      ready: true, process: { killed: false }, onMessage: function () {},
      send: function (message) { if (message.type === "query_start") captured = message.options; return true; },
    } } });
    var handle = await adapter.createQuery({ readOnlyExecution: true, adapterOptions: { CLAUDE: co },
      toolServers: { external: { command: "never-run" } }, toolServerDescriptors: [{ serverName: "external" }],
      resumeSessionId: "existing-conversation", cwd: home });
    assert.deepEqual(Array.from(captured.tools), ["Read", "Glob", "Grep"]);
    assert.equal(captured.strictMcpConfig, true);
    assert.equal(captured.settingSources.length, 0);
    assert.equal(captured.permissionMode, "default");
    assert.notEqual(captured.allowDangerouslySkipPermissions, true);
    assert.equal(captured.settings.disableAllHooks, true);
    assert.equal(captured.resume, "existing-conversation");
    assert.equal(Object.keys(captured.agents).length, 0);
    assert.equal((captured.mcpServerDescriptors || []).length, 0);
    assert.equal(Object.keys(captured.mcpServers || {}).length, 0);
    handle.close();
  });
});

test("Codex fresh and resumed queries remove native and dynamic external capabilities per thread", async function (t) {
  var f = await codexFixture.createFixture(t);
  var send = f.server.send.bind(f.server);
  f.server.send = async function (method, params) {
    var result = await send(method, params);
    if (method === "thread/read") return { thread: { status: { type: "idle" } } };
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    if (method === "thread/start" || method === "thread/resume") {
      result.sandbox = { type: "readOnly", networkAccess: false };
      result.approvalPolicy = "never";
    }
    return result;
  };
  for (var resume of [null, "existing-native-thread"]) {
    var q = await f.start({ readOnlyExecution: true, resumeSessionId: resume,
      toolPolicy: "allow-all", adapterOptions: { CODEX: { sandboxMode: "danger-full-access" } },
      toolServerDescriptors: [{ sessionScoped: true, serverName: "external", tools: [{ name: "mutate" }] }],
      callMcpTool: function () { throw new Error("External tool reached"); } });
    assert.equal(q.start.params.sandbox, "read-only");
    assert.equal(q.start.params.approvalPolicy, "never");
    assert.deepEqual(q.start.params.config, readOnly.codexConfig());
    assert.deepEqual(q.start.params.dynamicTools || [], []);
    f.complete(q);
    assert.equal(q.handle.pushMessage("Continue the same review"), true);
    await codexFixture.waitFor(function () { return f.server.nextTurn >= (resume ? 4 : 2); });
    q.handle.close();
  }
  var normal = await f.start({ toolPolicy: "allow-all",
    adapterOptions: { CODEX: { sandboxMode: "danger-full-access" } } });
  assert.equal(normal.start.params.sandbox, "danger-full-access");
  assert.equal(normal.start.params.config, undefined);
});

test("Codex refuses to start a turn if the server does not confirm the restricted sandbox", async function (t) {
  var f = await codexFixture.createFixture(t);
  var adapter = require("../lib/yoke/adapters/codex").contractTestKit;
  var handle = adapter.createQueryHandle(f.server, { readOnlyExecution: true, cwd: home,
    abortController: new AbortController(), interruptDrainTimeoutMs: 1 });
  handle.pushMessage("Inspect");
  var events = [];
  var timer = setTimeout(function () { handle.close(); }, 500);
  try { for await (var event of handle) events.push(event); }
  finally { clearTimeout(timer); handle.close(); }
  assert.equal(f.server.calls.some(function (call) { return call.method === "turn/start"; }), false);
  assert.match(JSON.stringify(events), /did not confirm the read-only sandbox/);
});
