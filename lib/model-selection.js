var { preferredClaudeBest } = require("./claude-defaults");
var { preferredCodexBest } = require("./codex-models");

function configuredModel(sm, vendor) {
  if (sm.serverDefaultModelsByVendor && sm.serverDefaultModelsByVendor[vendor]) {
    return sm.serverDefaultModelsByVendor[vendor];
  }
  if (sm.defaultModelsByVendor && sm.defaultModelsByVendor[vendor]) {
    return sm.defaultModelsByVendor[vendor];
  }
  return null;
}

function defaultModelForVendor(sm, vendor) {
  var configured = configuredModel(sm, vendor);
  if (configured && configured !== "default") return configured;
  var models = (sm.modelsByVendor && sm.modelsByVendor[vendor]) || [];
  if (vendor === "claude") return preferredClaudeBest(models);
  if (vendor === "codex") return preferredCodexBest(models);
  return configured;
}

module.exports = {
  defaultModelForVendor: defaultModelForVendor,
};
