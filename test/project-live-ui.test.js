var test = require("node:test");
var assert = require("node:assert");
var createLiveUiRegistry =
  require("../lib/server-live-ui-registry").createLiveUiRegistry;
var attachProjectLiveUi =
  require("../lib/project-live-ui").attachProjectLiveUi;
var exactLoopbackOrigin =
  require("../lib/project-live-ui").exactLoopbackOrigin;

function harness(overrides) {
  overrides = overrides || {};
  var sent = [];
  var commands = [];
  var controlWs = {
    readyState: 1,
    _clayUser: { id: "user-a" },
  };
  var extensionWs = {
    readyState: 1,
    _clayUser: { id: "user-a" },
  };
  var session = {
    localId: 7,
    storageId: overrides.sessionStorageId || "session-storage",
    cliSessionId: "provider-session",
    title: "Framer workflow",
    hidden: false,
    orchestrationTasks: overrides.orchestrationTasks || [],
    orchestrationEvents: [],
  };
  if (Array.isArray(overrides.liveUiReports)) {
    session.liveUiReports = overrides.liveUiReports;
  }
  var alternateSession = {
    localId: 8,
    storageId: "alternate-storage",
    cliSessionId: "alternate-provider-session",
    title: "Selected from extension",
    hidden: false,
    orchestrationTasks: [],
    orchestrationEvents: [],
  };
  var browserState = {
    _extensionWs: extensionWs,
    _extensionId: "extension-a",
    _browserTabList: {
      42: { id: 42, url: overrides.tabUrl || "http://localhost:4242/pricing" },
    },
  };
  var registry = overrides.registry || createLiveUiRegistry({
    serverInstanceId: "server-a",
    random: (function () {
      var value = 0;
      return function () {
        value += 1;
        return "random-" + value;
      };
    })(),
  });
  var coordinated = [];
  var closed = [];
  var followedUp = [];
  var attachments = [];
  var probes = [];
  var createdSessions = [];
  var taskSequence = 0;
  var saved = [];
  var liveUi = attachProjectLiveUi({
    slug: overrides.slug || "clay",
    registry: registry,
    workspace: {
      getLiveUiTarget: function (targetSession, cb) {
        cb(Object.assign({
          writableRoot: "/repo/clay",
          localUrl: "http://localhost:4242",
          running: true,
          portLive: true,
        }, overrides.workspace || {}));
      },
      attachLiveUiTarget: function (targetSession, tabUrl, userId, cb) {
        attachments.push({ session: targetSession, tabUrl: tabUrl, userId: userId });
        cb(overrides.attach || {
          ok: true,
          target: Object.assign({
            projectSlug: "clay",
            projectLabel: "Clay",
            writableRoot: "/repo/clay",
            localUrl: "http://localhost:4242",
            running: true,
            portLive: true,
          }, overrides.workspace || {}),
        });
      },
      inspectLiveUiTarget: function (tabUrl, userId, cb) {
        probes.push({ tabUrl: tabUrl, userId: userId });
        cb(overrides.probe || {
          ok: true,
          target: {
            projectSlug: "clay",
            projectLabel: "Clay",
            worktreeLabel: "design",
            writableRoot: "/repo/.worktrees/design",
          },
        });
      },
      bindLiveUiTarget: function (targetSession, target) {
        targetSession.devCwdAbs = target.writableRoot;
        return true;
      },
    },
    browserState: browserState,
    getSessionForWs: function () { return session; },
    sendTo: function (ws, message) {
      sent.push({ ws: ws, message: message });
    },
    sendExtensionCommandAny: function (command, args) {
      commands.push({ command: command, args: args });
      return Promise.resolve({ ok: true });
    },
    sm: {
      sessions: new Map([
        [session.localId, session],
        [alternateSession.localId, alternateSession],
      ]),
      saveSessionFile: function (targetSession) {
        saved.push(targetSession);
      },
    },
    usersModule: {
      isMultiUser: function () { return true; },
      canAccessSession: function (userId, targetSession) {
        return userId === "user-a" && !targetSession.denied;
      },
    },
    createSessionForMessage: function (ws, message) {
      var created = {
        localId: 9,
        storageId: "created-storage",
        title: "New chat",
        hidden: false,
        coordinationMode: message.coordinator === true,
        orchestrationTasks: [],
        orchestrationEvents: [],
      };
      createdSessions.push(created);
      return created;
    },
    saveImageFile: function () { return "live-ui-shot.png"; },
    taskOrchestrator: {
      coordinateExternalTask: function (input) {
        taskSequence++;
        coordinated.push(input);
        session.coordinationMode = true;
        var task = {
          taskId: "task-" + taskSequence,
          title: input.title,
          status: "running",
          currentActivity: "Worker is running",
          workerSessionId: 100 + taskSequence,
          workerColor: taskSequence === 1 ? "#A78BFA" : "#36C6A7",
        };
        session.orchestrationTasks.push(task);
        return {
          ok: true,
          orchestrationTaskId: task.taskId,
          workerSessionId: 100 + taskSequence,
          workerColor: task.workerColor,
        };
      },
      messageFromTool: function (input) {
        followedUp.push(input);
        var task = session.orchestrationTasks.find(function (candidate) {
          return candidate.taskId === input.taskId;
        });
        if (task) task.status = "running";
        return { content: [{ type: "text", text: "Sent the Live UI follow-up." }] };
      },
      closeTask: function (parent, taskId, targetWs, reason) {
        closed.push({ taskId: taskId, reason: reason });
        parent.orchestrationTasks = parent.orchestrationTasks.filter(function (task) {
          return task.taskId !== taskId;
        });
        return true;
      },
    },
  });
  return {
    liveUi: liveUi,
    registry: registry,
    controlWs: controlWs,
    extensionWs: extensionWs,
    session: session,
    alternateSession: alternateSession,
    sent: sent,
    commands: commands,
    coordinated: coordinated,
    closed: closed,
    followedUp: followedUp,
    attachments: attachments,
    probes: probes,
    createdSessions: createdSessions,
    saved: saved,
  };
}

