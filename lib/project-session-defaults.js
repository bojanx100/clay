var { codexConfigForAutomation } = require("./automation-modes");
var { CODEX_DEFAULTS } = require("./codex-defaults");

function applyProjectSessionDefaults(ctx) {
  var sm = ctx.sm;
  var opts = ctx.opts;
  var adapters = ctx.adapters;
  var defaultVendor = ctx.defaultVendor;
  var fullAutoMode = !!ctx.fullAutoMode;

  sm.availableVendors = Object.keys(adapters);
  sm.defaultVendor = defaultVendor;

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

  var projectLastVendor = typeof opts.onGetProjectLastVendor === "function"
    ? opts.onGetProjectLastVendor(ctx.slug) : null;
  sm.lastVendor = (projectLastVendor && projectLastVendor.vendor) || null;

  var srvDefaultVendorModel = typeof opts.onGetServerDefaultModel === "function" ? opts.onGetServerDefaultModel(defaultVendor) : null;
  var srvClaudeModel = typeof opts.onGetServerDefaultModel === "function" ? opts.onGetServerDefaultModel("claude") : null;
  var srvCodexModel = typeof opts.onGetServerDefaultModel === "function" ? opts.onGetServerDefaultModel("codex") : null;
  var srvCopilotModel = typeof opts.onGetServerDefaultModel === "function" ? opts.onGetServerDefaultModel("github-copilot") : null;
  var srvModel = typeof opts.onGetServerDefaultModel === "function" ? opts.onGetServerDefaultModel() : null;
  sm.defaultModelsByVendor = {
    claude: (srvClaudeModel && srvClaudeModel.model) || null,
    codex: (srvCodexModel && srvCodexModel.model) || null,
    "github-copilot": (srvCopilotModel && srvCopilotModel.model) || null,
  };
  sm.serverDefaultModelsByVendor = Object.assign({}, sm.defaultModelsByVendor);
  sm._savedDefaultModel = (srvDefaultVendorModel && srvDefaultVendorModel.model) || (srvModel && srvModel.model) || null;
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
