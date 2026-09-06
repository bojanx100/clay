var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var config = require("../lib/config");
var createManager = require("../lib/sessions").createSessionManager;
var topics = require("../lib/coop-topic-index");
var mates = require("../lib/mates");
var attachDebate = require("../lib/project-debate").attachDebate;
var attachPlanning = require("../lib/coop-planning").attachCoopPlanning;
var planningMcp = require("../lib/coop-planning-mcp");
var planningRecord = require("../lib/coop-planning-debate").record;

function tick() { return new Promise(function (resolve) { setImmediate(resolve); }); }

function fixture(t) {
  var cwd = fs.mkdtempSync(path.join(config.CONFIG_DIR, "planning-"));
  var registry = [
    { id: "mate_moderator", name: "Moderator", vendor: "codex", model: "moderator-model", status: "ready" },
    { id: "mate_product", name: "Product", vendor: "claude", status: "ready" },
    { id: "mate_engineering", name: "Engineering", vendor: "codex", status: "ready" },
  ];
  fs.mkdirSync(path.join(config.CONFIG_DIR, "mates"), { recursive: true });
  fs.writeFileSync(path.join(config.CONFIG_DIR, "mates/mates.json"), JSON.stringify({ mates: registry }));
  var smOptions = { cwd: cwd, slug: "lead", projectId: "system-lead", send: function () {} };
  var sm = createManager(smOptions);
  var source = sm.createSessionRaw({ coopHome: true });
  sm.saveSessionFile(source, { durable: true });
  var activeBefore = sm.getActiveSession();
  var indexFile = path.join(cwd, "topics.json");
  var index = topics.createTopicIndex({ file: indexFile });
  var created = index.createTopic({ title: "Pricing choices", group: "cross_project" });
  assert.equal(created.ok, true);
  var calls = [];
  var updates = [];
  var delegated = [];
  var selected;
  var service;
  var sdk = { createMentionSession: function (opts) {
    var call = { opts: opts, callbacks: opts, messages: [opts.initialMessage], closed: false };
    var handle = { isAlive: function () { return !call.closed; }, close: function () { call.closed = true; },
      pushMessage: function (text, callbacks) { call.messages.push(text); call.callbacks = callbacks; } };
    calls.push(call);
    return Promise.resolve(handle);
  } };
  var debateCtx = { cwd: cwd, slug: "lead", sm: sm, sdk: sdk,
    send: function () {}, sendTo: function () {}, sendToSession: function () {},
    getSessionForWs: function () { return selected; },
    getMateProfile: function (ctx, id) { return mates.getMate(ctx, id); },
    loadMateClaudeMd: function () { return "Discuss approaches."; }, loadMateDigests: function () { return ""; },
    onCoopPlanningFinished: function (session) { service.finished(session); } };
  var debate = attachDebate(debateCtx);
  var serviceCtx = { slug: "lead", sm: sm, debate: debate, topicIndex: index,
    canStart: function () { return true; }, queueUpdate: function (session, text) { updates.push(text); return true; },
    delegate: function (input) { delegated.push(input); return { content: [{ type: "text", text: "accepted" }] }; } };
  service = attachPlanning(serviceCtx);
  var gate = { planning: service };
  source.isProcessing = true;
  source._sessionControlToolQuery = new AbortController();
  var server = planningMcp.createPlanningServer(null, sm, source, gate);
  async function invoke(name, args) {
    var response = await server.instance._registeredTools[name].handler(args || {});
    if (response.isError) return response;
    try { return JSON.parse(response.content[0].text); } catch (error) { return response; }
  }
  function input(kind) {
    var team = service.participants(source);
    return { requestId: "pricing-" + (kind || "council"), kind: kind || "council", topicRef: created.topic.topicRef,
      question: "Choose a pricing approach", context: "We need simple pricing with a sustainable margin.",
      moderatorId: team[0].mateId, panelists: team.slice(1).map(function (mate) {
        return { mateId: mate.mateId, role: mate.name, brief: "Challenge the proposal from your perspective." };
      }) };
  }
  function byRef(ref, manager) {
    return Array.from((manager || sm).sessions.values()).find(function (session) { return session.storageId === ref.sessionStorageId; });
  }
  t.after(async function () { await new Promise(function (resolve) { setTimeout(resolve, 30); }); });
  return { sm: sm, source: source, cwd: cwd, index: index, calls: calls, updates: updates, delegated: delegated,
    service: service, input: input, invoke: invoke, gate: gate, serviceCtx: serviceCtx, smOptions: smOptions,
    activeBefore: activeBefore, byRef: byRef, debate: debate, debateCtx: debateCtx,
    select: function (session) { selected = session; } };
}