function pair(state, extra) {
  var message = Object.assign({
    type: "live_ui_request_pair",
    protocolVersion: 1,
    requestId: "request-1",
    sessionId: "session-storage",
    targetTabId: 42,
  }, extra || {});
  assert.strictEqual(state.liveUi.handleLiveUiMessage(state.controlWs, message), true);
  var pairingState = state.sent.filter(function (entry) {
    return entry.message.type === "live_ui_state" &&
      entry.message.state === "pairing";
  })[0];
  return pairingState ? pairingState.message : null;
}

function prove(state, pairingState) {
  var pairCommand = state.commands.filter(function (entry) {
    return entry.command === "live_ui_pair";
  })[0];
  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: pairingState.pairingId,
    event: "target.prove",
    payload: { nonce: pairCommand.args.nonce },
  });
}

function proveLatest(state, pairingState) {
  var pairCommands = state.commands.filter(function (entry) {
    return entry.command === "live_ui_pair";
  });
  var pairCommand = pairCommands[pairCommands.length - 1];
  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: pairingState.pairingId,
    event: "target.prove",
    payload: { nonce: pairCommand.args.nonce },
  });
}

test("pairs a server-derived session, dev origin, root, extension, and tab", function () {
  var state = harness();
  var paired = pair(state);
  assert.ok(paired);
  assert.strictEqual(paired.allowedOrigin, "http://localhost:4242");
  assert.strictEqual(paired.serverInstanceId, "server-a");
  assert.strictEqual(state.commands[0].command, "live_ui_pair");
  assert.ok(state.commands[0].args.reconnectCredential);
  assert.strictEqual(state.commands[0].args.projectLabel, "clay");
  assert.strictEqual(state.commands[0].args.sessionLabel, "Framer workflow");
  assert.strictEqual(state.commands[0].args.projectSlug, "clay");
  assert.strictEqual(state.commands[0].args.sessionId, "session-storage");

  prove(state, paired);
  assert.strictEqual(state.registry.getPair(paired.pairingId).state, "paired");
  assert.ok(state.sent.some(function (entry) {
    return entry.ws === state.controlWs &&
      entry.message.type === "live_ui_state" &&
      entry.message.state === "paired";
  }));
});

test("server can pin a visible session selected by the extension", function () {
  var state = harness();
  var paired = pair(state, { sessionId: state.alternateSession.localId });
  assert.ok(paired);
  assert.strictEqual(paired.sessionId, "alternate-storage");
  assert.strictEqual(state.commands[0].args.sessionLabel, "Selected from extension");
});

test("extension picker cannot pin a session hidden by access control", function () {
  var state = harness();
  state.alternateSession.denied = true;
  assert.strictEqual(pair(state, {
    sessionId: state.alternateSession.localId,
  }), null);
  assert.strictEqual(state.sent[0].message.code, "LIVE_UI_SESSION_DENIED");
});

