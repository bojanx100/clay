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
var childProcess = require("child_process");

var {
  midstreamTimeoutFor,
  isWatchdogProgressEvent,
  isContextOverflowError,
  watchdogTimeoutFor,
  clearInteractiveToolWaits,
} = require("../lib/sdk-bridge-stream");
var { attachBridgeDialogs } = require("../lib/sdk-bridge-dialogs");
var instructions = require("../lib/yoke/instructions");
var bridgeRecovery = require("../lib/sdk-bridge-recovery");
var cliSessions = require("../lib/cli-sessions");
var streamWatchdog = require("../lib/sdk-bridge-stream-watchdog");
var { CodexAppServer } = require("../lib/yoke/codex-app-server");

// --- Reported restart/error regressions -----------------------------------

test("CLI --dev --status is read-only when no daemon exists", function () {
  var clayHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-cli-status-"));
  try {
    var result = childProcess.spawnSync(process.execPath,
      [path.join(__dirname, "..", "bin", "cli.js"), "--dev", "--status"], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
        timeout: 5000,
        env: Object.assign({}, process.env, { CLAY_HOME: clayHome }),
      });
    assert.strictEqual(result.status, 1, "status must exit without starting or taking over a daemon");
    assert.match(result.stderr, /No running daemon found/);
    assert.strictEqual(fs.existsSync(path.join(clayHome, "daemon-dev.json")), false,
      "a read-only status check must not create daemon config");
  } finally {
    fs.rmSync(clayHome, { recursive: true, force: true });
  }
});

test("CLI rejects unsupported options instead of entering startup", function () {
  var clayHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-cli-option-"));
  try {
    var result = childProcess.spawnSync(process.execPath,
      [path.join(__dirname, "..", "bin", "cli.js"), "--dev", "--definitely-unsupported"], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
        timeout: 5000,
        env: Object.assign({}, process.env, { CLAY_HOME: clayHome }),
      });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Unknown option: --definitely-unsupported/);
    assert.strictEqual(fs.existsSync(path.join(clayHome, "daemon-dev.json")), false);
  } finally {
    fs.rmSync(clayHome, { recursive: true, force: true });
  }
});

test("provider tool lifecycle is projected for restart draining", function () {
  var session = { isProcessing: true };
  var state = streamWatchdog.createState(session, null);
  assert.strictEqual(session._activeProviderToolCount, 0);
  streamWatchdog.observeTool(state, { yokeType: "tool_start", toolId: "call-1" });
  streamWatchdog.observeTool(state, { yokeType: "tool_executing", toolId: "call-1" });
  assert.strictEqual(session._activeProviderToolCount, 1, "duplicate lifecycle events count once");
  streamWatchdog.observeTool(state, { yokeType: "tool_result", toolId: "call-1" });
  assert.strictEqual(session._activeProviderToolCount, 0);
});

test("restart drain waits until active provider tools finish", async function () {
  var currentTime = 0;
  var counts = [1, 1, 0];
  var result = await streamWatchdog.waitForActiveTools(function () {
    return counts.shift();
  }, {
    timeoutMs: 100,
    pollMs: 10,
    now: function () { return currentTime; },
    delay: function (ms) { currentTime += ms; return Promise.resolve(); },
  });
  assert.deepStrictEqual(result, { drained: true, count: 0, waitedMs: 20 });
  var daemonSource = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");
  assert.match(daemonSource, /waitForActiveTools\(countActiveProviderTools\)/,
    "daemon restart must use the tested provider-tool drain");
});

test("restart drain reports a bounded timeout", async function () {
  var currentTime = 0;
  var result = await streamWatchdog.waitForActiveTools(function () { return 2; }, {
    timeoutMs: 20,
    pollMs: 10,
    now: function () { return currentTime; },
    delay: function (ms) { currentTime += ms; return Promise.resolve(); },
  });
  assert.deepStrictEqual(result, { drained: false, count: 2, waitedMs: 20 });
});

test("Codex ignores only the known remote-control status notification", function () {
  var server = new CodexAppServer(process.execPath, {});
  var logged = [];
  var originalLog = console.log;
  console.log = function () { logged.push(Array.prototype.slice.call(arguments)); };
  try {
    server._handleMessage({ method: "remoteControl/status/changed", params: {} });
    assert.strictEqual(logged.length, 0);
    server._handleMessage({ method: "future/unknown/notification", params: {} });
    assert.strictEqual(logged.length, 1, "unknown notifications must remain observable");
  } finally {
    console.log = originalLog;
  }
});

