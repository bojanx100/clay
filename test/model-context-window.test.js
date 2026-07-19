// Tests for S6 (redefined): token-aware handoff budgeting.
//
// Before this module, buildHandoffContext always trimmed the inline handoff
// transcript to a flat 240000-char cap regardless of the TARGET model's real
// context window — a 200k-token model and a 1M-token model got the exact
// same inline budget. These tests pin: (1) context-window resolution across
// a representative matrix of Claude/Codex/Copilot-routed model names, (2)
// that the derived char budget scales with the window and stays clamped,
// and (3) that an oversized transcript is compacted (not failed) down to fit
// whatever budget the target model gets — the actual overflow scenario S6's
// acceptance criteria describe.
var test = require("node:test");
var assert = require("node:assert");

var {
  resolveContextWindowForModel,
  charBudgetForContextWindow,
  charBudgetForModel,
  MIN_HANDOFF_CHARS,
  MAX_HANDOFF_CHARS,
  DEFAULT_CONTEXT_WINDOW,
} = require("../lib/model-context-window");

var { buildHandoffContextFromHistory } = require("../lib/handoff-context");

test("resolveContextWindowForModel matrix: representative Claude/Codex/Copilot model names", function () {
  // Claude family (routed natively or via GitHub Copilot).
  assert.strictEqual(resolveContextWindowForModel("claude-fable-5"), 1000000);
  assert.strictEqual(resolveContextWindowForModel("claude-opus-4-8"), 1000000);
  assert.strictEqual(resolveContextWindowForModel("claude-haiku-4-5"), 200000);
  // Codex/OpenAI family.
  assert.strictEqual(resolveContextWindowForModel("gpt-5.5"), 1048576);
  assert.strictEqual(resolveContextWindowForModel("gpt-5.6-sol"), 1048576);
  assert.strictEqual(resolveContextWindowForModel("o4-mini"), 200000);
  // Unknown model name falls back to the safe default.
  assert.strictEqual(resolveContextWindowForModel("some-future-model"), DEFAULT_CONTEXT_WINDOW);
  assert.strictEqual(resolveContextWindowForModel(null), DEFAULT_CONTEXT_WINDOW);
});

test("a runtime-reported SDK context window always wins over the name-based guess", function () {
  assert.strictEqual(resolveContextWindowForModel("claude-haiku-4-5", 512000), 512000);
  assert.strictEqual(resolveContextWindowForModel("unknown-model", 77000), 77000);
});

test("[1m] suffix in the model name forces a 1M window regardless of table/sdk value", function () {
  assert.strictEqual(resolveContextWindowForModel("gpt-4.1 [1M]", 32000), 1000000);
});

test("charBudgetForContextWindow scales with the window and stays clamped", function () {
  var smallBudget = charBudgetForContextWindow(200000);
  var largeBudget = charBudgetForContextWindow(1000000);
  assert.ok(largeBudget > smallBudget, "a 1M-token window gets a bigger inline budget than a 200k one");
  assert.ok(smallBudget >= MIN_HANDOFF_CHARS, "never below the floor");
  assert.ok(largeBudget <= MAX_HANDOFF_CHARS, "never above the ceiling");
  // Tiny/garbage windows still produce a workable budget, not zero/NaN.
  assert.strictEqual(charBudgetForContextWindow(0), charBudgetForContextWindow(DEFAULT_CONTEXT_WINDOW));
  assert.ok(charBudgetForContextWindow(-5) >= MIN_HANDOFF_CHARS);
});

test("charBudgetForModel composes resolution + budgeting for a model name", function () {
  var haikuBudget = charBudgetForModel("claude-haiku-4-5");
  var fableBudget = charBudgetForModel("claude-fable-5");
  assert.ok(fableBudget > haikuBudget, "fable (1M window) gets more inline budget than haiku (200k)");
});

function bigHistory(blockCount, blockSize) {
  var history = [];
  for (var i = 0; i < blockCount; i++) {
    history.push({ type: "user_message", text: "turn " + i + ": " + "x".repeat(blockSize), _ts: 1000 + i });
    history.push({ type: "tool_result", id: "tool" + i, content: "y".repeat(blockSize), _ts: 1000 + i });
  }
  return history;
}

test("oversized transcript is compacted (not failed) to fit a small target model's budget", function () {
  var history = bigHistory(200, 4000); // ~1.6MB of raw transcript text
  var budget = charBudgetForModel("claude-haiku-4-5"); // 200k-token window -> smaller budget
  var out = buildHandoffContextFromHistory(history, {
    fromVendor: "claude",
    toVendor: "claude",
    targetModel: "claude-haiku-4-5",
    maxChars: budget,
  });
  assert.ok(out, "still produces a context block, never throws/fails");
  assert.ok(out.length <= budget + 2000, "trimmed to roughly the budget (small header/footer overhead only)");
  assert.ok(out.indexOf("[Older context omitted") !== -1, "oldest blocks were dropped, not truncated mid-block");
  assert.ok(out.indexOf("turn 199") !== -1, "most recent turn survives compaction");
});

test("three-provider matrix: same oversized history compacts cleanly for Claude, Codex, and Copilot targets", function () {
  var history = bigHistory(150, 3000);
  var targets = [
    { vendor: "claude", model: "claude-opus-4-8" },
    { vendor: "codex", model: "gpt-5.5" },
    { vendor: "github-copilot", model: "claude-haiku-4-5" },
  ];
  var budgets = {};
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    var budget = charBudgetForModel(t.model);
    budgets[t.vendor] = budget;
    var out = buildHandoffContextFromHistory(history, {
      fromVendor: "claude",
      toVendor: t.vendor,
      targetModel: t.model,
      maxChars: budget,
    });
    assert.ok(out, t.vendor + ": produced a handoff block");
    assert.ok(out.length <= budget + 2000, t.vendor + ": respects its own budget");
    assert.ok(out.indexOf("turn 149") !== -1, t.vendor + ": most recent turn present");
  }
  // The 1M-token targets (claude opus, gpt-5.5) get materially more inline
  // budget than the 200k-token one (haiku via copilot).
  assert.ok(budgets.claude > budgets["github-copilot"]);
  assert.ok(budgets.codex > budgets["github-copilot"]);
});
