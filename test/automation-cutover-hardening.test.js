// Regressions for the second round of independent-review findings on the Coop
// automation cutover. Each test is shaped like the incident it prevents:
// commit fencing, durability reporting, reconciliation honesty, launch-state
// rollback, the pre-launch fence, and owner attribution surviving the queue.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var gateModule = require("../lib/project-automation-gate");
var automationAudit = require("../lib/project-automation-audit");
var queueModule = require("../lib/project-user-message-queue");
var { createPrReviewState } = require("../lib/project-pr-review-state");
var { createIssueLaunchState } = require("../lib/project-issue-launch-state");

var PROJECT_A = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

// A workspace whose own policy makes bugs autonomous. beginLaunch re-reads
// policy, so a fixture without one is correctly refused.
function autonomousDir(name) {
  var dir = tempDir(name);
  var tasks = path.join(dir, ".clay", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, "issues.json"), JSON.stringify({
    id: "issues", source: { provider: "github", kind: "issue", repo: "o/r" },
    filter: { type: "bug" },
  }));
  return dir;
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
// The lease lapses between listing it and renewing it. Reconciliation must not
// treat that key as settled, or running work is left unclaimed.


// --- The claim protocol is gone from every reachable path ---------------------
//
// The bespoke lease/fencing protocol was removed rather than hardened, because
// a second claim authority beside portfolio-execution-bindings is a consensus
// problem Clay does not need. These assert that it cannot come back by
// accident: nothing requires it, and no Lead-ON decision reaches for one.

test("no automation module requires the removed claim protocol", function () {
  var fsMod = require("fs");
  var pathMod = require("path");
  var libDir = pathMod.join(__dirname, "..", "lib");
  var offenders = fsMod.readdirSync(libDir).filter(function (name) {
    if (!/\.js$/.test(name)) return false;
    return fsMod.readFileSync(pathMod.join(libDir, name), "utf8")
      .indexOf("automation-claim-") !== -1;
  });
  assert.deepStrictEqual(offenders, [],
    "the claim protocol must stay unreachable: " + offenders.join(", "));
  assert.strictEqual(fsMod.existsSync(pathMod.join(libDir, "automation-claim-leases.js")), false);
  assert.strictEqual(fsMod.existsSync(pathMod.join(libDir, "automation-claim-store.js")), false);
});

test("the gate exposes no claim surface at all", function () {
  var gateModule = require("../lib/project-automation-gate");
  var gate = gateModule.createAutomationGate({
    cwd: tempDir("clay-nosurface-"),
    slug: "nosurface",
    projectRef: { projectId: PROJECT_A },
    getLeadMode: function () { return true; },
  });
  var removed = ["acquire", "renew", "release", "releaseClaim", "renewClaim",
    "holdsClaim", "beginLaunch", "confirmRunning", "reconcileClaims", "leases"];
  for (var i = 0; i < removed.length; i++) {
    assert.strictEqual(gate[removed[i]], undefined,
      gate[removed[i]] && removed[i] + " must not be reachable");
  }
});
