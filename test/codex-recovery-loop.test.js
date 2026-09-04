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
  isConversationImageError,
  isContextOverflowError,
  watchdogTimeoutFor,
  clearInteractiveToolWaits,
} = require("../lib/sdk-bridge-stream");
var { attachBridgeDialogs } = require("../lib/sdk-bridge-dialogs");
var instructions = require("../lib/yoke/instructions");
var bridgeRecovery = require("../lib/sdk-bridge-recovery");
var cliSessions = require("../lib/cli-sessions");
var streamWatchdog = require("../lib/sdk-bridge-stream-watchdog");
var attachBridgeQueryStart = require("../lib/sdk-bridge-query-start").attachBridgeQueryStart;
var { CodexAppServer } = require("../lib/yoke/codex-app-server");
var codexAdapter = require("../lib/yoke/adapters/codex");

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

test("warm provider turns rearm the resident stream watchdog and timing", function () {
  var pushed = [];
  var bridge = attachBridgeQueryStart({
    adapters: {},
    sm: { modelsByVendor: {} },
    vendorReadiness: { ensure: function () { return Promise.resolve({ adapter: null }); } },
  });
  var session = {
    localId: 44,
    isProcessing: true,
    _watchdogTurnSeq: 3,
    _queryStartTs: 1,
    _firstActivityLogged: true,
    _firstTextLogged: true,
    queryInstance: {
      pushMessage: function (text) { pushed.push(text); },
    },
  };

  assert.strictEqual(bridge.pushMessage(session, "next warm turn", null), true);
  assert.deepStrictEqual(pushed, ["next warm turn"]);
  assert.strictEqual(session._watchdogTurnSeq, 4);
  assert.ok(session._queryStartTs > 1);
  assert.strictEqual(session._turnPerfId, "44:4");
  assert.strictEqual(session._firstActivityLogged, false);
  assert.strictEqual(session._firstTextLogged, false);
});

test("resident stream watchdog survives idle turns and tracks the next turn", function () {
  var currentTime = 1000;
  var session = { localId: 45, isProcessing: false };
  var state = streamWatchdog.createState(session, null);
  state.now = function () { return currentTime; };
  state.lastTickAt = currentTime;
  state.watchdogTimer = setInterval(function () {}, 10000);
  if (state.watchdogTimer.unref) state.watchdogTimer.unref();
  try {
    assert.strictEqual(streamWatchdog.watchdogTick({ adapter: { vendor: "codex" } }, state), "idle");

    currentTime = 2000;
    session.isProcessing = true;
    streamWatchdog.beginTurn(session, currentTime);
    assert.strictEqual(streamWatchdog.watchdogTick({ adapter: { vendor: "codex" } }, state), "active");
    assert.strictEqual(state.turnSeq, session._watchdogTurnSeq);
    assert.strictEqual(state.turnStartedAt, currentTime);
    assert.strictEqual(state.sawAnyEvent, false);
  } finally {
    clearInterval(state.watchdogTimer);
  }
});

