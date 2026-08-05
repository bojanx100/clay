var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var createBindings =
  require("../lib/portfolio-execution-bindings").createPortfolioExecutionBindings;

var PROJECT_ID = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";

function request(revision, mode, key) {
  return {
    portfolioTaskId: "portfolio-task",
    mode: mode || "direct_leaf",
    targetProject: { projectId: PROJECT_ID },
    bindingRevision: revision,
    idempotencyKey: key || "command-" + revision,
  };
}

test("portfolio execution bindings persist one idempotent canonical SessionRef", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bindings-"));
  var file = path.join(dir, "bindings.json");
  var clock = 10;
  var store = createBindings({ file: file, now: function () { return clock++; } });

  var reserved = store.reserve(request(1));
  assert.equal(reserved.ok, true);
  assert.equal(reserved.created, true);
  assert.equal(store.reserve(request(1)).created, false);
  var committed = store.commit("portfolio-task", 1, {
    projectId: PROJECT_ID,
    sessionStorageId: "canonical-worker",
  });
  assert.equal(committed.ok, true);
  assert.deepEqual(committed.binding.worker, {
    projectId: PROJECT_ID,
    sessionStorageId: "canonical-worker",
  });

  var restarted = createBindings({ file: file, now: function () { return clock++; } });
  assert.deepEqual(restarted.get("portfolio-task", 1).worker, committed.binding.worker);
  assert.equal(restarted.reserve(request(1)).created, false);
  assert.equal(restarted.reserve(request(1, "direct_leaf", "different-command")).reason,
    "idempotency_conflict");
  assert.equal(restarted.reserve(request(2)).reason, "active_binding_exists");
});

test("scope promotion and unavailable/deleted tombstones survive restart", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-promotion-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 50; } });
  store.reserve(request(1));
  store.commit("portfolio-task", 1, {
    projectId: PROJECT_ID,
    sessionStorageId: "leaf",
  });
  assert.equal(store.supersede("portfolio-task", 1, "scope_expansion").ok, true);
  assert.equal(store.reserve(request(2, "project_coordinator")).ok, true);
  store.commit("portfolio-task", 2, {
    projectId: PROJECT_ID,
    sessionStorageId: "coordinator",
  });
  assert.equal(store.markUnavailable("portfolio-task", 2, "project_restart").ok, true);
  assert.equal(store.get("portfolio-task").status, "unavailable");
  assert.equal(store.markDeleted("portfolio-task", 2, "session_deleted").ok, true);

  var restarted = createBindings({ file: file });
  assert.equal(restarted.get("portfolio-task").status, "deleted");
  assert.equal(restarted.list().length, 2);
  assert.equal(restarted.list()[0].status, "superseded");
});

test("malformed binding state fails closed without overwriting it", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-binding-corrupt-"));
  var file = path.join(dir, "bindings.json");
  fs.writeFileSync(file, "{not-json");
  var store = createBindings({ file: file });

  assert.equal(store.getLoadError(), "malformed_state");
  assert.deepEqual(store.reserve(request(1)), { ok: false, reason: "malformed_state" });
  assert.equal(fs.readFileSync(file, "utf8"), "{not-json");
});
