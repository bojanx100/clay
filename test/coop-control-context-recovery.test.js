var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
require("./helpers/isolated-clay-home");
var executions = require("../lib/coop-control-executions");
var fences = require("../lib/coop-control-fence");
var compaction = require("../lib/project-session-compaction");
var recovery = require("../lib/sdk-context-recovery");
var bridge = require("../lib/sdk-bridge-stream");
var providerHealth = require("../lib/provider-health");

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-context-recovery-"));
  var control = executions.createExecutionControl({ enabled: true, dbPath: path.join(dir, "control.sqlite") });
  var request = { portfolioTaskId: "restore-automation", bindingRevision: 1,
    idempotencyKey: "restore-automation-r1", mode: "project_coordinator",
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
    source: { projectId: "system-lead", sessionStorageId: "resident-coordinator" } };
  var token = control.reserveStart(request);
  control.bindStart(token, { projectId: request.targetProject.projectId, sessionStorageId: "worker" });
  control.openStartBarrier(token);
  control.markProviderStarted(token);
  var session = { localId: 1, storageId: "worker", cliSessionId: "exhausted-thread",
    vendor: "codex", model: "gpt-6-astra", providerRouteId: "codex-openai", isProcessing: true,
    coordinationMode: true, coordinationRole: "task_coordinator",
    history: [{ type: "user_message", text: "Restore automation without duplicating existing tasks." },
      { type: "delta", text: "Source patch committed. Runtime activation remains." }],
    orchestrationPolicy: { portfolioExecution: Object.assign({}, request, { status: "running" }) },
    orchestrationTasks: [{ taskId: "review", status: "reviewing", workerStorageId: "reviewer" }],
    pendingCoordinatorUpdates: [{ id: "review-update", text: "Review the real router", state: "staged" }],
    pendingAskUser: {}, pendingPermissions: {}, pendingElicitations: {},
    _coordinatorContextDelivery: { stale: true } };
  session.orchestrationPolicy.portfolioExecution.control = fences.attachFence(session, control.createFence(token));
  var h = { dir: dir, control: control, token: token, session: session, starts: [], events: [],
    leadMode: true, ordinaryResumes: 0, completions: 0 };
  h.sm = { sessions: new Map([[1, session]]), broadcastSessionList: function () {},
    sendAndRecord: function (s, event) { h.events.push(event); s.history.push(event); },
    saveSessionFile: function (s) { fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(s,
      function (key, value) { return key === "queryInstance" || key === "streamPromise" || key === "_coordinatorRenewal" ? undefined : value; })); },
    createSessionRaw: function () { throw new Error("Recovery must not create another Clay session"); } };
  h.compactor = compaction.attachSessionCompaction({ cwd: dir, sm: h.sm,
    getLeadMode: function () { return h.leadMode; }, renewalTimeoutMs: 20,
    sendToSession: function (id, event) { h.events.push(event); },
    sdk: { startQuery: function (s, prompt) {
      fences.assertAction(s, "provider_start");
      h.starts.push({ session: s, cliSessionId: s.cliSessionId, prompt: prompt });
      s.cliSessionId = "fresh-thread";
      return { ok: true };
    } } });
  h.opts = { getLeadMode: function () { return h.leadMode; },
    compactAndContinue: h.compactor.compactAndContinue,
    scheduleMessage: function () { h.ordinaryResumes++; },
    getAutoContinueSetting: function () { return true; },
    reconcileQueuedUserMessages: function () { h.completions++; } };
  h.cleanup = function () { control.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return h;
}

async function overflow(h, variant) {
  var session = h.session;
  var query = { close: function () {} };
  query[Symbol.asyncIterator] = async function* () {
    if (variant === "thrown") throw new Error("Prompt is too long");
    if (variant === "result") {
      yield { yokeType: "result", subtype: "error_during_execution", errors: ["maximum context length exceeded"] };
      return;
    }
    if (variant === "assistant") {
      session.responsePreview = "Prompt is too long";
      yield { yokeType: "result", subtype: "success", cost: 0 };
      return;
    }
    yield { yokeType: "error", text: "Error running remote compact task: Codex ran out of room in the model's context window." };
    yield { yokeType: "result", subtype: "success", cost: 0 };
  };
  session.queryInstance = query;
  session.isProcessing = true;
  session._turnDoneSent = false;
  session.onQueryComplete = function () { h.completions++; };
  var stream = bridge.attachBridgeStream({ sm: h.sm, opts: h.opts,
    adapter: { vendor: "codex" }, onProcessingChanged: function () {}, send: function () {},
    sendToSession: function () {}, sendAndRecord: function (s, event) {
      if (event.type === "done") s._turnDoneSent = true;
      h.sm.sendAndRecord(s, event);
    }, processSDKMessage: function (s, event) {
      if (!variant) throw new Error("Do not process empty completion after exhaustion");
      require("../lib/sdk-message-processor").attachMessageProcessor({ sm: h.sm,
        send: function () {}, slug: "test", adapter: { vendor: session.vendor }, cwd: h.dir,
        onProcessingChanged: function () {}, onAutoTitle: function () {}, opts: h.opts,
        discoverSkillDirs: function () { return []; }, mergeSkills: function () { return []; },
        getNotificationsModule: function () { return null; }, getSDK: function () { return null; },
      }).processSDKMessage(s, event);
    },
    isAuthErrorMessage: function () { return false; }, isTransientStreamError: function () { return false; },
    autoResumeAllowed: function () { return true; },
    scheduleInterruptResume: function () { h.ordinaryResumes++; },
    getVendorDisplayName: function () { return "Codex"; }, onTurnDone: function () { h.completions++; } });
  session.streamPromise = stream.processQueryStream(session);
  await session.streamPromise;
  if (session._coordinatorRenewal) await session._coordinatorRenewal;
}