test("rejects stale session claims, stopped dev servers, and wrong origins", function () {
  var stale = harness();
  assert.strictEqual(pair(stale, { sessionId: "other-session" }), null);
  assert.strictEqual(stale.sent[0].message.code, "LIVE_UI_SESSION_DENIED");

  var stopped = harness({ workspace: { running: false, portLive: false } });
  assert.strictEqual(pair(stopped), null);
  assert.strictEqual(stopped.sent[0].message.code, "LIVE_UI_DEV_SERVER_REQUIRED");

  var remote = harness({ tabUrl: "https://example.com/pricing" });
  assert.strictEqual(pair(remote), null);
  assert.strictEqual(remote.sent[0].message.code, "LIVE_UI_ORIGIN_DENIED");
});

test("attaches a selected chat only through the server-authorized workspace check", function () {
  var state = harness();
  var paired = pair(state, { attachWorkspace: true });
  assert.ok(paired);
  assert.strictEqual(state.attachments.length, 1);
  assert.strictEqual(state.attachments[0].session, state.session);
  assert.strictEqual(state.attachments[0].userId, "user-a");
  assert.strictEqual(state.attachments[0].tabUrl,
    "http://localhost:4242/pricing");

  var mismatched = harness({
    attach: {
      ok: false,
      code: "LIVE_UI_TARGET_PROJECT_MISMATCH",
      error: "The inspected server belongs to a different Clay project",
    },
  });
  assert.strictEqual(pair(mismatched, { attachWorkspace: true }), null);
  assert.strictEqual(mismatched.sent[0].message.code,
    "LIVE_UI_TARGET_PROJECT_MISMATCH");
  assert.strictEqual(mismatched.commands.length, 0);
});

test("probes the inspected server without exposing its absolute path", function () {
  var state = harness();
  state.liveUi.handleLiveUiMessage(state.controlWs, {
    type: "live_ui_probe_target",
    protocolVersion: 1,
    requestId: "probe-1",
    targetTabId: 42,
  });
  var message = state.sent[state.sent.length - 1].message;
  assert.strictEqual(message.type, "live_ui_target_workspace");
  assert.strictEqual(message.state, "matched");
  assert.strictEqual(message.projectSlug, "clay");
  assert.strictEqual(message.worktreeLabel, "design");
  assert.strictEqual(JSON.stringify(message).indexOf("/repo/"), -1);
});

test("remote previews can defer project choice while retaining exact-origin checks", function () {
  var state = harness({
    tabUrl: "https://preview.example.dev/account",
    probe: {
      ok: false,
      code: "LIVE_UI_TARGET_LISTENER_NOT_FOUND",
      error: "No local server process owns the inspected port",
    },
  });
  state.liveUi.handleLiveUiMessage(state.controlWs, {
    type: "live_ui_probe_target",
    protocolVersion: 1,
    requestId: "probe-preview",
    targetTabId: 42,
  });
  var message = state.sent[state.sent.length - 1].message;
  assert.strictEqual(message.state, "manual");
  assert.strictEqual(message.projectSlug, null);
});

test("creates and pairs a coordinator chat bound to the inspected workspace", function () {
  var state = harness();
  state.liveUi.handleLiveUiMessage(state.controlWs, {
    type: "live_ui_create_bound_session",
    protocolVersion: 1,
    requestId: "create-1",
    targetTabId: 42,
  });
  assert.strictEqual(state.createdSessions.length, 1);
  assert.strictEqual(state.createdSessions[0].coordinationMode, true);
  assert.strictEqual(state.createdSessions[0].devCwdAbs, "/repo/clay");
  var pairing = state.sent.filter(function (entry) {
    return entry.message.type === "live_ui_state" &&
      entry.message.state === "pairing";
  })[0];
  assert.ok(pairing);
  assert.strictEqual(pairing.message.sessionId, "created-storage");
});