async function complete(h, input) {
  var started = await h.invoke("start_coop_planning", input);
  assert.equal(started.ok, true, JSON.stringify(started));
  await tick();
  // A moderator attempting to finish early must still hear both perspectives.
  h.calls[0].callbacks.onDone("I suggest a simple flat price.");
  await tick();
  assert.equal(h.calls.length, 2);
  h.calls[1].callbacks.onDone("A flat price is easiest for customers to understand.");
  h.calls[0].callbacks.onDone("We should converge on flat pricing.");
  await tick();
  assert.equal(h.calls.length, 3);
  h.calls[2].callbacks.onDone("Use a usage ceiling to protect margin.");
  h.calls[0].callbacks.onDone("Use flat pricing with a published usage ceiling.");
  assert.match(h.calls[0].messages.at(-1), /final synthesis/);
  h.calls[0].callbacks.onDone("RECOMMENDATION: Flat pricing with a clear usage ceiling.\n" +
    "KEY ARGUMENTS:\n- Product favored simplicity. Engineering checked cost.\n" +
    "DISSENTS / TRADE-OFFS:\n- Heavy users need a separate tier.\nOPEN QUESTIONS:\n- None for this plan.");
  return started;
}

test("Council is a visible read-only debate in the same Coop Thread; all perspectives precede commissioning", async function (t) {
  var h = fixture(t);
  var input = h.input();
  var started = await complete(h, input);
  var session = h.byRef(started.planningRef);
  assert.equal(started.planningRef.projectId, "system-lead");
  assert.equal(session.orchestrationParent, undefined);
  assert.equal(h.sm.getActiveSession(), h.activeBefore, "Coop does not move the owner's foreground session");
  assert.equal(h.delegated.length, 0, "planning alone must not create project execution");
  assert.equal(h.calls.length, 3, "no extra digest providers are launched after planning");
  h.calls.forEach(function (call) {
    assert.equal(call.opts.readOnlyExecution, true);
    assert.equal(call.opts.session, session);
    assert.equal(call.closed, true);
  });
  assert.equal(h.calls[0].opts.model, "moderator-model");
  var topic = h.index.resolve(input.topicRef, false).topic;
  assert.equal(topic.threadState, "exploring");
  assert.equal(topic.relatedExecutions.length, 0);
  assert.equal(topic.relatedPlanning[0].sessionRef.sessionStorageId, session.storageId);
  var result = await h.invoke("read_coop_planning", { requestId: input.requestId });
  assert.equal(result.status, "ready");
  assert.equal(result.transcript.filter(function (entry) { return entry.type === "debate_turn_done"; }).length, 5);
  assert.equal(h.updates.length, 1);
  assert.match(h.updates[0], /usage ceiling/);
  var projection = h.index.project({ canAccessProject: function () { return true; },
    resolveRelatedSession: function (projectRef, sessionRef) {
      var found = h.byRef(sessionRef);
      return found && { topLevel: !found.orchestrationParent, title: found.title };
    } });
  var projected = projection.groups.flatMap(function (group) { return group.topics; })
    .find(function (item) { return item.topicRef.topicId === input.topicRef.topicId; });
  assert.equal(projected.threadState, "exploring", "a planning link must not promote the Thread to execution");
  assert.equal(projected.relatedSessions[0].sessionRef.sessionStorageId, session.storageId);
  var vm = require("vm");
  var page = { location: { pathname: "/p/lead/", search: new URL(result.url, "http://clay.test").search }, URLSearchParams: URLSearchParams };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../lib/public/modules/session-tab-state.js"), "utf8")
    .replace(/^export /gm, ""), page);
  assert.equal(page.readUrlSessionRef("lead").sessionStorageId, session.storageId);
  var request = { requestId: input.requestId, planDigest: result.planDigest,
    targetProject: { projectId: "11111111-1111-5111-8111-111111111111" },
    portfolioTaskId: "pricing", bindingRevision: 1, idempotencyKey: "pricing-v1",
    ownedPaths: "pricing", acceptanceCriteria: "Pricing matches the chosen policy." };
  await h.invoke("commission_coop_plan", request);
  assert.equal(h.delegated.length, 1);
  assert.equal(h.delegated[0].mode, "project_coordinator");
  assert.deepEqual(h.delegated[0].coopTopicRef, input.topicRef);
  assert.match(h.delegated[0].context, /Engineering checked cost/);
  var conflict = await h.invoke("commission_coop_plan", Object.assign({}, request, { portfolioTaskId: "duplicate" }));
  assert.equal(conflict.isError, true);
  assert.equal(h.delegated.length, 1);
});

