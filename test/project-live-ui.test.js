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
    storageId: "session-storage",
    cliSessionId: "provider-session",
    title: "Framer workflow",
    hidden: false,
    orchestrationTasks: [],
    orchestrationEvents: [],
  };
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
  var registry = createLiveUiRegistry({
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
  var taskSequence = 0;
  var liveUi = attachProjectLiveUi({
    slug: "clay",
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
    },
    usersModule: {
      isMultiUser: function () { return true; },
      canAccessSession: function (userId, targetSession) {
        return userId === "user-a" && !targetSession.denied;
      },
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
        };
        session.orchestrationTasks.push(task);
        return {
          ok: true,
          orchestrationTaskId: task.taskId,
          workerSessionId: 100 + taskSequence,
        };
      },
      closeTask: function (parent, taskId) {
        closed.push(taskId);
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

test("target reports create independent coordinator workers with automatic evidence", async function () {
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
    },
  });

  assert.strictEqual(state.coordinated.length, 1);
  assert.strictEqual(state.coordinated[0].coordinatorSessionId, "session-storage");
  assert.strictEqual(state.coordinated[0].promoteCoordinator, true);
  assert.match(state.coordinated[0].context, /#pricing/);
  assert.match(state.coordinated[0].context, /\[redacted-email\]/);
  assert.match(state.coordinated[0].context, /https:\/\/api\.example\.com\/pricing/);
  assert.doesNotMatch(state.coordinated[0].context, /token=secret/);
  assert.deepStrictEqual(state.coordinated[0].imageRefs, [{
    mediaType: "image/png",
    file: "live-ui-shot.png",
  }]);
  assert.ok(state.sent.some(function (entry) {
    return entry.ws === state.extensionWs &&
      entry.message.type === "live_ui_relay" &&
      entry.message.event === "report.accepted" &&
      entry.message.payload.status === "working";
  }));

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
  state.session.orchestrationTasks[0].resolvedByCoordinator = true;
  await new Promise(function (resolve) { setTimeout(resolve, 750); });
  assert.ok(state.sent.some(function (entry) {
    return entry.message.type === "live_ui_relay" &&
      entry.message.event === "report.status" &&
      entry.message.payload.status === "completed";
  }));
  assert.deepStrictEqual(state.closed, ["task-1"]);
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
  assert.strictEqual(exactLoopbackOrigin("https://example.com"), null);
});