test("accepts only a server-derived Tailscale or preview origin", function () {
  var tailscale = harness({
    tabUrl: "http://100.124.11.117:4242/pricing",
    workspace: { tailscaleUrl: "http://100.124.11.117:4242" },
  });
  var paired = pair(tailscale);
  assert.ok(paired);
  assert.strictEqual(paired.allowedOrigin, "http://100.124.11.117:4242");

  var preview = harness({
    tabUrl: "https://clay-pr-123.example.dev/pricing",
    workspace: { previewUrl: "https://clay-pr-123.example.dev" },
  });
  var previewPaired = pair(preview);
  assert.ok(previewPaired);
  assert.strictEqual(previewPaired.allowedOrigin,
    "https://clay-pr-123.example.dev");

  var mismatched = harness({
    tabUrl: "https://attacker.example/pricing",
    workspace: { previewUrl: "https://clay-pr-123.example.dev" },
  });
  assert.strictEqual(pair(mismatched), null);
  assert.strictEqual(mismatched.sent[0].message.code, "LIVE_UI_ORIGIN_DENIED");
});

test("relays a sanitized selection once only to the bound control", function () {
  var state = harness();
  var paired = pair(state);
  prove(state, paired);
  var selectionMessage = {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    clientMessageId: "selection-1",
    event: "selection.update",
    payload: {
      tag: "button",
      role: "button",
      text: "Email jane@example.com",
      accessibleName: "Save",
      route: "/pricing",
      documentGeneration: "document-1",
      rect: { x: 10, y: 20, width: 100, height: 40 },
      selectors: ["#save"],
    },
  };
  state.liveUi.handleLiveUiMessage(state.extensionWs, selectionMessage);
  state.liveUi.handleLiveUiMessage(state.extensionWs, selectionMessage);

  var selections = state.sent.filter(function (entry) {
    return entry.message.type === "live_ui_selection";
  });
  var acknowledgments = state.sent.filter(function (entry) {
    return entry.message.type === "live_ui_relay" &&
      entry.message.event === "relay.ack";
  });
  assert.strictEqual(selections.length, 1);
  assert.strictEqual(selections[0].ws, state.controlWs);
  assert.match(selections[0].message.selection.text, /\[redacted-email\]/);
  assert.strictEqual(acknowledgments.length, 2);
  assert.strictEqual(acknowledgments[1].message.duplicate, true);

  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    clientMessageId: "selection-clear-1",
    event: "selection.clear",
  });
  var cleared = state.sent.filter(function (entry) {
    return entry.message.type === "live_ui_selection" &&
      entry.message.selection === null;
  });
  assert.strictEqual(cleared.length, 1);
});

test("rejects target events from an unrelated control socket and supports unpair", function () {
  var state = harness();
  var paired = pair(state);
  prove(state, paired);
  var unrelated = { readyState: 1, _clayUser: { id: "user-a" } };
  state.liveUi.handleLiveUiMessage(unrelated, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    clientMessageId: "bad-selection",
    event: "selection.update",
    payload: {},
  });
  assert.strictEqual(state.sent[state.sent.length - 1].message.code,
    "LIVE_UI_EXTENSION_MISMATCH");

  state.liveUi.handleLiveUiMessage(state.controlWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    event: "control.unpair",
  });
  assert.strictEqual(state.registry.getPair(paired.pairingId).state, "revoked");
  assert.strictEqual(state.commands[state.commands.length - 1].command,
    "live_ui_unpair");
});

test("target reload reconnects and a control reload rebinds with rotation", function () {
  var state = harness();
  var paired = pair(state);
  prove(state, paired);

  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    clientMessageId: "report-before-refresh",
    event: "report.submit",
    payload: {
      text: "Keep this worker visible after refresh",
      screenshot: {
        mediaType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    },
  });
  var acceptedReport = state.sent.find(function (entry) {
    return entry.message.type === "live_ui_relay" &&
      entry.message.event === "report.accepted";
  }).message.payload;
  state.sent.length = 0;

  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    event: "target.disconnect",
  });
  assert.strictEqual(state.registry.getPair(paired.pairingId).state,
    "reconnecting");
  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    event: "target.reconnect",
  });
  assert.strictEqual(state.registry.getPair(paired.pairingId).state, "paired");
  var refreshedSnapshot = state.sent.find(function (entry) {
    return entry.ws === state.extensionWs &&
      entry.message.type === "live_ui_relay" &&
      entry.message.event === "reports.snapshot";
  });
  assert.ok(refreshedSnapshot);
  assert.strictEqual(refreshedSnapshot.message.payload.reports.length, 1);
  assert.strictEqual(refreshedSnapshot.message.payload.reports[0].reportId,
    acceptedReport.reportId);

  state.liveUi.handleDisconnect(state.controlWs);
  var nextControl = {
    readyState: 1,
    _clayUser: { id: "user-a" },
  };
  state.liveUi.handleLiveUiMessage(nextControl, {
    type: "live_ui_relay",
    protocolVersion: 1,
    requestId: "rebind-1",
    pairingId: paired.pairingId,
    event: "control.rebind",
    payload: { reconnectCredential: paired.reconnectCredential },
  });
  var rebound = state.sent.filter(function (entry) {
    return entry.ws === nextControl &&
      entry.message.type === "live_ui_state" &&
      entry.message.state === "paired";
  })[0];
  assert.ok(rebound);
  assert.notStrictEqual(rebound.message.reconnectCredential,
    paired.reconnectCredential);
});

