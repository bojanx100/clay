var connectionHandlers = require("./project-connection-handlers");
var connectionState = require("./project-connection-state");

// This identity changes only when the daemon process changes. It is sent in
// the initial info payload so a reconnect can detect stale frontend assets.
var RUNTIME_ASSET_ID = process.pid + "-" + Date.now();

/**
 * Attach connection/disconnection handlers to a project context.
 *
 * The public API remains the same; connection-handlers owns side effects and
 * connection-state owns restore/model/session-list decisions.
 */
function attachConnection(ctx) {
  return connectionHandlers.attachConnectionHandlers(Object.assign({}, ctx, {
    fullAutoMode: ctx.fullAutoMode || false,
    runtimeAssetId: RUNTIME_ASSET_ID,
  }));
}

module.exports = {
  attachConnection: attachConnection,
  activeOrchestrationCount: connectionState.activeOrchestrationCount,
  orchestrationSessionFields: connectionState.orchestrationSessionFields,
};
