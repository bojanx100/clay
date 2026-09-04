var CODEX_DEFAULTS = {
  approval: "on-request",
  sandbox: "danger-full-access",
  webSearch: "live",
};

var CODEX_APP_SERVER_DEFAULTS = {
  model_reasoning_summary: "detailed",
  model_supports_reasoning_summaries: true,
};

var CODEX_APPROVAL_POLICIES = ["untrusted", "on-request", "granular", "never"];

function normalizeCodexApproval(value) {
  if (value === "on-failure") return CODEX_DEFAULTS.approval;
  if (CODEX_APPROVAL_POLICIES.indexOf(value) === -1) return CODEX_DEFAULTS.approval;
  return value;
}

function getCodexConfig(sm, session) {
  return {
    approval: normalizeCodexApproval((session && session.codexApproval) || (sm && sm.codexApproval)),
    sandbox: (session && session.codexSandbox) || (sm && sm.codexSandbox) || CODEX_DEFAULTS.sandbox,
    webSearch: (session && session.codexWebSearch) || (sm && sm.codexWebSearch) || CODEX_DEFAULTS.webSearch,
  };
}

function withCodexAppServerDefaults(config) {
  return Object.assign({}, CODEX_APP_SERVER_DEFAULTS, config || {});
}

module.exports = {
  CODEX_DEFAULTS: CODEX_DEFAULTS,
  CODEX_APP_SERVER_DEFAULTS: CODEX_APP_SERVER_DEFAULTS,
  CODEX_APPROVAL_POLICIES: CODEX_APPROVAL_POLICIES,
  normalizeCodexApproval: normalizeCodexApproval,
  getCodexConfig: getCodexConfig,
  withCodexAppServerDefaults: withCodexAppServerDefaults,
};
