export function dispatchSessionMessage(msg, handlers) {
  if (!Object.prototype.hasOwnProperty.call(handlers, msg.type)) return false;
  var handler = handlers[msg.type];
  handler(msg);
  return true;
}

export function resolveSessionRuntime(msg) {
  var mode = msg.runtimeMode || msg.mode || "gui";
  var terminalId = typeof msg.runtimeTerminalId === "number"
    ? msg.runtimeTerminalId
    : (typeof msg.terminalId === "number" ? msg.terminalId : null);
  return { mode: mode, terminalId: terminalId };
}

function addOptionalSessionSettings(update, msg) {
  if (Object.prototype.hasOwnProperty.call(msg, "codexApproval")) {
    update.codexApproval = msg.codexApproval || null;
  }
  if (Object.prototype.hasOwnProperty.call(msg, "codexSandbox")) {
    update.codexSandbox = msg.codexSandbox || null;
  }
  if (Object.prototype.hasOwnProperty.call(msg, "codexWebSearch")) {
    update.codexWebSearch = msg.codexWebSearch || null;
  }
  return update;
}

export function buildSessionSwitchUpdate(msg, currentProjectSlug) {
  var runtime = resolveSessionRuntime(msg);
  var update = {
    activeSessionId: msg.id,
    activeSessionProjectSlug: currentProjectSlug,
    activeSessionTitle: msg.title || "",
    cliSessionId: msg.cliSessionId || null,
    vendorCapabilities: msg.capabilities || {},
    sessionIsProcessing: !!msg.isProcessing,
    activeSessionMode: runtime.mode,
    activeTerminalId: runtime.terminalId,
    sessionHasHistory: !!msg.hasHistory,
    currentProviderRouteId: msg.providerRouteId || null,
    requestedModel: msg.requestedModel || "",
    verifiedModel: msg.verifiedModel || "",
    modelVerificationSource: msg.modelVerificationSource || "",
    activeCoordinationMode: !!msg.coordinationMode,
    activeCoordinatorDemotionPending: !!msg.demotionPending,
    activeOrchestrationParent: msg.orchestrationParent || null,
    activeCoopHome: !!msg.coopHome,
    activeCoopChannel: msg.coopChannel || null,
    currentAutomationMode: msg.automationMode || "ask",
    currentMode: msg.permissionMode || "default",
  };
  return addOptionalSessionSettings(update, msg);
}

export function initialDraftForSessionSwitch(previousSessionId, draft) {
  if (previousSessionId || !draft) return null;
  var hasContent = !!((draft.text && draft.text.length > 0) ||
    (draft.images && draft.images.length > 0) ||
    (draft.pastes && draft.pastes.length > 0) ||
    (draft.files && draft.files.length > 0));
  return hasContent ? draft : null;
}

function findMateVendor(state, msg) {
  var target = state.dmTargetUser;
  if (!target || !target.isMate) return null;
  var mates = state.cachedMatesList || [];
  for (var i = 0; i < mates.length; i++) {
    if (mates[i].id === target.id && mates[i].vendor) return mates[i].vendor;
  }
  return null;
}

function vendorPlan(msg, state) {
  var routeId = msg.providerRouteId || null;
  var modelsByVendor = state.modelsByVendor || {};
  var modelCacheKey = routeId || msg.vendor;
  var currentModel = msg.verifiedModel || msg.requestedModel || "";
  var plan = [
    { action: "remember", sessionId: msg.id, vendor: msg.vendor, cliSessionId: msg.cliSessionId },
    { action: "store", update: {
      currentVendor: msg.vendor,
      currentProviderRouteId: routeId,
      currentModel: currentModel,
      currentModels: modelsByVendor[modelCacheKey] || [],
      currentModelsLoading: true,
    } },
    { action: "request_models", vendor: msg.vendor, providerRouteId: routeId },
  ];
  if (msg.hasHistory) plan.push({ action: "store", update: { vendorSelectionLocked: true } });
  return plan;
}

function historyVendorPlan(msg, state) {
  var modelsByVendor = state.modelsByVendor || {};
  return [
    { action: "store", update: {
      currentVendor: "claude",
      currentProviderRouteId: null,
      currentModel: msg.verifiedModel || msg.requestedModel || "",
      currentModels: modelsByVendor.claude || [],
      currentModelsLoading: true,
    } },
    { action: "store", update: { vendorSelectionLocked: false } },
  ];
}

export function getSessionVendorPlan(msg, state) {
  var currentState = state || {};
  if (msg.vendor) return vendorPlan(msg, currentState);
  if (msg.hasHistory) return historyVendorPlan(msg, currentState);
  var mateVendor = findMateVendor(currentState, msg);
  return mateVendor
    ? [{ action: "store", update: { currentVendor: mateVendor } }]
    : [];
}
