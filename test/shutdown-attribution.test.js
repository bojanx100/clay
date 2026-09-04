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

// --- Naming the parent while it is still alive ------------------------------
// A bare ppid turned out to be unreadable after the fact. Investigating the
// 2026-09-04 restart run (pids 61877 -> 45660 -> 67768 -> 89408 -> 6193 ->
// 45993) meant reading "ppid=6107" / "ppid=89392" / "ppid=67752" out of the log
// hours later, and `ps -p` returned nothing for any of them: every parent had
// already exited, so the number named an unidentifiable process and the trigger
// for six restarts could not be established at all. The description has to be
// taken during teardown, while the parent still exists.

test("the shutdown banner names the parent process, not just its pid", function () {
  var asked = [];
  var gate = createShutdownGate({
    pid: 6193,
    ppid: 6107,
    resolveParent: function (ppid) {
      asked.push(ppid);
      return "node /Users/bojansubotic/Desktop/clay/bin/cli.js --dev --headless\n";
    },
  });

  var decision = gate.request("SIGTERM");

  assert.deepStrictEqual(asked, [6107], "the probe must be given the parent pid");
  assert.match(decision.message, /ppid=6107/, "the raw pid stays, for correlation");
  assert.match(decision.message, /parent="node .*bin\/cli\.js --dev --headless"/,
    "without this the log cannot say what stopped the daemon");
  assert.doesNotMatch(decision.message, /\n/, "the banner must stay on one line");
});

test("the parent is described once, on the request that actually wins the latch", function () {
  var calls = 0;
  var gate = createShutdownGate({
    pid: 1, ppid: 2,
    resolveParent: function () { calls += 1; return "dev-watcher"; },
  });

  gate.request("SIGTERM");
  assert.strictEqual(calls, 1);

  // The follow-up signal is already ignored; probing again would shell out
  // during teardown for a line nobody prints.
  var second = gate.request("SIGTERM");
  assert.strictEqual(calls, 1, "an ignored request must not run the probe");
  assert.doesNotMatch(second.message, /parent=/);
});

test("a shutdown never depends on the probe succeeding", function () {
  function bannerWith(resolveParent) {
    return createShutdownGate({ pid: 1, ppid: 2, resolveParent: resolveParent }).request("SIGTERM");
  }

  var thrown = bannerWith(function () { throw new Error("ps: command not found"); });
  assert.strictEqual(thrown.proceed, true, "diagnostics must never block teardown");
  assert.match(thrown.message, /reason=SIGTERM/);
  assert.doesNotMatch(thrown.message, /parent=/);

  // A dead or unknown parent yields nothing rather than an empty field.
  assert.doesNotMatch(bannerWith(function () { return null; }).message, /parent=/);
  assert.doesNotMatch(bannerWith(function () { return "   \n"; }).message, /parent=/);
  assert.doesNotMatch(bannerWith(undefined).message, /parent=/);

  // Absent ppid: nothing to ask about.
  var noParent = createShutdownGate({
    pid: 1,
    resolveParent: function () { throw new Error("must not be called"); },
  }).request("SIGTERM");
  assert.strictEqual(noParent.proceed, true);
  assert.doesNotMatch(noParent.message, /parent=/);
});

