var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");
var config = require("../lib/config");
var createSessionManager = require("../lib/sessions").createSessionManager;
var state = require("../lib/project-connection-state");
var routing = require("../lib/coop-model-routing");
var policy = require("../lib/coop-model-policy");

async function fixture(run) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-opening-"));
  var oldHome = config.REAL_HOME;
  config.REAL_HOME = root;
  var cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd);
  var sessionsDir = path.join(config.CONFIG_DIR, "sessions", require("../lib/utils").encodeCwd(cwd));
  try { await run({ cwd: cwd, sessionsDir: sessionsDir }); }
  finally {
    await new Promise(function (resolve) { setImmediate(resolve); });
    config.REAL_HOME = oldHome;
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function manager(f) {
  return createSessionManager({ cwd: f.cwd, slug: "lead", isLead: true, send: function () {} });
}

function home(sm) {
  return Array.from(sm.sessions.values()).find(function (session) { return session.coopHome; });
}

test("a fresh Coop pins Astra before its first message or model catalog warmup", async function () {
  await fixture(function (f) {
    var sm = manager(f);
    var session = home(sm);
    sm.defaultVendor = "claude";
    sm.currentModel = "opus";
    sm.defaultModelsByVendor = { claude: "opus", codex: "gpt-5.6-terra" };
    sm.modelsByVendor = { codex: [{ value: "gpt-5.6-terra" }], claude: [{ value: "opus" }] };
    var opening = state.selectInitialModelState({ active: session, sessionManager: sm });
    assert.equal(opening.vendor, "codex");
    assert.equal(opening.model, "gpt-6-astra");
    assert.equal(session.model, "gpt-6-astra");
    assert.equal(session.requestedModel, "gpt-6-astra");
    assert.equal(session.providerRouteId, "codex-openai");
    assert.equal(session.cliSessionId, null);
    assert.equal(session.history.length, 0);
    assert.equal(session.verifiedModel, null, "a configured model is not a provider verification");
    assert.ok(opening.models.every(function (entry) {
      return policy.designationForTarget({ vendor: opening.vendor, model: entry.value || entry });
    }));
    var unavailable = policy.currentSessionRoute(session, { healthForCandidate: function () { return "unhealthy"; } });
    assert.equal(unavailable.ok, false, "pinning the opening model cannot bypass runtime health");
  });
});

test("loading a legacy empty Coop durably repairs its model and incarnation without changing its identity", async function () {
  await fixture(function (f) {
    var id = "761526f7-e814-42c6-bb56-4350657dab62";
    fs.mkdirSync(f.sessionsDir, { recursive: true });
    var file = path.join(f.sessionsDir, id + ".jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "meta", storageId: id, cliSessionId: null,
      coopHome: true, title: "Coop", createdAt: 100, lastActivity: 100,
      coopIncarnation: { version: 1, incarnationId: "original-incarnation", epoch: 1,
        vendor: "claude", providerRouteId: "claude-anthropic", model: "default", updatedAt: 100 },
    }) + "\n");
    var sm = manager(f);
    var session = home(sm);
    assert.equal(session.storageId, id);
    assert.equal(session.model, "gpt-6-astra");
    assert.equal(session.coopIncarnation.model, "gpt-6-astra");
    assert.equal(session.coopIncarnation.vendor, "codex");
    assert.equal(session.coopIncarnation.incarnationId, "original-incarnation");
    assert.equal(session.coopIncarnation.epoch, 1);
    var saved = JSON.parse(fs.readFileSync(file, "utf8").split("\n", 1)[0]);
    assert.equal(saved.model, "gpt-6-astra");
    assert.equal(saved.coopIncarnation.model, "gpt-6-astra");
    assert.equal(home(manager(f)).requestedModel, "gpt-6-astra");
  });
});

test("new Coop channels use only a governed model while ordinary sessions keep their chosen model", async function () {
  await fixture(function (f) {
    var sm = manager(f);
    var channel = sm.createSessionRaw({ coopChannel: { projectSlug: "clay" }, vendor: "claude", model: "opus" });
    assert.equal(channel.model, "fable");
    assert.equal(channel.providerRouteId, "claude-anthropic");
    var preferred = sm.createSessionRaw({ coopHome: true, vendor: "claude", model: "claude-fable-5[1m]" });
    assert.equal(preferred.model, "claude-fable-5[1m]");
    var ordinary = sm.createSessionRaw({ vendor: "claude", model: "opus" });
    assert.equal(ordinary.model, "opus");
  });
});

test("Coop model display and refresh retain Fable even when its alias is missing from the catalog", async function () {
  var session = { coopHome: true, vendor: "claude", providerRouteId: "claude-anthropic",
    model: "fable", requestedModel: "fable" };
  var sm = { currentModel: "opus", defaultModelsByVendor: { claude: "opus" },
    modelsByVendor: { claude: [{ value: "opus" }, { value: "claude-fable-5" }] } };
  var opening = state.selectInitialModelState({ active: session, sessionManager: sm });
  assert.equal(opening.model, "fable");
  assert.ok(opening.models.every(function (entry) { return String(entry.value || entry).indexOf("fable") !== -1; }));
  var sent;
  var api = require("../lib/project-vendor-models").attachProjectVendorModels({
    sm: sm, sdk: { prepareVendor: function () { return Promise.resolve(); } },
    getSessionForWs: function () { return session; }, sendTo: function (ws, msg) { sent = msg; },
  });
  assert.equal(api.handleMessage({}, { type: "get_vendor_models", vendor: "claude" }), true);
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(sent.model, "fable");
  assert.ok(sent.models.every(function (entry) { return String(entry.value || entry).indexOf("fable") !== -1; }));
});

test("opening initialization leaves started conversations alone and rolls back failed durable repair", function () {
  var session = { coopHome: true, storageId: "legacy", model: "opus", vendor: "claude", history: [] };
  var before = JSON.stringify(session);
  assert.throws(function () {
    routing.initializeSession(session, function () { throw new Error("disk full"); });
  }, /disk full/);
  assert.equal(JSON.stringify(session), before);
  session.cliSessionId = "existing-provider-conversation";
  assert.equal(routing.initializeSession(session), false);
  assert.equal(session.model, "opus");
  session.cliSessionId = null;
  session.history = [{ type: "delta", text: "Existing conversation" }];
  assert.equal(routing.initializeSession(session), false);
  assert.equal(session.model, "opus");
});


test("an unmarked empty legacy session gets its model when it becomes Coop at startup", async function () {
  await fixture(function (f) {
    var id = "11111111-1111-4111-8111-111111111111";
    fs.mkdirSync(f.sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(f.sessionsDir, id + ".jsonl"), JSON.stringify({
      type: "meta", storageId: id, cliSessionId: null, title: "Older empty session",
      vendor: "claude", model: "opus", createdAt: 100, lastActivity: 100,
    }) + "\n");
    var session = home(manager(f));
    assert.equal(session.storageId, id);
    assert.equal(session.model, "fable");
    assert.equal(session.requestedModel, "fable");
  });
});