test("Triage retries preserve identity across disk reload and report interruption instead of creating work", async function (t) {
  var h = fixture(t);
  var input = h.input("triage");
  var result = h.service.start(h.source, input);
  assert.equal(h.service.start(h.source, input).planningRef.sessionStorageId, result.planningRef.sessionStorageId);
  assert.equal(h.calls.length, 1);
  var restored = createManager(h.smOptions);
  var source = h.byRef({ sessionStorageId: h.source.storageId }, restored);
  var service = attachPlanning(Object.assign({}, h.serviceCtx, { sm: restored }));
  var reloaded = service.start(source, input);
  assert.equal(reloaded.status, "attention");
  assert.equal(reloaded.reason, "interrupted");
  assert.equal(reloaded.planningRef.sessionStorageId, result.planningRef.sessionStorageId);
  assert.equal(h.calls.length, 1);
  assert.equal(h.delegated.length, 0);
  assert.throws(function () { service.start(source, Object.assign({}, input, { question: "Changed scope" })); }, /conflict/);
  var plan = h.byRef(result.planningRef, restored);
  assert.ok(plan.debateState, "the durable discussion state survives restart");
  assert.throws(function () { service.commission(source, { requestId: input.requestId }); }, /completed_planning_revision/);
  service.flushReports();
  assert.equal(plan.debateState.phase, "ended", "the restored discussion offers the existing owner resume control");
  assert.equal(plan.history.at(-1).type, "debate_ended");
  assert.equal(plan.history.at(-1).reason, "interrupted");
  h.select(plan);
  var restoredDebate = attachDebate(Object.assign({}, h.debateCtx, { sm: restored }));
  restoredDebate.handleDebateConcludeResponse({}, { action: "continue", text: "Continue the pricing discussion." });
  await tick();
  assert.equal(planningRecord(plan).status, "running");
  assert.equal(h.calls.length, 2, "only explicit owner continuation restarts the interrupted discussion");
});

test("invalid teams, expired callers and missing Threads create no debate or task", async function (t) {
  var h = fixture(t);
  var before = h.sm.sessions.size;
  var input = h.input();
  assert.throws(function () { h.service.start(h.source, Object.assign({}, input,
    { panelists: [input.panelists[0], input.panelists[0]] })); }, /distinct/);
  assert.throws(function () { h.service.start(h.source, Object.assign({}, input,
    { moderatorId: input.panelists[0].mateId })); }, /distinct/);
  assert.throws(function () { h.service.start(h.source, Object.assign({}, input,
    { topicRef: { topicId: "missing" } })); }, /open_thread_required/);
  h.source._sessionControlToolQuery = new AbortController();
  assert.equal((await h.invoke("start_coop_planning", input)).isError, true);
  assert.equal(h.sm.sessions.size, before);
  assert.equal(h.calls.length, 0);
});

test("reopening planning invalidates the previous synthesis before new provider turns", async function (t) {
  var h = fixture(t);
  var input = h.input();
  var result = await complete(h, input);
  var session = h.byRef(result.planningRef);
  var oldDigest = planningRecord(session).planDigest;
  var oldGuard = h.calls[0].opts.isCurrent;
  h.select(session);
  h.debate.handleDebateConcludeResponse({}, { action: "continue", text: "Reconsider annual contracts." });
  assert.equal(planningRecord(session).status, "running");
  assert.equal(planningRecord(session).planDigest, undefined);
  assert.equal(oldGuard(), false, "old provider callbacks cannot influence the new discussion");
  assert.throws(function () { h.service.commission(h.source, { requestId: input.requestId, planDigest: oldDigest }); }, /completed_planning_revision/);
  await tick();
  var resumed = h.calls.at(-1);
  resumed.callbacks.onDone("Annual contracts might change this recommendation.");
  await tick();
  assert.equal(session._debate.phase, "live", "the revised discussion must hear new participant evidence");
  assert.equal(planningRecord(session).status, "running");
  h.debate.handleDebateStop({});
  h.calls.at(-1).callbacks.onDone("We need another review.");
  assert.equal(planningRecord(session).status, "attention");
  assert.equal(planningRecord(session).planDigest, undefined);
});

