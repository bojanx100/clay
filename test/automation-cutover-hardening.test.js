// Regressions for the second round of independent-review findings on the Coop
// automation cutover. Each test is shaped like the incident it prevents:
// commit fencing, durability reporting, reconciliation honesty, launch-state
// rollback, the pre-launch fence, and owner attribution surviving the queue.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var claimLeases = require("../lib/automation-claim-leases");
var gateModule = require("../lib/project-automation-gate");
var automationAudit = require("../lib/project-automation-audit");
var queueModule = require("../lib/project-user-message-queue");
var { createPrReviewState } = require("../lib/project-pr-review-state");
var { createIssueLaunchState } = require("../lib/project-issue-launch-state");

var PROJECT_A = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

// Minimal deps for the queue module: it only needs to notify and persist.
function queueDeps(onSend) {
  return {
    sendToSession: function (id, msg) { if (onSend) onSend(msg); },
    sendQueuedUserMessagesState: function () {},
    sm: { saveSessionFile: function () {}, broadcastSessionList: function () {} },
  };
}

function claim(key, holder) {
  return { projectRef: { projectId: PROJECT_A }, key: key, holder: holder };
}

// --- Commit fencing ------------------------------------------------------------

// A lock alone cannot fence a write. A holder that stalls, has its lock broken
// as stale, and then resumes would otherwise publish state derived from a read
// that is now superseded — erasing whatever the successor committed.
test("a commit is refused when the store moved under it", function () {
  var dir = tempDir("clay-fence-");
  var file = path.join(dir, "claims.json");
  var stalled = claimLeases.createClaimLeases({ file: file, ttlMs: 60000 });
  var other = claimLeases.createClaimLeases({ file: file, ttlMs: 60000 });

  // `stalled` reads the store, then another writer publishes.
  assert.strictEqual(stalled.acquire(claim("a", "holder-a")).ok, true);
  assert.strictEqual(other.acquire(claim("b", "holder-b")).ok, true);

  // Both writes must survive: neither erased the other.
  var onDisk = claimLeases.createClaimLeases({ file: file }).list();
  assert.strictEqual(onDisk.length, 2);
});

test("the epoch advances on every commit and is persisted", function () {
  var dir = tempDir("clay-epoch-");
  var file = path.join(dir, "claims.json");
  var store = claimLeases.createClaimLeases({ file: file, ttlMs: 60000 });
  store.acquire(claim("a", "h"));
  var first = JSON.parse(fs.readFileSync(file, "utf8")).epoch;
  store.acquire(claim("b", "h"));
  var second = JSON.parse(fs.readFileSync(file, "utf8")).epoch;
  assert.ok(Number.isInteger(first) && first > 0, "epoch must be persisted");
  assert.strictEqual(second, first + 1, "each commit must advance the epoch");
});

test("a stalled writer cannot publish over a successor's commit", function () {
  var dir = tempDir("clay-stale-commit-");
  var file = path.join(dir, "claims.json");
  var stalled = claimLeases.createClaimLeases({ file: file, ttlMs: 60000 });
  stalled.acquire(claim("seed", "h"));

  // Simulate a successor publishing while `stalled` is between read and write
  // by bumping the on-disk epoch behind its back.
  var onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  onDisk.epoch = onDisk.epoch + 5;
  fs.writeFileSync(file, JSON.stringify(onDisk, null, 2) + "\n");

  // The next commit reloads first, so it picks up the new epoch and succeeds
  // against CURRENT state rather than clobbering it.
  assert.strictEqual(stalled.acquire(claim("later", "h")).ok, true);
  var after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(after.leases.length, 2, "the successor's state must survive");
});

// --- Durability ----------------------------------------------------------------

// A rename is only durable once the directory entry is flushed. Swallowing the
// failure would report a claim as committed that a power loss can undo, and a
// claim that silently un-commits is a duplicate launch.
test("a directory fsync failure is reported, not swallowed", function () {
  var dir = tempDir("clay-durability-");
  var file = path.join(dir, "claims.json");
  var realFs = require("fs");
  var failingFs = Object.create(realFs);
  failingFs.fsyncSync = function (descriptor) {
    var stat = realFs.fstatSync(descriptor);
    if (stat.isDirectory()) {
      var error = new Error("simulated durability failure");
      error.code = "EIO";
      throw error;
    }
    return realFs.fsyncSync(descriptor);
  };
  var store = claimLeases.createClaimLeases({ fs: failingFs, file: file, ttlMs: 60000 });
  var result = store.acquire(claim("k", "h"));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "durability_failed");
});

