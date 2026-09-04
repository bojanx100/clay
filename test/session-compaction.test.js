var test = require("node:test");
var assert = require("node:assert");

var compaction = require("../lib/project-session-compaction");
var processorModule = require("../lib/sdk-message-processor");
var decisionStaging = require("../lib/coop-owner-decision-staging");

test("compact continuation prompt moves latest user message into current block", function () {
  var session = {
    localId: 7,
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.5",
    history: [
      { type: "user_message", text: "Build the staff helper", _ts: 1 },
      { type: "delta", text: "Implemented the first version.", _ts: 2 },
      { type: "user_message", text: "why did this stop?", _ts: 3 },
      { type: "result", usage: null, _ts: 4 },
    ],
  };

  var latest = compaction.findLatestUserMessage(session);
  var prompt = compaction.buildCompactContinuationPrompt(session, {
    latestUserMessage: latest,
    cwd: "/tmp/project",
    maxChars: 20000,
  });

  assert.ok(prompt.indexOf("Build the staff helper") !== -1);
  assert.ok(prompt.indexOf("Implemented the first version.") !== -1);
  assert.ok(prompt.indexOf("<current_user_message>\nwhy did this stop?\n</current_user_message>") !== -1);
  assert.ok(prompt.indexOf("Use this transcript only to preserve continuity") !== -1);
  assert.ok(prompt.indexOf("commits, pushes, tests, and status messages in <clay_handoff_context> are historical") !== -1);
  assert.ok(prompt.indexOf("if you create or push a new commit in this continuation, report that new commit") !== -1);
});

test("compaction replays the latest persisted image and retains its reference", function () {
  var source = {
    localId: 1,
    storageId: "old-session",
    title: "Image review",
    vendor: "codex",
    history: [
      { type: "user_message", text: "Review the prior work", _ts: 1 },
      { type: "tool_start", id: "tool-1", name: "ViewImage", _ts: 2 },
      { type: "tool_result", id: "tool-1", content: "The prior image was readable.", _ts: 3 },
      {
        type: "user_message",
        text: "Inspect this attached image",
        imageRefs: [{ mediaType: "image/png", file: "owner.png" }],
        _ts: 4,
      },
    ],
  };
  var sessions = new Map([[source.localId, source]]);
  var started = null;
  var loadedRefs = null;
  var sm = {
    sessions: sessions,
    createSessionRaw: function(opts) {
      var session = Object.assign({ localId: 2, history: [], pendingPermissions: {} }, opts);
      sessions.set(session.localId, session);
      return session;
    },
    sendAndRecord: function(session, event) { session.history.push(event); },
    saveSessionFile: function () {},
    switchSession: function () {},
    broadcastSessionList: function () {},
  };
  var api = compaction.attachSessionCompaction({
    cwd: "/tmp/project",
    imagesDir: "/tmp/project-images",
    sm: sm,
    sdk: {
      startQuery: function(session, prompt, images, access) {
        started = { session: session, prompt: prompt, images: images, access: access };
      },
    },
    sendToSession: function () {},
    ensureProjectAccessForSession: function () { return "owner-1"; },
    loadImagesForSdk: function(refs) {
      loadedRefs = refs;
      return [{ mediaType: "image/png", data: "image-data", savedPath: "/tmp/project-images/owner.png" }];
    },
  });

  var continuation = api.compactAndContinue(source, { reason: "manual" });
  var retriedMessage = continuation.history.find(function(entry) { return entry.compactedRetry === true; });

  assert.deepEqual(loadedRefs, [{ mediaType: "image/png", file: "owner.png" }]);
  assert.deepEqual(started.images, [{ mediaType: "image/png", data: "image-data", savedPath: "/tmp/project-images/owner.png" }]);
  assert.strictEqual(started.access, "owner-1");
  assert.deepEqual(retriedMessage.imageRefs, [{ mediaType: "image/png", file: "owner.png" }]);
  assert.strictEqual(retriedMessage.imageCount, 1);
  assert.ok(started.prompt.indexOf("Review the prior work") < started.prompt.indexOf("Tool result: ViewImage"));
  assert.match(started.prompt, /<clay_image_attachments>\n- image\/png: \/tmp\/project-images\/owner\.png\n<\/clay_image_attachments>/);
});