test("a failed readiness save cannot be commissioned and report delivery retries durably without duplicates", async function (t) {
  var h = fixture(t);
  var save = h.sm.saveSessionFile;
  var failReady = true;
  var failReportAck = false;
  h.sm.saveSessionFile = function (session, options) {
    var plan = planningRecord(session);
    if (plan && (failReady && plan.status === "ready" || failReportAck && plan.reportPending === false)) return false;
    return save(session, options);
  };
  var result = await complete(h, h.input());
  var session = h.byRef(result.planningRef);
  assert.equal(planningRecord(session).status, "attention");
  assert.equal(h.updates.length, 0);
  assert.throws(function () { h.service.commission(h.source, { requestId: h.input().requestId }); }, /completed_planning_revision/);
  failReady = false;
  h.serviceCtx.queueUpdate = function () { return false; };
  h.service.flushReports();
  assert.equal(planningRecord(session).status, "ready");
  assert.equal(planningRecord(session).reportPending, true);
  var queue = require("../lib/project-coordinator-update-queue").attachCoordinatorUpdateQueue({
    sm: h.sm, canDispatch: function () { return false; }, sendState: function () {},
  });
  h.serviceCtx.queueUpdate = queue.queue;
  failReportAck = true;
  h.service.flushReports();
  h.service.flushReports();
  assert.equal(h.source.pendingCoordinatorUpdates.length, 1);
  assert.equal(planningRecord(session).reportPending, true);
  var restored = createManager(h.smOptions);
  var restoredSource = h.byRef({ sessionStorageId: h.source.storageId }, restored);
  assert.equal(restoredSource.pendingCoordinatorUpdates.length, 1);
  var restoredQueue = require("../lib/project-coordinator-update-queue").attachCoordinatorUpdateQueue({
    sm: restored, canDispatch: function () { return false; }, sendState: function () {},
  });
  var service = attachPlanning(Object.assign({}, h.serviceCtx, { sm: restored, queueUpdate: restoredQueue.queue }));
  service.flushReports();
  assert.equal(restoredSource.pendingCoordinatorUpdates.length, 1);
  assert.equal(planningRecord(h.byRef(result.planningRef, restored)).reportPending, false);
});

test("the owner can join planning and cancellation never becomes a completed plan", async function (t) {
  var h = fixture(t);
  var result = await h.invoke("start_coop_planning", h.input());
  var session = h.byRef(result.planningRef);
  h.select(session);
  await tick();
  h.debate.handleDebateHandRaise({});
  h.calls[0].callbacks.onDone("We should discuss the options.");
  assert.match(h.calls[0].messages.at(-1), /raised their hand/);
  h.calls[0].callbacks.onDone("The floor is yours.");
  assert.equal(session._debate.awaitingUserFloor, true);
  h.debate.handleDebateUserFloorResponse({}, { text: "Our enterprise customers require annual contracts." });
  assert.match(h.calls[0].messages.at(-1), /annual contracts/);
  h.debate.handleDebateStop({});
  h.calls[0].callbacks.onDone("Acknowledged.");
  assert.equal(planningRecord(session).status, "attention");
  assert.equal(planningRecord(session).reason, "user_stopped");
  assert.equal(planningRecord(session).planDigest, undefined);
  assert.equal(h.delegated.length, 0);
});

test("native mention queries inherit planning restrictions while ordinary mentions retain their existing options", async function () {
  var captured = [];
  var adapter = { vendor: "codex", createQuery: async function (options) {
    captured.push(options);
    return { pushMessage: function () {}, close: function () {},
      [Symbol.asyncIterator]: async function* () {} };
  } };
  var bridge = require("../lib/sdk-bridge-mentions").attachBridgeMentions({
    cwd: config.CONFIG_DIR, adapter: adapter, adapters: { codex: adapter },
    checkToolWhitelist: function () { return { behavior: "allow" }; },
  });
  var options = { vendor: "codex", initialContext: "Discuss", initialMessage: "Plan", onError: function (message) {
    throw new Error(message);
  } };
  await bridge.createMentionSession(Object.assign({}, options, { readOnlyExecution: true }));
  assert.equal(captured[0].readOnlyExecution, true);
  assert.equal(captured[0].adapterOptions.CODEX.sandboxMode, "read-only");
  assert.deepEqual(captured[0].toolServerDescriptors, []);
  assert.equal((await captured[0].canUseTool("Write", {})).behavior, "deny");
  await bridge.createMentionSession(options);
  assert.equal(captured[1].readOnlyExecution, undefined);
  assert.deepEqual(captured[1].adapterOptions.CLAUDE.settingSources, ["user"]);
});