test("a filesystem that cannot fsync a directory is tolerated", function () {
  var dir = tempDir("clay-durability-ok-");
  var file = path.join(dir, "claims.json");
  var realFs = require("fs");
  var pickyFs = Object.create(realFs);
  pickyFs.fsyncSync = function (descriptor) {
    var stat = realFs.fstatSync(descriptor);
    if (stat.isDirectory()) {
      var error = new Error("not supported here");
      error.code = "EINVAL";
      throw error;
    }
    return realFs.fsyncSync(descriptor);
  };
  var store = claimLeases.createClaimLeases({ fs: pickyFs, file: file, ttlMs: 60000 });
  assert.strictEqual(store.acquire(claim("k", "h")).ok, true);
});

// --- Reconciliation honesty ------------------------------------------------------

// Reporting ok:true while claim operations failed tells the caller
// reconciliation succeeded when live work may have been left unclaimed.
test("reconciliation reports failure when a claim operation could not complete", function () {
  var dir = tempDir("clay-reconcile-honest-");
  var store = claimLeases.createClaimLeases({ file: path.join(dir, "claims.json") });
  var gate = gateModule.createAutomationGate({
    cwd: dir,
    slug: "honest",
    projectRef: { projectId: PROJECT_A },
    policyTtlMs: 0,
    getLeadMode: function () { return true; },
    leases: store,
    audit: automationAudit.createAutomationAudit({
      file: path.join(dir, "audit.jsonl"), slug: "honest",
    }),
  });

  // An active item with no claim would normally be reclaimed; make that fail.
  store.acquire = function () { return { ok: false, reason: "claim_store_busy" }; };
  var result = gate.reconcileClaims(["o/r#1"]);
  assert.strictEqual(result.ok, false, "a failed claim operation must not report success");
  assert.strictEqual(result.reason, "claim_operations_failed");
  assert.strictEqual(result.failures.length, 1);
  assert.strictEqual(result.failures[0].op, "reclaim");
});

test("a clean reconciliation still reports success", function () {
  var dir = tempDir("clay-reconcile-clean-");
  var gate = gateModule.createAutomationGate({
    cwd: dir,
    slug: "clean",
    projectRef: { projectId: PROJECT_A },
    policyTtlMs: 0,
    getLeadMode: function () { return true; },
    leases: claimLeases.createClaimLeases({ file: path.join(dir, "claims.json") }),
    audit: automationAudit.createAutomationAudit({
      file: path.join(dir, "audit.jsonl"), slug: "clean",
    }),
  });
  var result = gate.reconcileClaims([]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.failures.length, 0);
});

// --- The pre-launch fence ---------------------------------------------------------

// A read-only check leaves a window: the lease can lapse between the check and
// the launch. Renewing makes the check a fence — it only succeeds while the
// lease is provably ours, and it pushes expiry past the launch.
test("the pre-launch check renews, so a launch cannot straddle an expiry", function () {
  var dir = tempDir("clay-fence-launch-");
  var time = 1000;
  function now() { return time; }
  var store = claimLeases.createClaimLeases({ file: path.join(dir, "claims.json"), now: now });
  var gate = gateModule.createAutomationGate({
    cwd: dir,
    slug: "fence",
    projectRef: { projectId: PROJECT_A },
    now: now,
    policyTtlMs: 0,
    claimTtlMs: 5000,
    getLeadMode: function () { return true; },
    leases: store,
    audit: automationAudit.createAutomationAudit({
      file: path.join(dir, "audit.jsonl"), slug: "fence", now: now,
    }),
  });
  store.acquire({
    projectRef: { projectId: PROJECT_A }, key: gate.claimKeyFor("o/r#1"),
    holder: gate.holder, ttlMs: 5000,
  });

  time = 4000;
  assert.strictEqual(gate.holdsClaim("o/r#1"), true);
  var lease = store.get({ projectId: PROJECT_A }, gate.claimKeyFor("o/r#1"));
  assert.strictEqual(lease.expiresAt, 9000, "the fence must extend expiry past the launch");

  // A lease that is genuinely gone fails the fence.
  store.release({
    projectRef: { projectId: PROJECT_A }, key: gate.claimKeyFor("o/r#1"), holder: gate.holder,
  });
  assert.strictEqual(gate.holdsClaim("o/r#1"), false);
});

