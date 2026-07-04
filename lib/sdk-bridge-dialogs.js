var crypto = require("crypto");

function attachBridgeDialogs(ctx) {
  var sendAndRecord = ctx.sendAndRecord;
  var pushModule = ctx.pushModule;
  var slug = ctx.slug;

  function handleElicitation(session, request, opts) {
    if (session.loop && session.loop.active && session.loop.role !== "crafting") {
      return Promise.resolve({ action: "reject" });
    }

    return new Promise(function(resolve) {
      var requestId = crypto.randomUUID();
      if (!session.pendingElicitations) session.pendingElicitations = {};
      session.pendingElicitations[requestId] = {
        resolve: resolve,
        request: request,
      };
      sendAndRecord(session, {
        type: "elicitation_request",
        requestId: requestId,
        serverName: request.serverName,
        message: request.message,
        mode: request.mode || "form",
        url: request.url || null,
        elicitationId: request.elicitationId || null,
        requestedSchema: request.requestedSchema || null,
      });

      if (pushModule) {
        pushModule.sendPush({
          type: "elicitation",
          slug: slug,
          title: (request.serverName || "MCP Server") + " needs input",
          body: request.message || "Waiting for your response",
          tag: "claude-elicitation",
        });
      }

      if (opts.signal) {
        opts.signal.addEventListener("abort", function() {
          delete session.pendingElicitations[requestId];
          resolve({ action: "reject" });
        });
      }
    });
  }

  function handleUserDialog(session, request, opts) {
    if (session.loop && session.loop.active && session.loop.role !== "crafting") {
      return Promise.resolve({ behavior: "cancelled" });
    }

    return new Promise(function(resolve) {
      var requestId = crypto.randomUUID();
      if (!session.pendingUserDialogs) session.pendingUserDialogs = {};
      session.pendingUserDialogs[requestId] = {
        resolve: resolve,
        request: request,
      };
      sendAndRecord(session, {
        type: "user_dialog_request",
        requestId: requestId,
        dialogKind: request.dialogKind,
        payload: request.payload || {},
        toolUseId: request.toolUseID || null,
      });

      if (pushModule) {
        pushModule.sendPush({
          type: "user_dialog",
          slug: slug,
          title: "Claude needs a decision",
          body: "Waiting for your response",
          tag: "claude-user-dialog",
        });
      }

      if (opts.signal) {
        opts.signal.addEventListener("abort", function() {
          delete session.pendingUserDialogs[requestId];
          resolve({ behavior: "cancelled" });
        });
      }
    });
  }

  return {
    handleElicitation: handleElicitation,
    handleUserDialog: handleUserDialog,
  };
}

module.exports = { attachBridgeDialogs: attachBridgeDialogs };
