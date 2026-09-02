var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var users = require("../lib/users");
var presence = require("../lib/user-presence");
var emailAccounts = require("../lib/email-accounts");
var rateLimitUsageCache = require("../lib/rate-limit-usage-cache");
var handlers = require("../lib/project-connection-handlers");
var createTopicIndex = require("../lib/coop-topic-index").createTopicIndex;
var coopTopicConnection = require("../lib/coop-topic-connection");

function FakeWebSocket() {
  this.events = {};
}

FakeWebSocket.prototype.on = function (event, callback) {
  this.events[event] = callback;
};

FakeWebSocket.prototype.emit = function (event, value) {
  if (this.events[event]) this.events[event](value);
};

function makeSession(id) {
  return {
    localId: id,
    storageId: "storage-" + id,
    cliSessionId: "cli-" + id,
    title: "Session " + id,
    history: [{ type: "user_message", text: "hello", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" }],
    pendingPermissions: {
      request: { requestId: "request", toolName: "Bash", toolInput: { command: "pwd" }, toolUseId: "tool", decisionReason: "needs approval", mateId: "mate" },
    },
    isProcessing: true,
    lastActivity: 10,
    lastViewedAt: 1,
    vendor: "claude",
    model: "claude-sonnet",
    requestedModel: "claude-sonnet",
    verifiedModel: "claude-sonnet",
    mode: "gui",
    loop: { loopId: "loop-1" },
    orchestrationTasks: [],
  };
}

function makeContext(session, sent, events, diagnostics) {
  var sessions = session ? new Map([[session.localId, session]]) : new Map();
  var sm = {
    installedVendors: ["claude"],
    availableVendors: ["claude"],
    modelsByVendor: { claude: ["claude-sonnet"] },
    availableModels: ["claude-default"],
    defaultVendor: "claude",
    currentModel: "claude-default",
    currentPermissionMode: "default",
    currentEffort: "medium",
    currentBetas: [],
    currentThinking: "adaptive",
    currentThinkingBudget: 10000,
    sessions: sessions,
    activeSessionId: session ? session.localId : null,
    slashCommands: ["help"],
    capabilitiesByVendor: {},
    saveSessionFile: function (value) { events.push("save:" + value.localId); },
    replayHistory: function () { events.push("history"); },
    queuedUserMessagesForClient: function () { return ["queued"]; },
    createSession: function () {
      var created = makeSession(99);
      created.pendingPermissions = {};
      created.history = [];
      created.isProcessing = false;
      this.sessions.set(created.localId, created);
      return created;
    },
  };
  return {
    cwd: "/tmp/project",
    slug: "project",
    isMate: false,
    osUsers: [],
    debug: false,
    dangerouslySkipPermissions: false,
    fullAutoMode: false,
    currentVersion: "test",
    lanHost: "127.0.0.1",
    sm: sm,
    tm: {
      list: function () { return [{ id: 1 }]; },
      detachAll: function () { events.push("detach"); },
    },
    nm: { list: function () { return [{ id: "note" }]; } },
    clients: new Set(),
    send: function () {},
    sendTo: function (ws, message) { sent.push(message); },
    _loop: {
      loopState: {},
      loopRegistry: { getById: function () { return { name: "Loop", source: "test" }; } },
      sendConnectionState: function () { sent.push({ type: "loop_state" }); },
      resumeLoop: function () { events.push("resume"); },
    },
    _mcp: { sendConnectionState: function () { sent.push({ type: "mcp_state" }); } },
    _notifications: { sendConnectionState: function () { sent.push({ type: "notification_state" }); } },
    hydrateImageRefs: function () {},
    resolveSessionForView: function () { events.push("resolve_view"); },
    broadcastClientCount: function () { events.push("client_count"); },
    broadcastPresence: function () { events.push("presence_broadcast"); },
    getProjectList: function () { return [{ slug: "project" }]; },
    getHubSchedules: function () { return [{ id: "schedule" }]; },
    loadContextSources: function () { return ["knowledge:one"]; },
    saveContextSources: function (slug, id, value) { events.push("save_context:" + id + ":" + value.join(",")); },
    autoResumeRestartSession: function () { events.push("auto_resume"); },
    restoreDebateState: function () { events.push("restore_debate"); },
    pendingDebateProposals: { pending: { briefData: { title: "Debate" } } },
    stopFileWatch: function () { events.push("stop_file_watch"); },
    stopAllDirWatches: function () { events.push("stop_dir_watches"); },
    getProjectOwnerId: function () { return "owner"; },
    getTitle: function () { return "Title"; },
    getIcon: function () { return "🧱"; },
    getProject: function () { return "Project"; },
    _email: { getEmailDefaults: function () { return []; } },
    warmup: function () { events.push("warmup"); },
    runtimeAssetId: "runtime-test",
    leadMode: {
      getLeadModeState: function () { return { enabled: false, changedAt: null, changedBy: null }; },
      publicState: function (state) { return { leadMode: state.enabled, changedAt: state.changedAt, changedBy: state.changedBy }; },
      resolveOwnerId: function () { return "owner"; },
      isAuthority: function (user, multiUser, ownerId) { return !multiUser || !!(user && user.id === ownerId); },
    },
    diagLog: function (line) { if (diagnostics) diagnostics.push(line); },
    humanAttention: { disconnect: function () { events.push("attention_disconnect"); } },
  };
}

function patchDependencies(options) {
  var originals = {
    isMultiUser: users.isMultiUser,
    getClaudeOpenMode: users.getClaudeOpenMode,
    defaultClaudeOpenMode: users.defaultClaudeOpenMode,
    getLeadMode: users.getLeadMode,
    getPresence: presence.getPresence,
    setPresence: presence.setPresence,
    listAccounts: emailAccounts.listAccounts,
    liveEntries: rateLimitUsageCache.liveEntries,
  };
  users.isMultiUser = function () { return !!options.multiUser; };
  users.getClaudeOpenMode = function () { return "gui"; };
  users.defaultClaudeOpenMode = function () { return "gui"; };
  users.getLeadMode = function () { return false; };
  presence.getPresence = function () { return options.storedPresence || null; };
  presence.setPresence = function (slug, userId, sessionId, mateDm) {
    options.presenceWrites.push({ slug: slug, userId: userId, sessionId: sessionId, mateDm: mateDm });
  };
  emailAccounts.listAccounts = function () { return []; };
  rateLimitUsageCache.liveEntries = function () { return [{ type: "rate_limit", value: 1 }]; };
  return function restore() {
    users.isMultiUser = originals.isMultiUser;
    users.getClaudeOpenMode = originals.getClaudeOpenMode;
    users.defaultClaudeOpenMode = originals.defaultClaudeOpenMode;
    users.getLeadMode = originals.getLeadMode;
    presence.getPresence = originals.getPresence;
    presence.setPresence = originals.setPresence;
    emailAccounts.listAccounts = originals.listAccounts;
    rateLimitUsageCache.liveEntries = originals.liveEntries;
  };
}

test("restored connection preserves initial ordering, history, permissions, debate, and presence", async function () {
  var sent = [];
  var events = [];
  var diagnostics = [];
  var options = { storedPresence: { sessionId: 7, mateDm: "mate-1" }, multiUser: false, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var ctx = makeContext(makeSession(7), sent, events, diagnostics);
    ctx._loop.loopState._needsResume = true;
    var connection = handlers.attachConnectionHandlers(ctx);
    var ws = new FakeWebSocket();
    connection.handleConnection(ws, null, function (socket, msg) {
      if (msg.type === "explode") throw new Error("boom");
      events.push("handled:" + msg.type);
    }, function (socket) {
      connection.handleDisconnection(socket);
    });

    var types = sent.map(function (message) { return message.type; });
    assert.equal(types[0], "info");
    assert.ok(types.indexOf("model_info") < types.indexOf("config_state"));
    assert.ok(types.indexOf("config_state") < types.indexOf("session_list"));
    assert.ok(types.indexOf("session_list") < types.indexOf("session_switched"));
    assert.ok(types.indexOf("session_switched") < types.indexOf("term_list"));
    assert.ok(types.indexOf("term_list") < types.indexOf("context_sources_state"));
    assert.ok(types.indexOf("context_sources_state") < types.indexOf("permission_request_pending"));
    assert.ok(types.indexOf("debate_proposal_pending") > types.indexOf("restore_mate_dm"));
    assert.deepEqual(sent.find(function (message) { return message.type === "restore_mate_dm"; }), {
      type: "restore_mate_dm",
      mateId: "mate-1",
    });
    assert.equal(sent.find(function (message) { return message.type === "info"; }).runtimeAssetId, "runtime-test");
    assert.equal(sent.find(function (message) { return message.type === "info"; }).icon, "🧱",
      "the initial connection snapshot carries current project icon metadata");
    assert.equal(sent.find(function (message) { return message.type === "session_switched"; }).queuedUserMessages[0], "queued");
    assert.ok(events.indexOf("history") !== -1);
    assert.ok(events.indexOf("auto_resume") !== -1);
    assert.ok(events.indexOf("restore_debate") !== -1);
    assert.ok(events.indexOf("warmup") !== -1);
    assert.equal(ctx._loop.loopState._needsResume, undefined);
    await new Promise(function (resolve) { setTimeout(resolve, 550); });
    assert.ok(events.indexOf("resume") !== -1);
    assert.equal(options.presenceWrites[0].sessionId, 7);
    assert.equal(options.presenceWrites[0].mateDm, "mate-1");

    ws.emit("message", Buffer.from("not-json"));
    ws.emit("message", JSON.stringify({ type: "explode" }));
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /\[WS-HANDLER-ERROR\].*type=explode/);
    assert.deepEqual(sent.find(function (message) { return message.type === "toast"; }), {
      type: "toast",
      level: "error",
      message: "Something went wrong handling that action (explode). The server kept running — check the diagnostics log.",
    });

    ws.emit("close");
    assert.ok(events.indexOf("detach") !== -1);
    assert.ok(events.indexOf("stop_file_watch") !== -1);
    assert.ok(events.indexOf("stop_dir_watches") !== -1);
    assert.ok(events.indexOf("attention_disconnect") !== -1);
    assert.equal(ctx.clients.size, 0);
  } finally {
    restore();
  }
});

test("auto-created connection applies email defaults after presence and initial session list", function () {
  var sent = [];
  var events = [];
  var options = { storedPresence: null, multiUser: false, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var ctx = makeContext(null, sent, events);
    ctx._email.getEmailDefaults = function () { return ["account-1", "account-2"]; };
    var connection = handlers.attachConnectionHandlers(ctx);
    var ws = new FakeWebSocket();
    connection.handleConnection(ws, null, function () {}, function () {});
    var types = sent.map(function (message) { return message.type; });
    assert.equal(types.indexOf("session_switched"), -1);
    assert.equal(types.filter(function (type) { return type === "session_list"; }).length, 1);
    var contextMessages = sent.filter(function (message) { return message.type === "context_sources_state"; });
    assert.deepEqual(contextMessages[contextMessages.length - 1].active, ["email:account-1", "email:account-2"]);
    assert.ok(events.indexOf("save_context:99:email:account-1,email:account-2") !== -1);
    assert.equal(options.presenceWrites[0].sessionId, 99);
  } finally {
    restore();
  }
});

test("initial session lists are typed with their source project slug", function () {
  var sent = [];
  var events = [];
  var options = { storedPresence: null, multiUser: false, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var ctx = makeContext(makeSession(7), sent, events);
    ctx.slug = "clay";
    handlers.attachConnectionHandlers(ctx).handleConnection(new FakeWebSocket(), null, function () {}, function () {});
    var sessionList = sent.find(function (message) { return message.type === "session_list"; });
    assert.equal(sessionList.projectSlug, "clay");
    assert.equal(sessionList.sessions[0].coopHome, false);
    assert.equal(sessionList.sessions[0].coopChannel, null);
  } finally {
    restore();
  }
});

test("initial last vendor is resolved for the connecting user and project", function () {
  var sent = [];
  var events = [];
  var calls = [];
  var options = { storedPresence: null, multiUser: false, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var ctx = makeContext(makeSession(7), sent, events);
    ctx.opts = {
      onGetProjectLastVendor: function (slug, userId) {
        calls.push({ slug: slug, userId: userId });
        return { vendor: userId === "owner-a" ? "codex" : "claude" };
      },
    };
    handlers.attachConnectionHandlers(ctx).handleConnection(
      new FakeWebSocket(), { id: "owner-a" }, function () {}, function () {});

    assert.deepStrictEqual(calls, [{ slug: "project", userId: "owner-a" }]);
    assert.deepStrictEqual(sent.find(function (message) {
      return message.type === "last_vendor";
    }), { type: "last_vendor", vendor: "codex" });
  } finally {
    restore();
  }
});

test("Lead connection restores Coop home instead of a remembered worker", function () {
  var sent = [];
  var events = [];
  var options = { storedPresence: { sessionId: 2 }, multiUser: false, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var home = makeSession(1);
    home.coopHome = true;
    var worker = makeSession(2);
    worker.lastViewedAt = 99;
    var ctx = makeContext(home, sent, events);
    ctx.slug = "lead";
    ctx.sm.sessions.set(worker.localId, worker);
    ctx.sm.activeSessionId = worker.localId;
    var ws = new FakeWebSocket();
    ws._clayRequestedSessionId = worker.storageId;
    handlers.attachConnectionHandlers(ctx).handleConnection(ws, null, function () {}, function () {});

    var switched = sent.find(function (message) { return message.type === "session_switched"; });
    assert.equal(switched.id, home.localId);
    assert.equal(switched.coopHome, true);
    assert.equal(switched.coopChannel, null);
    assert.equal(options.presenceWrites[0].sessionId, home.localId);
  } finally {
    restore();
  }
});

test("Lead exact SessionRef restore still opens the requested reference session", function () {
  var sent = [];
  var events = [];
  var options = { storedPresence: { sessionId: 1 }, multiUser: false, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var home = makeSession(1);
    home.coopHome = true;
    var worker = makeSession(2);
    var ctx = makeContext(home, sent, events);
    ctx.slug = "lead";
    ctx.sm.sessions.set(worker.localId, worker);
    var ws = new FakeWebSocket();
    ws._clayRequestedSessionId = worker.storageId;
    ws._clayRequestedSessionExact = true;
    handlers.attachConnectionHandlers(ctx).handleConnection(ws, null, function () {}, function () {});

    var switched = sent.find(function (message) { return message.type === "session_switched"; });
    assert.equal(switched.id, worker.localId);
    assert.equal(switched.coopHome, false);
    assert.equal(options.presenceWrites[0].sessionId, worker.localId);
    assert.ok(events.indexOf("history") !== -1,
      "the exact target session replays its canonical transcript");
    assert.ok(sent.some(function (message) {
      return message.type === "permission_request_pending";
    }), "the exact target session restores its pending-input affordance");
  } finally {
    restore();
  }
});

test("exact requested session misses do not auto-create or replay another transcript", function () {
  var sent = [];
  var events = [];
  var options = { storedPresence: { sessionId: 7 }, multiUser: false, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var ctx = makeContext(makeSession(7), sent, events);
    var connection = handlers.attachConnectionHandlers(ctx);
    var ws = new FakeWebSocket();
    ws._clayRequestedSessionId = "deleted-storage-id";
    ws._clayRequestedSessionExact = true;
    connection.handleConnection(ws, null, function () {}, function () {});

    assert.equal(ctx.sm.sessions.size, 1);
    assert.equal(sent.some(function (message) { return message.type === "session_switched"; }), false);
    assert.equal(events.indexOf("history"), -1);
    assert.equal(options.presenceWrites.length, 0);
    var sessionList = sent.find(function (message) { return message.type === "session_list"; });
    assert.equal(sessionList.sessions.length, 1);
    assert.equal(sessionList.sessions[0].active, false);
  } finally {
    restore();
  }
});

test("connection exposes Lead state to every user but reserves changes for the Clay owner", function () {
  var sent = [];
  var events = [];
  var options = { storedPresence: null, multiUser: true, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var ctx = makeContext(null, sent, events);
    var connection = handlers.attachConnectionHandlers(ctx);
    connection.handleConnection(new FakeWebSocket(), { id: "admin-2", role: "admin" }, function () {}, function () {});
    var adminState = sent.filter(function (message) { return message.type === "lead_mode_changed"; }).pop();
    assert.deepEqual(adminState, { type: "lead_mode_changed", leadMode: false, changedAt: null, changedBy: null, canChange: false });

    connection.handleConnection(new FakeWebSocket(), { id: "owner", role: "admin" }, function () {}, function () {});
    var ownerState = sent.filter(function (message) { return message.type === "lead_mode_changed"; }).pop();
    assert.deepEqual(ownerState, { type: "lead_mode_changed", leadMode: false, changedAt: null, changedBy: null, canChange: true });
  } finally {
    restore();
  }
});

test("global projection is Lead-only and SessionRef navigation is resolve-only", function () {
  var sent = [];
  var events = [];
  var options = { storedPresence: null, multiUser: false, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var nonLead = makeContext(makeSession(7), sent, events);
    nonLead.getGlobalCoopProjection = function () { throw new Error("must not run outside Coop"); };
    handlers.attachConnectionHandlers(nonLead).handleConnection(new FakeWebSocket(), null, function () {}, function () {});
    assert.equal(sent.some(function (message) { return message.type === "global_coop_projection"; }), false);

    sent.length = 0;
    var lead = makeContext(makeSession(7), sent, events);
    lead.slug = "lead";
    lead.getGlobalCoopProjection = function () {
      return { type: "global_coop_projection", projects: [{ projectRef: { projectId: "system-lead" } }] };
    };
    lead.resolveGlobalSessionRef = function (ref) {
      if (!ref || ref.sessionStorageId !== "restart-safe") return { ok: false, code: "session_not_found" };
      return {
        ok: true,
        ref: { projectId: "8c1d8aa6-58b1-5645-85ef-bfcf229e53f9", sessionStorageId: "restart-safe" },
        project: { slug: "renamed-project" },
        session: { localId: 314 },
      };
    };
    var before = lead.sm.sessions.size;
    var connection = handlers.attachConnectionHandlers(lead);
    var ws = new FakeWebSocket();
    connection.handleConnection(ws, null, function () { throw new Error("navigation must not route locally"); }, function () {});
    assert.equal(sent.filter(function (message) { return message.type === "global_coop_projection"; }).length, 1);

    ws.emit("message", JSON.stringify({
      type: "resolve_session_ref",
      sessionRef: { projectId: "8c1d8aa6-58b1-5645-85ef-bfcf229e53f9", sessionStorageId: "restart-safe" },
    }));
    assert.deepEqual(sent.at(-1), {
      type: "session_ref_resolved",
      ok: true,
      sessionRef: { projectId: "8c1d8aa6-58b1-5645-85ef-bfcf229e53f9", sessionStorageId: "restart-safe" },
      slug: "renamed-project",
      localId: 314,
    });
    assert.equal(lead.sm.sessions.size, before);

    ws.emit("message", JSON.stringify({ type: "resolve_session_ref", sessionRef: { projectId: "bad" } }));
    assert.deepEqual(sent.at(-1), { type: "session_ref_resolved", ok: false, code: "session_not_found" });
    assert.equal(lead.sm.sessions.size, before);
  } finally {
    restore();
  }
});

test("Lead topic operations select a canonical lens and resolve only exact referenced events", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-connection-topic-"));
  var sent = [];
  var events = [];
  var options = { storedPresence: null, multiUser: false, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var index = createTopicIndex({ file: path.join(dir, "lead", "topics.json"), now: function () { return 10; } });
    var home = makeSession(1);
    home.storageId = "canonical-topic-home";
    home.coopHome = true;
    home.coopTopicSelection = { topicRef: { topicId: "legacy-topic" }, projectRef: null };
    home.history = [
      { type: "user_message", text: "Codex auth topic event", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" },
      { type: "delta_replace", text: "The authentication result is ready." },
      { type: "done" },
    ];
    var ctx = makeContext(home, sent, events);
    ctx.slug = "lead";
    ctx.coopTopicIndex = index;
    ctx.hydrateImageRefs = function (item) { return item; };
    var projectVisible = true;
    var lensProjectRef = { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" };
    ctx.getGlobalCoopProjection = function () {
      return { type: "global_coop_projection", coop: null, projects: projectVisible ? [{ projectRef: lensProjectRef }] : [], topics: [] };
    };
    var replays = [];
    var forwarded = [];
    ctx.sm.replayHistory = function (session, from, socket, transform, replayOptions) {
      replays.push(replayOptions || null);
    };
    var connection = handlers.attachConnectionHandlers(ctx);
    var ws = new FakeWebSocket();
    connection.handleConnection(ws, null, function (socket, message) { forwarded.push(message); }, function () {});

    ws.emit("message", JSON.stringify({ type: "coop_topic_select", topicRef: { topicId: "codex-authentication" }, projectRef: null }));
    assert.deepEqual(ws._clayCoopTopicRef, { topicId: "codex-authentication" });
    assert.equal(ws._clayCoopProjectRef, null);
    assert.equal(home.coopTopicSelection, undefined);
    assert.deepEqual(replays.pop(), {
      eventIndexes: [0, 1, 2], scope: "topic",
      topicRef: { topicId: "codex-authentication" }, projectRef: null,
      annotateHistoryIndex: true,
    });
    ws.emit("message", JSON.stringify({
      type: "switch_session", id: home.localId, historyScope: "topic",
      topicRef: { topicId: "codex-authentication" }, projectRef: null,
    }));
    assert.equal(forwarded.length, 0);
    assert.equal(ws._clayTopicReplayOptions, undefined);
    ws.emit("message", JSON.stringify({
      type: "resolve_canonical_event", topicRef: { topicId: "codex-authentication" },
      eventRef: { eventKey: "canonical:canonical-topic-home:0", eventIndex: 0, sessionStorageId: "canonical-topic-home" },
    }));
    var resolved = sent.filter(function (message) { return message.type === "canonical_event_resolved"; }).pop();
    assert.deepEqual(resolved, {
      type: "canonical_event_resolved", ok: true, topicRef: { topicId: "codex-authentication" },
      eventRef: { projectId: "system-lead", sessionStorageId: "canonical-topic-home", eventIndex: 0 },
      turnRef: { projectId: "system-lead", sessionStorageId: "canonical-topic-home", startEventIndex: 0, endEventIndex: 2 },
    });
    assert.deepEqual(replays.pop(), {
      eventIndexes: [0, 1, 2], scope: "drill_through",
      topicRef: { topicId: "codex-authentication" }, projectRef: null,
      annotateHistoryIndex: true, focusEventIndex: 0,
    });
    ws.emit("message", JSON.stringify({ type: "coop_topic_select", topicRef: null, projectRef: null }));
    assert.equal(ws._clayCoopTopicRef, null);
    assert.equal(ws._clayCoopProjectRef, null);
    assert.deepEqual(replays.pop(), {
      scope: "canonical", topicRef: null, projectRef: null,
      annotateHistoryIndex: true,
    });
    ws.emit("message", JSON.stringify({
      type: "switch_session", id: home.localId, historyScope: "canonical", topicRef: null, projectRef: null,
    }));
    assert.equal(forwarded.length, 0);
    ws.emit("message", JSON.stringify({ type: "coop_topic_select", topicRef: null, projectRef: lensProjectRef }));
    assert.deepEqual(ws._clayCoopProjectRef, lensProjectRef);
    assert.deepEqual(replays.pop(), {
      scope: "canonical", topicRef: null, projectRef: lensProjectRef,
      annotateHistoryIndex: true,
    });
    assert.equal(index.move({ topicId: "codex-authentication" }, {
      projectRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
    }).ok, true);
    projectVisible = false;
    var replayCount = replays.length;
    ws.emit("message", JSON.stringify({
      type: "resolve_canonical_event", topicRef: { topicId: "codex-authentication" },
      projectRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
      eventRef: { eventKey: "canonical:canonical-topic-home:0", eventIndex: 0, sessionStorageId: "canonical-topic-home" },
    }));
    assert.deepEqual(sent.filter(function (message) { return message.type === "canonical_event_resolved" }).pop(), {
      type: "canonical_event_resolved", ok: false, code: "project_target_unavailable",
    });
    assert.equal(replays.length, replayCount);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Main remains selectable when compaction leaves the topic index on its predecessor", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-connection-main-compacted-"));
  var sent = [];
  var events = [];
  var options = { storedPresence: null, multiUser: false, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var index = createTopicIndex({ file: path.join(dir, "lead", "topics.json"), now: function () { return 10; } });
    var predecessor = makeSession(1);
    predecessor.storageId = "canonical-main-predecessor";
    predecessor.coopHome = true;
    assert.equal(index.ensureRetro(predecessor, { projects: [] }).ok, true);

    var home = makeSession(2);
    home.storageId = "canonical-main-successor";
    home.compactedFromStorageId = predecessor.storageId;
    home.coopHome = true;
    assert.deepEqual(index.ensureRetro(home, { projects: [] }), {
      ok: false,
      code: "canonical_session_mismatch",
    });

    var ctx = makeContext(home, sent, events);
    ctx.slug = "lead";
    ctx.coopTopicIndex = index;
    var replays = [];
    ctx.sm.replayHistory = function (session, from, socket, transform, replayOptions) {
      replays.push(replayOptions || null);
    };
    var connection = handlers.attachConnectionHandlers(ctx);
    var ws = new FakeWebSocket();
    connection.handleConnection(ws, null, function () {}, function () {});

    ws.emit("message", JSON.stringify({
      type: "coop_topic_select", topicRef: null, projectRef: null, historyScope: "main",
    }));

    assert.deepEqual(sent.filter(function (message) {
      return message.type === "coop_topic_selected";
    }).pop(), {
      type: "coop_topic_selected", ok: true, topicRef: null, projectRef: null,
    });
    assert.deepEqual(replays.pop(), {
      eventIndexes: [0], scope: "main", topicRef: null, projectRef: null,
      annotateHistoryIndex: true,
    });
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("topic selection replays predecessor-owned memberships after compaction", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-connection-topic-compacted-"));
  var sent = [];
  var events = [];
  var options = { storedPresence: null, multiUser: false, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var index = createTopicIndex({ file: path.join(dir, "lead", "topics.json"), now: function () { return 10; } });
    var predecessor = makeSession(1);
    predecessor.storageId = "canonical-topic-predecessor";
    predecessor.coopHome = true;
    predecessor.history = [
      { type: "user_message", text: "Codex auth secret-body-should-never-persist and queued ingress recovery", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" },
      { type: "delta_replace", text: "Final assistant authentication and recovery reply" },
      { type: "done" },
    ];
    assert.equal(index.ensureRetro(predecessor, { projects: [] }).ok, true);

    var home = makeSession(2);
    home.storageId = "canonical-topic-successor";
    home.compactedFromStorageId = predecessor.storageId;
    home.coopHome = true;
    home.history = [
      { type: "user_message", text: "Compacted continuation follow-up", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner-2" },
      { type: "delta_replace", text: "Continuation reply" },
      { type: "done" },
    ];

    var ctx = makeContext(home, sent, events);
    ctx.slug = "lead";
    ctx.coopTopicIndex = index;
    ctx.sm.sessions.set(predecessor.localId, predecessor);
    var replays = [];
    ctx.sm.switchSession = function (localId, socket, hydrate, replayOptions) {
      replays.push(replayOptions || null);
    };

    assert.equal(coopTopicConnection.handleTopicMessage(ctx, { isOwner: true }, {
      type: "coop_topic_select",
      topicRef: { topicId: "codex-authentication" },
      historyScope: "topic",
    }, {
      isCoopClient: function () { return true; },
      globalProjectionProvider: function () { return null; },
    }), true);

    assert.deepEqual(sent.filter(function (message) {
      return message.type === "coop_topic_selected";
    }).pop(), {
      type: "coop_topic_selected", ok: true, topicRef: { topicId: "codex-authentication" }, projectRef: null,
    });
    assert.equal(replays.length, 1);
    assert.ok(Array.isArray(replays[0].eventIndexes));
    assert.ok(replays[0].eventIndexes.length > 0, "topic replay keeps predecessor-owned membership");
    assert.equal(replays[0].eventIndexes[0], 0);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Coop topic selection is isolated per socket and preserves a prior selection on denial", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-connection-topic-socket-"));
  var sent = [];
  var events = [];
  var options = { storedPresence: null, multiUser: false, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var index = createTopicIndex({ file: path.join(dir, "lead", "topics.json"), now: function () { return 10; } });
    var home = makeSession(1);
    home.storageId = "canonical-topic-home";
    home.coopHome = true;
    home.history = [
      { type: "user_message", text: "Codex authentication topic", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" },
      { type: "delta_replace", text: "Final answer" },
      { type: "done" },
    ];
    var ctx = makeContext(home, sent, events);
    ctx.slug = "lead";
    ctx.coopTopicIndex = index;
    ctx.getGlobalCoopProjection = function () { return { type: "global_coop_projection", coop: null, projects: [], topics: [] }; };
    var connection = handlers.attachConnectionHandlers(ctx);
    var first = new FakeWebSocket();
    var second = new FakeWebSocket();
    connection.handleConnection(first, null, function () {}, function () {});
    connection.handleConnection(second, null, function () {}, function () {});

    assert.equal(home.coopTopicSelection, undefined);

    first.emit("message", JSON.stringify({
      type: "coop_topic_select", topicRef: { topicId: "codex-authentication" }, projectRef: null,
    }));
    assert.deepEqual(first._clayCoopTopicRef, { topicId: "codex-authentication" });
    assert.equal(second._clayCoopTopicRef, undefined);
    assert.equal(home.coopTopicSelection, undefined);

    first.emit("message", JSON.stringify({
      type: "coop_topic_select", topicRef: { topicId: "missing-topic" }, projectRef: null,
    }));
    assert.deepEqual(sent.filter(function (message) { return message.type === "coop_topic_selected" }).pop(), {
      type: "coop_topic_selected", ok: false, code: "topic_not_found",
    });
    assert.deepEqual(first._clayCoopTopicRef, { topicId: "codex-authentication" });
    assert.equal(first._clayCoopProjectRef, null);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("topic filtered replay receives bounded, sorted canonical membership indexes", function () {
  var session = { storageId: "canonical-topic-home", history: [{}, {}, {}, {}, {}] };
  var indexes = coopTopicConnection.boundedMembershipIndexes({
    turnRefs: [{ sessionStorageId: "canonical-topic-home", startEventIndex: 2, endEventIndex: 4 }],
    eventRefs: [
      { sessionStorageId: "canonical-topic-home", eventIndex: 4 },
      { sessionStorageId: "canonical-topic-home", eventIndex: 0 },
      { sessionStorageId: "canonical-topic-home", eventIndex: -1 },
      { sessionStorageId: "canonical-topic-home", eventIndex: 8 },
    ],
  }, session);
  assert.deepEqual(indexes, [0, 2, 3, 4]);
});

test("topic pagination stays membership-bounded and fails closed after ACL revocation", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-connection-topic-pages-"));
  var sent = [];
  var events = [];
  var options = { storedPresence: null, multiUser: false, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var index = createTopicIndex({ file: path.join(dir, "lead", "topics.json"), now: function () { return 10; } });
    var home = makeSession(1);
    home.storageId = "canonical-topic-home";
    home.coopHome = true;
    home.history = [
      { type: "user_message", text: "Codex auth page", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" },
      { type: "delta_replace", text: "Topic-only answer" },
      { type: "done" },
      { type: "user_message", text: "Unrelated page", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" },
      { type: "delta_replace", text: "Must not leak" },
      { type: "done" },
    ];
    var ctx = makeContext(home, sent, events);
    ctx.slug = "lead";
    ctx.coopTopicIndex = index;
    ctx.hydrateImageRefs = function (item) { return item; };
    var accessible = true;
    var projectRef = { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" };
    ctx.getGlobalCoopProjection = function () {
      return { type: "global_coop_projection", projects: accessible ? [{ projectRef: projectRef }] : [] };
    };
    var connection = handlers.attachConnectionHandlers(ctx);
    var ws = new FakeWebSocket();
    connection.handleConnection(ws, null, function () {}, function () {});
    index.ensureRetro(home);
    var topicRef = index.classifyCanonicalIngress(home, {
      text: "Obsidian routing ledger", coopProjectRef: projectRef,
    }, { isProjectAvailable: function () { return true; } }).topicRef;
    index.addEventMembership(topicRef, [{ eventIndex: 0 }]);
    ws.emit("message", JSON.stringify({ type: "coop_topic_select", topicRef: topicRef, projectRef: projectRef }));
    ws.emit("message", JSON.stringify({ type: "load_more_history", before: 1, target: 0 }));
    var page = sent.filter(function (item) { return item.type === "history_prepend"; }).pop();
    assert.deepEqual(page.items.map(function (item) { return item._historyIndex; }), [0]);
    assert.equal(page.items.some(function (item) { return item.text === "Must not leak"; }), false);

    accessible = false;
    ws.emit("message", JSON.stringify({ type: "load_more_history", before: 1, target: 0 }));
    var denied = sent.filter(function (item) { return item.type === "history_prepend"; }).pop();
    assert.deepEqual(denied.items, []);
    assert.equal(denied.meta.denied, true);
    assert.equal(ws._clayCoopTopicRef, undefined);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("revoked project topics fail closed for selection and every existing-topic operation", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-connection-topic-acl-"));
  var sent = [];
  var events = [];
  var options = { storedPresence: null, multiUser: false, presenceWrites: [] };
  var restore = patchDependencies(options);
  try {
    var index = createTopicIndex({ file: path.join(dir, "lead", "topics.json"), now: function () { return 10; } });
    var home = makeSession(1);
    home.storageId = "canonical-topic-home";
    home.coopHome = true;
    home.history = [
      { type: "user_message", text: "A complete canonical turn", from: "a66ce4a1", fromName: "Admin", clientMessageId: "cm-owner" },
      { type: "delta_replace", text: "A complete final answer" },
      { type: "done" },
    ];
    var ctx = makeContext(home, sent, events);
    ctx.slug = "lead";
    ctx.coopTopicIndex = index;
    ctx.getGlobalCoopProjection = function () { return { type: "global_coop_projection", coop: null, projects: [], topics: [] }; };
    // The canonical owner is connected (single-user shape); the ACL under
    // test is project visibility, not authority.
    ctx.isCoopTopicOwner = function () { return true; };
    var connection = handlers.attachConnectionHandlers(ctx);
    var ws = new FakeWebSocket();
    connection.handleConnection(ws, null, function () {}, function () {});
    assert.equal(index.ensureRetro(home).ok, true);
    var projectRef = { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" };
    var createOptions = { isProjectAvailable: function () { return true; } };
    var revoked = index.classifyCanonicalIngress(home, {
      text: "Marigold graphite cobalt", coopProjectRef: projectRef,
    }, createOptions).topicRef;
    var visible = index.classifyCanonicalIngress(home, { text: "Cedar vellum poppy" }, createOptions).topicRef;
    var revokedClosed = index.classifyCanonicalIngress(home, {
      text: "Saffron quartz lichen", coopProjectRef: projectRef,
    }, createOptions).topicRef;
    assert.equal(index.close(revokedClosed).ok, true);
    var unchanged = JSON.stringify(index.load());

    function rejected(message) {
      ws.emit("message", JSON.stringify(message));
      var result = sent.filter(function (item) { return item.type === "coop_topic_result"; }).pop();
      assert.equal(result.ok, false);
      assert.equal(result.code, "topic_target_unavailable");
    }

    ws.emit("message", JSON.stringify({
      type: "coop_topic_select", topicRef: revoked, projectRef: projectRef,
    }));
    assert.deepEqual(sent.filter(function (item) { return item.type === "coop_topic_selected"; }).pop(), {
      type: "coop_topic_selected", ok: false, code: "project_target_unavailable",
    });
    rejected({ type: "coop_topic_rename", topicRef: revoked, title: "Leaked rename" });
    rejected({ type: "coop_topic_move", topicRef: revoked, group: "cross_project" });
    rejected({ type: "coop_topic_close", topicRef: revoked });
    rejected({ type: "coop_topic_reopen", topicRef: revokedClosed });
    rejected({ type: "coop_topic_link_execution", topicRef: revoked, execution: { projectRef: projectRef } });
    rejected({
      type: "coop_topic_split", topicRef: revoked,
      parts: [{ topicId: "should-not-split", title: "No split", group: "cross_project", eventRefs: [] }],
    });
    rejected({
      type: "coop_topic_merge", targetTopicRef: visible, sourceTopicRefs: [revoked],
    });
    rejected({
      type: "coop_topic_merge", targetTopicRef: revoked, sourceTopicRefs: [visible],
    });
    assert.equal(JSON.stringify(index.load()), unchanged);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
