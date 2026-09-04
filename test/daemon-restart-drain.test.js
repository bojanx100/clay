// Regression cover for the restart drain predicate.
//
// Each test here corresponds to a way a requested daemon restart could be
// starved by fleet activity it should not have waited for. See
// lib/daemon-restart-drain.js for the production evidence that motivated them.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var restartDrain = require("../lib/daemon-restart-drain");
var streamWatchdog = require("../lib/sdk-bridge-stream-watchdog");

// Minimal stand-in for the relay's project iteration. Sessions expose only the
// fields the drain predicate reads.
function fleet(sessions) {
  return function forEachProject(fn) {
    fn({ sm: { sessions: { forEach: function (each) { sessions.forEach(each); } } } });
  };
}

// A session that is genuinely mid-turn: a dispatched user message with no
// terminal `done` after it, so hasStaleProcessingState() is false.
function busySession(id, toolCount) {
  return {
    localId: id,
    isProcessing: true,
    _activeProviderToolCount: toolCount,
    _queryStartTs: 2000,
    history: [
      { type: "done", _ts: 1500 },
      { type: "user_message", _ts: 2000 },
    ],
  };
}

// Guard the fixture itself: if these stopped modelling the real predicate the
// drain tests below would pass for the wrong reason.
test("fixtures model the real stale-processing predicate", function () {
  var queued = require("../lib/sessions-queued-messages");
  assert.strictEqual(queued.hasStaleProcessingState(busySession(1, 1)), false,
    "a genuinely busy session must not read as stale");
});

test("counts in-flight provider tool calls across the fleet", function () {
  var count = restartDrain.countActiveProviderTools({
    forEachProject: fleet([busySession(1, 2), busySession(2, 3)]),
  });
  assert.strictEqual(count, 5);
});

test("an idle session never blocks a restart", function () {
  var idle = busySession(1, 4);
  idle.isProcessing = false;
  assert.strictEqual(restartDrain.countActiveProviderTools({
    forEachProject: fleet([idle]),
  }), 0);
});

// The self-blocking case: Coop asking for a restart from inside its own tool
// call would otherwise wait for itself for the full deadline.
test("the requesting session does not block its own restart", function () {
  var sessions = [busySession(7, 1), busySession(9, 2)];
  assert.strictEqual(restartDrain.countActiveProviderTools({
    forEachProject: fleet(sessions),
  }), 3, "without the exclusion the requester counts itself");
  assert.strictEqual(restartDrain.countActiveProviderTools({
    forEachProject: fleet(sessions),
    excludeSessionId: 7,
  }), 2, "the requesting session must be excluded from its own drain");
});

// A session wedged with a stale isProcessing flag never decrements its tool
// count, so before the fix it blocked every future restart permanently.
test("a session with a stale isProcessing flag does not block a restart", function () {
  var wedged = {
    localId: 3,
    isProcessing: true,
    _activeProviderToolCount: 5,
    // Query started BEFORE the last terminal `done`, which is exactly what
    // hasStaleProcessingState() treats as a flag reasserted without a turn.
    _queryStartTs: 500,
    history: [
      { type: "user_message", _ts: 400 },
      { type: "done", _ts: 900 },
    ],
  };
  assert.strictEqual(
    require("../lib/sessions-queued-messages").hasStaleProcessingState(wedged), true,
    "fixture must actually be stale by the real predicate");
  assert.strictEqual(restartDrain.countActiveProviderTools({
    forEachProject: fleet([wedged]),
  }), 0);
});

test("a destroying session does not block a restart", function () {
  var dying = busySession(4, 3);
  dying.destroying = true;
  assert.strictEqual(restartDrain.countActiveProviderTools({
    forEachProject: fleet([dying]),
  }), 0);
});

test("blockers are named so a forced restart is explainable", function () {
  var blockers = restartDrain.activeToolBlockers({
    forEachProject: fleet([busySession(11, 2)]),
  });
  assert.deepStrictEqual(blockers, [{ sessionId: 11, title: "", count: 2 }]);
  assert.match(restartDrain.describeBlockers(blockers), /#11 x2/);
});

test("a missing forEachProject is treated as a drained fleet", function () {
  assert.strictEqual(restartDrain.countActiveProviderTools({}), 0);
});

// --- the tool-count leak on abnormal turn end ---

// observeTool only decrements on a matching tool_result. A turn aborted
// mid-tool used to leave the increment stranded on the session forever, which
// is what made a wedged session block restarts and vetoed its reaping.
test("finishing a turn releases tool calls that never returned a result", function () {
  var session = { isProcessing: true };
  var state = streamWatchdog.createState(session, null);
  streamWatchdog.observeTool(state, { yokeType: "tool_start", toolId: "call-1" });
  streamWatchdog.observeTool(state, { yokeType: "tool_start", toolId: "call-2" });
  assert.strictEqual(session._activeProviderToolCount, 2);

  // Turn ends abnormally: no tool_result for either call.
  streamWatchdog.releaseTools(state);
  assert.strictEqual(session._activeProviderToolCount, 0,
    "an aborted turn must not strand its in-flight tool count on the session");
  assert.strictEqual(state.activeToolCount, 0);
});

test("the stream finaliser releases in-flight tool calls", function () {
  var source = fs.readFileSync(
    path.join(__dirname, "..", "lib", "sdk-bridge-stream.js"), "utf8");
  assert.match(source, /function finishStream[\s\S]*?watchdog\.releaseTools\(state\)/,
    "finishStream must release in-flight tool calls when a turn ends");
});

// --- proceed-at-deadline ---

test("the drain deadline forces the restart instead of cancelling it", function () {
  var source = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");
  assert.doesNotMatch(source, /Restart cancelled after waiting for/,
    "the deadline must no longer abandon a requested restart");
  assert.match(source, /Restart drain deadline reached[\s\S]*?restarting anyway/,
    "the deadline must restart anyway and say so");
  assert.match(source, /timeoutMs: RESTART_DRAIN_DEADLINE_MS/,
    "the drain must use the restart-specific deadline, not the watchdog default");
});
