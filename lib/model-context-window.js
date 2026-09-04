// Server-side model context-window lookup + token-aware char budgeting for
// handoff transcripts (S6: "token re-budgeting + compaction-on-entry").
//
// Before this, buildHandoffContext always trimmed to a flat
// DEFAULT_MAX_CONTEXT_CHARS (240000) regardless of the TARGET model's actual
// context window: a 200k-token model and a 1M-token model got the same inline
// budget, under-using large windows and giving no real margin on small ones.
// This resolves the target model's context window (mirrors the client's
// display-only KNOWN_CONTEXT_WINDOWS table in app-panels.js — kept as a
// separate, smaller table here since the two serve different purposes and
// live in different module systems; update both if a new model family ships)
// and derives a char budget proportional to it. trimBlocks() in
// handoff-context.js still does the actual compaction (oldest-first drop with
// an "[Older context omitted]" marker) — this module only sizes the budget.

var CHARS_PER_TOKEN = 3.5;
// Fraction of the target model's context window reserved for the inline
// handoff transcript. The rest stays free for the system prompt, tool
// schemas, the wrapped user message, and the model's own response.
var HANDOFF_BUDGET_FRACTION = 0.12;
var MIN_HANDOFF_CHARS = 40000;
var MAX_HANDOFF_CHARS = 500000;
var DEFAULT_CONTEXT_WINDOW = 200000;

// Known context windows (tokens) by model-name substring, longest/most
// specific keys first so a family default doesn't shadow a more specific one.
var KNOWN_CONTEXT_WINDOWS = {
  "claude-fable-5": 1000000,
  "fable": 1000000,
  "claude-opus-5": 1000000,
  "claude-opus-4-8": 1000000,
  "claude-opus-4-7": 1000000,
  "opus-4-6": 1000000,
  "claude-sonnet-4-6": 1000000,
  "claude-sonnet-4": 1000000,
  "claude-haiku-4-5": 200000,
  "gpt-5.6-sol": 1048576,
  "gpt-5.6-terra": 1048576,
  "gpt-5.6-luna": 1048576,
  "gpt-5.5": 1048576,
  "gpt-5.6": 1048576,
  "gpt-5.4": 1048576,
  "gpt-5.3": 1048576,
  "gpt-5.2": 1048576,
  "gpt-4.1": 1047576,
  "o3": 200000,
  "o4-mini": 200000,
};

// Resolve a model's context window in tokens. `sdkContextWindow` is a runtime-
// reported value (e.g. from the SDK's tokenUsage/usage_update events) and
// always wins when present, since it reflects the truth for that exact
// account/model rather than a guess from the model name.
function resolveContextWindowForModel(model, sdkContextWindow) {
  var lc = String(model || "").toLowerCase();
  if (lc.indexOf("[1m]") !== -1) return 1000000;
  if (sdkContextWindow && sdkContextWindow > 0) return sdkContextWindow;
  for (var key in KNOWN_CONTEXT_WINDOWS) {
    if (Object.prototype.hasOwnProperty.call(KNOWN_CONTEXT_WINDOWS, key) && lc.indexOf(key) !== -1) {
      return KNOWN_CONTEXT_WINDOWS[key];
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// Derive the char budget for an inline handoff transcript from a context
// window (tokens). Clamped so a tiny/unknown window still gets a workable
// budget and a huge one doesn't balloon the handoff into an essay.
function charBudgetForContextWindow(contextWindowTokens) {
  var tokens = Number(contextWindowTokens) > 0 ? Number(contextWindowTokens) : DEFAULT_CONTEXT_WINDOW;
  var budget = Math.round(tokens * CHARS_PER_TOKEN * HANDOFF_BUDGET_FRACTION);
  return Math.max(MIN_HANDOFF_CHARS, Math.min(MAX_HANDOFF_CHARS, budget));
}

// Convenience: resolve + budget in one call for the common case (model name
// only, no runtime SDK value known yet — e.g. right after a provider switch,
// before the target model has reported anything).
function charBudgetForModel(model, sdkContextWindow) {
  return charBudgetForContextWindow(resolveContextWindowForModel(model, sdkContextWindow));
}

module.exports = {
  resolveContextWindowForModel: resolveContextWindowForModel,
  charBudgetForContextWindow: charBudgetForContextWindow,
  charBudgetForModel: charBudgetForModel,
  KNOWN_CONTEXT_WINDOWS: KNOWN_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW: DEFAULT_CONTEXT_WINDOW,
  MIN_HANDOFF_CHARS: MIN_HANDOFF_CHARS,
  MAX_HANDOFF_CHARS: MAX_HANDOFF_CHARS,
};
