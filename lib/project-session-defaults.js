var { codexConfigForAutomation } = require("./automation-modes");
var { CODEX_DEFAULTS } = require("./codex-defaults");
var normalizeRoutingProfile =
  require("./provider-routing-policy").normalizeRoutingProfile;

function applyProjectSessionDefaults(ctx) {
  var sm = ctx.sm;
  var opts = ctx.opts;
  var adapters = ctx.adapters;
  var defaultVendor = ctx.defaultVendor;
  var fullAutoMode = !!ctx.fullAutoMode;

  sm.availableVendors = Object.keys(adapters);
  sm.defaultVendor = defaultVendor;
  var routingState = typeof opts.onGetProjectProviderRoutingProfile === "function"
    ? opts.onGetProjectProviderRoutingProfile(ctx.slug) : null;
  sm.providerRoutingProfile = normalizeRoutingProfile(
    routingState && routingState.profile);
  sm.workerRoutingPolicy = Object.assign({}, sm.workerRoutingPolicy || {}, {
    profile: sm.providerRoutingProfile,
  });

  var srvMode = typeof opts.onGetServerDefaultMode === "function" ? opts.onGetServerDefaultMode() : null;
  sm._savedDefaultMode = fullAutoMode ? "bypassPermissions" : ((srvMode && srvMode.mode) || "default");
  sm.serverDefaultMode = sm._savedDefaultMode;
  if (sm._savedDefaultMode) sm.currentPermissionMode = sm._savedDefaultMode;
  if (fullAutoMode) {
    var fullAutoCodexConfig = codexConfigForAutomation("full");
    sm.codexApproval = fullAutoCodexConfig.approval;
    sm.codexSandbox = fullAutoCodexConfig.sandbox;
    sm.defaultAutomationMode = "full";
  }

  var srvEffort = typeof opts.onGetServerDefaultEffort === "function" ? opts.onGetServerDefaultEffort() : null;
  sm.serverDefaultEffort = (srvEffort && srvEffort.effort) || "medium";
  sm.currentEffort = sm.serverDefaultEffort;

  var vendorIds = Object.keys(adapters);
  var srvModel = typeof opts.onGetServerDefaultModel === "function" ? opts.onGetServerDefaultModel() : null;
  sm.defaultModelsByVendor = {};
  sm.serverDefaultModelsByVendor = {};
  for (var vi = 0; vi < vendorIds.length; vi++) {
    var vendorId = vendorIds[vi];
    var serverValue = typeof opts.onGetServerDefaultModel === "function"
      ? opts.onGetServerDefaultModel(vendorId) : null;
    var projectValue = typeof opts.onGetProjectDefaultModel === "function"
      ? opts.onGetProjectDefaultModel(ctx.slug, vendorId) : null;
    var serverModel = serverValue && serverValue.model || null;
    var projectModel = projectValue && projectValue.model || null;
    sm.serverDefaultModelsByVendor[vendorId] = serverModel;
    sm.defaultModelsByVendor[vendorId] = projectModel || serverModel;
  }
  sm._savedDefaultModel = sm.defaultModelsByVendor[defaultVendor] ||
    (srvModel && srvModel.model) || null;
  if (sm._savedDefaultModel) sm.currentModel = sm._savedDefaultModel;

  var srvCodex = typeof opts.onGetServerCodexDefaults === "function" ? opts.onGetServerCodexDefaults() : null;
  sm.serverDefaultCodexConfig = {
    approval: CODEX_DEFAULTS.approval,
    sandbox: CODEX_DEFAULTS.sandbox,
    webSearch: CODEX_DEFAULTS.webSearch,
  };
  if (srvCodex) {
    var codexDefaults = Object.assign({}, srvCodex || {});
    sm.serverDefaultCodexConfig = {
      approval: codexDefaults.approval || CODEX_DEFAULTS.approval,
      sandbox: codexDefaults.sandbox || CODEX_DEFAULTS.sandbox,
      webSearch: codexDefaults.webSearch || CODEX_DEFAULTS.webSearch,
    };
    if (!fullAutoMode) {
      sm.codexApproval = codexDefaults.approval || sm.codexApproval || CODEX_DEFAULTS.approval;
      sm.codexSandbox = codexDefaults.sandbox || sm.codexSandbox || CODEX_DEFAULTS.sandbox;
    }
    sm.codexWebSearch = codexDefaults.webSearch || sm.codexWebSearch || CODEX_DEFAULTS.webSearch;
  }
  if (fullAutoMode) {
    sm.serverDefaultCodexConfig.approval = sm.codexApproval || sm.serverDefaultCodexConfig.approval;
    sm.serverDefaultCodexConfig.sandbox = sm.codexSandbox || sm.serverDefaultCodexConfig.sandbox;
  }
}

module.exports = {
  applyProjectSessionDefaults: applyProjectSessionDefaults,
};