test("a runaway parent description cannot flood the log", function () {
  var gate = createShutdownGate({
    pid: 1, ppid: 2,
    resolveParent: function () { return "x".repeat(5000); },
  });

  var message = gate.request("SIGTERM").message;
  assert.ok(message.length < 400, "one shutdown line, not a wall of argv: got " + message.length);
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
  assert.match(daemonSource, /createShutdownGate\(\{\s*pid: process\.pid,\s*ppid: process\.ppid,/,
    "daemon must build the gate with its own pid/ppid");
  assert.doesNotMatch(daemonSource, /console\.log\("\[daemon\] Shutting down\.\.\."\)/,
    "the banner must come from the gate, never from a bare log before the guard");
});

test("every signal handler passes its signal name", function () {
  assert.match(daemonSource, /process\.on\("SIGTERM", function \(\) \{ gracefulShutdown\("SIGTERM"\); \}\)/);
  assert.match(daemonSource, /process\.on\("SIGINT", function \(\) \{ gracefulShutdown\("SIGINT"\); \}\)/);
  assert.match(daemonSource, /process\.on\("SIGHUP", function \(\) \{ gracefulShutdown\("SIGHUP"\); \}\)/);
});

test("daemon.js gives the gate a real parent probe", function () {
  assert.match(daemonSource, /resolveParent: describeParentProcess/,
    "the gate can only name the parent if the daemon supplies the probe");
  assert.match(daemonSource, /execFileSync\("ps", \["-o", "args=", "-p", String\(ppid\)\]/,
    "the probe must read the live process table");
  assert.match(daemonSource, /if \(!ppid \|\| ppid === 1\) return null;/,
    "a daemon re-parented to init has no identifiable parent left to describe");
});

test("shutdown stops provider-health scoring before any project is torn down", function () {
  assert.match(daemonSource, /providerHealth\.markLocalShutdown\(\)/,
    "without this a restart marks healthy provider routes unhealthy");

  // Ordering is the whole fix: shutdownProjects() is what closes the streams,
  // so EVERY path that calls it must arm the latch first. There are two -
  // gracefulShutdown() and performRestart()'s self-spawn branch, which tears
  // down directly without going through the gate. Anchoring on the call sites
  // rather than the declaration is what exposed the second one.
  var latches = daemonSource.match(/providerHealth\.markLocalShutdown\(\)/g) || [];
  var teardowns = daemonSource.match(/shutdownProjects\(\)\.then\(/g) || [];
  assert.strictEqual(latches.length, teardowns.length,
    "every teardown path needs its own latch: found " + teardowns.length
    + " shutdownProjects() call(s) but " + latches.length + " latch(es)");

  // Each teardown must be preceded by a latch with no unlatched teardown in
  // between, checked positionally so a latch cannot be credited to a path it
  // does not guard.
  var events = [];
  var pattern = /providerHealth\.markLocalShutdown\(\)|shutdownProjects\(\)\.then\(/g;
  var match;
  while ((match = pattern.exec(daemonSource)) !== null) {
    events.push(match[0].indexOf("markLocalShutdown") !== -1 ? "latch" : "teardown");
  }
  var armed = 0;
  for (var i = 0; i < events.length; i++) {
    if (events[i] === "latch") armed += 1;
    else {
      assert.ok(armed > 0,
        "teardown #" + (i + 1) + " runs with no latch set - its first aborted streams are still blamed on the provider");
      armed -= 1;
    }
  }

  // The latch belongs in the shutdown paths, not at module load, which would
  // disarm provider health for the whole process life.
  var firstLatch = daemonSource.indexOf("providerHealth.markLocalShutdown()");
  var firstShutdownPath = daemonSource.indexOf("function performRestart(");
  assert.ok(firstLatch > firstShutdownPath,
    "the latch belongs in the shutdown paths, not at startup");
});

test("no gracefulShutdown call site is left without a reason", function () {
  // Matches gracefulShutdown() with an empty argument list. The declaration
  // `function gracefulShutdown(reason)` is not an empty list, so it is excluded.
  var argless = daemonSource.match(/gracefulShutdown\(\s*\)/g) || [];
  assert.deepStrictEqual(argless, [],
    "a shutdown with no reason is exactly the bug this test exists to prevent");
});

// --- Watcher exit notice ----------------------------------------------------
// The daemon is supervised and the watcher is not: bin/cli.js respawns the
// daemon 500ms after any unexpected exit (the "Unexpected exit — auto restart"
// branch), but shutdownWatcher sets intentionalKill, which suppresses that
// respawn, and nothing supervises the watcher itself. So killing the daemon is
// a blip Clay recovers from alone, while killing the watcher is terminal. The
// old exit line was a bare "Shutting down...", identical for a Ctrl+C and for a
// scripted kill, and never said Clay would stay down.

var { watcherShutdownMessage } = require('../lib/shutdown-gate');

test('the watcher exit line names the signal that stopped it', function () {
  assert.match(watcherShutdownMessage('SIGTERM'), /\(SIGTERM\)/);
  assert.match(watcherShutdownMessage('SIGINT'), /\(SIGINT\)/);
  assert.match(watcherShutdownMessage('SIGHUP'), /\(SIGHUP\)/);
});

test('the watcher exit line says the outage is terminal and how to undo it', function () {
  var msg = watcherShutdownMessage('SIGTERM');
  assert.match(msg, /Clay stays down/, 'must state the outage is terminal');
  assert.match(msg, /this watcher is not/, 'must name the supervised/unsupervised asymmetry');
  assert.match(msg, /Run `clay`/, 'must say how to bring Clay back');
});

test('a scripted kill reads differently from a Ctrl+C', function () {
  var ctrlC = watcherShutdownMessage('SIGINT');
  var scripted = watcherShutdownMessage('SIGTERM');
  // This is the whole point: five 2026-09-04 outages were scripted kills that
  // looked exactly like the owner pressing Ctrl+C.
  assert.doesNotMatch(ctrlC, /not a Ctrl\+C/, 'a real Ctrl+C must not be called unexpected');
  assert.match(scripted, /not a Ctrl\+C, something sent SIGTERM/,
    'a SIGTERM must be flagged as coming from something other than the owner');
});

test('a missing signal still produces a usable line', function () {
  var msg = watcherShutdownMessage();
  assert.match(msg, new RegExp('\\(' + UNKNOWN_REASON + '\\)'));
  assert.match(msg, /Clay stays down/);
});

test('bin/cli.js routes its exit line through the shared helper', function () {
  var cliSource = fs.readFileSync(path.join(__dirname, '..', 'bin', 'cli.js'), 'utf8');
  assert.match(cliSource, /watcherShutdownMessage\(signal\)/,
    'the watcher must build its line from the helper, not inline text');
  assert.doesNotMatch(cliSource, /\[dev\]\\x1b\[0m Shutting down\.\.\."/,
    'the bare unattributed "Shutting down..." line must be gone');
});

test('every watcher signal handler passes its signal name', function () {
  var cliSource = fs.readFileSync(path.join(__dirname, '..', 'bin', 'cli.js'), 'utf8');
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(function (sig) {
    assert.match(cliSource,
      new RegExp('process\\.on\\("' + sig + '", function \\(\\) \\{ shutdownWatcher\\("' + sig + '"\\); \\}\\)'),
      sig + ' must be forwarded by name');
  });
  assert.doesNotMatch(cliSource, /process\.on\("SIG[A-Z]+", shutdownWatcher\)/,
    'no handler may pass the function bare, which loses the signal name');
});
