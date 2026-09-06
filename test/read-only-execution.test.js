var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var home = require("./helpers/isolated-clay-home");
var createManager = require("../lib/sessions").createSessionManager;
var createBridge = require("../lib/sdk-bridge").createSDKBridge;
var authority = require("../lib/read-only-execution");
var grant = require("../lib/coop-autonomy-grant");

function fixture(t, vendor) {
  vendor = vendor || "codex";
  var dir = fs.mkdtempSync(path.join(home, "readonly-"));
  var sm = createManager({ cwd: dir, send: function () {} });
  var options = [];
  var messages = [];
  var permissionOverrides = [];
  var end;
  var pending = new Promise(function (resolve) { end = resolve; });
  var handle = { pushMessage: function (text) { messages.push(text); return true; },
    setPermissionMode: function (mode) { permissionOverrides.push(mode); } };
  handle[Symbol.asyncIterator] = function () { return { next: function () { return pending; } }; };
  var adapter = { vendor: vendor, createQuery: async function (value) { options.push(value); return handle; } };
  sm.defaultVendor = vendor;
  sm.modelsByVendor = {}; sm.modelsByVendor[vendor] = ["fixture-model"];
  var adapters = {}; adapters[vendor] = adapter;
  var bridge = createBridge({ cwd: dir, sessionManager: sm, adapter: adapter,
    adapters: adapters, dangerouslySkipPermissions: true, send: function () {},
    mcpServers: { dangerous: { type: "stdio", command: "must-never-launch" } } });
  var session = sm.getActiveSession();
  session.vendor = vendor; session.model = "fixture-model";
  session.permissionMode = "bypassPermissions";
  session.allowedTools = { Edit: true };
  // Exercise the real standing admission predicate against a real policy file.
  var policy = JSON.parse(fs.readFileSync(path.join(__dirname, "../scoped-autonomy-policy.json")));
  policy.enabled = true; policy.categories = ["read_only_diagnosis"];
  var file = path.join(dir, "autonomy.json"); fs.writeFileSync(file, JSON.stringify(policy));
  var admitted = grant.standingAdmission({ title: "Diagnose the parser", objective: "Inspect evidence.",
    ownedPaths: "read-only: lib/parser.js" }, {
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
  }, { autonomyPolicyFile: file });
  assert.equal(admitted.ok, true);
  session.orchestrationPolicy = { portfolioExecution: { reviewOnly: admitted.reviewOnly } };
  t.after(async function () { end({ done: true }); if (session.streamPromise) await session.streamPromise; });
  return { sm: sm, session: session, bridge: bridge, options: options, messages: messages,
    permissionOverrides: permissionOverrides, dir: dir };
}

["claude", "codex"].forEach(function (vendor) {
  test(vendor + " admitted read-only evidence overrides bypass preferences on fresh, resumed and warm turns", async function (t) {
    var f = fixture(t, vendor);
    f.session.cliSessionId = "existing-provider-thread";
    var started = await f.bridge.startQuery(f.session, "Inspect the parser", null, null);
    assert.equal(started.ok, true);
    var options = f.options[0];
    assert.equal(options.resumeSessionId, "existing-provider-thread");
    assert.equal(options.readOnlyExecution, true);
    assert.deepEqual(options.toolServers, {});
    assert.deepEqual(options.toolServerDescriptors, []);
    assert.equal(options.adapterOptions.CODEX.sandboxMode, "read-only");
    assert.equal(options.adapterOptions.CODEX.approvalPolicy, "never");
    assert.equal(options.adapterOptions.CLAUDE.allowDangerouslySkipPermissions, false);
    assert.deepEqual(options.adapterOptions.CLAUDE.tools, ["Read", "Glob", "Grep"]);
    assert.equal((await options.canUseTool("Edit", { file_path: "parser.js" }, {})).behavior, "deny");
    assert.equal((await f.bridge.handleCanUseTool(f.session, "Edit", {}, {})).behavior, "deny");
    assert.equal((await options.canUseTool("Bash", { command: "echo changed > parser.js" }, {})).behavior, "deny");
    assert.equal((await options.canUseTool("Read", { file_path: "parser.js" }, {})).behavior, "allow");
    assert.throws(function () { options.callMcpTool("dangerous", "mutate", {}); }, /read-only/);
    assert.equal((await options.onElicitation({ serverName: "dangerous" }, {})).action, "decline");
    await f.bridge.setPermissionMode(f.session, "bypassPermissions");
    assert.equal(f.permissionOverrides.length, 0);
    assert.equal(f.bridge.pushMessage(f.session, "Continue reading"), true);
    assert.equal(f.messages.length, 2);
  });
});

