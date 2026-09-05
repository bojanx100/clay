var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var createRouter = require("../lib/server-cross-project").createCrossProjectRouter;

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function harness(t, overrides) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-delivery-clock-"));
  var router = createRouter(Object.assign({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    deliveryRetryIntervalMs: 5,
    retryBaseMs: 5,
  }, overrides || {}));
  t.after(function () {
    if (router.stopDeliveryRetry) router.stopDeliveryRetry();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return router;
}

function enqueue(router) {
  return router.deliverEnvelope(router.createEnvelope({
    eventId: "clock-report", bindingRevision: 1,
    source: { projectId: "system-source", sessionStorageId: "worker" },
    destination: { projectId: "system-target", sessionStorageId: "coordinator" },
    payload: { type: "coordinator_update", text: "The worker has finished." },
  }));
}

test("daemon delivery clock retries without caller replay or project registration", async function (t) {
  var attempts = 0;
  var router = harness(t, { getProjectContextById: function () {
    return { deliverCrossProjectEnvelope: function () {
      attempts++;
      return attempts === 1 ? { ok: false, reason: "delivery_error" } : { ok: true };
    } };
  } });
  assert.equal(enqueue(router).pending, true);
  for (var i = 0; i < 100 && router.getPendingEventIds().length; i++) await delay(10);
  assert.deepEqual(router.getPendingEventIds(), []);
  assert.equal(attempts, 2);
});

test("delivery clock stays paused during recovery and stops when the router is destroyed", async function (t) {
  var attempts = 0;
  var router = harness(t, {
    coopExecutionControl: { enabled: true },
    coopStartupRecovery: { enabled: true, assertReady: function () {} },
    getProjectContextById: function () { return { deliverCrossProjectEnvelope: function () {
      attempts++;
      return { ok: false, reason: "delivery_error" };
    } }; },
  });
  assert.equal(enqueue(router).pending, true);
  await delay(25);
  assert.equal(attempts, 1);
  router.completeControlledStartup();
  for (var i = 0; i < 100 && attempts === 1; i++) await delay(10);
  assert.ok(attempts > 1);
  assert.equal(typeof router.stopDeliveryRetry, "function");
  router.stopDeliveryRetry();
  var stoppedAt = attempts;
  await delay(30);
  assert.equal(attempts, stoppedAt);
});

test("delivery clock does not retry after shutdown begins", async function (t) {
  var attempts = 0;
  var router = harness(t, { getProjectContextById: function () {
    return { deliverCrossProjectEnvelope: function () {
      attempts++;
      return { ok: false, reason: "delivery_error" };
    } };
  } });
  enqueue(router);
  router.prepareControlledRestart();
  await delay(30);
  assert.equal(attempts, 1);
  assert.deepEqual(router.getPendingEventIds(), ["clock-report"]);
});