test("target reports stay routed to their paired project after control navigation", function () {
  var pairedProject = harness({ slug: "webapp" });
  var pairingState = pair(pairedProject);
  prove(pairedProject, pairingState);
  pairedProject.liveUi.handleDisconnect(pairedProject.controlWs);
  pairedProject.controlWs.readyState = 3;

  var currentProject = harness({
    slug: "clay",
    registry: pairedProject.registry,
  });
  currentProject.liveUi.handleLiveUiMessage(currentProject.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    requestId: "cross-project-rebind",
    pairingId: pairingState.pairingId,
    event: "control.rebind",
    payload: { reconnectCredential: pairingState.reconnectCredential },
  });
  assert.strictEqual(pairedProject.registry.getPair(pairingState.pairingId).state,
    "paired");
  currentProject.liveUi.handleLiveUiMessage(currentProject.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: pairingState.pairingId,
    clientMessageId: "cross-project-report",
    event: "report.submit",
    payload: {
      text: "Keep the expanded grid above the content.",
      screenshot: {
        mediaType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    },
  });

  assert.strictEqual(pairedProject.coordinated.length, 1);
  assert.strictEqual(pairedProject.coordinated[0].objective,
    "Keep the expanded grid above the content.");
  assert.strictEqual(currentProject.sent.filter(function (entry) {
    return entry.message.type === "live_ui_state" &&
      entry.message.code === "LIVE_UI_PROJECT_MISMATCH";
  }).length, 0);
});

test("initial pairing routes through the existing Clay project connection", function () {
  var pairedProject = harness({
    slug: "webapp",
    sessionStorageId: "webapp-session",
  });
  var currentProject = harness({
    slug: "lead",
    registry: pairedProject.registry,
    sessionStorageId: "lead-session",
  });
  currentProject.liveUi.handleLiveUiMessage(currentProject.extensionWs, {
    type: "live_ui_request_pair",
    protocolVersion: 1,
    requestId: "cross-project-pair",
    projectSlug: "webapp",
    sessionId: "webapp-session",
    targetTabId: 43,
    tabs: [{ id: 43, url: "http://localhost:4242/pricing" }],
    extensionId: "extension-a",
    attachWorkspace: true,
  });

  var pairingState = pairedProject.sent.find(function (entry) {
    return entry.ws === currentProject.extensionWs &&
      entry.message.type === "live_ui_state" &&
      entry.message.state === "pairing";
  });
  assert.ok(pairingState);
  var pairing = pairedProject.registry.getPair(pairingState.message.pairingId);
  assert.strictEqual(pairing.projectSlug, "webapp");
  assert.strictEqual(pairing.sessionId, "webapp-session");
  var command = pairedProject.sent.find(function (entry) {
    return entry.ws === currentProject.extensionWs &&
      entry.message.type === "extension_command" &&
      entry.message.command === "live_ui_pair";
  });
  assert.ok(command);
});

test("cross-project routing rejects a different extension user", function () {
  var pairedProject = harness({ slug: "webapp" });
  var pairingState = pair(pairedProject);
  prove(pairedProject, pairingState);
  pairedProject.liveUi.handleDisconnect(pairedProject.controlWs);
  pairedProject.controlWs.readyState = 3;
  pairedProject.extensionWs.readyState = 3;

  var currentProject = harness({
    slug: "clay",
    registry: pairedProject.registry,
  });
  currentProject.extensionWs._clayUser = { id: "user-b" };
  currentProject.liveUi.handleLiveUiMessage(currentProject.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: pairingState.pairingId,
    clientMessageId: "wrong-user-report",
    event: "report.submit",
    payload: { text: "This must not reach the paired project." },
  });

  assert.strictEqual(pairedProject.coordinated.length, 0);
  assert.strictEqual(currentProject.sent.filter(function (entry) {
    return entry.message.type === "live_ui_state" &&
      entry.message.code === "LIVE_UI_EXTENSION_OFFLINE";
  }).length, 1);
});