test("an old unrestricted warm handle cannot receive newly restricted work", function (t) {
  var f = fixture(t);
  f.session.queryInstance = { pushMessage: function () { throw new Error("unsafe warm dispatch"); } };
  assert.equal(f.bridge.pushMessage(f.session, "Inspect only"), false);
});

test("unsupported evidence providers refuse before a provider query is constructed", async function (t) {
  var f = fixture(t, "github-copilot");
  assert.equal((await f.bridge.startQuery(f.session, "Inspect", null, null)).ok, false);
  assert.equal(f.options.length, 0);
  assert.match(JSON.stringify(f.session.history), /Read-only execution is not supported/);
});

test("inherited authority survives a real session-store reload without the parent", function (t) {
  var f = fixture(t);
  var worker = f.sm.createSessionRaw({ storageId: "read-only-child" });
  authority.inherit(f.session, worker, f.sm);
  assert.equal(f.sm.saveSessionFile(worker, { durable: true }), true);
  var restored = createManager({ cwd: f.dir, send: function () {} });
  var child = Array.from(restored.sessions.values()).find(function (s) { return s.storageId === worker.storageId; });
  assert.ok(child);
  assert.equal(authority.isReadOnly(child, { sessions: new Map([[child.localId, child]]) }), true);
});

test("older children resolve restricted authority through the real stable parent reference", function (t) {
  var f = fixture(t);
  var child = f.sm.createSessionRaw({ storageId: "legacy-child" });
  var unrelated = f.sm.createSessionRaw({ storageId: "wrong-parent" });
  child.orchestrationParent = { sessionStorageId: f.session.storageId, sessionId: unrelated.localId };
  assert.equal(authority.isReadOnly(child, f.sm), true);
  child.orchestrationParent.sessionStorageId = unrelated.storageId;
  assert.equal(authority.isReadOnly(child, f.sm), false, "a reused local id cannot override stable identity");
});

test("startup retains older child authority before graph cleanup can detach its parent", function (t) {
  var f = fixture(t);
  var child = f.sm.createSessionRaw({ storageId: "older-stored-child" });
  child.orchestrationParent = { sessionStorageId: f.session.storageId, taskId: "spent-task" };
  f.sm.saveSessionFile(child, { durable: true });
  var api = require("../lib/project-task-orchestrator").attachTaskOrchestrator({ sm: f.sm,
    sdk: f.bridge, sendToSession: function () {}, ensureProjectAccessForSession: function () {} });
  t.after(api.stopCoopWatchdog);
  assert.equal(child.orchestrationPolicy.readOnlyExecution, true);
  delete child.orchestrationParent;
  assert.equal(authority.isReadOnly(child, f.sm), true);
  var restored = createManager({ cwd: f.dir, send: function () {} });
  var saved = Array.from(restored.sessions.values()).find(function (s) { return s.storageId === child.storageId; });
  assert.equal(authority.isReadOnly(saved, { sessions: new Map() }), true);
});

test("failed retention cannot leave a false in-memory persistence receipt", function (t) {
  var f = fixture(t);
  var child = f.sm.createSessionRaw({ storageId: "failed-retention" });
  child.orchestrationParent = { sessionStorageId: f.session.storageId };
  var save = f.sm.saveSessionFile;
  f.sm.saveSessionFile = function () { return false; };
  assert.throws(function () { authority.retain(child, f.sm); }, /could not be saved/);
  assert.equal(child.orchestrationPolicy, undefined);
  f.sm.saveSessionFile = save;
  authority.retain(child, f.sm);
  assert.equal(child.orchestrationPolicy.readOnlyExecution, true);
});

test("ordinary owner sessions keep their existing writable query configuration", async function (t) {
  var f = fixture(t);
  delete f.session.orchestrationPolicy;
  assert.equal((await f.bridge.startQuery(f.session, "Implement my change", null, null)).ok, true);
  assert.notEqual(f.options[0].readOnlyExecution, true);
  assert.equal(f.options[0].adapterOptions.CODEX.sandboxMode, "danger-full-access");
  assert.equal((await f.options[0].canUseTool("Edit", {}, {})).behavior, "allow");
});
