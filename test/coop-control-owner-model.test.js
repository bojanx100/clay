var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var config = require("../lib/config");
var modelModule = require("../lib/coop-owner-model");
var createManager = require("../lib/sessions").createSessionManager;
var createControlContext = require("../lib/coop-control-role-context").createControlRoleContext;
var plane = require("../lib/coop-control-plane");
var PROJECT = "11111111-1111-5111-8111-111111111111";
var OTHER = "22222222-2222-5222-8222-222222222222";

function fixture(t) {
  var cwd = fs.mkdtempSync(path.join(config.CONFIG_DIR, "owner-model-"));
  var options = { cwd: cwd, slug: "lead", projectId: "system-lead", send: function () {} };
  var sm = createManager(options);
  var source = sm.createSessionRaw({ coopHome: true, ownerId: crypto.randomUUID() });
  var model = modelModule.getDefaultOwnerModel();
  var ledger = require("../lib/coop-owner-requests").attachCoopOwnerRequests({ file: path.join(cwd, "requests.json") });
  var ingress = require("../lib/project-user-message-coop").attachCoopForegroundIngress({ sm: sm, coopOwnerRequests: ledger });
  var sequence = 0;
  function ownerTurn(text, projectId, overrides) {
    var id = "coop:" + source.storageId + ":" + (++sequence);
    var msg = { text: text, coopClassification: "existing_topic", coopTopicRef: { topicId: "pricing" },
      coopProjectRef: projectId ? { projectId: projectId } : null };
    var event = Object.assign({ type: "user_message", text: text, from: source.ownerId, coopIngressId: id,
      coopProjectRef: msg.coopProjectRef, coopTopicRef: msg.coopTopicRef }, overrides || {});
    source.history.push(event);
    assert.equal(ingress.recordPrepared(source, { coopIngress: { ingressId: id, sequence: sequence, kind: "text" } }, msg, text), true);
    return id;
  }
  var projectDirs = {};
  [PROJECT, OTHER].forEach(function (id) {
    var dir = path.join(cwd, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "Project instructions for " + id);
    projectDirs[id] = dir;
  });
  function contextFor(manager) {
    return createControlContext({ projectContextsById: function (id) {
      if (id === "system-lead") return [{ manager: manager }];
      return projectDirs[id] ? [{ getStatus: function () { return { projectId: id, path: projectDirs[id] }; } }] : [];
    }, sessionManagerForContext: function (context) { return context.manager; } });
  }
  t.after(async function () { await new Promise(function (resolve) { setTimeout(resolve, 30); }); });
  return { cwd: cwd, sm: sm, source: source, ownerTurn: ownerTurn, model: model,
    options: options, contextFor: contextFor, ingress: ingress };
}

function remember(h, id, quote, preference, supersedesId) {
  return h.model.remember(h.source, h.sm, { ingressId: id, quote: quote, preference: preference || quote,
    kind: preference ? "inferred_preference" : "owner_statement", supersedesId: supersedesId });
}

test("real owner ingress is retrieved without another write and survives disk reload with exact source evidence", function (t) {
  var h = fixture(t);
  var memoryFile = path.join(config.CONFIG_DIR, "lead/owner-model", crypto.createHash("sha256").update(h.source.ownerId).digest("hex") + ".json");
  var id = h.ownerTurn("I prefer one short summary of outcomes and blockers.", PROJECT);
  assert.equal(h.model.context(h.source, h.sm).recentOwnerObservations.length, 1);
  assert.equal(fs.existsSync(memoryFile), false, "reading durable observations needs no second store write");
  assert.throws(function () { remember(h, id, "Invented owner instruction"); }, /exact_owner_quote/);
  var saved = remember(h, id, "one short summary of outcomes and blockers", "Prefer concise outcome summaries.");
  assert.equal(saved.preference.kind, "inferred_preference");
  assert.equal(saved.preference.projectRef.projectId, PROJECT);
  assert.equal(saved.preference.ingressId, id);
  var restored = createManager(h.options);
  var source = Array.from(restored.sessions.values()).find(function (session) { return session.storageId === h.source.storageId; });
  var context = modelModule.createOwnerModel().context(source, restored);
  assert.equal(context.preferences[0].id, saved.preference.id);
  assert.equal(context.recentOwnerObservations.length, 1);
  assert.equal(context.recentOwnerObservations[0].text, "I prefer one short summary of outcomes and blockers.");
  assert.equal(remember(h, id, "one short summary of outcomes and blockers", "Prefer concise outcome summaries.").unchanged, true);
});