test("a new pairing restores every non-dismissed Live UI worker for the chat", function () {
  var state = harness();
  var firstPair = pair(state);
  prove(state, firstPair);
  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: firstPair.pairingId,
    clientMessageId: "durable-report",
    event: "report.submit",
    payload: {
      text: "Keep this worker attached to the chat",
      screenshot: {
        mediaType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    },
  });
  assert.strictEqual(state.session.liveUiReports.length, 1);
  assert.ok(state.saved.indexOf(state.session) !== -1);

  state.liveUi.handleLiveUiMessage(state.controlWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: firstPair.pairingId,
    event: "control.unpair",
  });
  state.sent.length = 0;
  var secondPair = pair(state, { requestId: "request-2" });
  proveLatest(state, secondPair);
  var snapshot = state.sent.find(function (entry) {
    return entry.ws === state.extensionWs &&
      entry.message.type === "live_ui_relay" &&
      entry.message.event === "reports.snapshot";
  });
  assert.ok(snapshot);
  assert.strictEqual(snapshot.message.payload.reports.length, 1);
  assert.strictEqual(snapshot.message.payload.reports[0].title,
    "Keep this worker attached to the chat");
});

test("persisted Live UI workers are reconstructed after a server restart", function () {
  var state = harness({
    orchestrationTasks: [{
      taskId: "task-restored",
      clientRef: "live-ui-report:report-restored",
      title: "Restore the pricing worker",
      status: "running",
      workerSessionId: 144,
      workerColor: "#36C6A7",
    }],
    liveUiReports: [{
      reportId: "report-restored",
      taskId: "task-restored",
      title: "Restore the pricing worker",
      status: "working",
      message: "Being worked on.",
      selection: null,
      workerSessionId: 144,
      workerColor: "#36C6A7",
    }],
  });
  var paired = pair(state);
  prove(state, paired);
  var snapshot = state.sent.find(function (entry) {
    return entry.ws === state.extensionWs &&
      entry.message.type === "live_ui_relay" &&
      entry.message.event === "reports.snapshot";
  });
  assert.strictEqual(snapshot.message.payload.reports.length, 1);
  assert.strictEqual(snapshot.message.payload.reports[0].reportId,
    "report-restored");
  assert.strictEqual(snapshot.message.payload.reports[0].worker.sessionId, 144);
});

test("legacy Live UI tasks recover once without resurrecting dismissed cards", function () {
  var state = harness({
    orchestrationTasks: [{
      taskId: "legacy-live-ui-task",
      clientRef: "live-ui:old-pair:old-message",
      title: "Legacy clock worker",
      status: "completed",
      resolvedByCoordinator: true,
      workerSessionId: 151,
      workerColor: "#A78BFA",
    }],
  });
  var firstPair = pair(state);
  prove(state, firstPair);
  var firstSnapshot = state.sent.find(function (entry) {
    return entry.message.type === "live_ui_relay" &&
      entry.message.event === "reports.snapshot";
  });
  assert.strictEqual(firstSnapshot.message.payload.reports.length, 1);
  assert.strictEqual(firstSnapshot.message.payload.reports[0].reportId,
    "legacy-live-ui-task");

  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: firstPair.pairingId,
    clientMessageId: "dismiss-legacy-worker",
    event: "report.dismiss",
    payload: { reportId: "legacy-live-ui-task" },
  });
  state.liveUi.handleLiveUiMessage(state.controlWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: firstPair.pairingId,
    event: "control.unpair",
  });
  state.sent.length = 0;
  var secondPair = pair(state, { requestId: "request-after-dismiss" });
  proveLatest(state, secondPair);
  var secondSnapshot = state.sent.find(function (entry) {
    return entry.message.type === "live_ui_relay" &&
      entry.message.event === "reports.snapshot";
  });
  assert.strictEqual(secondSnapshot.message.payload.reports.length, 0);
  assert.strictEqual(state.session.liveUiReports[0].dismissed, true);
});