test("watchdog excludes sleep and long event-loop gaps from provider silence", function () {
  var currentTime = 1000;
  var aborted = 0;
  var session = {
    localId: 46,
    isProcessing: true,
    abortController: {
      abort: function () { aborted++; },
      signal: { aborted: false },
    },
  };
  streamWatchdog.beginTurn(session, currentTime);
  var state = streamWatchdog.createState(session, null);
  state.now = function () { return currentTime; };
  state.lastTickAt = currentTime;

  currentTime += 120000;
  assert.strictEqual(streamWatchdog.watchdogTick({ adapter: { vendor: "codex" } }, state), "clock_gap");
  assert.strictEqual(aborted, 0);
  assert.strictEqual(state.turnStartedAt, 121000);

  currentTime += 100;
  assert.strictEqual(streamWatchdog.watchdogTick({ adapter: { vendor: "codex" } }, state), "active");
  assert.strictEqual(aborted, 0);
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
  assert.match(daemonSource, /return countActiveProviderTools\(excludeSessionId\);/,
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

function waitForCondition(check, timeoutMs) {
  var startedAt = Date.now();
  return new Promise(function(resolve, reject) {
    function poll() {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("condition was not met before timeout"));
        return;
      }
      setTimeout(poll, 20);
    }
    poll();
  });
}

test("Codex app-server restarts after an unexpected child exit", async function(t) {
  var appServerDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-app-server-restart-"));
  var counterFile = path.join(appServerDir, "starts");
  var appServerScript = path.join(appServerDir, "app-server");
  fs.writeFileSync(appServerScript,
    "var fs = require('fs');\n" +
    "var counter = " + JSON.stringify(counterFile) + ";\n" +
    "var starts = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;\n" +
    "fs.writeFileSync(counter, String(starts + 1));\n" +
    "if (starts === 0) process.exit(23);\n" +
    "setInterval(function () {}, 1000);\n");
  var server = new CodexAppServer(process.execPath, { cwd: appServerDir });

  t.after(function() {
    server.stop();
    fs.rmSync(appServerDir, { recursive: true, force: true });
  });

  await server.start();
  var firstPid = server.proc.pid;
  await waitForCondition(function() {
    var starts = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0;
    return starts >= 2 && server.proc && server.proc.pid !== firstPid && server.started;
  }, 1200);

  assert.ok(server.proc.pid !== firstPid, "the replacement app-server must have a new PID");
  assert.strictEqual(server.started, true);
  assert.strictEqual(server.restartState().terminal, false,
    "a recovered app-server must not be left in the terminal state");
});

// The other half of the restart contract: automatic recovery must be BOUNDED.
// start() resolves as soon as spawn() succeeds, so a binary that spawns and
// dies immediately looks like a healthy start on every pass. Without a cap that
// becomes a tight spawn storm against a genuinely broken binary, which is worse
// than staying down. Attempts must stop at the cap and report a clear terminal
// state rather than looping forever.
test("Codex app-server bounds restart attempts and reports a terminal state at the cap", async function(t) {
  var appServerDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-app-server-bounded-"));
  var counterFile = path.join(appServerDir, "starts");
  var appServerScript = path.join(appServerDir, "app-server");
  // A permanently broken app-server: every spawn exits immediately.
  fs.writeFileSync(appServerScript,
    "var fs = require('fs');\n" +
    "var counter = " + JSON.stringify(counterFile) + ";\n" +
    "var starts = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;\n" +
    "fs.writeFileSync(counter, String(starts + 1));\n" +
    "process.exit(23);\n");

  var maxAttempts = 3;
  var server = new CodexAppServer(process.execPath, {
    cwd: appServerDir,
    restartMaxAttempts: maxAttempts,
    restartBaseDelayMs: 10,
    restartMaxDelayMs: 20,
    restartStableMs: 5000,
  });
  var terminalEvents = [];
  server.subscribe(function(msg) {
    if (msg && msg.params && msg.params.error &&
        msg.params.error.codexErrorInfo === "app_server_restart_exhausted") {
      terminalEvents.push(msg);
    }
  });

  t.after(function() {
    server.stop();
    fs.rmSync(appServerDir, { recursive: true, force: true });
  });

  function starts() {
    return fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0;
  }

  await server.start();
  // Settle on either the terminal state (bounded) or the first spawn past the
  // cap (unbounded), so an unbounded implementation fails on the spawn-count
  // assertion below instead of just timing out.
  await waitForCondition(function() {
    var isTerminal = typeof server.restartState === "function" && server.restartState().terminal;
    return isTerminal || starts() > maxAttempts + 1;
  }, 3000);

  // Initial spawn plus exactly maxAttempts recovery spawns, then it gives up.
  assert.strictEqual(starts(), maxAttempts + 1,
    "a broken binary must be spawned at most (cap + 1) = " + (maxAttempts + 1) +
    " times, but it was spawned " + starts() + " times (unbounded restart loop)");
  assert.strictEqual(server.restartState().terminal, true,
    "reaching the cap must surface a terminal state");
  assert.strictEqual(server.restartState().attempts, maxAttempts + 1,
    "the attempt counter must stop one past the cap, not keep climbing");
  assert.strictEqual(server.started, false);
  assert.strictEqual(terminalEvents.length, 1,
    "the terminal state must be surfaced to subscribers exactly once");
  assert.match(terminalEvents[0].params.error.message, /will not be restarted automatically/);

  // Requests after the cap fail with the terminal reason, not a generic message.
  await assert.rejects(function() { return server.send("thread/start", {}); },
    /exhausting automatic restarts/);

  // And the loop stays dead: no further spawns after the terminal state.
  var settled = starts();
  await new Promise(function(resolve) { setTimeout(resolve, 150); });
  assert.strictEqual(starts(), settled, "no spawns may occur after the terminal state");
});

test("workspace discovery keeps expected non-repository Git failures off stderr", function(t) {
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-workspace-non-repo-"));
  t.after(function() { fs.rmSync(projectDir, { recursive: true, force: true }); });
  var modulePath = path.join(__dirname, "..", "lib", "project-workspace-git.js");
  var result = childProcess.spawnSync(process.execPath, [
    "-e",
    "var workspaceGit = require(process.argv[1]); workspaceGit.getBranch(process.argv[2]);",
    modulePath,
    projectDir,
  ], { encoding: "utf8" });

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stderr, "",
    "an expected non-repository probe must not leak Git's fatal message");
});

