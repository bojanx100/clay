// Regressions for the independent-review findings that survived the pivot to
// Coop-as-single-writer. Each test is shaped like the incident it prevents:
// launch-state rollback, owner attribution surviving every replay route, and
// the deleted claim protocol staying unreachable.
//
// The commit-fencing, durability and pre-launch-fence regressions that used to
// live here went with the bespoke claim protocol they guarded — the boundary
// no longer holds claims, so those failure modes have no path to occur.
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

// Minimal deps for the queue module: it only needs to notify and persist.
function queueDeps(onSend) {
  return {
    sendToSession: function (id, msg) { if (onSend) onSend(msg); },
    sendQueuedUserMessagesState: function () {},
    sm: { saveSessionFile: function () {}, broadcastSessionList: function () {} },
  };
}

function reconsiderationEvidence(overrides) {
  return Object.assign({
    schema: "clay.owner_requested_automation_reconsideration",
    version: 1,
    reason: "owner_requested_bounce_reconsideration",
    ownerRequestRefs: ["owner-ingress:122", "owner-ingress:125"],
    requestedAt: 1788717600000,
    currentQualificationRequired: true,
    verifiedNoLiveSession: true,
    sessionSnapshot: { projectRef: { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" }, sessions: [] },
  }, overrides || {});
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

test("#2503: stale unarmed launch state clears only with exact owner reconsideration evidence", function () {
  var cwd = tempDir("clay-issue-stale-repair-");
  var issueState = createIssueLaunchState(cwd);
  var file = path.join(cwd, ".clay", "tasks", "issue-launch-state.json");
  var stale = {
    status: "launched",
    statusAtCompletion: "",
    armed: false,
    lastLaunchAt: 1786016107837,
    completedAt: 0,
    updatedAt: 1786016107837,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ "trialview/v2#2503": stale }, null, 2) + "\n");

  var context = { projectRef: { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" },
    bindingSnapshot: [], projectSlug: "webapp" };
  assert.equal(issueState.clearStaleLaunch("trialview/v2#2503",
    reconsiderationEvidence({ expectedEntry: stale, sessionSnapshot: {
      projectRef: context.projectRef, sessions: [{ storageId: "live-2503",
        taskLauncher: { itemUrl: "https://github.com/trialview/v2/issues/2503" } }],
    } }), context).reason, "live_session_conflict");
  assert.equal(issueState.clearStaleLaunch("trialview/v2#2503",
    reconsiderationEvidence({ expectedEntry: stale }), Object.assign({}, context, {
      bindingSnapshot: [{ portfolioTaskId: "portfolio-webapp-2503", bindingRevision: 1,
        targetProject: context.projectRef, status: "active" }],
    })).reason, "active_binding_conflict");
  assert.deepEqual(issueState.snapshot("trialview/v2#2503"), stale);

  var result = issueState.clearStaleLaunch("trialview/v2#2503",
    reconsiderationEvidence({ expectedEntry: stale }), {
      projectRef: { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" },
      bindingSnapshot: [], projectSlug: "webapp",
    });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.removed, true);
  assert.deepEqual(result.before, stale);
  assert.equal(issueState.hasEntry("trialview/v2#2503"), false,
    "normal qualification may now reconsider the issue from scratch");
});

test("#2503: stale launch-state repair fails closed on mismatches and live conflicts", function () {
  var cases = [{
    name: "expected entry mismatch",
    entry: {
      status: "launched", statusAtCompletion: "", armed: false,
      lastLaunchAt: 1786016107837, completedAt: 0, updatedAt: 1786016107837,
    },
    evidence: {
      expectedEntry: {
        status: "launched", statusAtCompletion: "", armed: false,
        lastLaunchAt: 1786016107837, completedAt: 0, updatedAt: 1786016107838,
      },
    },
    reason: "stale_launch_mismatch",
  }, {
    name: "armed bounce",
    entry: {
      status: "completed", statusAtCompletion: "Dev Complete", armed: true,
      lastLaunchAt: 1786016107837, completedAt: 1786016200000, updatedAt: 1786016200000,
    },
    evidence: {
      expectedEntry: {
        status: "completed", statusAtCompletion: "Dev Complete", armed: true,
        lastLaunchAt: 1786016107837, completedAt: 1786016200000, updatedAt: 1786016200000,
      },
    },
    reason: "invalid_reconsideration_evidence",
  }, {
    name: "live conflict",
    entry: {
      status: "launched", statusAtCompletion: "", armed: false,
      lastLaunchAt: 1786016107837, completedAt: 0, updatedAt: 1786016107837,
    },
    evidence: {
      expectedEntry: {
        status: "launched", statusAtCompletion: "", armed: false,
        lastLaunchAt: 1786016107837, completedAt: 0, updatedAt: 1786016107837,
      },
      verifiedNoLiveSession: false,
    },
    reason: "invalid_reconsideration_evidence",
  }];
  for (var i = 0; i < cases.length; i++) {
    var cwd = tempDir("clay-issue-stale-repair-fail-");
    var issueState = createIssueLaunchState(cwd);
    var file = path.join(cwd, ".clay", "tasks", "issue-launch-state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ "trialview/v2#2503": cases[i].entry },
      null, 2) + "\n");
    var result = issueState.clearStaleLaunch("trialview/v2#2503",
      reconsiderationEvidence(cases[i].evidence));
    assert.equal(result.ok, false, cases[i].name);
    assert.equal(result.reason, cases[i].reason, cases[i].name);
    assert.equal(issueState.hasEntry("trialview/v2#2503"), true, cases[i].name);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
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