test("context exhaustion renews the real controlled execution once with its unfinished graph intact", async function () {
  var h = harness();
  providerHealth._reset();
  try {
    var session = h.session;
    var refs = session.orchestrationPolicy.portfolioExecution.control;
    var tasks = session.orchestrationTasks;
    var reports = session.pendingCoordinatorUpdates;
    await overflow(h);
    assert.equal(h.starts.length, 1);
    assert.equal(h.starts[0].session, session);
    assert.equal(h.starts[0].cliSessionId, null, "the exhausted native thread must not be resumed");
    assert.match(h.starts[0].prompt, /Restore automation without duplicating existing tasks/);
    assert.match(h.starts[0].prompt, /Runtime activation remains/);
    assert.equal(session.orchestrationTasks, tasks);
    assert.equal(session.pendingCoordinatorUpdates, reports);
    assert.equal(session._coordinatorContextDelivery, null, "next turn must reload authoritative project context");
    assert.equal(session.orchestrationPolicy.portfolioExecution.control, refs);
    var durable = h.control.inspect(h.token.executionId);
    assert.equal(durable.execution.currentEpoch, 1);
    assert.equal(durable.current.sessionRef.sessionStorageId, "worker");
    assert.equal(durable.execution.status, "running");
    assert.equal(h.completions, 0, "overflow must not run task-completion or queued-reminder callbacks");
    assert.equal(h.ordinaryResumes, 0);
    assert.equal(session.contextRecovery.status, "started");
    assert.equal(providerHealth.getRouteHealth("codex", "codex-openai", "gpt-6-astra").state, "healthy");
    await overflow(h);
    assert.equal(h.starts.length, 1, "a failed fresh context cannot start an automatic renewal loop");
    assert.equal(session.contextRecovery.status, "blocked");
    assert.equal(session.contextRecovery.reason, "recovery_exhausted");
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "session.json"))).contextRecovery.attempts, 1);
  } finally { h.cleanup(); providerHealth._reset(); }
});

["thrown", "result", "assistant"].forEach(function (variant) {
  test("Claude context exhaustion recovers through the " + variant + " path", async function () {
    var h = harness();
    try {
      h.session.vendor = "claude";
      h.session.model = "claude-fable";
      h.session.providerRouteId = "claude-anthropic";
      await overflow(h, variant);
      assert.equal(h.starts.length, 1);
      assert.equal(h.completions, 0);
      assert.equal(h.ordinaryResumes, 0);
      assert.equal(h.session.contextRecovery.status, "started");
    } finally { h.cleanup(); }
  });
});

test("context recovery budget survives the real session persistence and loader", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-context-budget-"));
  try {
    var managers = require("../lib/sessions");
    var sm = managers.createSessionManager({ cwd: dir, send: function () {} });
    var session = sm.createSessionRaw({ storageId: "context-budget", vendor: "codex" });
    session.contextRecovery = { status: "blocked", reason: "recovery_exhausted",
      sourceCliSessionId: "original-thread", attempts: 1, detectedAt: Date.now() };
    sm.saveSessionFile(session, { durable: true });
    var rebooted = managers.createSessionManager({ cwd: dir, send: function () {} });
    var restored = Array.from(rebooted.sessions.values()).find(function (entry) { return entry.storageId === "context-budget"; });
    assert.ok(restored);
    assert.deepEqual(restored.contextRecovery, session.contextRecovery);
    assert.equal(require("../lib/coop-session-lifecycle").lifecycleState(restored, null,
      null, "task_coordinator"), "needs_input");
    assert.equal(require("../lib/sdk-bridge-recovery").attachBridgeRecovery({ opts: {} }).autoResumeAllowed(restored), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

["lead_off", "owner_stop", "owner_question"].forEach(function (condition) {
  test("context recovery respects " + condition, async function () {
    var h = harness();
    try {
      if (condition === "lead_off") h.leadMode = false;
      if (condition === "owner_stop") h.session.taskStopRequested = true;
      if (condition === "owner_question") h.session.pendingAskUser = { ask: { mode: "mcp" } };
      await overflow(h);
      assert.equal(h.starts.length, 0);
      assert.equal(h.session.contextRecovery.status, "blocked");
      assert.equal(h.ordinaryResumes, 0);
    } finally { h.cleanup(); }
  });
});

test("renewal rechecks authority after the old stream stops", async function () {
  var h = harness();
  try {
    var release;
    h.session.streamPromise = new Promise(function (resolve) { release = resolve; });
    h.session.queryInstance = { close: function () {} };
    assert.equal(h.compactor.compactAndContinue(h.session, { inPlace: true }), h.session);
    h.control.abandon(h.token, "owner_cancelled");
    release();
    await h.session._coordinatorRenewal;
    assert.equal(h.starts.length, 0);
    assert.equal(h.session.cliSessionId, "exhausted-thread");
  } finally { h.cleanup(); }
});

test("a provider that cannot detach blocks renewal within a bounded wait", async function () {
  var h = harness();
  try {
    h.session.streamPromise = new Promise(function () {});
    h.session.queryInstance = { close: function () {} };
    h.compactor.compactAndContinue(h.session, { inPlace: true });
    await h.session._coordinatorRenewal;
    assert.equal(h.starts.length, 0);
    assert.equal(h.session.cliSessionId, "exhausted-thread");
    assert.equal(h.session._compactionInProgress, false);
    assert.ok(h.events.some(function (entry) { return /did not stop in time/.test(entry.text); }));
  } finally { h.cleanup(); }
});
