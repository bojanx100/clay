var fs = require("fs");
var path = require("path");
var home = require("./isolated-clay-home");
var createManager = require("../../lib/sessions").createSessionManager;
var createBridge = require("../../lib/sdk-bridge").createSDKBridge;
var attachOrchestrator = require("../../lib/project-task-orchestrator").attachTaskOrchestrator;
var createRouter = require("../../lib/server-cross-project").createCrossProjectRouter;

async function settled() { await new Promise(function (resolve) { setImmediate(resolve); }); }

function fixture(t, options) {
  options = options || {};
  require("../../lib/provider-health")._reset();
  var dir = fs.mkdtempSync(path.join(home, "coordinator-reports-"));
  var f = { now: 1000, mode: true, starts: 0, pushes: [], failure: "", held: [], events: [] };
  var cleanups = [];
  function build(storageId) {
    f.sm = createManager({ cwd: dir, projectId: "system-lead", send: function () {} });
    f.sm.defaultVendor = "codex";
    f.sm.modelsByVendor = { codex: ["gpt-5.6-terra"] };
    f.sm.installedVendors = ["codex"];
    f.sm.availableVendors = ["codex"];
    f.session = storageId ? Array.from(f.sm.sessions.values()).find(function (session) {
      return session.storageId === storageId;
    }) : f.sm.getActiveSession();
    f.session.vendor = "codex";
    f.session.model = "gpt-5.6-terra";
    f.session.coordinationMode = true;
    f.sm.saveSessionFile(f.session, { durable: true });
    var adapter = { vendor: "codex", createQuery: async function () {
      f.starts++;
      if (f.failure === "create") throw new Error("Unavailable fixture provider");
      if (f.failure === "defer") await new Promise(function (resolve) { f.release = resolve; });
      var finish;
      var pending = new Promise(function (resolve) { finish = resolve; });
      var handle = { pushMessage: function (text) {
        if (f.failure === "push-false") return false;
        f.pushes.push(text);
        if (f.failure === "push-throw") throw new Error("Submission receipt lost");
      }, close: function () { finish({ done: true }); } };
      handle[Symbol.asyncIterator] = function () { return { next: function () { return pending; } }; };
      f.held.push(handle);
      return handle;
    } };
    f.bridge = createBridge({ cwd: dir, slug: options.slug || "lead", sessionManager: f.sm,
      adapter: adapter, adapters: { codex: adapter }, send: function () {} });
    f.router = createRouter({ bindingFile: path.join(dir, "bindings.json"), deliveryFile: path.join(dir, "delivery.json"),
      projectCoordinatorIntake: true, isLeadModeEnabled: function () { return f.mode; },
      now: function () { return f.now; }, deliveryRetryIntervalMs: options.intervalMs });
    f.api = attachOrchestrator({ sm: f.sm, sdk: f.bridge, crossProject: f.router, slug: options.slug || "lead",
      now: function () { return f.now; }, cwd: dir,
      sendToSession: function (id, event) { f.events.push(event); }, ensureProjectAccessForSession: function () {},
      autonomyPolicyFile: path.join(dir, "absent-autonomy.json") });
    var api = f.api;
    var manager = f.sm;
    var unregister = f.router.registerProjectResolver({ getProjectId: function () { return "system-lead"; },
      getSessionManager: function () { return manager; }, getTaskOrchestrator: function () { return api; } });
    cleanups.push(unregister, api.stopCoopWatchdog, f.router.stopDeliveryRetry);
  }
  build();
  f.reopen = function () {
    f.session.destroying = true;
    f.router.stopDeliveryRetry();
    f.api.stopCoopWatchdog();
    build(f.session.storageId);
  };
  f.envelope = function (id) { return { eventId: id || "report-1",
    destination: { projectId: "system-lead", sessionStorageId: f.session.storageId },
    payload: { type: "coordinator_update", text: "Worker completed and verified the project change." } }; };
  f.deliver = function (id) { return f.api.deliverCrossProjectEnvelope(f.envelope(id)); };
  f.disk = function () {
    return fs.readFileSync(path.join(f.sm.sessionsDir, f.session.storageId + ".jsonl"), "utf8")
      .trim().split("\n").map(JSON.parse);
  };
  t.after(async function () {
    cleanups.forEach(function (cleanup) { if (cleanup) cleanup(); });
    f.held.forEach(function (handle) { handle.close(); });
    await settled();
  });
  return f;
}

module.exports = { fixture: fixture, settled: settled };