test("fresh and warm Coop provider context receives corrections and retractions immediately", async function (t) {
  var h = fixture(t);
  var id = h.ownerTurn("I prefer brief reports.", PROJECT);
  var first = remember(h, id, "I prefer brief reports.");
  var messages = [];
  var finish;
  var end = new Promise(function (resolve) { finish = resolve; });
  var handle = { pushMessage: function (text) { messages.push(text); } };
  handle[Symbol.asyncIterator] = function () { return { next: function () { return end; } }; };
  var adapter = { vendor: "codex", createQuery: async function () { return handle; } };
  var bridge = require("../lib/sdk-bridge").createSDKBridge({ cwd: h.cwd, slug: "lead", sessionManager: h.sm,
    adapter: adapter, adapters: { codex: adapter }, send: function () {}, getControlSessionContext: h.contextFor(h.sm) });
  h.sm.modelsByVendor = { codex: ["gpt-6-astra"] };
  h.source.vendor = "codex";
  h.source.providerRouteId = "codex-openai";
  h.source.model = "gpt-6-astra";
  h.sm.ensureCoopTopTierRoute = require("../lib/coop-model-routing").attachRuntime({ sm: h.sm,
    activeModel: function (session) { return session.model; } }).ensureRoute;
  h.source.cliSessionId = "saved-provider-conversation";
  t.after(function () { finish({ done: true }); });
  await bridge.startQuery(h.source, "How should you report back?", null, null);
  function current(text) {
    var match = text.match(/<clay_control_context>\n([\s\S]*?)\n<\/clay_control_context>/);
    assert.ok(match);
    return JSON.parse(match[1]).ownerModel;
  }
  assert.equal(current(messages.at(-1)).preferences[0].preference, "I prefer brief reports.");
  var corrected = h.ownerTurn("For this project, include the financial assumptions in every report.", PROJECT);
  var second = remember(h, corrected, "include the financial assumptions in every report",
    "Include financial assumptions in project reports.", first.preference.id);
  bridge.pushMessage(h.source, "Prepare the next report.", null);
  var preferences = current(messages.at(-1)).preferences;
  assert.equal(preferences.length, 1);
  assert.equal(preferences[0].id, second.preference.id);
  assert.equal(preferences[0].version, 2);
  var forgotten = h.ownerTurn("Forget that reporting preference.", PROJECT);
  h.model.retract(h.source, h.sm, { preferenceId: second.preference.id, ingressId: forgotten,
    quote: "Forget that reporting preference." });
  bridge.pushMessage(h.source, "What do you remember?", null);
  assert.equal(current(messages.at(-1)).preferences.length, 0);
});

test("owner and project boundaries exclude other people's decisions and unrelated project preferences", function (t) {
  var h = fixture(t);
  var id = h.ownerTurn("Use annual contracts for this project.", PROJECT);
  remember(h, id, "Use annual contracts for this project.");
  var otherId = h.ownerTurn("Use monthly contracts for the other project.", OTHER);
  remember(h, otherId, "Use monthly contracts for the other project.");
  var otherOwner = h.sm.createSessionRaw({ ownerId: crypto.randomUUID() });
  assert.equal(h.model.context(otherOwner, h.sm).preferences.length, 0);
  var alien = h.ownerTurn("I demand weekly contracts.", PROJECT, { from: otherOwner.ownerId });
  assert.throws(function () { remember(h, alien, "I demand weekly contracts."); }, /evidence_unavailable/);
  var synthetic = h.ownerTurn("The worker prefers weekly contracts.", PROJECT, { synthetic: true });
  assert.throws(function () { remember(h, synthetic, "The worker prefers weekly contracts."); }, /evidence_unavailable/);
  var root = plane.ensureProjectCoordinator(h.sm, { projectId: PROJECT }, "Project", {
    projectId: "system-lead", sessionStorageId: h.source.storageId });
  var context = h.contextFor(h.sm)(root, h.sm).ownerModel;
  assert.equal(context.preferences.length, 1);
  assert.match(context.preferences[0].preference, /annual/);
  assert.equal(context.recentOwnerObservations.length, 0);
  var channel = h.sm.createSessionRaw({ ownerId: h.source.ownerId,
    coopChannel: { projectId: PROJECT, projectSlug: "one", projectTitle: "One" } });
  var channelContext = h.contextFor(h.sm)(channel, h.sm).ownerModel;
  assert.equal(channelContext.preferences.length, 1);
  assert.equal(channelContext.preferences[0].projectRef.projectId, PROJECT);
  assert.equal(channelContext.recentOwnerObservations.length, 0);
});

