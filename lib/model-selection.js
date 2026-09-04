var { preferredClaudeBest } = require("./claude-defaults");
var { preferredCodexBest } = require("./codex-models");
var { isClaudeFableExhausted } = require("./rate-limit-usage-cache");

function configuredModel(sm, vendor) {
  if (sm.defaultModelsByVendor && sm.defaultModelsByVendor[vendor]) {
    return sm.defaultModelsByVendor[vendor];
  }
  if (sm.serverDefaultModelsByVendor && sm.serverDefaultModelsByVendor[vendor]) {
    return sm.serverDefaultModelsByVendor[vendor];
  }
  return null;
}

function defaultModelForVendor(sm, vendor) {
  var configured = configuredModel(sm, vendor);
  if (configured && configured !== "default") return configured;
  var models = (sm.modelsByVendor && sm.modelsByVendor[vendor]) || [];
  if (vendor === "claude") return preferredClaudeBest(models, { fableAvailable: !isClaudeFableExhausted() });
  if (vendor === "codex") return preferredCodexBest(models);
  var first = null;
  for (var i = 0; i < models.length; i++) {
    var entry = models[i];
    var value = typeof entry === "string" ? entry : entry && (entry.value || entry.model || entry.id);
    if (!value) continue;
    if (!first) first = value;
    if (entry && typeof entry === "object" && entry.isDefault) return value;
    if (value === "auto" || value === "default") return value;
  }
  return first || configured;
}

module.exports = {
  defaultModelForVendor: defaultModelForVendor,
};