test("Codex empty zero-usage turn triggers compact-and-continue once", function () {
  var recorded = [];
  var compactCalls = 0;
  var sm = {
    modelsByVendor: { codex: ["gpt-5.5"] },
    availableModels: ["gpt-5.5"],
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    sendToSession: function () {},
    sendAndRecord: function (session, obj) {
      recorded.push(obj);
      session.history.push(obj);
    },
  };
  var processor = processorModule.attachMessageProcessor({
    sm: sm,
    send: function () {},
    slug: "test",
    isMate: false,
    mateDisplayName: "",
    pushModule: null,
    getNotificationsModule: function () { return null; },
    getSDK: function () { return null; },
    adapter: { vendor: "codex" },
    cwd: process.cwd(),
    onProcessingChanged: function () {},
    onTurnDone: function () {},
    onAutoTitle: function () {},
    opts: {
      compactAndContinue: function () {
        compactCalls++;
        return { localId: 2 };
      },
    },
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
  });
  var session = {
    localId: 1,
    vendor: "codex",
    history: [
      { type: "user_message", text: "hello", _ts: 1 },
    ],
    blocks: {},
    sentToolResults: {},
    pendingPermissions: {},
    pendingElicitations: {},
    pendingAskUser: {},
    activeTaskToolIds: {},
    taskIdMap: {},
    isProcessing: true,
    responsePreview: "",
    streamedText: false,
  };

  processor.processSDKMessage(session, { yokeType: "turn_start" });
  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: null,
    usage: null,
    modelUsage: { "gpt-5.5": { contextWindow: null } },
    sessionId: "thread-1",
  });
  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: null,
    usage: null,
    modelUsage: { "gpt-5.5": { contextWindow: null } },
    sessionId: "thread-1",
  });

  assert.strictEqual(compactCalls, 1);
  assert.ok(recorded.some(function (item) {
    return item.type === "info" && String(item.text || "").indexOf("Clay is compacting") !== -1;
  }));
});

test("Claude's zero-cost image-history rejection starts one fresh compacted continuation", function () {
  var recorded = [];
  var compactCalls = 0;
  var sm = {
    modelsByVendor: { claude: ["claude-opus-4.8"] },
    availableModels: ["claude-opus-4.8"],
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    sendToSession: function () {},
    sendAndRecord: function (session, obj) {
      recorded.push(obj);
      session.history.push(obj);
    },
  };
  var processor = processorModule.attachMessageProcessor({
    sm: sm,
    send: function () {},
    slug: "test",
    isMate: false,
    mateDisplayName: "",
    pushModule: null,
    getNotificationsModule: function () { return null; },
    getSDK: function () { return null; },
    adapter: { vendor: "claude" },
    cwd: process.cwd(),
    onProcessingChanged: function () {},
    onTurnDone: function () {},
    onAutoTitle: function () {},
    opts: {
      compactAndContinue: function (session, options) {
        compactCalls++;
        assert.strictEqual(session.localId, 1);
        assert.deepEqual(options, { reason: "claude_image_history" });
        return { localId: 2 };
      },
    },
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
  });
  var session = {
    localId: 1,
    vendor: "claude",
    history: [{ type: "user_message", text: "Continue the work", _ts: 1 }],
    blocks: {},
    sentToolResults: {},
    pendingPermissions: {},
    pendingElicitations: {},
    pendingAskUser: {},
    activeTaskToolIds: {},
    taskIdMap: {},
    isProcessing: true,
    responsePreview: "",
    streamedText: false,
  };
  var imageError = "API Error: an image in the conversation could not be processed and " +
    "was removed. Re-read the file with a different approach if you still need it.";

  processor.processSDKMessage(session, { yokeType: "turn_start" });
  processor.processSDKMessage(session, {
    yokeType: "message",
    messageRole: "assistant",
    content: [{ type: "text", text: imageError }],
  });
  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    sessionId: "poisoned-claude-thread",
  });

  assert.strictEqual(compactCalls, 1);
  assert.strictEqual(recorded[recorded.length - 1].type, "done");
  assert.strictEqual(recorded[recorded.length - 1].code, 0);
  assert.ok(!recorded.some(function (item) { return item.type === "result"; }));
});