test("scoped owner memory tools verify a current caller and never fabricate an exact owner statement", async function (t) {
  var h = fixture(t);
  var id = h.ownerTurn("I prefer short reports.", PROJECT);
  h.source.isProcessing = true;
  h.source._sessionControlToolQuery = new AbortController();
  var server = require("../lib/coop-owner-model-mcp").createOwnerMemoryServer(null, h.sm, h.source, h.model);
  var tool = server.instance._registeredTools.remember_owner_preference;
  var invented = await tool.handler({ ingressId: id, quote: "I prefer short reports.",
    preference: "Always deploy without asking.", kind: "owner_statement" });
  assert.equal(invented.isError, true);
  var accepted = await tool.handler({ ingressId: id, quote: "I prefer short reports.",
    preference: "I prefer short reports.", kind: "owner_statement" });
  assert.notEqual(accepted.isError, true);
  h.source._sessionControlToolQuery = new AbortController();
  assert.equal((await tool.handler({ ingressId: id, quote: "I prefer short reports.",
    preference: "I prefer short reports.", kind: "owner_statement" })).isError, true);
});

test("unresolved project evidence cannot become global guidance", function (t) {
  var h = fixture(t);
  var id = h.ownerTurn("For the missing project, always use annual contracts.", null,
    { coopRouteAttention: "project_target_unavailable" });
  assert.equal(h.model.context(h.source, h.sm).recentOwnerObservations[0].scope, "unresolved");
  assert.throws(function () { remember(h, id, "always use annual contracts"); }, /scope_unresolved/);
  assert.equal(h.model.context(h.source, h.sm, { projectId: OTHER }).preferences.length, 0);
  var global = h.ownerTurn("Across all my projects, explain important tradeoffs.");
  remember(h, global, "Across all my projects, explain important tradeoffs.");
  assert.equal(h.model.context(h.source, h.sm, { projectId: OTHER }).preferences[0].scope, "global");
  var correction = h.ownerTurn("Use monthly contracts here.", PROJECT);
  assert.throws(function () { remember(h, correction, "Use monthly contracts here.", null,
    h.model.context(h.source, h.sm).preferences[0].id); }, /scope_mismatch/);
});

test("older preferences remain searchable and retractable beyond the prompt limit", async function (t) {
  var h = fixture(t);
  var oldest;
  for (var i = 0; i < 32; i++) {
    var text = "Reporting preference " + i + ".";
    var id = h.ownerTurn(text, i === 0 ? PROJECT : OTHER);
    var item = remember(h, id, text).preference;
    if (i === 0) oldest = item;
  }
  assert.equal(h.model.context(h.source, h.sm).preferences.some(function (item) { return item.id === oldest.id; }), false);
  assert.equal(h.model.context(h.source, h.sm, { projectId: PROJECT }).preferences[0].id, oldest.id);
  h.source.isProcessing = true;
  h.source._sessionControlToolQuery = new AbortController();
  var tools = require("../lib/coop-owner-model-mcp").createOwnerMemoryServer(null, h.sm, h.source, h.model).instance._registeredTools;
  var result = JSON.parse((await tools.list_owner_preferences.handler({ search: "Reporting preference 0." })).content[0].text);
  assert.equal(result.preferences[0].id, oldest.id);
  var page = JSON.parse((await tools.list_owner_preferences.handler({})).content[0].text);
  assert.equal(page.nextOffset, 30);
  assert.equal(JSON.parse((await tools.list_owner_preferences.handler({ offset: page.nextOffset })).content[0].text).preferences.length, 2);
  var forget = h.ownerTurn("Forget reporting preference 0.", PROJECT);
  h.model.retract(h.source, h.sm, { preferenceId: oldest.id, ingressId: forget, quote: "Forget reporting preference 0." });
  assert.equal(h.model.context(h.source, h.sm, { projectId: PROJECT }).preferences.length, 0);
  assert.equal(h.model.list(h.source, { search: "Reporting preference 0.", status: "all" }).preferences[0].status, "retracted");
  assert.throws(function () { remember(h, oldest.ingressId, oldest.quote, "Learn that same preference again."); }, /evidence_retracted/);
});