test("incomplete startup retries the same planning record and repairs its missing Thread link", function (t) {
  var h = fixture(t);
  var original = h.index.linkPlanning;
  h.index.linkPlanning = function () { return { ok: false }; };
  assert.throws(function () { h.service.start(h.source, h.input()); }, /planning_thread_link_failed/);
  var staged = Array.from(h.sm.sessions.values()).find(function (session) { return planningRecord(session); });
  assert.ok(staged);
  assert.equal(h.calls.length, 0);
  h.index.linkPlanning = original;
  var result = h.service.start(h.source, h.input());
  assert.equal(result.planningRef.sessionStorageId, staged.storageId);
  assert.equal(h.calls.length, 1);
  assert.equal(h.index.resolve(h.input().topicRef, false).topic.relatedPlanning.length, 1);
});

test("a real governance refusal releases the unsubmitted commissioning reservation for a corrected retry", async function (t) {
  var h = fixture(t);
  var result = await complete(h, h.input());
  var session = h.byRef(result.planningRef);
  var external = require("../lib/project-task-orchestrator-external");
  var coordinate = external.createExternalTaskCoordinator({
    projectId: function () { return "system-lead"; },
    sessionForInput: function (input) { return input.coordinatorSessionId === h.source.storageId ? h.source : null; },
    governanceLifecycle: require("../lib/coop-governance-lifecycle").createLifecycle({ file: path.join(h.cwd, "governance.jsonl") }),
    autonomyPolicyFile: path.join(h.cwd, "absent-autonomy-policy.json"),
    createProjectExecution: function (input) { h.delegated.push(input); return { ok: true }; },
  });
  var handlers = require("../lib/orchestration-tool-handlers").createToolHandlers({
    isProjectExecutionInput: function (input) { return !!input.targetProject; },
    coordinateExternalTask: coordinate,
    error: function (text) { return { isError: true, content: [{ type: "text", text: text }] }; },
    success: function (text) { return { content: [{ type: "text", text: text }] }; },
  });
  h.serviceCtx.delegate = handlers.delegate;
  var input = { requestId: h.input().requestId, planDigest: planningRecord(session).planDigest,
    targetProject: { projectId: "11111111-1111-5111-8111-111111111111" },
    portfolioTaskId: "pricing", bindingRevision: 1, idempotencyKey: "pricing-v1",
    ownedPaths: "pricing", acceptanceCriteria: "Verify the policy.", implementationGrantRef: "missing-grant" };
  var refused = await h.service.commission(h.source, input);
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.executionNotStarted, true);
  assert.equal(h.delegated.length, 0);
  assert.equal(planningRecord(session).commissionDigest, undefined);
  delete input.implementationGrantRef;
  var accepted = await h.service.commission(h.source, input);
  assert.notEqual(accepted.isError, true);
  assert.equal(h.delegated.length, 1);
});

test("completed Council feedback survives queue restart and returns to its originating conversation Thread", async function (t) {
  var h = fixture(t);
  var starts = [];
  var queueModule = require("../lib/project-coordinator-update-queue");
  var queueContext = { sm: h.sm, sdk: { startQuery: function (session, text) {
    starts.push(text); return { ok: true };
  } }, sendState: function () {}, onProcessingChanged: function () {}, sendToSession: function () {},
  ensureProjectAccessForSession: function () {} };
  h.serviceCtx.queueUpdate = queueModule.attachCoordinatorUpdateQueue(queueContext).queue;
  var input = h.input();
  var started = await complete(h, input);
  var plan = h.byRef(started.planningRef);
  var eventId = "planning:" + plan.storageId + ":1";
  assert.equal(h.source.pendingCoordinatorUpdates[0].feedback.eventId, eventId);
  var restored = createManager(h.smOptions);
  var source = h.byRef({ sessionStorageId: h.source.storageId }, restored);
  restored.getHistoryView(source);
  var queue = queueModule.attachCoordinatorUpdateQueue(Object.assign({}, queueContext, { sm: restored }));
  assert.equal(queue.flush(source), true);
  assert.equal(starts.length, 1);
  var ownerUpdates = require("../lib/coop-owner-updates");
  assert.deepEqual(ownerUpdates.pending(restored, source).map(function (ref) { return ref.eventId; }), [eventId]);
  var text = "Council recommends flat pricing with a usage ceiling. The plan is ready to discuss.";
  assert.equal(ownerUpdates.publish(restored, source, { replyId: "council-result", text: text,
    feedbackEventIds: [eventId] }).ok, true);
  var view = restored.getHistoryView(source);
  var indexes = require("../lib/coop-topic-connection").boundedMembershipIndexes(
    h.index.resolve(input.topicRef, false).topic, source, view);
  assert.deepEqual(indexes.map(function (index) { return view.history[index].text; }), [text]);
  assert.deepEqual(ownerUpdates.indexesForTopic(view, { topicId: "unrelated" }), []);
});
