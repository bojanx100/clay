// Meta selectors are routing aliases that stay valid regardless of the
// account's concrete model access ("default" = let the CLI pick its
// recommended model). Safe to offer even alongside an authoritative model
// list, because they never name a specific model the account might lack.
var CLAUDE_META_MODELS = [
  {
    value: "default",
    displayName: "Default",
    description: "Recommended model for your account.",
  },
  {
    value: "best",
    displayName: "Best available",
    description: "Uses Fable where available, otherwise the latest Opus.",
  },
];

// Speculative concrete models shown ONLY when the CLI reports no usable model
// list (offline, warmup failed, or a non-Claude runtime). These are a best
// guess and must NEVER be appended to an authoritative list: the account may
// not have access to them, and selecting one errors at the API with
// "may not exist or you may not have access to it".
var CLAUDE_SPECULATIVE_MODELS = [
  {
    value: "fable",
    displayName: "Fable 5",
    description: "For your toughest challenges.",
  },
  {
    value: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "Most efficient for everyday tasks.",
  },
  {
    value: "claude-haiku-4-5",
    displayName: "Haiku 4.5",
    description: "Fastest for quick answers.",
  },
  {
    value: "claude-opus-4-8",
    displayName: "Opus 4.8",
    description: "Previous Opus model for complex tasks.",
  },
  {
    value: "claude-opus-4-7",
    displayName: "Opus 4.7",
    description: "Older Opus model with xhigh as its default effort.",
  },
  {
    value: "claude-opus-4-6",
    displayName: "Opus 4.6",
    description: "Previous Opus model for complex tasks.",
  },
];

// Full best-guess list used only when there is no authoritative model list.
var CLAUDE_FALLBACK_MODELS = CLAUDE_META_MODELS.concat(CLAUDE_SPECULATIVE_MODELS);

function cloneModel(model) {
  var out = {};
  for (var key in model) out[key] = model[key];
  return out;
}

function fallbackClaudeModels() {
  var out = [];
  for (var i = 0; i < CLAUDE_FALLBACK_MODELS.length; i++) {
    out.push(cloneModel(CLAUDE_FALLBACK_MODELS[i]));
  }
  return out;
}

function modelValue(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.value || model.id || model.name || "";
}

function hasConcreteClaudeModel(models) {
  if (!Array.isArray(models)) return false;
  for (var i = 0; i < models.length; i++) {
    if (modelValue(models[i]).indexOf("claude-") === 0) return true;
  }
  return false;
}

function withClaudeFallbackModels(models) {
  if (!Array.isArray(models) || models.length === 0) return fallbackClaudeModels();
  if (!hasConcreteClaudeModel(models)) return fallbackClaudeModels();

  // Authoritative list present: trust it verbatim. Only add back always-safe
  // meta selectors (e.g. "default") the CLI list may omit. Never append
  // speculative concrete models — the account may not have access to them, and
  // offering one leads to an API "may not exist / no access" error on select.
  var out = models.slice();
  var seen = {};
  for (var i = 0; i < out.length; i++) {
    var existing = modelValue(out[i]);
    if (existing) seen[existing] = true;
  }
  var metaPrefix = [];
  for (var j = 0; j < CLAUDE_META_MODELS.length; j++) {
    var meta = CLAUDE_META_MODELS[j];
    if (!seen[meta.value]) metaPrefix.push(cloneModel(meta));
  }
  return metaPrefix.concat(out);
}

// opts.fableAvailable defaults to true. Pass { fableAvailable: false } when
// Fable's shared quota pool is exhausted (see
// rate-limit-usage-cache#isClaudeFableExhausted): "best" then skips Fable
// and resolves straight to the latest available Opus instead of erroring.
function preferredClaudeBest(models, opts) {
  var fableAvailable = !opts || opts.fableAvailable !== false;
  if (Array.isArray(models)) {
    if (fableAvailable) {
      for (var i = 0; i < models.length; i++) {
        if (modelValue(models[i]) === "best") return "best";
      }
      for (var j = 0; j < models.length; j++) {
        var value = modelValue(models[j]);
        if (value && value.toLowerCase().indexOf("fable") !== -1) return value;
      }
    }
    for (var k = 0; k < models.length; k++) {
      var opusValue = modelValue(models[k]);
      if (opusValue && opusValue.toLowerCase().indexOf("opus") !== -1) return opusValue;
    }
  }
  return fableAvailable ? "best" : "claude-opus-4-8";
}

module.exports = {
  CLAUDE_FALLBACK_MODELS: CLAUDE_FALLBACK_MODELS,
  fallbackClaudeModels: fallbackClaudeModels,
  preferredClaudeBest: preferredClaudeBest,
  withClaudeFallbackModels: withClaudeFallbackModels,
};
