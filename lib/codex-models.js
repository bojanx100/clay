var DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

var CODEX_FALLBACK_MODELS = [
  {
    value: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description: "Flagship GPT-5.6 model for complex coding, computer use, research, and cybersecurity.",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningEffort: "medium",
  },
  {
    value: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    description: "Balanced GPT-5.6 model for everyday work with strong performance at lower cost.",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningEffort: "medium",
  },
  {
    value: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    description: "Fast and affordable GPT-5.6 model for clear, repeatable work.",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    value: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Previous-generation frontier model for complex coding, computer use, knowledge work, and research.",
    supportedEffortLevels: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    value: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "Strong model for everyday coding.",
    supportedEffortLevels: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    value: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    description: "Small, fast, and cost-efficient model for simpler coding tasks.",
    supportedEffortLevels: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    value: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3 Codex Spark",
    description: "Ultra-fast coding model.",
    supportedEffortLevels: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
  },
];

function cloneModel(model) {
  var out = {};
  for (var key in model) {
    if (Array.isArray(model[key])) out[key] = model[key].slice();
    else out[key] = model[key];
  }
  return out;
}

function fallbackCodexModels() {
  var out = [];
  for (var i = 0; i < CODEX_FALLBACK_MODELS.length; i++) {
    out.push(cloneModel(CODEX_FALLBACK_MODELS[i]));
  }
  return out;
}

function modelValue(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.value || model.model || model.id || model.name || "";
}

function fallbackForValue(value) {
  for (var i = 0; i < CODEX_FALLBACK_MODELS.length; i++) {
    if (CODEX_FALLBACK_MODELS[i].value === value) return CODEX_FALLBACK_MODELS[i];
  }
  return null;
}

function normalizeEffortLevels(levels) {
  var out = [];
  if (!Array.isArray(levels)) return out;
  for (var i = 0; i < levels.length; i++) {
    var effort = levels[i];
    if (effort && typeof effort === "object") effort = effort.reasoningEffort || effort.value || effort.id || effort.name;
    if (typeof effort === "string" && effort && out.indexOf(effort) === -1) out.push(effort);
  }
  return out;
}

function normalizeCodexModel(model) {
  var value = modelValue(model);
  if (!value) return null;

  var fallback = fallbackForValue(value);
  var out = fallback ? cloneModel(fallback) : { value: value };
  if (typeof model === "string") return out;

  out.value = value;
  out.id = model.id || value;
  out.model = model.model || value;
  out.displayName = model.displayName || model.display_name || model.label || model.name || out.displayName || value;
  out.description = model.description || out.description || "";
  out.hidden = !!model.hidden;
  out.isDefault = !!model.isDefault;
  if (model.defaultReasoningEffort) out.defaultReasoningEffort = model.defaultReasoningEffort;
  if (model.supportsEffort === false) out.supportsEffort = false;

  var efforts = normalizeEffortLevels(model.supportedReasoningEfforts || model.supportedEffortLevels);
  if (efforts.length > 0) out.supportedEffortLevels = efforts;
  return out;
}

function normalizeCodexModels(models) {
  var out = [];
  var seen = {};
  if (!Array.isArray(models)) return out;
  for (var i = 0; i < models.length; i++) {
    var normalized = normalizeCodexModel(models[i]);
    if (!normalized || !normalized.value || seen[normalized.value]) continue;
    seen[normalized.value] = true;
    out.push(normalized);
  }
  return out;
}

function preferredCodexDefault(models) {
  if (Array.isArray(models)) {
    for (var i = 0; i < models.length; i++) {
      if (models[i] && typeof models[i] === "object" && models[i].isDefault && modelValue(models[i])) {
        return modelValue(models[i]);
      }
    }
    if (models.length > 0 && modelValue(models[0])) return modelValue(models[0]);
  }
  return DEFAULT_CODEX_MODEL;
}

function preferredCodexBest(models) {
  var bestSol = "";
  var bestVersion = [];
  if (Array.isArray(models)) {
    for (var i = 0; i < models.length; i++) {
      var value = modelValue(models[i]);
      var match = value.match(/^gpt-(\d+)(?:\.(\d+))?(?:\.(\d+))?-sol$/i);
      if (!match) continue;
      var version = [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0)];
      if (!bestSol || version[0] > bestVersion[0] ||
          (version[0] === bestVersion[0] && version[1] > bestVersion[1]) ||
          (version[0] === bestVersion[0] && version[1] === bestVersion[1] && version[2] > bestVersion[2])) {
        bestSol = value;
        bestVersion = version;
      }
    }
    if (bestSol) return bestSol;
  }
  return preferredCodexDefault(models);
}

module.exports = {
  DEFAULT_CODEX_MODEL: DEFAULT_CODEX_MODEL,
  CODEX_FALLBACK_MODELS: CODEX_FALLBACK_MODELS,
  fallbackCodexModels: fallbackCodexModels,
  normalizeCodexModel: normalizeCodexModel,
  normalizeCodexModels: normalizeCodexModels,
  preferredCodexBest: preferredCodexBest,
  preferredCodexDefault: preferredCodexDefault,
};
