// Regression tests for the Codex watchdog resume-loop and the injected
// project-instructions leak in rollout imports.
//
// Observed failure (recovery-events log, 2026-07-03/04): the 30s mid-stream
// watchdog repeatedly killed HEALTHY Codex turns during silent reasoning gaps
// (case=mid-generation, silentMs 30-35s), auto-resume started a fresh
// conversation whose first message got the "--- Instructions from CLAUDE.md ---"
// block prepended, the rollout importer copied that composed string verbatim
// into visible chat bubbles, and the loop repeated until the auto-resume
// budget ran out.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { midstreamTimeoutFor, isWatchdogProgressEvent } = require("../lib/sdk-bridge-stream");
var instructions = require("../lib/yoke/instructions");
var bridgeRecovery = require("../lib/sdk-bridge-recovery");
var cliSessions = require("../lib/cli-sessions");

// --- Watchdog budget -------------------------------------------------------

test("codex gets a mid-stream watchdog budget that tolerates silent reasoning", function () {
  var codexMs = midstreamTimeoutFor("codex");
  assert.ok(codexMs >= 90 * 1000,
    "codex mid-stream timeout must exceed normal silent-reasoning gaps (got " + codexMs + "ms)");
});

test("claude keeps the tight mid-stream watchdog (it streams continuously)", function () {
  assert.strictEqual(midstreamTimeoutFor("claude"), 30 * 1000);
  assert.strictEqual(midstreamTimeoutFor(undefined), 30 * 1000);
});

// A content-free "system" catch-all flood must NOT keep the watchdog alive —
// that stall wedged a real claude session behind spinning thinking dots.
test("content-free system events are not watchdog progress", function () {
  assert.strictEqual(isWatchdogProgressEvent({ yokeType: "system" }), false);
  assert.strictEqual(isWatchdogProgressEvent({ yokeType: "system", subtype: "mystery" }), false);
});

test("real output and payload-bearing system events count as progress", function () {
  assert.strictEqual(isWatchdogProgressEvent({ yokeType: "text_delta", text: "hi" }), true);
  assert.strictEqual(isWatchdogProgressEvent({ yokeType: "tool_start" }), true);
  assert.strictEqual(isWatchdogProgressEvent({ yokeType: "thinking_delta" }), true);
  // A system event that actually surfaces an error is progress (it gets shown).
  assert.strictEqual(isWatchdogProgressEvent({ yokeType: "system", error: "hook blocked" }), true);
  assert.strictEqual(isWatchdogProgressEvent({ yokeType: "system", content: [{ type: "text", text: "x" }] }), true);
  assert.strictEqual(isWatchdogProgressEvent(null), true);
});

// --- Injected-instructions stripping ---------------------------------------

var MARKER = instructions.INSTRUCTIONS_END_MARKER;

test("stripInjectedInstructions removes a marker-delimited block", function () {
  var composed = "--- Instructions from CLAUDE.md ---\n@AGENTS.md\n" + MARKER + "\n\ncontinue";
  assert.strictEqual(instructions.stripInjectedInstructions(composed, null, "codex"), "continue");
});

test("stripInjectedInstructions handles multi-paragraph instruction content", function () {
  var composed = "--- Instructions from CLAUDE.md ---\nRule one.\n\nRule two.\n" + MARKER +
    "\n\nFix the login bug";
  assert.strictEqual(instructions.stripInjectedInstructions(composed, null, "codex"), "Fix the login bug");
});

test("stripInjectedInstructions strips legacy (marker-less) blocks when files match", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-instr-"));
  try {
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "@AGENTS.md\n");
    var merged = instructions.scanAndMerge(dir, "codex");
    assert.ok(merged.indexOf("--- Instructions from CLAUDE.md ---") === 0, "precondition: merged block built");
    var composed = merged + "\n\n" + "continue";
    assert.strictEqual(instructions.stripInjectedInstructions(composed, dir, "codex"), "continue");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stripInjectedInstructions leaves unrelated text and lookalikes alone", function () {
  assert.strictEqual(instructions.stripInjectedInstructions("continue", null, "codex"), "continue");
  var userTyped = "Please add '--- Instructions from CLAUDE.md ---' to the docs";
  assert.strictEqual(instructions.stripInjectedInstructions(userTyped, null, "codex"), userTyped);
});

// --- Rollout import end-to-end ---------------------------------------------

function writeRollout(home, threadId, cwd, userMessages) {
  // Rollouts live in a dated tree: .codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  var dir = path.join(home, ".codex", "sessions", "2026", "07", "04");
  fs.mkdirSync(dir, { recursive: true });
  var lines = [JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: cwd } })];
  for (var i = 0; i < userMessages.length; i++) {
    lines.push(JSON.stringify({
      type: "event_msg",
      timestamp: new Date(1700000000000 + i * 1000).toISOString(),
      payload: { type: "user_message", message: userMessages[i] },
    }));
  }
  lines.push(JSON.stringify({
    type: "event_msg",
    timestamp: new Date(1700000009000).toISOString(),
    payload: { type: "agent_message", message: "done" },
  }));
  fs.writeFileSync(path.join(dir, "rollout-" + threadId + ".jsonl"), lines.join("\n") + "\n");
}

test("readCodexHistorySync shows user text, not the injected composition", function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clay-home-"));
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-proj-"));
  try {
    var threadId = "0199-test-thread";
    var composedFirst = "--- Instructions from CLAUDE.md ---\n@AGENTS.md\n" + MARKER +
      "\n\nRead the plan and execute it";
    var composedResume = "--- Instructions from CLAUDE.md ---\n@AGENTS.md\n" + MARKER +
      "\n\n" + bridgeRecovery.RESUME_AFTER_INTERRUPT_PROMPT;
    writeRollout(home, threadId, cwd, [composedFirst, composedResume]);

    var history = cliSessions.readCodexHistorySync(home, threadId, cwd);
    var userTexts = history.filter(function (h) { return h.type === "user_message"; })
      .map(function (h) { return h.text; });

    assert.strictEqual(userTexts[0], "Read the plan and execute it");
    // The synthetic resume prompt maps back to its display label.
    assert.strictEqual(userTexts[1], bridgeRecovery.RESUME_DISPLAY_LABEL);
    for (var i = 0; i < userTexts.length; i++) {
      assert.ok(userTexts[i].indexOf("--- Instructions from") === -1,
        "injected instructions must not leak into visible history");
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
