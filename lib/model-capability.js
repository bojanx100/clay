function modelCapabilityTier(model) {
  var value = String(model || "").toLowerCase().replace(/[_.]/g, "-");
  if (!value) return null;
  if (value === "best" || value.indexOf("fable") !== -1 || /^gpt-5-6-sol(?:-|$)/.test(value)) return 4;
  if (value.indexOf("haiku") !== -1 || value.indexOf("mini") !== -1 || value.indexOf("spark") !== -1) return 1;
  if (value.indexOf("opus") !== -1 || /^gpt-5-6-terra(?:-|$)/.test(value) || /^gpt-5-5(?:-|$)/.test(value) || value.indexOf("gemini-3-1-pro") !== -1) return 3;
  if (value.indexOf("sonnet") !== -1 || /^gpt-5-6-luna(?:-|$)/.test(value) || /^gpt-5-4(?:-|$)/.test(value) || value.indexOf("gemini-3-5-flash") !== -1) return 2;
  return null;
}

function capabilityComparison(sourceModel, targetModel) {
  var sourceTier = modelCapabilityTier(sourceModel);
  var targetTier = modelCapabilityTier(targetModel);
  var sameModel = !!sourceModel && !!targetModel && String(sourceModel).toLowerCase() === String(targetModel).toLowerCase();
  return {
    sourceTier: sourceTier,
    targetTier: targetTier,
    comparable: sameModel || (sourceTier !== null && targetTier !== null && targetTier >= sourceTier),
  };
}

module.exports = {
  modelCapabilityTier: modelCapabilityTier,
  capabilityComparison: capabilityComparison,
};