test("failed memory commits preserve evidence and retry without losing or duplicating preferences", function (t) {
  var h = fixture(t);
  var id = h.ownerTurn("I prefer a concise report.", PROJECT);
  var io = require("../lib/coop-control-ledger-file");
  var commit = io.commitJson;
  io.commitJson = function () { return { ok: false, code: "test_disk_unavailable" }; };
  try { assert.throws(function () { remember(h, id, "I prefer a concise report."); }, /test_disk_unavailable/); }
  finally { io.commitJson = commit; }
  var restored = createManager(h.options);
  var source = Array.from(restored.sessions.values()).find(function (session) { return session.storageId === h.source.storageId; });
  var model = modelModule.createOwnerModel();
  assert.equal(model.context(source, restored).recentOwnerObservations[0].ingressId, id);
  var input = { ingressId: id, quote: "I prefer a concise report.", preference: "I prefer a concise report.", kind: "owner_statement" };
  assert.equal(model.remember(source, restored, input).ok, true);
  assert.equal(model.remember(source, restored, input).unchanged, true);
  assert.equal(model.context(source, restored).preferences.length, 1);
});

test("ambiguous, unprepared, and unsaved owner evidence cannot be learned", function (t) {
  var h = fixture(t);
  var id = h.ownerTurn("Prefer annual contracts.", PROJECT);
  var event = h.source.history.find(function (item) { return item.coopIngressId === id; });
  h.source.history.push(Object.assign({}, event));
  h.sm.saveSessionFile(h.source, { durable: true });
  assert.throws(function () { remember(h, id, event.text); }, /evidence_unavailable/);
  var restored = createManager(h.options);
  var lazy = Array.from(restored.sessions.values()).find(function (session) { return session.storageId === h.source.storageId; });
  var historyStore = require("../lib/sessions-history-store");
  historyStore.release(lazy);
  assert.throws(function () { h.model.remember(lazy, restored, { ingressId: id,
    quote: event.text, preference: event.text, kind: "owner_statement" }); }, /evidence_unavailable/);
  assert.equal(historyStore.isResident(lazy), false, "rejected evidence does not pin an unloaded transcript");
  h.source.history.pop();
  delete event.coopIngressPreparedText;
  h.sm.saveSessionFile(h.source, { durable: true });
  assert.throws(function () { remember(h, id, event.text); }, /evidence_unavailable/);
  event.coopIngressPreparedText = event.text;
  h.source._historyNeedsRewrite = true;
  assert.throws(function () { remember(h, id, event.text); }, /evidence_unavailable/);
  h.sm.saveSessionFile(h.source, { durable: true });
  assert.equal(remember(h, id, event.text).ok, true);
});

