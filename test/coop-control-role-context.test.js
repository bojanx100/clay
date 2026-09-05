var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var crypto = require("node:crypto");
var controlPlane = require("../lib/coop-control-plane");
var createRouter = require("../lib/server-cross-project").createCrossProjectRouter;
var createSDKBridge = require("../lib/sdk-bridge").createSDKBridge;

var PROJECT = "11111111-1111-5111-8111-111111111111";
var OTHER = "22222222-2222-5222-8222-222222222222";

function manager(projectId) {
  var sessions = new Map();
  return {
    sessions: sessions, modelsByVendor: { codex: ["gpt-5.6-terra"] },
    getProjectId: function () { return projectId; },
    saveSessionFile: function () { return true; },
    broadcastSessionList: function () {}, sendToSession: function () {},
    createSessionRaw: function (input) {
      var session = Object.assign({ localId: sessions.size + 1, storageId: crypto.randomUUID(),
        history: [], vendor: "codex", model: "gpt-5.6-terra" }, input || {});
      sessions.set(session.localId, session);
      return session;
    },
  };
}

function fixture(t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-control-role-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var lead = manager("system-lead");
  var coop = lead.createSessionRaw({ coopHome: true });
  var router = createRouter({ bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json") });
  function register(projectId, name, isWorktree, sm) {
    sm = sm || manager(projectId);
    var cwd = path.join(dir, name);
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "Rules for " + name);
    var state = { projectId: projectId, path: cwd, title: "Same title", isWorktree: !!isWorktree };
    var context = { getProjectId: function () { return projectId; },
      getStatus: function () { return state; },
      getSessionManager: function () { return sm; } };
    return { cwd: cwd, context: context, unregister: router.registerProjectResolver(context) };
  }
  var leadProject = register("system-lead", "lead", false, lead);
  var worktree = register(PROJECT, "worktree", true);
  var other = register(OTHER, "other", false);
  var target = register(PROJECT, "canonical", false);
  fs.mkdirSync(path.join(target.cwd, "localAIConfig"));
  fs.writeFileSync(path.join(target.cwd, "localAIConfig/AGENTS.local.md"), "Require explicit owner acceptance.");
  fs.writeFileSync(path.join(target.cwd, "localAIConfig/TRIAGE.local.md"), "Inspect existing automation before staffing.");
  var root = controlPlane.ensureProjectCoordinator(lead, { projectId: PROJECT }, "Same title",
    { projectId: "system-lead", sessionStorageId: coop.storageId });
  return { dir: dir, lead: lead, coop: coop, root: root, router: router, target: target,
    leadProject: leadProject, other: other, worktree: worktree, register: register };
}

function snapshot(text) {
  var match = text.match(/<clay_control_context>\n([\s\S]*?)\n<\/clay_control_context>/);
  assert.ok(match, "the provider receives server-resolved control context");
  return JSON.parse(match[1]);
}

function bridgeFixture(t, f) {
  var messages = [];
  var options = [];
  var finish;
  var end = new Promise(function (resolve) { finish = resolve; });
  var handle = { pushMessage: function (text, images) { messages.push({ text: text, images: images }); } };
  handle[Symbol.asyncIterator] = function () { return { next: function () { return end; } }; };
  var adapter = { vendor: "codex", createQuery: async function (queryOptions) {
    options.push(queryOptions); return handle;
  } };
  var bridge = createSDKBridge({ cwd: f.leadProject.cwd, slug: "lead", sessionManager: f.lead,
    adapter: adapter, adapters: { codex: adapter }, send: function () {},
    getControlSessionContext: f.router.getControlSessionContext });
  t.after(async function () {
    finish({ done: true });
    if (f.root.streamPromise) await f.root.streamPromise;
  });
  return { bridge: bridge, messages: messages, options: options };
}

test("provider starts and resumes use exact bound project rules, never titles or a competing worktree", async function (t) {
  var f = fixture(t);
  var h = bridgeFixture(t, f);
  f.root.cliSessionId = "existing-provider-conversation";
  var originalHistory = JSON.stringify(f.root.history);
  var message = "Review the project called Same title; keep the current scope.";
  await h.bridge.startQuery(f.root, message, null, null);
  assert.equal(h.options.length, 1);
  assert.equal(h.options[0].resumeSessionId, "existing-provider-conversation");
  assert.equal(h.options[0].cwd, f.leadProject.cwd, "the conversation retains its own provider workspace");
  var context = snapshot(h.messages[0].text);
  assert.equal(context.role, "project_coordinator");
  assert.deepEqual(context.projectRef, { projectId: PROJECT });
  assert.equal(context.project.path, f.target.cwd);
  assert.equal(context.instructions[0].body, "Rules for canonical");
  assert.deepEqual(context.instructions.map(function (file) { return file.path; }),
    ["AGENTS.md", "localAIConfig/AGENTS.local.md", "localAIConfig/TRIAGE.local.md"]);
  assert.equal(context.ownerAcceptanceRequired, true);
  assert.equal(h.messages[0].text.endsWith(message), true);
  assert.equal(JSON.stringify(f.root.history), originalHistory, "context is not recorded as an owner request");

  fs.writeFileSync(path.join(f.target.cwd, "AGENTS.md"), "Updated canonical rules.");
  assert.equal(h.bridge.pushMessage(f.root, "What changed?", ["image-ref"]), true);
  var next = snapshot(h.messages[1].text);
  assert.equal(next.instructions[0].body, "Updated canonical rules.");
  assert.notEqual(next.instructions[0].digest, context.instructions[0].digest);
  assert.deepEqual(h.messages[1].images, ["image-ref"]);
});

test("missing required project instructions are surfaced on a warm turn without a partial rule snapshot", async function (t) {
  var f = fixture(t);
  var h = bridgeFixture(t, f);
  await h.bridge.startQuery(f.root, "Inspect the current work.", null, null);
  fs.unlinkSync(path.join(f.target.cwd, "localAIConfig/TRIAGE.local.md"));
  assert.equal(h.bridge.pushMessage(f.root, "Can work proceed?", null), true);
  var context = snapshot(h.messages[1].text);
  assert.equal(context.ok, false);
  assert.equal(context.reason, "project_local_instructions_missing");
  assert.deepEqual(context.missing, ["localAIConfig/TRIAGE.local.md"]);
  assert.equal(context.instructions, undefined);
});

test("removed or ambiguous canonical projects never borrow another project's rules", function (t) {
  var f = fixture(t);
  var duplicate = f.register(PROJECT, "second-canonical", false);
  assert.equal(f.router.getControlSessionContext(f.root, f.lead).reason, "project_context_unavailable");
  duplicate.unregister();
  assert.equal(f.router.getControlSessionContext(f.root, f.lead).ok, true);
  f.target.unregister();
  var missing = f.router.getControlSessionContext(f.root, f.lead);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "project_context_unavailable");
  assert.equal(missing.instructions, undefined, "a surviving worktree is not silently made canonical");
});