test("compaction transfers the permanent Coop-home role to its continuation", function () {
  var sessions = new Map();
  var source = {
    localId: 1,
    storageId: "old-home",
    coopHome: true,
    title: "Coop",
    titleManuallySet: true,
    vendor: "codex",
    history: [{ type: "user_message", text: "Continue the CTO work", _ts: 1 }],
  };
  sessions.set(source.localId, source);
  var nextLocalId = 2;
  var switchedTo = null;
  var started = null;
  var sm = {
    sessions: sessions,
    createSessionRaw: function (opts) {
      var session = Object.assign({
        localId: nextLocalId++,
        history: [],
        pendingPermissions: {},
      }, opts);
      sessions.set(session.localId, session);
      return session;
    },
    sendAndRecord: function (session, event) { session.history.push(event); },
    saveSessionFile: function () {},
    switchSession: function (id) { switchedTo = id; },
    broadcastSessionList: function () {},
  };
  var api = compaction.attachSessionCompaction({
    cwd: "/tmp/project",
    sm: sm,
    sdk: { startQuery: function (session, prompt) { started = { session: session, prompt: prompt }; } },
    sendToSession: function () {},
  });

  var continuation = api.compactAndContinue(source, { reason: "manual" });

  assert.strictEqual(continuation.coopHome, true);
  assert.strictEqual(source.coopHome, undefined);
  assert.strictEqual(source.hidden, true);
  assert.strictEqual(continuation.title, "Coop");
  assert.strictEqual(switchedTo, continuation.localId);
  assert.strictEqual(started.session, continuation);
  assert.match(started.prompt, /Continue the CTO work/);
});

test("compaction carries coopControlledBy onto the continuation session", function () {
  var sessions = new Map();
  var source = {
    localId: 1,
    storageId: "old-worker",
    coopControlledBy: {
      coopSessionStorageId: "coop-home",
      since: 5,
    },
    title: "Controlled worker",
    vendor: "codex",
    history: [{ type: "user_message", text: "Continue", _ts: 1 }],
  };
  sessions.set(source.localId, source);
  var sm = {
    sessions: sessions,
    createSessionRaw: function (opts) {
      var session = Object.assign({
        localId: 2,
        history: [],
        pendingPermissions: {},
      }, opts);
      sessions.set(session.localId, session);
      return session;
    },
    sendAndRecord: function () {},
    saveSessionFile: function () {},
    switchSession: function () {},
    broadcastSessionList: function () {},
  };
  var api = compaction.attachSessionCompaction({
    cwd: process.cwd(),
    sm: sm,
    sdk: { startQuery: function () {} },
    sendToSession: function () {},
  });

  var continuation = api.compactAndContinue(source, { reason: "manual" });

  assert.deepEqual(continuation.coopControlledBy, {
    coopSessionStorageId: "coop-home",
    since: 5,
  });
});

test("compaction transfers a scoped Coop channel into a distinct provider thread", function () {
  var sessions = new Map();
  var source = {
    localId: 1,
    storageId: "old-webapp-channel",
    cliSessionId: "provider-thread-old",
    coopChannel: {
      projectSlug: "webapp",
      projectTitle: "Web App",
      projectPath: "/repos/webapp",
    },
    ownerId: "owner-1",
    sessionVisibility: "private",
    title: "Web App",
    titleManuallySet: true,
    vendor: "codex",
    history: [{ type: "user_message", text: "Continue the release", _ts: 1 }],
  };
  sessions.set(source.localId, source);
  var nextLocalId = 2;
  var started = null;
  var sm = {
    sessions: sessions,
    createSessionRaw: function (opts) {
      var session = Object.assign({
        localId: nextLocalId++,
        history: [],
        pendingPermissions: {},
      }, opts);
      sessions.set(session.localId, session);
      return session;
    },
    sendAndRecord: function (session, event) { session.history.push(event); },
    saveSessionFile: function () {},
    switchSession: function () {},
    broadcastSessionList: function () {},
  };
  var api = compaction.attachSessionCompaction({
    cwd: "/tmp/lead",
    sm: sm,
    sdk: {
      startQuery: function (session, prompt) {
        started = { session: session, prompt: prompt };
      },
    },
    sendToSession: function () {},
  });

  var continuation = api.compactAndContinue(source, { reason: "manual" });

  assert.deepEqual(continuation.coopChannel, {
    projectSlug: "webapp",
    projectTitle: "Web App",
    projectPath: "/repos/webapp",
  });
  assert.strictEqual(source.coopChannel, undefined);
  assert.strictEqual(source.hidden, true);
  assert.strictEqual(continuation.ownerId, "owner-1");
  assert.strictEqual(continuation.sessionVisibility, "private");
  assert.strictEqual(continuation.cliSessionId, undefined);
  assert.notStrictEqual(continuation.storageId, source.storageId);
  assert.match(started.prompt, /^<coop_project_channel>/);
  assert.match(started.prompt, /Canonical project checkout: \/repos\/webapp/);
  assert.match(started.prompt, /Continue the release/);
});