test("Codex failed MCP status produces an error tool result without an error object", function() {
  var state = codexAdapter.contractTestKit.createEventState("gpt-5.6-sol");
  var events = codexAdapter.contractTestKit.normalizeEvent({
    method: "item/completed",
    params: {
      item: {
        id: "browser-click-failed",
        type: "mcpToolCall",
        tool: "browser_click",
        status: "failed",
        error: null,
        result: { content: [{ type: "text", text: "Element is no longer attached" }] },
      },
    },
  }, state);
  var result = events.filter(function(event) { return event.yokeType === "tool_result"; })[0];

  assert.ok(result, "the terminal MCP item must emit a tool result");
  assert.strictEqual(result.isError, true);
});

test("Codex abort keeps its stream and event subscription open until the interrupted turn terminates", async function() {
  var handler = null;
  var unsubscribeCount = 0;
  var turnStartedResolve;
  var turnStarted = new Promise(function(resolve) { turnStartedResolve = resolve; });
  var finishedCount = 0;
  var server = {
    started: true,
    subscribe: function(nextHandler) {
      handler = nextHandler;
      return function() {
        unsubscribeCount++;
        handler = null;
      };
    },
    send: function(method, params) {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "interrupt-thread" } });
      if (method === "turn/start") {
        turnStartedResolve(params);
        return Promise.resolve({});
      }
      if (method === "turn/interrupt") return Promise.resolve({});
      return Promise.resolve({});
    },
  };
  var handle = codexAdapter.contractTestKit.createQueryHandle(server, {
    cwd: process.cwd(),
    model: "gpt-5.6-sol",
    abortController: new AbortController(),
    onFinished: function() { finishedCount++; },
  });
  handle.pushMessage("keep the interrupted tool result durable");
  await turnStarted;
  var iterator = handle[Symbol.asyncIterator]();
  var sessionEvent = await iterator.next();
  assert.strictEqual(sessionEvent.value.yokeType, "session_id");
  var iteratorEnd = iterator.next();

  var drain = handle.abort();
  assert.ok(drain && typeof drain.then === "function", "abort must expose its drain promise");
  var iteratorSettled = false;
  iteratorEnd.then(function() { iteratorSettled = true; });
  await new Promise(function(resolve) { setImmediate(resolve); });
  assert.strictEqual(iteratorSettled, false,
    "sdk-bridge must remain busy until Codex confirms that the interrupted turn stopped");
  assert.strictEqual(unsubscribeCount, 0,
    "late hook and terminal events still need a subscriber while the iterator is open");
  handler({ method: "hook/started", params: { threadId: "interrupt-thread" } });
  assert.strictEqual(unsubscribeCount, 0);
  handler({
    method: "turn/completed",
    params: {
      threadId: "interrupt-thread",
      turn: { id: "interrupt-turn", status: "interrupted", items: [] },
    },
  });
  var interruptedEvent = await iteratorEnd;
  assert.strictEqual(interruptedEvent.done, false,
    "the provider interruption event is delivered before the stream closes");
  assert.strictEqual(interruptedEvent.value.yokeType, "interrupted");
  var resultEvent = await iterator.next();
  assert.strictEqual(resultEvent.done, false,
    "the provider result event is delivered before the stream closes");
  assert.strictEqual(resultEvent.value.yokeType, "result");
  assert.strictEqual((await iterator.next()).done, true,
    "the visible query iterator ends after the provider-side turn terminates");
  await drain;

  assert.strictEqual(unsubscribeCount, 1);
  assert.strictEqual(finishedCount, 1);
});

test("Codex shutdown drain waits for every active abort to settle", async function() {
  var release;
  var settled = false;
  var pending = codexAdapter._test.abortQueriesAndWait([{
    abort: function() {
      return new Promise(function(resolve) { release = resolve; });
    },
  }], Date.now() + 1000).then(function() { settled = true; });

  await Promise.resolve();
  assert.strictEqual(settled, false, "shutdown must not stop the app-server ahead of abort persistence");
  release();
  await pending;
  assert.strictEqual(settled, true);
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

test("isConversationImageError recognizes Claude's native many-image rejection", function () {
  assert.strictEqual(isConversationImageError(
    "API Error: an image in the conversation could not be processed and was removed. " +
    "Re-read the file with a different approach if you still need it."), true);
  assert.strictEqual(isConversationImageError(
    "At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"), true);
  assert.strictEqual(isConversationImageError("API Error: authentication required"), false);
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
