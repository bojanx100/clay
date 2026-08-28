// Lifecycle-safe client handling for Codex dynamic tool requests.
//
// A request can survive long enough to race an interrupt, app-server restart,
// or duplicate delivery. Execute a stable call identity once, fan the single
// result to every JSON-RPC request that represented it, and replace unfinished
// work with an explicit cancellation result before interrupting the turn.

function cancellationResult(reason) {
  return {
    contentItems: [{
      type: "inputText",
      text: "Tool execution cancelled: " + reason + ".",
    }],
    success: false,
  };
}

function unavailableResult() {
  return {
    contentItems: [{ type: "inputText", text: "Workspace dependency runtime unavailable." }],
    success: false,
  };
}

function failureResult() {
  return {
    contentItems: [{ type: "inputText", text: "Failed to load workspace dependency runtime details." }],
    success: false,
  };
}

function requestKey(params, requestId) {
  return String(params.callId || params.itemId || requestId);
}

function addRequestId(record, requestId) {
  if (record.requestIds.indexOf(requestId) === -1) record.requestIds.push(requestId);
}

function createDynamicToolLifecycle(appServer, options) {
  var opts = options || {};
  var records = {};

  function deliver(record, result) {
    if (record.settled) return false;
    record.settled = true;
    record.result = result;
    for (var i = 0; i < record.requestIds.length; i++) {
      if (appServer && appServer.started) appServer.respond(record.requestIds[i], result);
    }
    return true;
  }

  function replyDuplicate(record, requestId) {
    var knownRequest = record.requestIds.indexOf(requestId) !== -1;
    addRequestId(record, requestId);
    if (record.settled && !knownRequest && appServer && appServer.started) {
      appServer.respond(requestId, record.result);
    }
  }

  function cancelPending(reason) {
    var keys = Object.keys(records);
    var cancelled = 0;
    for (var i = 0; i < keys.length; i++) {
      var record = records[keys[i]];
      if (deliver(record, cancellationResult(reason))) cancelled++;
    }
    if (cancelled > 0 && typeof opts.onCancel === "function") opts.onCancel(cancelled, reason);
    return cancelled;
  }

  function handleWorkspaceToolCall(message, params, workspaceDependencies, isCancelled) {
    var key = requestKey(params, message.id);
    var record = records[key];
    if (record) {
      replyDuplicate(record, message.id);
      return true;
    }

    record = { key: key, requestIds: [message.id], settled: false, result: null };
    records[key] = record;
    if (isCancelled()) {
      deliver(record, cancellationResult("the Codex turn was interrupted"));
      return true;
    }
    if (!workspaceDependencies) {
      deliver(record, unavailableResult());
      return true;
    }

    workspaceDependencies.handleCall(params.arguments).then(function(result) {
      if (record.settled) return;
      if (isCancelled()) {
        deliver(record, cancellationResult("the Codex turn was interrupted"));
        return;
      }
      deliver(record, result);
    }).catch(function(error) {
      if (record.settled) return;
      if (!isCancelled()) console.error("[yoke/codex] workspace dependency tool failed:", error.message || error);
      deliver(record, isCancelled()
        ? cancellationResult("the Codex turn was interrupted")
        : failureResult());
    });
    return true;
  }

  return {
    cancelPending: cancelPending,
    handleWorkspaceToolCall: handleWorkspaceToolCall,
  };
}

module.exports = {
  cancellationResult: cancellationResult,
  createDynamicToolLifecycle: createDynamicToolLifecycle,
};