test("ordinary sessions and unregistered lookalikes cannot acquire a control identity", function (t) {
  var f = fixture(t);
  var ordinary = f.lead.createSessionRaw({ title: "Coop project coordinator" });
  assert.equal(f.router.getControlSessionContext(ordinary, f.lead), null);
  assert.equal(f.router.getControlSessionContext(Object.assign({}, f.root), f.lead), null);
  assert.equal(f.router.getControlSessionContext(f.root, manager("system-lead")), null);
  f.root._deleted = true;
  assert.equal(f.router.getControlSessionContext(f.root, f.lead), null);
});

test("Coop, Council and Triage receive their actual roles without borrowing project instructions", function (t) {
  var f = fixture(t);
  var ensured = controlPlane.ensureControlPlane(f.lead, [{ projectRef: { projectId: PROJECT }, title: "Same title" }]);
  var channel = require("../lib/project-coop-channels").ensureProjectChannel(f.lead,
    { projectId: PROJECT, slug: "canonical", title: "Same title", path: f.target.cwd }, null, false);
  [[f.coop, "coop"], [channel, "coop"], [ensured.council, "council"], [ensured.triage, "triage"]].forEach(function (item) {
    var context = f.router.getControlSessionContext(item[0], f.lead);
    assert.equal(context.role, item[1]);
    assert.equal(context.instructions, undefined);
    assert.equal(context.coopRef.sessionStorageId, f.coop.storageId);
  });
});

test("ordinary owner turns remain byte-identical at the provider boundary", function (t) {
  var f = fixture(t);
  var h = bridgeFixture(t, f);
  var ordinary = f.lead.createSessionRaw({ title: "Discuss the project coordinator" });
  var delivered = [];
  ordinary.queryInstance = { pushMessage: function (text, images) { delivered.push([text, images]); } };
  var text = "Please explain this design.\nKeep my formatting.";
  var images = ["owner-image"];
  assert.equal(h.bridge.pushMessage(ordinary, text, images), true);
  assert.deepEqual(delivered, [[text, images]]);
});