test("compaction refuses to orphan unresolved coordinator workers", function () {
  var source = {
    localId: 1,
    storageId: "coop-channel-active",
    coopChannel: { projectSlug: "webapp", projectTitle: "Web App" },
    coordinationMode: true,
    orchestrationTasks: [{ taskId: "task-active", status: "running" }],
    history: [{ type: "user_message", text: "Continue", _ts: 1 }],
  };
  var created = 0;
  var errors = [];
  var api = compaction.attachSessionCompaction({
    cwd: "/tmp/lead",
    sm: {
      sessions: new Map([[source.localId, source]]),
      createSessionRaw: function () { created++; return {}; },
    },
    sdk: { startQuery: function () {} },
    sendToSession: function (id, message) { errors.push([id, message]); },
  });

  assert.strictEqual(api.compactAndContinue(source, { reason: "manual" }), null);
  assert.strictEqual(created, 0);
  assert.ok(source.coopChannel);
  assert.strictEqual(source.hidden, undefined);
  assert.match(errors[0][1].text, /worker tasks still need attention/);
});

test("compaction transfers an unanswered typed owner decision without treating it as a worker", function () {
  var decisionScope = {
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
    portfolioTaskId: "coherent-plan", bindingRevision: 1, planRevision: 1,
    planDigest: "0123456789abcdef", coopTopicRef: { topicId: "coherent-plan" },
  };
  var decisionRef = decisionStaging.decisionRefFor(decisionScope);
  var source = {
    localId: 1,
    storageId: "coop-owner-decision-source",
    coopHome: true,
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "plan-decision",
      status: "needs_input",
      ownerDecision: {
        version: 1,
        decisionRef: decisionRef,
        status: "unanswered",
        scope: decisionScope,
        createdAt: 1,
      },
    }],
    history: [{ type: "user_message", text: "Continue", _ts: 1 }],
  };
  var sessions = new Map([[source.localId, source]]);
  var api = compaction.attachSessionCompaction({
    cwd: "/tmp/lead",
    sm: {
      sessions: sessions,
      createSessionRaw: function (options) {
        var next = Object.assign({ localId: 2, history: [] }, options);
        sessions.set(next.localId, next);
        return next;
      },
      sendAndRecord: function (session, event) { session.history.push(event); },
      saveSessionFile: function () {},
      switchSession: function () {},
      broadcastSessionList: function () {},
    },
    sdk: { startQuery: function () {} },
    sendToSession: function () {},
  });

  var continuation = api.compactAndContinue(source, { reason: "manual" });
  assert.ok(continuation);
  assert.equal(continuation.orchestrationTasks[0].ownerDecision.status, "unanswered");
  assert.equal(continuation.orchestrationTasks[0].ownerDecision.decisionRef, decisionRef);
  assert.equal(source.orchestrationTasks, undefined);
});

test("Coop rotation resets compaction depth through the existing compaction path", function () {
  var source = {
    localId: 1,
    storageId: "rotation-source",
    coopHome: true,
    compactionDepth: 3,
    history: [{ type: "user_message", text: "Rotate this context", _ts: 1 }],
  };
  var sessions = new Map([[source.localId, source]]);
  var api = compaction.attachSessionCompaction({
    cwd: "/tmp/project",
    sm: {
      sessions: sessions,
      createSessionRaw: function (options) {
        var next = Object.assign({ localId: 2, history: [] }, options);
        sessions.set(next.localId, next);
        return next;
      },
      sendAndRecord: function (session, event) { session.history.push(event); },
      saveSessionFile: function () {},
      switchSession: function () {},
      broadcastSessionList: function () {},
    },
    sdk: { startQuery: function () {} },
    sendToSession: function () {},
    now: function () { return 12345; },
  });

  var continuation = api.compactAndContinue(source, { rotation: true, reason: "coop_cleanup_rotation" });

  assert.equal(continuation.compactionDepth, 0);
  assert.equal(continuation.compactedAt, 12345);
});