test("closed orchestration workers are omitted from restored Live UI cards", function () {
  var state = harness({
    orchestrationTasks: [{
      taskId: "task-closed",
      clientRef: "live-ui-report:report-closed",
      title: "Closed worker",
      status: "cancelled",
    }],
    liveUiReports: [{
      reportId: "report-closed",
      taskId: "task-closed",
      title: "Closed worker",
      status: "working",
      message: "Being worked on.",
    }],
  });
  var paired = pair(state);
  prove(state, paired);
  var snapshot = state.sent.find(function (entry) {
    return entry.message.type === "live_ui_relay" &&
      entry.message.event === "reports.snapshot";
  });
  assert.strictEqual(snapshot.message.payload.reports.length, 0);
  assert.strictEqual(state.session.liveUiReports[0].dismissed, true);
});

test("an unknown rebind revokes the stale extension pairing after restart", function () {
  var state = harness();
  state.liveUi.handleLiveUiMessage(state.controlWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    requestId: "rebind-stale",
    pairingId: "pair-from-previous-server",
    event: "control.rebind",
    payload: { reconnectCredential: "stale-reconnect-token" },
  });
  assert.ok(state.sent.some(function (entry) {
    return entry.ws === state.controlWs &&
      entry.message.type === "live_ui_state" &&
      entry.message.state === "revoked" &&
      entry.message.pairingId === "pair-from-previous-server" &&
      entry.message.reason === "server_restart";
  }));
});

test("target exit revokes the pairing and notifies the control", function () {
  var state = harness();
  var paired = pair(state);
  prove(state, paired);
  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    event: "target.closed",
    payload: { reason: "user_exit" },
  });
  assert.strictEqual(state.registry.getPair(paired.pairingId).state, "revoked");
  assert.ok(state.sent.some(function (entry) {
    return entry.ws === state.controlWs &&
      entry.message.type === "live_ui_state" &&
      entry.message.state === "revoked" &&
      entry.message.reason === "user_exit";
  }));
});