// --- Watchdog budget -------------------------------------------------------

test("codex gets a mid-stream watchdog budget that tolerates silent reasoning", function () {
  var codexMs = midstreamTimeoutFor("codex");
  assert.ok(codexMs >= 90 * 1000,
    "codex mid-stream timeout must exceed normal silent-reasoning gaps (got " + codexMs + "ms)");
});

// Regression for the 2026-08-15 watchdog abort (session 397): GPT-5.6 Sol was
// still reasoning when the generic Codex budget expired at 122.9s. Sol needs
// more first-turn headroom without slowing the faster Codex model families.
test("GPT-5.6 Sol gets a longer first-turn watchdog budget", function () {
  var terraMs = midstreamTimeoutFor("codex", 0, "gpt-5.6-terra");
  var solMs = midstreamTimeoutFor("codex", 0, "gpt-5.6-sol");
  assert.strictEqual(terraMs, 120 * 1000);
  assert.strictEqual(solMs, 240 * 1000);
  assert.strictEqual(watchdogTimeoutFor({ model: "gpt-5.6-sol" }, 0, true, "codex"), solMs);
  assert.strictEqual(midstreamTimeoutFor("codex", 1, "gpt-5.6-sol"), 480 * 1000);
  assert.strictEqual(midstreamTimeoutFor("codex", 2, "gpt-5.6-sol"), 10 * 60 * 1000,
    "Sol escalation must still cap at the tool-active budget");
});

test("claude gets a mid-stream watchdog budget that tolerates silent reasoning (Opus 4.8 extended thinking)", function () {
  assert.ok(midstreamTimeoutFor("claude") >= 90 * 1000,
    "claude mid-stream timeout must exceed normal silent-reasoning gaps");
  assert.ok(midstreamTimeoutFor(undefined) >= 90 * 1000,
    "default mid-stream timeout must exceed normal silent-reasoning gaps");
});

// Regression for the 2026-07-24 resume loop (session 298): five healthy codex
// turns killed in a row at silentMs 122-125s vs a fixed 120s budget. The
// budget must escalate with each consecutive watchdog auto-resume so the loop
// self-extinguishes instead of burning the whole resume budget on one long
// silent-reasoning stretch.
test("mid-stream watchdog budget doubles per consecutive auto-resume, capped at the tool budget", function () {
  var base = midstreamTimeoutFor("codex");
  var toolBudget = 10 * 60 * 1000;
  assert.strictEqual(midstreamTimeoutFor("codex", 0), base);
  assert.strictEqual(midstreamTimeoutFor("codex", 1), Math.min(base * 2, toolBudget));
  assert.strictEqual(midstreamTimeoutFor("codex", 2), Math.min(base * 4, toolBudget));
  assert.ok(midstreamTimeoutFor("codex", 3) <= toolBudget,
    "escalation must never exceed the tool-active budget");
  assert.strictEqual(midstreamTimeoutFor("codex", 50), midstreamTimeoutFor("codex", 3),
    "escalation exponent is capped");
});

test("watchdogTimeoutFor reads the session resume streak for mid-generation waits", function () {
  var fresh = {};
  var looping = { _consecutiveAutoResumes: 2 };
  assert.strictEqual(watchdogTimeoutFor(fresh, 0, true, "codex"), midstreamTimeoutFor("codex"));
  assert.strictEqual(watchdogTimeoutFor(looping, 0, true, "codex"), midstreamTimeoutFor("codex", 2));
  assert.ok(watchdogTimeoutFor(looping, 0, true, "codex") > watchdogTimeoutFor(fresh, 0, true, "codex"),
    "a resumed turn must get more silent-reasoning headroom than a fresh one");
});

// A context-window overflow must be classified as recoverable regardless of
// which path surfaces it (thrown error OR in-stream error event) so the client
// shows the "context_overflow" card, not a bare "Prompt is too long" bubble.
test("isContextOverflowError recognizes the Anthropic overflow variants", function () {
  assert.strictEqual(isContextOverflowError("Prompt is too long"), true);
  assert.strictEqual(isContextOverflowError("API Error: 400 prompt is too long"), true);
  assert.strictEqual(isContextOverflowError("input length exceeds context_length"), true);
  assert.strictEqual(isContextOverflowError("this model's maximum context length is 200000 tokens"), true);
});

