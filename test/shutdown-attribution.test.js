// Regression test for the unattributable-shutdown bug.
//
// Observed 2026-09-04: the daemon logged only "[daemon] Shutting down..." and
// then tore down 130 projects. The log named no cause, so the shutdown was
// indistinguishable from a crash, an in-app restart, or an external kill. It
// turned out a throwaway repair script had sent SIGTERM to the daemon and its
// dev watcher. Two separate defects made that unreadable:
//
// 1. gracefulShutdown() printed the banner BEFORE its reentrancy guard, so the
//    watcher's follow-up SIGTERM printed a second "Shutting down..." and one
//    shutdown read as two.
// 2. The SIGTERM/SIGINT/SIGHUP handlers passed no reason, and unlike every
//    other shutdown path they log nothing of their own — so the signal name,
//    the only record of what stopped the daemon, was never written down.
//
// lib/shutdown-gate.js now owns both the latch and the wording so they cannot
// drift apart, and daemon.js passes a reason at every call site.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var { createShutdownGate, UNKNOWN_REASON } = require("../lib/shutdown-gate");

test("the first shutdown request proceeds and names its reason", function () {
  var gate = createShutdownGate({ pid: 4242, ppid: 99 });
  var decision = gate.request("SIGTERM");

  assert.strictEqual(decision.proceed, true, "first request must tear the daemon down");
  assert.match(decision.message, /Shutting down\.\.\./);
  assert.match(decision.message, /reason=SIGTERM/, "the signal name is the whole record of who stopped us");
  assert.match(decision.message, /pid=4242/);
  assert.match(decision.message, /ppid=99/, "parent pid is the best sender hint Node can give");
});

test("a second request does not reprint the banner, so one shutdown cannot read as two", function () {
  var gate = createShutdownGate({ pid: 1, ppid: 2 });

  var first = gate.request("SIGINT");
  var second = gate.request("SIGTERM");

  assert.strictEqual(first.proceed, true);
  assert.strictEqual(second.proceed, false, "the latch must hold on the second request");

  // The exact defect: the banner must appear once and only once.
  var banner = /Shutting down\.\.\./;
  assert.match(first.message, banner);
  assert.doesNotMatch(second.message, banner,
    "a follow-up signal must not reprint the shutdown banner");

  // ...and the follow-up must still be attributable, naming both signals.
  assert.match(second.message, /already in progress/);
  assert.match(second.message, /started by SIGINT/, "must say which request actually won");
  assert.match(second.message, /ignoring: SIGTERM/, "must say which request was dropped");
});

test("the winning reason is reported, not overwritten by later requests", function () {
  var gate = createShutdownGate({ pid: 1, ppid: 2 });
  gate.request("web-ui");
  gate.request("SIGTERM");
  gate.request("SIGKILL-ish");

  assert.strictEqual(gate.getFirstReason(), "web-ui");
  assert.strictEqual(gate.hasStarted(), true);
});

test("a missing or blank reason degrades to an explicit marker, never a silent blank", function () {
  assert.match(createShutdownGate({}).request().message, new RegExp("reason=" + UNKNOWN_REASON));
  assert.match(createShutdownGate({}).request("   ").message, new RegExp("reason=" + UNKNOWN_REASON));
  assert.match(createShutdownGate({}).request(null).message, new RegExp("reason=" + UNKNOWN_REASON));
});

// --- Wiring guard -----------------------------------------------------------
// The gate above is only useful if daemon.js actually routes through it. These
// assertions are mechanical on purpose (AGENTS.md: add the guard rather than
// trusting prose) and fail if the daemon is reverted to the old shape while the
// module stays behind.

var daemonSource = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");

test("daemon.js routes shutdown through the gate instead of a bare latch", function () {
  assert.match(daemonSource, /createShutdownGate\(\{ pid: process\.pid, ppid: process\.ppid \}\)/,
    "daemon must build the gate with its own pid/ppid");
  assert.doesNotMatch(daemonSource, /console\.log\("\[daemon\] Shutting down\.\.\."\)/,
    "the banner must come from the gate, never from a bare log before the guard");
});

test("every signal handler passes its signal name", function () {
  assert.match(daemonSource, /process\.on\("SIGTERM", function \(\) \{ gracefulShutdown\("SIGTERM"\); \}\)/);
  assert.match(daemonSource, /process\.on\("SIGINT", function \(\) \{ gracefulShutdown\("SIGINT"\); \}\)/);
  assert.match(daemonSource, /process\.on\("SIGHUP", function \(\) \{ gracefulShutdown\("SIGHUP"\); \}\)/);
});

test("no gracefulShutdown call site is left without a reason", function () {
  // Matches gracefulShutdown() with an empty argument list. The declaration
  // `function gracefulShutdown(reason)` is not an empty list, so it is excluded.
  var argless = daemonSource.match(/gracefulShutdown\(\s*\)/g) || [];
  assert.deepStrictEqual(argless, [],
    "a shutdown with no reason is exactly the bug this test exists to prevent");
});
