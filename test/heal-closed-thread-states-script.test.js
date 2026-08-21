var assert = require("node:assert/strict");
var childProcess = require("node:child_process");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");

var topics = require("../lib/coop-topic-index");
var lifecycle = require("../lib/coop-thread-lifecycle");
var ownerRequests = require("../lib/coop-owner-requests");
var repair = require("../lib/coop-thread-closure-repair");

var SCRIPT = path.join(__dirname, "..", "scripts", "heal-closed-thread-states.js");

function damagedStore(t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-heal-closed-script-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var clayHome = path.join(dir, "clay-home");
  var file = path.join(clayHome, "lead", "coop-topic-index.json");
  var index = topics.createTopicIndex({ file: file });
  var state = index.load();
  state.topics.damaged = {
    topicRef: { topicId: "damaged" },
    threadRef: { threadId: "damaged" },
    title: "Damaged",
    group: "uncategorised",
    status: "closed",
    threadState: lifecycle.THREAD_STATES.EXPLORING,
    closeOutcome: null,
    hidden: false,
    createdAt: 1,
    updatedAt: 1,
    threadStateUpdatedAt: 1,
    eventRefs: [],
    turnRefs: [],
    relatedExecutions: [],
  };
  index.save();
  return { clayHome: clayHome, file: file };
}

function run(args, env) {
  return childProcess.spawnSync(process.execPath, [SCRIPT].concat(args), {
    encoding: "utf8",
    env: Object.assign({}, process.env, env || {}),
  });
}

test("the repair CLI is dry-run by default and applies idempotently when asked", function (t) {
  var store = damagedStore(t);
  var dryRun = run(["--file", store.file]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Would repair 1 record/);
  assert.match(dryRun.stdout, /Dry run: nothing written/);
  assert.equal(topics.createTopicIndex({ file: store.file }).load().topics.damaged.threadState,
    lifecycle.THREAD_STATES.EXPLORING, "dry-run must leave the durable record untouched");

  var apply = run(["--file", store.file, "--apply"]);
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /Repaired 1 record/);
  var repaired = topics.createTopicIndex({ file: store.file }).load().topics.damaged;
  assert.equal(repaired.threadState, lifecycle.THREAD_STATES.CLOSED);
  assert.equal(repaired.closeOutcome, lifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED);

  var replay = run(["--file", store.file, "--apply"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout, /Nothing to repair/);
});

test("a copy rehearsal cannot reconcile the live owner-request ledger", function (t) {
  var store = damagedStore(t);
  var result = run(["--file", store.file, "--apply", "--reconcile-requests"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be combined with --file/);
  assert.equal(topics.createTopicIndex({ file: store.file }).load().topics.damaged.threadState,
    lifecycle.THREAD_STATES.EXPLORING);
});

test("a failed owner-request settlement leaves the topic repair retryable", function (t) {
  var store = damagedStore(t);
  var index = topics.createTopicIndex({ file: store.file });
  var attempts = 0;
  var failed = repair.healWithOwnerRequests(index, {
    reconcileTopicClosure: function () {
      attempts++;
      return { ok: false, reason: "injected_failure" };
    },
  }, {});
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "owner_request_reconcile_failed");
  assert.equal(index.load().topics.damaged.threadState, lifecycle.THREAD_STATES.EXPLORING,
    "the topic must remain eligible for a fresh-process retry");

  var retried = repair.healWithOwnerRequests(index, {
    reconcileTopicClosure: function () {
      attempts++;
      return { ok: true, settled: [], preserved: [], changed: false };
    },
  }, {});
  assert.equal(retried.ok, true);
  assert.equal(retried.healed.length, 1);
  assert.equal(attempts, 2);
  assert.equal(index.load().topics.damaged.threadState, lifecycle.THREAD_STATES.CLOSED);
});

test("live repair settles owner requests before changing the topic record", function (t) {
  var store = damagedStore(t);
  var ownerFile = path.join(store.clayHome, "lead", "coop-owner-requests.json");
  var ledger = ownerRequests.attachCoopOwnerRequests({ file: ownerFile });
  var liveEnv = { CLAY_HOME: store.clayHome, CLAY_DEV: "" };
  ledger.record({
    ingressId: "coop:canonical:1", ingressSequence: 1,
    sessionRef: { projectId: "system-lead", sessionStorageId: "canonical" },
    topicRef: { topicId: "damaged" },
  });

  var reconcileDryRun = run(["--reconcile-requests"], liveEnv);
  assert.equal(reconcileDryRun.status, 1);
  assert.match(reconcileDryRun.stderr, /requires --apply/);
  assert.equal(topics.createTopicIndex({ file: store.file }).load().topics.damaged.threadState,
    lifecycle.THREAD_STATES.EXPLORING);

  var refused = run(["--apply"], liveEnv);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /requires --reconcile-requests/);
  assert.equal(topics.createTopicIndex({ file: store.file }).load().topics.damaged.threadState,
    lifecycle.THREAD_STATES.EXPLORING);

  var alias = path.join(store.clayHome, "lead", "..", "lead", "coop-topic-index.json");
  var aliasRefused = run(["--file", alias, "--apply"], liveEnv);
  assert.equal(aliasRefused.status, 1);
  assert.match(aliasRefused.stderr, /requires --reconcile-requests/);

  fs.writeFileSync(path.join(store.clayHome, "daemon.json"),
    JSON.stringify({ pid: process.pid }) + "\n");
  var daemonRefused = run(["--apply", "--reconcile-requests", "--owner-approved"],
    liveEnv);
  assert.equal(daemonRefused.status, 1);
  assert.match(daemonRefused.stderr, /stop the Clay daemon/);
  fs.unlinkSync(path.join(store.clayHome, "daemon.json"));

  var applied = run(["--apply", "--reconcile-requests", "--owner-approved"],
    liveEnv);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Settling owner requests linked to repair candidates/);
  assert.match(applied.stdout, /Verified snapshot:/);
  assert.equal(fs.readdirSync(path.join(store.clayHome, "repair-snapshots")).length, 1);
  assert.equal(topics.createTopicIndex({ file: store.file }).load().topics.damaged.threadState,
    lifecycle.THREAD_STATES.CLOSED);
  assert.equal(ownerRequests.attachCoopOwnerRequests({ file: ownerFile })
    .get("coop:canonical:1").state, "done");
});