test("compaction moves a settled coordinator graph and retargets worker lineage", function () {
  var source = {
    localId: 1,
    storageId: "coop-channel-settled",
    coopChannel: { projectSlug: "webapp", projectTitle: "Web App" },
    coordinationMode: true,
    orchestrationGraphId: "graph-1",
    orchestrationTasks: [{
      taskId: "task-done",
      status: "completed",
      workerSessionId: 99,
      workerStorageId: "worker-1",
    }],
    orchestrationEvents: [{ type: "task_completed" }],
    orchestrationPolicy: { maxParallel: 2 },
    orchestrationProjectCompletion: {
      status: "completed",
      completionRevision: 1,
      graphDigest: "terminal-graph",
    },
    liveUiReports: [{
      reportId: "report-done",
      taskId: "task-done",
      dismissed: false,
    }],
    history: [{ type: "user_message", text: "Summarize the completed work", _ts: 1 }],
  };
  var worker = {
    localId: 2,
    storageId: "worker-1",
    orchestrationParent: {
      taskId: "task-done",
      sessionId: source.localId,
      sessionStorageId: source.storageId,
    },
  };
  var sessions = new Map([[source.localId, source], [worker.localId, worker]]);
  var saved = [];
  var nextLocalId = 3;
  var api = compaction.attachSessionCompaction({
    cwd: "/tmp/lead",
    sm: {
      sessions: sessions,
      createSessionRaw: function (options) {
        var session = Object.assign({ localId: nextLocalId++, history: [] }, options);
        sessions.set(session.localId, session);
        return session;
      },
      sendAndRecord: function (session, event) { session.history.push(event); },
      saveSessionFile: function (session) { saved.push(session); },
      switchSession: function () {},
      broadcastSessionList: function () {},
    },
    sdk: { startQuery: function () {} },
    sendToSession: function () {},
  });

  var continuation = api.compactAndContinue(source, { reason: "manual" });

  assert.strictEqual(continuation.coordinationMode, true);
  assert.strictEqual(continuation.orchestrationGraphId, "graph-1");
  assert.strictEqual(continuation.orchestrationProjectCompletion.graphDigest, "terminal-graph");
  assert.strictEqual(continuation.orchestrationTasks[0].taskId, "task-done");
  assert.strictEqual(continuation.liveUiReports[0].reportId, "report-done");
  assert.strictEqual(source.coordinationMode, undefined);
  assert.strictEqual(source.orchestrationTasks, undefined);
  assert.strictEqual(source.liveUiReports, undefined);
  assert.strictEqual(worker.orchestrationParent.sessionId, continuation.localId);
  assert.strictEqual(worker.orchestrationParent.sessionStorageId, continuation.storageId);
  assert.ok(saved.indexOf(worker) !== -1);
});

// DEFECT A. A Coop-controlled execution is fenced to one exact session
// identity that the control plane pins durably. Compaction mints a new
// storageId and MOVES orchestrationPolicy -- control metadata included -- onto
// it while nothing repoints the control plane, which orphaned a live execution
// and then bricked graceful restart. Refuse instead of re-homing.
test("compaction refuses a session bound to a Coop-controlled execution", function () {
  var sessions = new Map();
  var source = {
    localId: 1,
    storageId: "351a861b-pre-compaction",
    title: "Controlled coordinator",
    vendor: "codex",
    history: [{ type: "user_message", text: "Do the controlled work", _ts: 1 }],
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "webapp-automation-policy-board-exclusions",
        bindingRevision: 2,
        mode: "project_coordinator",
        status: "running",
        control: {
          executionId: "exec:9091916b",
          incarnationId: "inc:9fdab3e9",
          epoch: 1,
          role: "coordinator",
          authorityId: "auth:1234",
        },
      },
    },
  };
  sessions.set(source.localId, source);
  var created = 0;
  var recorded = [];
  var started = 0;
  var sm = {
    sessions: sessions,
    createSessionRaw: function (opts) {
      created += 1;
      var session = Object.assign({ localId: 2, history: [] }, opts);
      sessions.set(session.localId, session);
      return session;
    },
    sendAndRecord: function (session, event) { recorded.push(event); },
    saveSessionFile: function () {},
    switchSession: function () {},
    broadcastSessionList: function () {},
  };
  var api = compaction.attachSessionCompaction({
    cwd: process.cwd(),
    sm: sm,
    sdk: { startQuery: function () { started += 1; } },
    sendToSession: function () {},
  });

  var continuation = api.compactAndContinue(source, { reason: "empty_turn" });

  assert.strictEqual(continuation, null);
  assert.strictEqual(created, 0);
  assert.strictEqual(started, 0);
  assert.strictEqual(sessions.size, 1);
  assert.strictEqual(source.hidden, undefined);
  assert.strictEqual(source.compactedIntoLocalId, undefined);
  assert.strictEqual(source.orchestrationPolicy.portfolioExecution.control.executionId,
    "exec:9091916b");
  assert.ok(recorded.some(function (item) {
    return item.type === "error" && String(item.text).indexOf("exec:9091916b") !== -1;
  }), "the refusal must be recorded on the session rather than failing silently");
});

