var crypto = require("crypto");
var sanitizeSelectionPacket =
  require("./project-live-ui-context").sanitizeSelectionPacket;
var attachLiveUiReports =
  require("./project-live-ui-reports").attachLiveUiReports;
var attachProjectLiveUiPairing =
  require("./project-live-ui-pairing").attachProjectLiveUiPairing;
var liveUiTarget = require("./project-live-ui-target");

var PROTOCOL_VERSION = 1;

function clientIdFor(ws) {
  if (!ws._clayLiveUiClientId) ws._clayLiveUiClientId = crypto.randomUUID();
  return ws._clayLiveUiClientId;
}

function userIdFor(ws) {
  return ws && ws._clayUser ? ws._clayUser.id : "_single_user";
}

function attachProjectLiveUi(ctx) {
  var slug = ctx.slug;
  var registry = ctx.registry;
  var workspace = ctx.workspace;
  var browserState = ctx.browserState;
  var getSessionForWs = ctx.getSessionForWs;
  var usersModule = ctx.usersModule;
  var sendTo = ctx.sendTo;
  var sendExtensionCommandAny = ctx.sendExtensionCommandAny;
  var createSessionForMessage = ctx.createSessionForMessage;
  var controls = new Map();
  var selections = new Map();
  var reports = attachLiveUiReports({
    registry: registry,
    coordinateExternalTask: ctx.taskOrchestrator.coordinateExternalTask,
    saveImageFile: ctx.saveImageFile,
    getLinuxUserForSession: ctx.getLinuxUserForSession,
    followUpTask: ctx.taskOrchestrator.messageFromTool,
    assertExtensionSender: assertExtensionSender,
    sendTarget: sendTarget,
    closeTask: function (pairing, session, taskId, reason) {
      return ctx.taskOrchestrator.closeTask(
        session, taskId, pairControlWs(pairing), reason);
    },
  });
  var pairingRequests = attachProjectLiveUiPairing({
    protocolVersion: PROTOCOL_VERSION,
    slug: slug,
    registry: registry,
    workspace: workspace,
    browserState: browserState,
    getSessionForWs: getSessionForWs,
    usersModule: usersModule,
    sendTo: sendTo,
    sendExtensionCommandAny: sendExtensionCommandAny,
    createSessionForMessage: createSessionForMessage,
    controls: controls,
    reports: reports,
    sm: ctx.sm,
    clientIdFor: clientIdFor,
    userIdFor: userIdFor,
    extensionIdentity: extensionIdentity,
    assertProtocol: assertProtocol,
    sendError: sendError,
    sendState: sendState,
  });

  function sendError(ws, requestId, error, pairingId) {
    sendTo(ws, {
      type: "live_ui_state",
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId || null,
      pairingId: pairingId || null,
      state: "error",
      code: error && error.code ? error.code : "LIVE_UI_ERROR",
      error: error && error.message ? error.message : String(error),
    });
  }

  function sendState(ws, requestId, state, extra) {
    sendTo(ws, Object.assign({
      type: "live_ui_state",
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId || null,
      state: state,
    }, extra || {}));
  }

  function assertProtocol(msg) {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      var error = new Error("Live UI protocol version 1 is required");
      error.code = "LIVE_UI_PROTOCOL_MISMATCH";
      throw error;
    }
  }

  function extensionIdentity() {
    var extensionWs = browserState._extensionWs;
    if (!extensionWs || extensionWs.readyState !== 1) {
      var error = new Error("Browser extension is not connected");
      error.code = "LIVE_UI_EXTENSION_OFFLINE";
      throw error;
    }
    return {
      ws: extensionWs,
      ownerKey: clientIdFor(extensionWs),
      instanceId: browserState._extensionId || clientIdFor(extensionWs),
    };
  }

  function pairControlWs(pairing) {
    return controls.get(pairing.controlClientId) || null;
  }

  function assertExtensionSender(ws, pairing) {
    var extension = extensionIdentity();
    if (ws !== extension.ws ||
        pairing.extensionInstanceId !== extension.instanceId) {
      var error = new Error("Live UI target events must come from the paired extension");
      error.code = "LIVE_UI_EXTENSION_MISMATCH";
      throw error;
    }
    return extension;
  }

  function proveTarget(ws, msg, pairing) {
    var extension = assertExtensionSender(ws, pairing);
    var proved = registry.provePair({
      pairingId: pairing.pairingId,
      userId: userIdFor(ws),
      extensionInstanceId: extension.instanceId,
      targetTabId: pairing.targetTabId,
      allowedOrigin: pairing.allowedOrigin,
      nonce: msg.payload && msg.payload.nonce,
    });
    var controlWs = pairControlWs(proved);
    if (controlWs) {
      sendState(controlWs, null, "paired", {
        pairingId: proved.pairingId,
        sessionId: proved.sessionId,
        targetTabId: proved.targetTabId,
        allowedOrigin: proved.allowedOrigin,
      });
    }
    reports.sendSnapshot(proved);
  }

  function updateSelection(ws, msg, pairing) {
    assertExtensionSender(ws, pairing);
    var accepted = registry.acceptMessage(pairing.pairingId, msg.clientMessageId, function () {
      var result = sanitizeSelectionPacket(msg.payload);
      if (!result.ok) {
        var error = new Error(result.error);
        error.code = "LIVE_UI_SELECTION_INVALID";
        throw error;
      }
      var selection = Object.assign({
        selectionId: crypto.randomUUID(),
        pairingId: pairing.pairingId,
      }, result.packet);
      selections.set(pairing.pairingId, selection);
      return { accepted: true, selectionId: selection.selectionId };
    });
    var controlWs = pairControlWs(pairing);
    if (controlWs && !accepted.duplicate) {
      sendTo(controlWs, {
        type: "live_ui_selection",
        protocolVersion: PROTOCOL_VERSION,
        pairingId: pairing.pairingId,
        selection: selections.get(pairing.pairingId),
      });
    }
    sendTo(ws, {
      type: "live_ui_relay",
      protocolVersion: PROTOCOL_VERSION,
      pairingId: pairing.pairingId,
      event: "relay.ack",
      clientMessageId: msg.clientMessageId,
      duplicate: accepted.duplicate,
      acknowledgment: accepted.acknowledgment,
    });
  }

  function clearSelection(ws, msg, pairing) {
    assertExtensionSender(ws, pairing);
    var accepted = registry.acceptMessage(pairing.pairingId, msg.clientMessageId, function () {
      selections.delete(pairing.pairingId);
      return { accepted: true, cleared: true };
    });
    var controlWs = pairControlWs(pairing);
    if (controlWs && !accepted.duplicate) {
      sendTo(controlWs, {
        type: "live_ui_selection",
        protocolVersion: PROTOCOL_VERSION,
        pairingId: pairing.pairingId,
        selection: null,
      });
    }
    sendTo(ws, {
      type: "live_ui_relay",
      protocolVersion: PROTOCOL_VERSION,
      pairingId: pairing.pairingId,
      event: "relay.ack",
      clientMessageId: msg.clientMessageId,
      duplicate: accepted.duplicate,
      acknowledgment: accepted.acknowledgment,
    });
  }

  function disconnectTarget(ws, pairing) {
    var extension = assertExtensionSender(ws, pairing);
    var reconnecting = registry.disconnect({
      pairingId: pairing.pairingId,
      userId: userIdFor(ws),
      extensionInstanceId: extension.instanceId,
      actor: "target",
    });
    var controlWs = pairControlWs(reconnecting);
    if (controlWs) {
      sendState(controlWs, null, "reconnecting", {
        pairingId: reconnecting.pairingId,
        reconnectExpiresAt: reconnecting.reconnectExpiresAt,
      });
    }
  }

  function reconnectTarget(ws, pairing) {
    var extension = assertExtensionSender(ws, pairing);
    var tab = browserState._browserTabList[pairing.targetTabId];
    var tabOrigin = tab && tab.url ? liveUiTarget.exactHttpOrigin(tab.url) : null;
    var reconnected = registry.reconnectPair({
      pairingId: pairing.pairingId,
      userId: userIdFor(ws),
      extensionInstanceId: extension.instanceId,
      actor: "target",
      targetTabId: pairing.targetTabId,
      allowedOrigin: tabOrigin,
    });
    var controlWs = pairControlWs(reconnected.pairing);
    if (controlWs) {
      sendState(controlWs, null, "paired", {
        pairingId: reconnected.pairing.pairingId,
        sessionId: reconnected.pairing.sessionId,
        targetTabId: reconnected.pairing.targetTabId,
        allowedOrigin: reconnected.pairing.allowedOrigin,
      });
    }
    reports.sendSnapshot(reconnected.pairing);
  }

  function closeTarget(ws, msg, pairing) {
    assertExtensionSender(ws, pairing);
    registry.revokePair(pairing.pairingId,
      msg.payload && msg.payload.reason ? msg.payload.reason : "target_closed");
    selections.delete(pairing.pairingId);
    reports.clearPair(pairing.pairingId);
    var controlWs = pairControlWs(pairing);
    if (controlWs) {
      sendState(controlWs, null, "revoked", {
        pairingId: pairing.pairingId,
        reason: msg.payload && msg.payload.reason ?
          msg.payload.reason : "target_closed",
      });
    }
  }

  function rebindControl(ws, msg, pairing) {
    var extension = extensionIdentity();
    if (pairing.userId !== userIdFor(ws)) {
      var userError = new Error("The reconnecting control user does not own this pairing");
      userError.code = "LIVE_UI_CONTROL_MISMATCH";
      throw userError;
    }
    var controlId = clientIdFor(ws);
    var reconnected = registry.reconnectPair({
      pairingId: pairing.pairingId,
      userId: userIdFor(ws),
      extensionInstanceId: extension.instanceId,
      actor: "control",
      controlClientId: controlId,
      controlOwnerKey: controlId,
      controlReconnectToken: msg.payload && msg.payload.reconnectCredential,
    });
    controls.set(controlId, ws);
    sendState(ws, msg.requestId, "paired", {
      pairingId: reconnected.pairing.pairingId,
      sessionId: reconnected.pairing.sessionId,
      targetTabId: reconnected.pairing.targetTabId,
      allowedOrigin: reconnected.pairing.allowedOrigin,
      reconnectCredential: reconnected.controlReconnectToken,
    });
  }

  function unpair(ws, msg, pairing) {
    if (pairing.controlClientId !== clientIdFor(ws) ||
        pairing.userId !== userIdFor(ws)) {
      var error = new Error("Only the paired control client can unpair Live UI");
      error.code = "LIVE_UI_CONTROL_MISMATCH";
      throw error;
    }
    registry.revokePair(pairing.pairingId, "control_unpair");
    selections.delete(pairing.pairingId);
    reports.clearPair(pairing.pairingId);
    sendExtensionCommandAny("live_ui_unpair", {
      protocolVersion: PROTOCOL_VERSION,
      pairingId: pairing.pairingId,
    }, 3000).catch(function () {});
    sendState(ws, msg.requestId, "revoked", {
      pairingId: pairing.pairingId,
      reason: "control_unpair",
    });
  }

  function sendTarget(pairing, event, payload) {
    var extension = extensionIdentity();
    sendTo(extension.ws, {
      type: "live_ui_relay",
      protocolVersion: PROTOCOL_VERSION,
      pairingId: pairing.pairingId,
      event: event,
      payload: payload || null,
    });
  }

  function relay(ws, msg) {
    assertProtocol(msg);
    var pairing = registry.getPair(msg.pairingId);
    if (pairing.projectSlug !== slug) {
      var error = new Error("The pairing belongs to another project");
      error.code = "LIVE_UI_PROJECT_MISMATCH";
      throw error;
    }
    if (msg.event === "target.prove") return proveTarget(ws, msg, pairing);
    if (msg.event === "selection.update") return updateSelection(ws, msg, pairing);
    if (msg.event === "selection.clear") return clearSelection(ws, msg, pairing);
    if (msg.event === "report.submit") {
      return reports.handleMessage(ws, msg, pairing, selections.get(pairing.pairingId));
    }
    if (msg.event === "report.dismiss" || msg.event === "report.approve") {
      return reports.dismiss(ws, msg, pairing);
    }
    if (msg.event === "target.disconnect") return disconnectTarget(ws, pairing);
    if (msg.event === "target.reconnect") return reconnectTarget(ws, pairing);
    if (msg.event === "target.closed") return closeTarget(ws, msg, pairing);
    if (msg.event === "control.rebind") return rebindControl(ws, msg, pairing);
    if (msg.event === "control.unpair") return unpair(ws, msg, pairing);
    var eventError = new Error("Unsupported Live UI relay event");
    eventError.code = "LIVE_UI_EVENT_DENIED";
    throw eventError;
  }

  function dispatchLiveUiMessage(ws, msg) {
    if (msg.type === "live_ui_request_pair") return pairingRequests.pair(ws, msg);
    if (msg.type === "live_ui_probe_target") return pairingRequests.probeTarget(ws, msg);
    if (msg.type === "live_ui_create_bound_session") {
      return pairingRequests.createBoundSession(ws, msg);
    }
    return relay(ws, msg);
  }

  function isReconnectFailure(msg, error) {
    if (msg.event !== "control.rebind") return false;
    return error.code === "LIVE_UI_NOT_FOUND" ||
      error.code === "LIVE_UI_REVOKED" ||
      error.code === "LIVE_UI_INVALID_RECONNECT" ||
      error.code === "LIVE_UI_IDENTITY_MISMATCH";
  }

  function handleLiveUiMessage(ws, msg) {
    var accepted = msg && (
      msg.type === "live_ui_request_pair" ||
      msg.type === "live_ui_probe_target" ||
      msg.type === "live_ui_create_bound_session" ||
      msg.type === "live_ui_relay");
    if (!accepted) return false;
    try {
      dispatchLiveUiMessage(ws, msg);
    } catch (error) {
      if (isReconnectFailure(msg, error)) {
        sendState(ws, msg.requestId, "revoked", {
          pairingId: msg.pairingId,
          reason: error.code === "LIVE_UI_NOT_FOUND" ?
            "server_restart" : "reconnect_rejected",
        });
      } else {
        sendError(ws, msg.requestId, error, msg.pairingId);
      }
    }
    return true;
  }

  function handleDisconnect(ws) {
    if (!ws || !ws._clayLiveUiClientId) return;
    controls.delete(ws._clayLiveUiClientId);
    registry.disconnectClient({
      userId: userIdFor(ws),
      controlClientId: ws._clayLiveUiClientId,
    });
  }

  return {
    handleLiveUiMessage: handleLiveUiMessage,
    handleDisconnect: handleDisconnect,
  };
}

module.exports = {
  PROTOCOL_VERSION: PROTOCOL_VERSION,
  attachProjectLiveUi: attachProjectLiveUi,
  exactLoopbackOrigin: liveUiTarget.exactLoopbackOrigin,
};
