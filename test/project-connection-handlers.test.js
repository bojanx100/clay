var test = require("node:test");
var assert = require("node:assert/strict");
var users = require("../lib/users");
var presence = require("../lib/user-presence");
var emailAccounts = require("../lib/email-accounts");
var rateLimitUsageCache = require("../lib/rate-limit-usage-cache");
var handlers = require("../lib/project-connection-handlers");

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
    history: [{ type: "user_message", text: "hello" }],
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
