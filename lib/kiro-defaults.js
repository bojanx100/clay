// Kiro-specific default values. Single source of truth — do not duplicate
// elsewhere. Consumed by the server-side vendor plumbing and sent to clients
// via the config state so the UI renders the right controls.

var KIRO_DEFAULTS = {
  // Default agent/mode used when a Kiro session starts. "kiro_default" is the
  // general-purpose Kiro CLI agent.
  mode: "kiro_default",
};

function getKiroConfig(sm) {
  return {
    mode: (sm && sm.kiroMode) || KIRO_DEFAULTS.mode,
  };
}

module.exports = {
  KIRO_DEFAULTS: KIRO_DEFAULTS,
  getKiroConfig: getKiroConfig,
};
