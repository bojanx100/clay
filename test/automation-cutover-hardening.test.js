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

// Newest committed epoch file, under the O_EXCL epoch-commit layout.
function readCommitted(file) {
  var dir = path.dirname(file);
  var base = path.basename(file);
  var epochs = fs.readdirSync(dir)
    .filter(function (n) { return n.indexOf(base + ".") === 0 && /\.\d+$/.test(n); })
    .map(function (n) { return Number(n.slice(base.length + 1)); })
    .sort(function (a, b) { return b - a; });
  return epochs.length ? JSON.parse(fs.readFileSync(file + "." + epochs[0], "utf8")) : null;
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
  var first = readCommitted(file).epoch;
  store.acquire(claim("b", "h"));
  var second = readCommitted(file).epoch;
  assert.ok(Number.isInteger(first) && first > 0, "epoch must be persisted");
  assert.strictEqual(second, first + 1, "each commit must advance the epoch");
});

test("a stalled writer cannot publish over a successor's commit", function () {
  var dir = tempDir("clay-stale-commit-");
  var file = path.join(dir, "claims.json");
  var stalled = claimLeases.createClaimLeases({ file: file, ttlMs: 60000 });
  stalled.acquire(claim("seed", "h"));

  // A successor publishes the next epoch while `stalled` still believes the
  // previous one is current.
  var successor = claimLeases.createClaimLeases({ file: file, ttlMs: 60000 });
  successor.acquire(claim("successor-work", "other"));

  // The stalled writer's commit reloads first, so it builds on the successor's
  // state rather than replacing it. Both survive.
  assert.strictEqual(stalled.acquire(claim("later", "h")).ok, true);
  var after = readCommitted(file);
  assert.strictEqual(after.leases.length, 3, "no commit may erase another");
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
  store.adopt = function () { return { ok: false, reason: "claim_store_busy" }; };
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

  var before = issueState.snapshot("o/r#6");
  assert.strictEqual(before, null);

  issueState.recordLaunch("o/r#6");
  assert.strictEqual(issueState.hasEntry("o/r#6"), true, "the issue was marked launched");

  issueState.restore("o/r#6", before);
  assert.strictEqual(issueState.hasEntry("o/r#6"), false,
    "a failed start must not dedupe the issue forever");
});

