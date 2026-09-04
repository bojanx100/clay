var { automationForClaudePermission } = require("./automation-modes");

function attachBridgeControls(ctx) {
  var sm = ctx.sm;
  var send = ctx.send;
  var adapter = ctx.adapter;
  var modelEntryValue = ctx.modelEntryValue;
  var sendModelInfoForVendor = ctx.sendModelInfoForVendor;

  async function setModel(session, model) {
    if (model && typeof model !== "string") {
      model = modelEntryValue(model);
    }
    if (!session.queryInstance) {
      sm.currentModel = model;
      session.model = model;
      session.requestedModel = model;
      session.verifiedModel = null;
      session.modelVerificationSource = null;
      try { sm.saveSessionFile(session); } catch (e) {}
      var inactiveSessionVendor = session.vendor || (adapter && adapter.vendor) || "claude";
      sendModelInfoForVendor(inactiveSessionVendor, model, session);
      send({ type: "config_state", model: sm.currentModel, mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [] });
      return;
    }
    try {
      await session.queryInstance.setModel(model);
      sm.currentModel = model;
      session.model = model;
      session.requestedModel = model;
      session.verifiedModel = null;
      session.modelVerificationSource = null;
      try { sm.saveSessionFile(session); } catch (e) {}
      var sessionVendor = session.vendor || (adapter && adapter.vendor) || "claude";
      sendModelInfoForVendor(sessionVendor, model, session);
      send({ type: "config_state", model: sm.currentModel, mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [] });
    } catch (e) {
      send({ type: "error", text: "Failed to switch model: " + (e.message || e) });
    }
  }

  async function setEffort(session, effort) {
    if (!session.queryInstance) {
      sm.currentEffort = effort;
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [] });
      return;
    }
    if (typeof session.queryInstance.setEffort === "function") {
      await session.queryInstance.setEffort(effort);
    }
    sm.currentEffort = effort;
    send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [] });
  }

  async function setPermissionMode(session, mode) {
    if (!session.queryInstance) {
      sm.currentPermissionMode = mode;
      session.permissionMode = mode;
      session.automationMode = automationForClaudePermission(mode);
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, automationMode: session.automationMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [] });
      return;
    }
    try {
      await session.queryInstance.setPermissionMode(mode);
      sm.currentPermissionMode = mode;
      session.permissionMode = mode;
      session.automationMode = automationForClaudePermission(mode);
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, automationMode: session.automationMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [] });
    } catch (e) {
      send({ type: "error", text: "Failed to set permission mode: " + (e.message || e) });
    }
  }

  async function stopTask(taskId) {
    var session = sm.getActiveSession();
    if (!session) return;
    session.taskStopRequested = true;
    if (!session.queryInstance) return;
    try {
      await session.queryInstance.stopTask(taskId);
    } catch (e) {
      console.error("[sdk-bridge] stopTask error:", e.message);
    }
    if (session.abortController) {
      session.abortController.abort();
    }
  }

  async function reloadSkills(session) {
    if (!session || !session.queryInstance) return;
    try {
      await session.queryInstance.reloadSkills();
      send({ type: "system_info", text: "Skills reloaded." });
    } catch (e) {
      send({ type: "error", text: "Failed to reload skills: " + (e.message || e) });
    }
  }

  async function setMcpPermissionModeOverride(session, serverName, mode) {
    if (!session || !session.queryInstance) return;
    try {
      await session.queryInstance.setMcpPermissionModeOverride(serverName, mode);
    } catch (e) {
      send({ type: "error", text: "Failed to set MCP permission mode: " + (e.message || e) });
    }
  }

  return {
    setModel: setModel,
    setEffort: setEffort,
    setPermissionMode: setPermissionMode,
    stopTask: stopTask,
    reloadSkills: reloadSkills,
    setMcpPermissionModeOverride: setMcpPermissionModeOverride,
  };
}

module.exports = { attachBridgeControls: attachBridgeControls };
