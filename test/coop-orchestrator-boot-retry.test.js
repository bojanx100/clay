// Proves that attachTaskOrchestratorCoop (the integration point wiring
// provenance/fan-in/watchdog into the real task orchestrator) resumes
// pending fan-in work automatically on attach -- i.e. right after a
// daemon restart / project reattach -- rather than only reacting to a
// brand-new live task transition. This closes a gap an earlier revision
// had: retryPending() was only ever invoked from the watchdog's 60s tick,
// and nothing ever started that timer until an unrelated live transition
// called refreshWatchdog(), so a pending cross-project event left over
// from before a crash could sit un-retried indefinitely if the underlying
// task had already reached its terminal state.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

function createScratchDir(name) {
  var base = path.join(__dirname, ".scratch");
  fs.mkdirSync(base, { recursive: true });
  var dir = path.join(base, name + "-" + process.pid + "-" + Date.now() + "-" +
    Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("attaching the task orchestrator's coop relay immediately retries any pending outbox event left from before restart", function () {
  var clayHome = createScratchDir("orchestrator-coop-boot-retry");
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = clayHome;
  delete require.cache[require.resolve("../lib/config")];
  delete require.cache[require.resolve("../lib/coop-fanin-delivery")];
  delete require.cache[require.resolve("../lib/coop-watchdog-runtime")];
  delete require.cache[require.resolve("../lib/project-task-orchestrator-coop")];
  try {
    // Seed the "clay" project's per-slug outbox on disk as if a prior
    // process instance had a cross-project delivery fail (e.g. the lead
    // project wasn't attached yet) and then crashed/restarted before it
    // could be retried.
    var deliveryFile = path.join(clayHome, "coop-fanin", "clay.json");
    fs.mkdirSync(path.dirname(deliveryFile), { recursive: true });
    fs.writeFileSync(deliveryFile, JSON.stringify({
      delivered: [],
      pending: [{
        eventId: "boot-pending-1",
        coopSessionStorageId: "coop-home",
        sessionStorageId: "worker-1",
        taskId: "task-1",
        status: "completed",
        occurredAt: 1,
      }],
    }));

    var coopSession = { localId: 1, storageId: "coop-home", pendingCoordinatorUpdates: [] };
    var sm = { sessions: new Map([[1, coopSession]]) };
    var deliveredNow = false;
    var crossProject = {
      deliver: function (targetSlug, sessionStorageId, text) {
        if (sessionStorageId !== "coop-home") return { ok: false, reason: "unknown" };
        deliveredNow = true;
        coopSession.pendingCoordinatorUpdates.push({ text: text });
        return { ok: true };
      },
    };

    var attachTaskOrchestratorCoop =
      require("../lib/project-task-orchestrator-coop").attachTaskOrchestratorCoop;

    // attachTaskOrchestratorCoop is called once per project on boot; this
    // is exactly that call, with a non-lead slug so delivery must route
    // through crossProject.deliver, not the local fast path.
    var coopRelay = attachTaskOrchestratorCoop({
      sm: sm,
      slug: "clay",
      crossProject: crossProject,
      usersModule: { getLeadMode: function () { return true; } },
      queueCoordinatorUpdate: function () {},
      workerForTask: function () { return null; },
      now: function () { return 100; },
    });

    assert.ok(coopRelay, "attach still returns the coop relay API");
    assert.equal(deliveredNow, true,
      "a pending outbox event from a prior instance must be retried immediately on attach, without waiting for the first watchdog tick or a new live transition");

    var onDisk = JSON.parse(fs.readFileSync(deliveryFile, "utf8"));
    assert.equal(onDisk.delivered.length, 1);
    assert.equal(onDisk.pending.length, 0);
  } finally {
    if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
    else delete process.env.CLAY_HOME;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/coop-fanin-delivery")];
    delete require.cache[require.resolve("../lib/coop-watchdog-runtime")];
    delete require.cache[require.resolve("../lib/project-task-orchestrator-coop")];
    fs.rmSync(clayHome, { recursive: true, force: true });
  }
});