test("the real Lead local-server assembly reserves owner memory for the current Coop query", function (t) {
  var h = fixture(t);
  var adapters = {};
  ["claude", "codex"].forEach(function (vendor) {
    adapters[vendor] = { createToolServer: function (input) {
      return Object.assign({}, input, { adapterVendor: vendor });
    } };
  });
  var local = require("../lib/project-local-mcp-servers").createProjectLocalMcpServers({
    adapter: adapters.claude, adapters: adapters,
    isMate: false, isHostAgent: false, slug: "lead", sm: h.sm,
    clients: new Set(), browserState: {}, pendingDebateProposals: {},
    loadContextSources: function () { return []; }, saveContextSources: function () {},
    getAllProjectsWithSessions: function () { return []; },
    email: { createMcpDeps: function () { return {}; }, hasEmailCapability: function () { return false; } },
    mateDatastore: {}, taskOrchestrationGate: { planning: {} },
  });
  ["claude", "codex"].forEach(function (vendor) {
    h.source.vendor = vendor;
    h.source.isProcessing = false;
    delete h.source._sessionControlToolQuery;
    var dormant = local.getLocalMcpServers(h.source)["clay-owner-memory"];
    assert.equal(dormant.sessionScoped, true);
    assert.equal(dormant.tools, undefined);
    h.source.isProcessing = true;
    h.source._sessionControlToolQuery = new AbortController();
    var servers = local.getLocalMcpServers(h.source);
    var live = servers["clay-owner-memory"];
    assert.equal(live.sessionScoped, true);
    ["./coop-owner-model-mcp", "./coop-owner-updates-mcp", "./coop-planning-mcp"].forEach(function (modulePath) {
      var name = require("../lib/" + modulePath.slice(2)).SERVER_NAME;
      assert.equal(servers[name].adapterVendor, vendor, name + " must use the current query's provider");
    });
    assert.deepEqual(live.tools.map(function (tool) { return tool.name; }),
      ["list_owner_preferences", "remember_owner_preference", "retract_owner_preference"]);
  });
  var worker = h.sm.createSessionRaw({ ownerId: h.source.ownerId });
  worker._sessionControlToolQuery = new AbortController();
  assert.equal(local.getLocalMcpServers(worker)["clay-owner-memory"].tools, undefined);
});

test("compaction preserves recent owner evidence and resolves queued ingress prepared in its continuation", function (t) {
  var h = fixture(t);
  var first = h.ownerTurn("Explain tradeoffs before choosing.", PROJECT);
  var queued = "coop:" + h.source.storageId + ":2";
  var text = "Include financial assumptions in this project.";
  h.source.vendor = "codex";
  h.source.isProcessing = true;
  h.source.coopConversationIngress = { nextSequence: 3, recent: [], activeIngressId: first };
  h.sm.sendAndRecord(h.source, { type: "user_message", text: text, from: h.source.ownerId,
    coopIngressId: queued, coopIngressSequence: 2, coopIngressPending: true });
  var starts = [];
  var sdk = { startQuery: function (session, prompt) { starts.push({ session: session, prompt: prompt }); },
    pushMessage: function () { return false; } };
  var queue = require("../lib/project-user-message-queue").attachProjectUserMessageQueue({ sm: h.sm, sdk: sdk,
    sendToSession: function () {}, onProcessingChanged: function () {}, ensureProjectAccessForSession: function () { return null; } });
  queue.dispatchPreparedToSdk(h.source, { coopIngress: true, ingressId: queued, ingressSequence: 2,
    actorUserId: h.source.ownerId, finalText: text, displayText: text, coopProjectRef: { projectId: PROJECT } });
  assert.equal(starts.length, 0);
  var continuation = require("../lib/project-session-compaction").attachSessionCompaction({
    cwd: h.cwd, sm: h.sm, sdk: sdk, sendToSession: function () {},
  }).compactAndContinue(h.source, { reason: "manual" });
  assert.ok(continuation);
  assert.equal(h.model.context(continuation, h.sm).recentOwnerObservations[0].ingressId, first);
  continuation.isProcessing = false;
  assert.equal(queue.flushCoopIngress(continuation), true);
  assert.equal(starts.length, 2);
  var observed = h.model.context(continuation, h.sm).recentOwnerObservations;
  assert.deepEqual(observed.map(function (item) { return item.ingressId; }), [first, queued]);
  assert.equal(observed[1].sourceRef.sessionStorageId, continuation.storageId);
  var learned = h.model.remember(continuation, h.sm, { ingressId: queued, quote: text,
    preference: text, kind: "owner_statement" });
  assert.equal(learned.preference.projectRef.projectId, PROJECT);
  assert.equal(learned.preference.sourceRef.sessionStorageId, continuation.storageId);
  var restored = createManager(h.options);
  var current = Array.from(restored.sessions.values()).find(function (session) { return session.storageId === continuation.storageId; });
  assert.equal(modelModule.createOwnerModel().context(current, restored).preferences[0].id, learned.preference.id);
});
