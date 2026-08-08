var liveUiTarget = require("./project-live-ui-target");

function displayLabel(value, fallback) {
  var label = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (label || fallback).slice(0, 160);
}

function attachProjectLiveUiPairing(ctx) {
  function targetTab(msg) {
    var tab = ctx.browserState._browserTabList[Number(msg.targetTabId)];
    if (tab && tab.url) return tab;
    var error = new Error(
      "The target tab is not available from the connected extension");
    error.code = "LIVE_UI_TAB_NOT_FOUND";
    throw error;
  }

  function finishPair(ws, msg, session, tab, target, targetError) {
    try {
      if (targetError) throw targetError;
      if (!target || !target.running || !target.portLive || !target.localUrl) {
        var devError = new Error(
          "Start the session's local development server before opening Live UI");
        devError.code = "LIVE_UI_DEV_SERVER_REQUIRED";
        throw devError;
      }
      var allowedOrigin = liveUiTarget.resolveTargetOrigin(target, tab.url);
      if (!allowedOrigin) {
        var originError = new Error(
          "The target tab must use a Clay-managed development or preview origin");
        originError.code = "LIVE_UI_ORIGIN_DENIED";
        throw originError;
      }
      var extension = ctx.extensionIdentity();
      var controlId = ctx.clientIdFor(ws);
      ctx.controls.set(controlId, ws);
      var created = ctx.registry.createPair({
        userId: ctx.userIdFor(ws),
        projectSlug: ctx.slug,
        sessionId: session.storageId || session.localId,
        writableRoot: target.writableRoot,
        extensionInstanceId: extension.instanceId,
        extensionOwnerKey: extension.ownerKey,
        controlClientId: controlId,
        controlOwnerKey: controlId,
        targetTabId: Number(msg.targetTabId),
        allowedOrigin: allowedOrigin,
        allowRemoteOrigin: !liveUiTarget.exactLoopbackOrigin(allowedOrigin),
        takeover: msg.takeover === true,
      });
      ctx.reports.registerPair(created.pairing.pairingId, session);
      ctx.sendState(ws, msg.requestId, "pairing", {
        pairingId: created.pairing.pairingId,
        serverInstanceId: created.pairing.serverInstanceId,
        sessionId: created.pairing.sessionId,
        targetTabId: Number(msg.targetTabId),
        allowedOrigin: allowedOrigin,
        reconnectCredential: created.controlReconnectToken,
        expiresAt: created.pairing.expiresAt,
      });
      ctx.sendExtensionCommandAny("live_ui_pair", {
        protocolVersion: ctx.protocolVersion,
        pairingId: created.pairing.pairingId,
        serverInstanceId: created.pairing.serverInstanceId,
        targetTabId: Number(msg.targetTabId),
        allowedOrigin: allowedOrigin,
        nonce: created.nonce,
        reconnectCredential: created.controlReconnectToken,
        projectLabel: displayLabel(
          target.projectLabel || ctx.slug, "Clay project"),
        sessionLabel: displayLabel(session.title, "New chat"),
        projectSlug: ctx.slug,
        sessionId: session.storageId || session.localId,
      }, 5000).then(function (result) {
        if (!result || result.ok === false) {
          var extensionError = new Error(
            "The browser extension did not accept the Live UI pairing");
          extensionError.code = "LIVE_UI_EXTENSION_PAIR_FAILED";
          throw extensionError;
        }
      }).catch(function (error) {
        ctx.registry.revokePair(
          created.pairing.pairingId, "extension_pair_failed");
        ctx.sendError(ws, msg.requestId, error);
      });
    } catch (error) {
      ctx.sendError(ws, msg.requestId, error);
    }
  }

  function pairResolved(ws, msg, session, targetOverride) {
    var tab = targetTab(msg);
    if (targetOverride) {
      finishPair(ws, msg, session, tab, targetOverride, null);
      return;
    }
    if (msg.attachWorkspace === true || msg.reconnectServer === true) {
      if (!ctx.workspace.attachLiveUiTarget) {
        var unavailable = new Error(
          "This Clay version cannot attach a chat to a development server");
        unavailable.code = "LIVE_UI_ATTACH_UNAVAILABLE";
        finishPair(ws, msg, session, tab, null, unavailable);
        return;
      }
      ctx.workspace.attachLiveUiTarget(
        session, tab.url, ctx.userIdFor(ws), function (result) {
          if (result && result.ok) {
            finishPair(ws, msg, session, tab, result.target, null);
            return;
          }
          if (result && result.code === "LIVE_UI_TARGET_LISTENER_NOT_FOUND") {
            ctx.workspace.getLiveUiTarget(session, function (target) {
              finishPair(ws, msg, session, tab, target, null);
            });
            return;
          }
          var attachError = new Error(result && result.error ?
            result.error : "Clay could not attach this chat to the development server");
          attachError.code = result && result.code ?
            result.code : "LIVE_UI_ATTACH_FAILED";
          finishPair(ws, msg, session, tab, null, attachError);
        });
      return;
    }
    ctx.workspace.getLiveUiTarget(session, function (target) {
      finishPair(ws, msg, session, tab, target, null);
    });
  }

  function pair(ws, msg) {
    ctx.assertProtocol(msg);
    var session = liveUiTarget.resolveSession(
      ctx.sm,
      ctx.usersModule,
      ws,
      msg.sessionId,
      ctx.getSessionForWs(ws)
    );
    if (!session) {
      var error = new Error("The selected session cannot be paired");
      error.code = "LIVE_UI_SESSION_DENIED";
      throw error;
    }
    pairResolved(ws, msg, session, null);
  }

  function probeTarget(ws, msg) {
    ctx.assertProtocol(msg);
    ctx.extensionIdentity();
    var tab = targetTab(msg);
    ctx.workspace.inspectLiveUiTarget(tab.url, ctx.userIdFor(ws), function (result) {
      var target = result && result.target;
      var manual = result &&
        result.code === "LIVE_UI_TARGET_LISTENER_NOT_FOUND" &&
        !liveUiTarget.exactLoopbackOrigin(tab.url);
      ctx.sendTo(ws, {
        type: "live_ui_target_workspace",
        protocolVersion: ctx.protocolVersion,
        requestId: msg.requestId || null,
        targetTabId: Number(msg.targetTabId),
        state: result && result.ok ? "matched" : manual ? "manual" : "unmatched",
        projectSlug: target ? target.projectSlug : null,
        projectLabel: target ?
          displayLabel(target.projectLabel, target.projectSlug) : null,
        worktreeLabel: target ?
          displayLabel(target.worktreeLabel, "Main workspace") : null,
        code: result && result.code || null,
        error: result && result.error || null,
      });
    });
  }

  function createBoundSession(ws, msg) {
    ctx.assertProtocol(msg);
    if (!ctx.createSessionForMessage || !ctx.workspace.attachLiveUiTarget) {
      var unavailable = new Error("This Clay version cannot create a Live UI chat");
      unavailable.code = "LIVE_UI_CREATE_UNAVAILABLE";
      throw unavailable;
    }
    var tab = targetTab(msg);
    ctx.workspace.attachLiveUiTarget(
      null, tab.url, ctx.userIdFor(ws), function (result) {
        if (!result || !result.ok) {
          var attachError = new Error(result && result.error ?
            result.error : "Clay could not identify the inspected workspace");
          attachError.code = result && result.code ||
            "LIVE_UI_TARGET_PROJECT_NOT_FOUND";
          ctx.sendError(ws, msg.requestId, attachError);
          return;
        }
        var session = ctx.createSessionForMessage(ws, {
          type: "new_session",
          coordinator: true,
          mode: "gui",
        });
        if (ctx.workspace.bindLiveUiTarget) {
          ctx.workspace.bindLiveUiTarget(session, result.target);
        } else {
          session.devCwdAbs = result.target.writableRoot;
        }
        pairResolved(ws, msg, session, result.target);
      });
  }

  return {
    createBoundSession: createBoundSession,
    pair: pair,
    probeTarget: probeTarget,
  };
}

module.exports = { attachProjectLiveUiPairing: attachProjectLiveUiPairing };
