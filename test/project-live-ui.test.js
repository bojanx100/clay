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
  var sessionSubscriber = null;
  var dispatched = [];
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
      sessions: new Map([[session.localId, session]]),
      subscribeSession: function (sessionId, callback) {
        assert.strictEqual(sessionId, session.localId);
        sessionSubscriber = callback;
        return function () { sessionSubscriber = null; };
      },
    },
    userMessage: {
      handleUserMessage: function (ws, message) {
        dispatched.push({ ws: ws, message: message });
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
    sent: sent,
    commands: commands,
    dispatched: dispatched,
    emitSession: function (event) {
      if (sessionSubscriber) sessionSubscriber(event);
    },
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

  prove(state, paired);
  assert.strictEqual(state.registry.getPair(paired.pairingId).state, "paired");
  assert.ok(state.sent.some(function (entry) {
    return entry.ws === state.controlWs &&
      entry.message.type === "live_ui_state" &&
      entry.message.state === "paired";
  }));
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

test("target chat dispatches to the pinned session and streams only its active turn", function () {
  var state = harness();
  var paired = pair(state);
  prove(state, paired);
  state.liveUi.handleLiveUiMessage(state.extensionWs, {
    type: "live_ui_relay",
    protocolVersion: 1,
    pairingId: paired.pairingId,
    clientMessageId: "selection-chat",
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
    clientMessageId: "chat-1",
    event: "chat.message",
    payload: { text: "Increase the spacing" },
  });

  assert.strictEqual(state.dispatched.length, 1);
  assert.strictEqual(state.dispatched[0].ws, state.controlWs);
  assert.strictEqual(state.dispatched[0].message.sessionId, state.session.localId);
  assert.strictEqual(state.dispatched[0].message.preserveActiveSession, true);
  assert.match(state.dispatched[0].message.pastes[0], /#pricing/);

  state.emitSession({ type: "delta", text: "I updated it." });
  state.emitSession({ type: "done", code: 0 });
  var targetEvents = state.sent.filter(function (entry) {
    return entry.ws === state.extensionWs &&
      entry.message.type === "live_ui_relay" &&
      entry.message.event === "chat.stream";
  });
  assert.deepStrictEqual(targetEvents.map(function (entry) {
    return entry.message.payload.type;
  }), ["delta", "done"]);
});

test("loopback origin validation is exact and excludes production URLs", function () {
  assert.strictEqual(exactLoopbackOrigin("http://localhost:3000/path"),
    "http://localhost:3000");
  assert.strictEqual(exactLoopbackOrigin("https://127.0.0.1:7292/app"),
    "https://127.0.0.1:7292");
  assert.strictEqual(exactLoopbackOrigin("https://example.com"), null);
});