test("isContextOverflowError ignores unrelated errors and empty input", function () {
  assert.strictEqual(isContextOverflowError("Authentication required"), false);
  assert.strictEqual(isContextOverflowError("ECONNRESET"), false);
  assert.strictEqual(isContextOverflowError(""), false);
  assert.strictEqual(isContextOverflowError(null), false);
  assert.strictEqual(isContextOverflowError(undefined), false);
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

test("submitted connector elicitation keeps the tool-active watchdog budget until stream progress", async function () {
  var session = {};
  var dialogs = attachBridgeDialogs({
    sendAndRecord: function () {},
    pushModule: null,
    slug: "test",
  });
  var elicitationPromise = dialogs.handleElicitation(session, {
    serverName: "codex_apps",
    message: "GitHub project access is required",
  }, {});
  var requestId = Object.keys(session.pendingElicitations)[0];

  assert.ok(requestId, "elicitation must be tracked");
  assert.strictEqual(watchdogTimeoutFor(session, 0, true, "codex"), 10 * 60 * 1000);

  session.pendingElicitations[requestId].resolve({ action: "accept" });
  delete session.pendingElicitations[requestId];
  await elicitationPromise;

  assert.strictEqual(watchdogTimeoutFor(session, 0, true, "codex"), 10 * 60 * 1000,
    "submitting the dialog must not downgrade an in-flight connector call to mid-generation");

  clearInteractiveToolWaits(session);
  assert.strictEqual(watchdogTimeoutFor(session, 0, true, "codex"), midstreamTimeoutFor("codex"));
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

test("stripInjectedInstructions removes a model-guidance-only block", function () {
  var composed = instructions.MODEL_GUIDANCE_MARKER + "\nCurrent runtime: Codex model: gpt-5.6-sol.\n" +
    MARKER + "\n\nImplement the change";
  assert.strictEqual(instructions.stripInjectedInstructions(composed, null, "codex"), "Implement the change");
});

test("stripInjectedInstructions removes model guidance after an existing system prompt", function () {
  var composed = "Custom system prompt.\n\n" + instructions.MODEL_GUIDANCE_MARKER +
    "\nCurrent runtime: Codex model: gpt-5.6-sol.\n" + MARKER + "\n\nImplement the change";
  assert.strictEqual(instructions.stripInjectedInstructions(composed, null, "codex"), "Implement the change");
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

// --- Transient stream-error classification ---------------------------------
//
// Observed 2026-08-11 (session 019fd26a): the Codex CLI ran its own reconnect
// ladder ("Reconnecting... 5/5"), gave up, and emitted a connectivity error
// that isTransientStreamError did not recognise. Clay recorded it as a strong
// provider failure instead of retrying once, which is what sent the session
// down the rate-limit scheduling path.

test("the Codex give-up error after its reconnect ladder classifies as transient", function () {
  var recovery = bridgeRecovery.attachBridgeRecovery({ opts: {} });
  var codexGiveUp = "stream disconnected before completion: error sending request for url "
    + "(https://chatgpt.com/backend-api/codex/responses)";

  assert.strictEqual(recovery.isTransientStreamError(codexGiveUp), true,
    "a network drop must be retryable, not a provider outage");
  assert.strictEqual(recovery.isTransientStreamError("connection closed before message completed"), true);
});

test("previously recognised transient stream errors still classify", function () {
  var recovery = bridgeRecovery.attachBridgeRecovery({ opts: {} });
  var known = [
    "socket connection was closed unexpectedly",
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "fetch failed",
    "network error",
    "Premature close",
    "terminated",
    "socket hang up",
  ];
  known.forEach(function (text) {
    assert.strictEqual(recovery.isTransientStreamError(text), true, text + " must stay transient");
  });
});

test("real provider failures are not misread as transient connectivity", function () {
  var recovery = bridgeRecovery.attachBridgeRecovery({ opts: {} });
  var terminal = [
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage",
    "Prompt is too long",
    "invalid api key",
    "",
    null,
  ];
  terminal.forEach(function (text) {
    assert.strictEqual(recovery.isTransientStreamError(text), false,
      String(text) + " must not be retried as a blip");
  });
});
