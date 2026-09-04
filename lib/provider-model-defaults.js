function legacyField(vendor) {
  if (vendor === "claude") return "defaultClaudeModel";
  if (vendor === "codex") return "defaultCodexModel";
  if (vendor === "github-copilot") return "defaultCopilotModel";
  return null;
}

function getModel(container, vendor) {
  container = container || {};
  if (!vendor) return container.defaultModel || null;
  var map = container.defaultModelsByVendor || {};
  if (Object.prototype.hasOwnProperty.call(map, vendor)) return map[vendor] || null;
  var field = legacyField(vendor);
  if (field && container[field]) return container[field];
  if (vendor === "claude") return container.defaultModel || null;
  return null;
}

function setModel(container, vendor, model) {
  container = container || {};
  if (!vendor) {
    if (model) container.defaultModel = model;
    else delete container.defaultModel;
    return;
  }
  if (!container.defaultModelsByVendor) container.defaultModelsByVendor = {};
  if (model) container.defaultModelsByVendor[vendor] = model;
  else delete container.defaultModelsByVendor[vendor];
  if (Object.keys(container.defaultModelsByVendor).length === 0) {
    delete container.defaultModelsByVendor;
  }
  var field = legacyField(vendor);
  if (field) {
    if (model) container[field] = model;
    else delete container[field];
  }
}

module.exports = {
  getModel: getModel,
  setModel: setModel,
};
