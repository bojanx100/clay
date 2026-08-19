// Proves a starting `--dev` watcher stops the previous watcher, not just its
// daemon. Shutting down only the daemon left the old watcher alive to respawn it,
// after which two daemons raced for the port and SIGTERMed each other on bind --
// a restart every ~40s that looks like a crash loop but is two live instances
// fighting. Reproducible by running `clay --dev` twice.
var test = require("node:test");
var assert = require("node:assert/strict");

var priorWatcherToStop = require("../lib/dev-watcher-takeover").priorWatcherToStop;

var alive = function () { return true; };
var dead = function () { return false; };

test("a live previous watcher is stopped before this one takes over", function () {
  assert.equal(priorWatcherToStop({ devWatcherPid: 4242 }, 99, alive), 4242);
});

test("a previous watcher that has already exited is left alone", function () {
  assert.equal(priorWatcherToStop({ devWatcherPid: 4242 }, 99, dead), null);
});

test("the watcher never signals itself", function () {
  // Signalling our own pid would kill the process that is starting up.
  assert.equal(priorWatcherToStop({ devWatcherPid: 99 }, 99, alive), null);
});

test("a config written before this field existed is handled", function () {
  assert.equal(priorWatcherToStop({}, 99, alive), null);
  assert.equal(priorWatcherToStop(null, 99, alive), null);
});

test("a malformed or unsafe pid is never signalled", function () {
  // 0 and negatives address process groups -- signalling those would take down
  // unrelated processes, including this one.
  assert.equal(priorWatcherToStop({ devWatcherPid: 0 }, 99, alive), null);
  assert.equal(priorWatcherToStop({ devWatcherPid: -1 }, 99, alive), null);
  assert.equal(priorWatcherToStop({ devWatcherPid: "4242" }, 99, alive), null);
  assert.equal(priorWatcherToStop({ devWatcherPid: 1.5 }, 99, alive), null);
  assert.equal(priorWatcherToStop({ devWatcherPid: NaN }, 99, alive), null);
});

test("the default liveness probe reports this process as alive and a free pid as dead", function () {
  // No isAlive override: exercises the signal-0 probe the real call site uses.
  assert.equal(priorWatcherToStop({ devWatcherPid: process.pid }, process.pid + 1),
    process.pid, "our own pid is detectably alive");
  // 2^22 is above any real pid on macOS/Linux defaults.
  assert.equal(priorWatcherToStop({ devWatcherPid: 4194303 }, 99), null,
    "an unused pid is treated as already exited");
});

test("the dev watcher handles the signals a takeover actually sends", function () {
  // The takeover, `kill`, and supervising scripts all send SIGTERM. Only SIGINT
  // was handled, so the watcher died without killing its daemon, orphaning it.
  var source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "bin", "cli.js"), "utf8");
  assert.match(source, /process\.on\("SIGTERM", shutdownWatcher\)/);
  assert.match(source, /process\.on\("SIGINT", shutdownWatcher\)/);
  assert.match(source, /process\.on\("SIGHUP", shutdownWatcher\)/);
});

test("the dev watcher records its own pid so a later takeover can find it", function () {
  var source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "bin", "cli.js"), "utf8");
  assert.match(source, /config\.devWatcherPid = process\.pid/);
});