test("target reports remain for review and route follow-up to their existing worker", async function () {
  var state = harness();
  var paired = pair(state);
  prove(state, paired);
  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    clientMessageId: "selection-report",
    event: "selection.update",
    payload: {
      tag: "section",
      text: "Pricing",
      route: "/pricing",
      documentGeneration: "document-1",
      rect: { x: 0, y: 0, width: 600, height: 320 },
      selectors: ["#pricing"],
      component: {
        framework: "react",
        name: "PricingCard",
        chain: ["PricingCard", "PricingGrid", "App"],
        source: {
          file: "http://localhost:4242/src/components/PricingCard.tsx?t=1",
          line: 18,
          column: 3,
        },
      },
    },
  });
  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    clientMessageId: "report-1",
    event: "report.submit",
    payload: {
      text: "Increase the spacing",
      screenshot: {
        mediaType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
      diagnostics: {
        console: [{ level: "error", text: "Failed for jane@example.com" }],
        network: [{
          method: "GET",
          url: "https://api.example.com/pricing?token=secret",
          status: 500,
          duration: 23,
        }],
      },
      attachments: {
        images: [{
          mediaType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          name: "pricing-mobile.png",
        }],
        pastes: ["Viewport: 390x844\nExpected 24px spacing"],
      },
    },
  });

  assert.strictEqual(state.coordinated.length, 1);
  assert.strictEqual(state.coordinated[0].coordinatorSessionId, "session-storage");
  assert.strictEqual(state.coordinated[0].promoteCoordinator, true);
  assert.match(state.coordinated[0].context, /#pricing/);
  assert.match(state.coordinated[0].context, /React component: PricingCard/);
  assert.match(state.coordinated[0].context,
    /Likely source: src\/components\/PricingCard\.tsx:18/);
  assert.match(state.coordinated[0].context,
    /Writable root: \/repo\/clay/);
  assert.match(state.coordinated[0].ownedPaths,
    /^Live UI report .+ Likely component source: src\/components\/PricingCard\.tsx\./);
  assert.match(state.coordinated[0].ownedPaths,
    /Confirm the smallest safe source boundary/);
  assert.match(state.coordinated[0].context, /\[redacted-email\]/);
  assert.match(state.coordinated[0].context, /https:\/\/api\.example\.com\/pricing/);
  assert.doesNotMatch(state.coordinated[0].context, /token=secret/);
  assert.deepStrictEqual(state.coordinated[0].imageRefs, [
    { mediaType: "image/png", file: "live-ui-shot.png" },
    { mediaType: "image/png", file: "live-ui-shot.png" },
  ]);
  assert.match(state.coordinated[0].context, /pricing-mobile\.png/);
  assert.match(state.coordinated[0].context, /Expected 24px spacing/);
  assert.ok(state.sent.some(function (entry) {
    return entry.ws === state.extensionWs &&
      entry.message.type === "live_ui_relay" &&
      entry.message.event === "report.accepted" &&
      entry.message.payload.status === "working" &&
      entry.message.payload.worker.sessionId === 101 &&
      entry.message.payload.worker.color === "#A78BFA" &&
      entry.message.payload.locator.component.name === "PricingCard";
  }));
  var firstAccepted = state.sent.find(function (entry) {
    return entry.message.type === "live_ui_relay" &&
      entry.message.event === "report.accepted";
  }).message.payload;

  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    clientMessageId: "report-2",
    event: "report.submit",
    payload: {
      text: "Fix the mobile label",
      screenshot: {
        mediaType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    },
  });
  assert.strictEqual(state.coordinated.length, 2);

  state.session.orchestrationTasks[0].status = "completed";
  state.session.orchestrationTasks[0].resolvedByCoordinator = false;
  await new Promise(function (resolve) { setTimeout(resolve, 750); });
  assert.ok(state.sent.some(function (entry) {
    return entry.message.type === "live_ui_relay" &&
      entry.message.event === "report.status" &&
      entry.message.payload.status === "completed" &&
      entry.message.payload.message === "Ready for your review.";
  }));
  assert.deepStrictEqual(state.closed, []);

  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    clientMessageId: "report-followup-1",
    event: "report.submit",
    payload: {
      reportId: firstAccepted.reportId,
      text: "The spacing is still too tight on mobile.",
      screenshot: {
        mediaType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    },
  });
  assert.strictEqual(state.coordinated.length, 2);
  assert.strictEqual(state.followedUp.length, 1);
  assert.strictEqual(state.followedUp[0].taskId, "task-1");
  assert.strictEqual(state.followedUp[0]._liveUiFollowup, true);
  assert.match(state.followedUp[0].message, /still too tight on mobile/);
  assert.deepStrictEqual(state.followedUp[0].imageRefs, [{
    mediaType: "image/png",
    file: "live-ui-shot.png",
  }]);

  state.session.orchestrationTasks[0].status = "completed";
  state.session.orchestrationTasks[0].resolvedByCoordinator = true;
  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    clientMessageId: "report-dismiss-1",
    event: "report.dismiss",
    payload: { reportId: firstAccepted.reportId },
  });
  assert.deepStrictEqual(state.closed, []);
  assert.strictEqual(state.session.orchestrationTasks[0].taskId, "task-1");
  assert.ok(state.sent.some(function (entry) {
    return entry.message.type === "live_ui_relay" &&
      entry.message.event === "report.removed" &&
      entry.message.payload.reportId === firstAccepted.reportId;
  }));
  var errorsBeforeDuplicate = state.sent.filter(function (entry) {
    return entry.message.type === "live_ui_state" && entry.message.state === "error";
  }).length;
  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    clientMessageId: "report-dismiss-1",
    event: "report.dismiss",
    payload: { reportId: firstAccepted.reportId },
  });
  assert.strictEqual(state.closed.length, 0);
  assert.strictEqual(state.sent.filter(function (entry) {
    return entry.message.type === "live_ui_state" && entry.message.state === "error";
  }).length, errorsBeforeDuplicate);
});

test("rejects an unsafe Live UI screenshot payload", function () {
  var state = harness();
  var paired = pair(state);
  prove(state, paired);
  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    clientMessageId: "report-unsafe-image",
    event: "report.submit",
    payload: {
      text: "Inspect this",
      screenshot: {
        mediaType: "image/svg+xml",
        data: "PHN2Zz48L3N2Zz4=",
      },
    },
  });
  assert.strictEqual(state.coordinated.length, 0);
  assert.ok(state.sent.some(function (entry) {
    return entry.message.type === "live_ui_state" &&
      entry.message.code === "LIVE_UI_SCREENSHOT_REQUIRED";
  }));
});

test("loopback origin validation is exact and excludes production URLs", function () {
  assert.strictEqual(exactLoopbackOrigin("http://localhost:3000/path"),
    "http://localhost:3000");
  assert.strictEqual(exactLoopbackOrigin("https://127.0.0.1:7292/app"),
    "https://127.0.0.1:7292");
  assert.strictEqual(exactLoopbackOrigin("http://[::1]:4242/app"),
    "http://[::1]:4242");
  assert.strictEqual(exactLoopbackOrigin("https://example.com"), null);
});