test("an uncontrolled orchestration policy still compacts", function () {
  var sessions = new Map();
  var source = {
    localId: 1,
    storageId: "plain-coordinator",
    vendor: "codex",
    history: [{ type: "user_message", text: "Keep going", _ts: 1 }],
    orchestrationPolicy: { portfolioExecution: { portfolioTaskId: "plain", status: "running" } },
  };
  sessions.set(source.localId, source);
  var sm = {
    sessions: sessions,
    createSessionRaw: function (opts) {
      var session = Object.assign({ localId: 2, history: [] }, opts);
      sessions.set(session.localId, session);
      return session;
    },
    sendAndRecord: function () {},
    saveSessionFile: function () {},
    switchSession: function () {},
    broadcastSessionList: function () {},
  };
  var api = compaction.attachSessionCompaction({
    cwd: process.cwd(),
    sm: sm,
    sdk: { startQuery: function () {} },
    sendToSession: function () {},
  });

  var continuation = api.compactAndContinue(source, { reason: "empty_turn" });

  assert.ok(continuation);
  assert.strictEqual(continuation.orchestrationPolicy.portfolioExecution.portfolioTaskId, "plain");
});

test("Codex empty zero-usage turn does not announce compaction for a controlled execution", function () {
  var recorded = [];
  var compactCalls = 0;
  var sm = {
    modelsByVendor: { codex: ["gpt-5.5"] },
    availableModels: ["gpt-5.5"],
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    sendToSession: function () {},
    sendAndRecord: function (session, obj) {
      recorded.push(obj);
      session.history.push(obj);
    },
  };
  var processor = processorModule.attachMessageProcessor({
    sm: sm,
    send: function () {},
    slug: "test",
    isMate: false,
    mateDisplayName: "",
    pushModule: null,
    getNotificationsModule: function () { return null; },
    getSDK: function () { return null; },
    adapter: { vendor: "codex" },
    cwd: process.cwd(),
    onProcessingChanged: function () {},
    onTurnDone: function () {},
    onAutoTitle: function () {},
    opts: {
      compactAndContinue: function () { compactCalls++; return { localId: 2 }; },
    },
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
  });
  var session = {
    localId: 1,
    vendor: "codex",
    history: [{ type: "user_message", text: "hello", _ts: 1 }],
    orchestrationPolicy: {
      portfolioExecution: { control: { executionId: "exec:9091916b", role: "coordinator" } },
    },
    blocks: {},
    sentToolResults: {},
    pendingPermissions: {},
    pendingElicitations: {},
    pendingAskUser: {},
    activeTaskToolIds: {},
    taskIdMap: {},
    isProcessing: true,
    responsePreview: "",
    streamedText: false,
  };

  processor.processSDKMessage(session, { yokeType: "turn_start" });
  processor.processSDKMessage(session, {
    yokeType: "result",
    cost: null,
    usage: null,
    modelUsage: { "gpt-5.5": { contextWindow: null } },
    sessionId: "thread-1",
  });

  assert.strictEqual(compactCalls, 0);
  assert.ok(!recorded.some(function (item) {
    return String(item.text || "").indexOf("Clay is compacting") !== -1;
  }), "no compaction may be announced when compaction will be refused");
  assert.ok(recorded.some(function (item) {
    return item.type === "error" && String(item.text || "").indexOf("empty response") !== -1;
  }), "the wedged provider must still be reported");
});