test("the pre-launch fence fails closed when the claim belongs to someone else", function () {
  var dir = tempDir("clay-fence-foreign-");
  var store = claimLeases.createClaimLeases({ file: path.join(dir, "claims.json") });
  var gate = gateModule.createAutomationGate({
    cwd: dir, slug: "foreign", projectRef: { projectId: PROJECT_A }, policyTtlMs: 0,
    getLeadMode: function () { return true; },
    leases: store,
    audit: automationAudit.createAutomationAudit({
      file: path.join(dir, "audit.jsonl"), slug: "foreign",
    }),
  });
  store.acquire({
    projectRef: { projectId: PROJECT_A }, key: gate.claimKeyFor("o/r#2"),
    holder: "another-daemon", ttlMs: 60000,
  });
  assert.strictEqual(gate.holdsClaim("o/r#2"), false);
});

// --- Launch-state rollback ---------------------------------------------------------

// Releasing the claim was not enough: the PR pass stayed spent and the issue
// stayed marked launched, so an item whose session never started could lose a
// pass or be deduped forever.
test("a PR pass consumed for a session that never started is restored", function () {
  var cwd = tempDir("clay-pr-rollback-");
  var prState = createPrReviewState(cwd);
  var item = { key: "o/r#5", latestFeedbackTs: 100, ci_failing: true };

  var before = prState.get("o/r#5");
  assert.strictEqual(before.passCount, 0);

  prState.recordLaunch(item, 2);
  assert.strictEqual(prState.get("o/r#5").passCount, 1, "the pass was consumed");

  prState.restore("o/r#5", before);
  assert.strictEqual(prState.get("o/r#5").passCount, 0, "a failed start must give the pass back");
  assert.strictEqual(prState.shouldLaunch(item, 2).launch, true, "and the item is launchable again");
});

test("an issue marked launched for a session that never started is unmarked", function () {
  var cwd = tempDir("clay-issue-rollback-");
  var issueState = createIssueLaunchState(cwd);

  var existedBefore = issueState.hasEntry("o/r#6");
  assert.strictEqual(existedBefore, false);

  issueState.recordLaunch("o/r#6");
  assert.strictEqual(issueState.hasEntry("o/r#6"), true, "the issue was marked launched");

  issueState.forget("o/r#6", existedBefore);
  assert.strictEqual(issueState.hasEntry("o/r#6"), false,
    "a failed start must not dedupe the issue forever");
});

test("rollback never destroys state that already existed", function () {
  var cwd = tempDir("clay-rollback-safe-");
  var issueState = createIssueLaunchState(cwd);
  issueState.recordCompletion("o/r#7", "Dev Complete", true);
  assert.strictEqual(issueState.hasEntry("o/r#7"), true);

  // existedBefore = true, so a rollback must leave the prior entry alone.
  issueState.forget("o/r#7", true);
  assert.strictEqual(issueState.hasEntry("o/r#7"), true);
  assert.strictEqual(issueState.get("o/r#7").armed, true, "prior state must be preserved");
});

// --- Owner attribution across the queue ---------------------------------------------

// A turn that is queued now and dispatched later must still know who sent it.
// The Done-workflow gate authorizes on the real sender, so a replayed turn
// that lost its actor would silently fail the owner check.
test("a queued turn keeps the identity of whoever sent it", function () {
  var session = { localId: 1 };
  var notified = [];
  queueModule.queuePreparedMessage(
    session, "mark as done", null, "q1", "mark as done", 0, null, null,
    { actorUserId: "user-owner" },
    queueDeps(function (msg) { notified.push(msg); }));

  assert.strictEqual(session.pendingUserMessageQueue.length, 1);
  assert.strictEqual(session.pendingUserMessageQueue[0].actorUserId, "user-owner",
    "the sender must be persisted on the queued item");
});

test("a queued turn with no identified sender records none rather than guessing", function () {
  var session = { localId: 1 };
  queueModule.queuePreparedMessage(
    session, "hi", null, "q2", "hi", 0, null, null, {},
    queueDeps(null));
  assert.strictEqual(session.pendingUserMessageQueue[0].actorUserId, null);
});