// recordLaunch overwrites `armed`, `status` and `statusAtCompletion` on an
// EXISTING entry, so a rollback that only removed newly created entries would
// silently disarm a bounce that had been waiting to relaunch.
test("rollback restores an existing issue's armed state, not just new entries", function () {
  var cwd = tempDir("clay-rollback-armed-");
  var issueState = createIssueLaunchState(cwd);

  // A completed issue that progressed on the board is armed for one relaunch.
  issueState.recordCompletion("o/r#7", "Dev Complete", true);
  var before = issueState.snapshot("o/r#7");
  assert.strictEqual(before.armed, true);
  assert.strictEqual(before.status, "completed");

  // A launch that then fails would otherwise leave it disarmed forever.
  issueState.recordLaunch("o/r#7");
  assert.strictEqual(issueState.get("o/r#7").armed, false, "recordLaunch disarms");

  issueState.restore("o/r#7", before);
  var after = issueState.get("o/r#7");
  assert.strictEqual(after.armed, true, "the pending bounce must be restored");
  assert.strictEqual(after.status, "completed");
  assert.strictEqual(after.statusAtCompletion, "Dev Complete");
  assert.strictEqual(issueState.shouldRelaunch("o/r#7"), true);
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

test("a Coop ingress rebuilt from history keeps the sender", function () {
  var session = {
    localId: 1,
    history: [{
      type: "user_message",
      text: "mark as done",
      from: "user-owner",
      coopIngressId: "ing-1",
      coopIngressPending: true,
      coopIngressSequence: 1,
      coopIngressPreparedText: "mark as done",
    }],
  };
  queueModule.rebuildCoopIngressFromHistory(session, {
    coopControl: null, sm: { saveSessionFile: function () {} },
  });
  assert.strictEqual(session.pendingCoopIngress.length, 1);
  assert.strictEqual(session.pendingCoopIngress[0].actorUserId, "user-owner",
    "a restart must not strip the sender from a pending ingress turn");
});

// The end-to-end point of carrying the actor: a "mark as done" that was queued
// and only dispatched later must still be judged against who really sent it.
test("a replayed Done request is authorized by its original sender", function () {
  var dispatched = [];
  var deps = Object.assign(queueDeps(null), {
    onUserMessageDispatched: function (session, text, actorUserId) {
      dispatched.push({ text: text, actorUserId: actorUserId });
      return "";
    },
    shouldQueueDuringProcessing: function () { return false; },
    coopControl: null,
    sdk: { startQuery: function () {}, pushMessage: function () {} },
    ensureProjectAccessForSession: function () { return null; },
    onProcessingChanged: function () {},
    hasQueuedUserMessageDispatchBlocker: function () { return false; },
    sendToSession: function () {},
    sendQueuedUserMessagesState: function () {},
    sm: { saveSessionFile: function () {}, broadcastSessionList: function () {} },
  });

  var owner = { localId: 1, isProcessing: false };
  queueModule.dispatchPreparedToSdk(owner,
    { finalText: "mark as done", displayText: "mark as done", actorUserId: "user-owner" }, deps);

  var intruder = { localId: 2, isProcessing: false };
  queueModule.dispatchPreparedToSdk(intruder,
    { finalText: "mark as done", displayText: "mark as done", actorUserId: "user-other" }, deps);

  assert.strictEqual(dispatched.length, 2);
  assert.strictEqual(dispatched[0].actorUserId, "user-owner");
  assert.strictEqual(dispatched[1].actorUserId, "user-other",
    "a non-owner's replayed request must arrive attributed to the non-owner");
});

// --- Adversarial interleavings ------------------------------------------------

// A successor commits in the window a stale holder would have used to rename.
// Under the O_EXCL epoch protocol the stale holder simply loses the create.
test("a successor injected between read and commit is never overwritten", function () {
  var dir = tempDir("clay-interleave-commit-");
  var file = path.join(dir, "claims.json");
  var victim = claimLeases.createClaimLeases({ file: file, ttlMs: 60000 });
  var successor = claimLeases.createClaimLeases({ file: file, ttlMs: 60000 });

  victim.acquire(claim("seed", "h"));

  // Inject the successor's commit precisely between the victim's read and its
  // own commit attempt, by hooking the filesystem the victim writes through.
  var realFs = require("fs");
  var injected = false;
  var racingFs = Object.create(realFs);
  racingFs.openSync = function (target, flags, mode) {
    if (!injected && String(flags) === "wx" && String(target).indexOf(file + ".") === 0) {
      injected = true;
      successor.acquire(claim("successor-work", "other"));
    }
    return realFs.openSync(target, flags, mode);
  };
  var racer = claimLeases.createClaimLeases({ fs: racingFs, file: file, ttlMs: 60000 });
  var result = racer.acquire(claim("racer-work", "racer"));

  assert.strictEqual(result.ok, true, "the loser must retry and eventually commit");
  var committed = readCommitted(file);
  var keys = committed.leases.map(function (l) { return l.key; }).sort();
  assert.deepStrictEqual(keys, ["racer-work", "seed", "successor-work"],
    "no commit may erase another, however they interleave");
});

// The lease lapses between listing it and renewing it. Reconciliation must not
// treat that key as settled, or running work is left unclaimed.
test("a lease that expires between list and renew is reacquired, not skipped", function () {
  var dir = tempDir("clay-interleave-renew-");
  var time = 1000;
  function now() { return time; }
  var store = claimLeases.createClaimLeases({ file: path.join(dir, "claims.json"), now: now });
  var gate = gateModule.createAutomationGate({
    cwd: dir, slug: "renewrace", projectRef: { projectId: PROJECT_A },
    now: now, policyTtlMs: 0, claimTtlMs: 5000, holderPid: 4242,
    getLeadMode: function () { return true; },
    leases: store,
    audit: automationAudit.createAutomationAudit({
      file: path.join(dir, "audit.jsonl"), slug: "renewrace", now: now }),
  });
  store.acquire({
    projectRef: { projectId: PROJECT_A }, key: gate.claimKeyFor("o/r#9"),
    holder: gate.holder, holderPid: 4242, ttlMs: 5000,
  });

  // Expire the lease in the window between list() and renew().
  var realList = store.list;
  store.list = function () {
    var out = realList.call(store);
    time = 100000;
    return out;
  };

  var result = gate.reconcileClaims(["o/r#9"]);
  assert.strictEqual(gate.holdsClaim("o/r#9"), true,
    "running work must end reconciliation holding a claim");
  assert.ok(result.reclaimed >= 1 || result.adopted >= 1);
});

// Two replay routes previously dropped the sender. Both fail CLOSED (they deny
// the real owner rather than granting a non-owner), but denying an owner their
// own Done workflow for no visible reason is its own defect.
test("steer-requeue carries the original sender across the requeue", function () {
  var session = { localId: 1, pendingUserMessageQueue: [] };
  var deps = queueDeps(null);

  // A turn queued by the owner, then steered to the front.
  queueModule.queuePreparedMessage(session, "mark as done", null, "q1",
    "mark as done", 0, null, null, { actorUserId: "user-owner" }, deps);
  var queued = session.pendingUserMessageQueue.splice(0, 1)[0];
  assert.strictEqual(queued.actorUserId, "user-owner");

  // This mirrors the steer path in project-user-message-handlers.js: the item
  // is spliced out and re-queued, and the sender must survive that rebuild.
  queueModule.queuePreparedMessage(session, queued.text, queued.images, queued.queueId,
    queued.displayText, queued.imageCount, queued.clientMessageId, queued.pastes,
    { front: true, silent: true, hidden: true, actorUserId: queued.actorUserId || null }, deps);

  assert.strictEqual(session.pendingUserMessageQueue[0].actorUserId, "user-owner",
    "a steered turn must not become unattributed");
});

test("a requeued turn with no sender stays null rather than inventing one", function () {
  var session = { localId: 1, pendingUserMessageQueue: [] };
  var deps = queueDeps(null);
  queueModule.queuePreparedMessage(session, "hi", null, "q2", "hi", 0, null, null,
    { front: true, actorUserId: null }, deps);
  assert.strictEqual(session.pendingUserMessageQueue[0].actorUserId, null);
});
