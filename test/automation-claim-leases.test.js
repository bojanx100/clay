// Tests for the fenced automation claim state machine and its two-phase
// committed-epoch store.
//
// The invariant under test is singular: at most one actor may have work in
// flight for a given (project, item), and no crash, stall, or interleaving may
// produce a second launch. Everything here is shaped like the incident it
// prevents.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var leasesModule = require("../lib/automation-claim-leases");
var storeModule = require("../lib/automation-claim-store");
var createClaimLeases = leasesModule.createClaimLeases;

var PROJECT_A = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
var PROJECT_B = "system-lead";

function tempFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), name)), "automation-claims.json");
}

function clock(start) {
  var value = start;
  return { now: function () { return value; }, set: function (next) { value = next; } };
}

function req(projectId, key, holder, extra) {
  return Object.assign({
    projectRef: { projectId: projectId }, key: key, holder: holder, holderPid: 4242,
  }, extra || {});
}

// Drive a claim all the way to RUNNING, the way the launch path does.
function toRunning(store, projectId, key, holder, extra) {
  var acquired = store.acquire(req(projectId, key, holder, extra));
  assert.equal(acquired.ok, true);
  var token = acquired.lease.token;
  assert.equal(store.beginLaunch(req(projectId, key, holder, { token: token })).ok, true);
  assert.equal(store.confirmRunning(req(projectId, key, holder, { token: token })).ok, true);
  return token;
}

// --- The state machine ---------------------------------------------------------

test("a claim walks CLAIMED -> LAUNCHING -> RUNNING and blocks others throughout", function () {
  var store = createClaimLeases({ file: tempFile("clay-sm-"), ttlMs: 60000 });
  var acquired = store.acquire(req(PROJECT_A, "k", "a"));
  assert.equal(acquired.lease.state, "CLAIMED");
  assert.equal(acquired.lease.generation, 1);
  var token = acquired.lease.token;

  assert.equal(store.acquire(req(PROJECT_A, "k", "b")).reason, "held");

  var launching = store.beginLaunch(req(PROJECT_A, "k", "a", { token: token }));
  assert.equal(launching.lease.state, "LAUNCHING");
  assert.equal(store.acquire(req(PROJECT_A, "k", "b")).reason, "held");

  var running = store.confirmRunning(req(PROJECT_A, "k", "a", { token: token }));
  assert.equal(running.lease.state, "RUNNING");
  assert.equal(store.acquire(req(PROJECT_A, "k", "b")).reason, "held");

  assert.equal(store.release(req(PROJECT_A, "k", "a", { token: token })).ok, true);
  assert.equal(store.get({ projectId: PROJECT_A }, "k"), null);
  assert.equal(store.acquire(req(PROJECT_A, "k", "b")).ok, true);
});

test("a LAUNCHING claim never expires, so no timer can license a second launch", function () {
  var time = clock(1000);
  var store = createClaimLeases({ file: tempFile("clay-launching-"), now: time.now, ttlMs: 500 });
  var token = store.acquire(req(PROJECT_A, "k", "a")).lease.token;
  assert.equal(store.beginLaunch(req(PROJECT_A, "k", "a", { token: token })).ok, true);

  // Far past any TTL: an in-flight launch may already have produced a session.
  time.set(1000 + 500 * 1000);
  assert.equal(store.get({ projectId: PROJECT_A }, "k").state, "LAUNCHING");
  assert.equal(store.acquire(req(PROJECT_A, "k", "b")).reason, "held");
  assert.equal(store.sweep().removed, 0, "an in-flight launch must never be swept");
});

test("a CLAIMED claim that was never launched does expire", function () {
  var time = clock(1000);
  var store = createClaimLeases({ file: tempFile("clay-claimed-exp-"), now: time.now, ttlMs: 500 });
  store.acquire(req(PROJECT_A, "k", "a"));
  time.set(1501);
  assert.equal(store.get({ projectId: PROJECT_A }, "k"), null);
  assert.equal(store.acquire(req(PROJECT_A, "k", "b")).ok, true);
});

test("the launch intent, actor and policy digest are persisted before any side effect", function () {
  var file = tempFile("clay-intent-");
  var store = createClaimLeases({ file: file, ttlMs: 60000 });
  var token = store.acquire(req(PROJECT_A, "k", "a", {
    actor: "user-owner", policyDigest: "digest-1",
  })).lease.token;
  store.beginLaunch(req(PROJECT_A, "k", "a", {
    token: token, intent: { recipeId: "issues", automationClaimKey: "o/r#1" },
  }));

  // A fresh reader — i.e. a restarted daemon — sees the whole intent.
  var recovered = createClaimLeases({ file: file }).get({ projectId: PROJECT_A }, "k");
  assert.equal(recovered.state, "LAUNCHING");
  assert.equal(recovered.actor, "user-owner");
  assert.equal(recovered.policyDigest, "digest-1");
  assert.equal(recovered.intent.automationClaimKey, "o/r#1");
});

// --- Fencing tokens -------------------------------------------------------------

test("a stale token cannot advance, renew or release a re-issued claim", function () {
  var time = clock(1000);
  var store = createClaimLeases({ file: tempFile("clay-token-"), now: time.now, ttlMs: 500 });
  var stale = store.acquire(req(PROJECT_A, "k", "a")).lease.token;

  // The claim lapses and is re-issued to someone else.
  time.set(1501);
  var fresh = store.acquire(req(PROJECT_A, "k", "b"));
  assert.equal(fresh.ok, true);
  assert.equal(fresh.lease.generation, 2, "a re-issue must advance the generation");

  assert.equal(store.beginLaunch(req(PROJECT_A, "k", "a", { token: stale })).reason, "holder_mismatch");
  assert.equal(store.beginLaunch(req(PROJECT_A, "k", "b", { token: stale })).reason, "fencing_token_mismatch");
  assert.equal(store.release(req(PROJECT_A, "k", "b", { token: stale })).reason, "fencing_token_mismatch");
});

test("transitions reject a wrong source state", function () {
  var store = createClaimLeases({ file: tempFile("clay-order-"), ttlMs: 60000 });
  var token = store.acquire(req(PROJECT_A, "k", "a")).lease.token;
  // RUNNING requires a LAUNCHING predecessor; renew requires RUNNING.
  assert.equal(store.confirmRunning(req(PROJECT_A, "k", "a", { token: token })).reason, "invalid_state");
  assert.equal(store.renew(req(PROJECT_A, "k", "a", { token: token })).reason, "invalid_state");
  store.beginLaunch(req(PROJECT_A, "k", "a", { token: token }));
  assert.equal(store.beginLaunch(req(PROJECT_A, "k", "a", { token: token })).reason, "invalid_state");
});

test("only RUNNING is renewable, and renewal extends it", function () {
  var time = clock(1000);
  var store = createClaimLeases({ file: tempFile("clay-renew-"), now: time.now, ttlMs: 1000 });
  var token = toRunning(store, PROJECT_A, "k", "a");
  time.set(1500);
  var renewed = store.renew(req(PROJECT_A, "k", "a", { token: token }));
  assert.equal(renewed.lease.expiresAt, 2500);
  assert.equal(renewed.lease.renewals, 1);
  assert.equal(store.renew(req(PROJECT_A, "k", "b", { token: token })).reason, "holder_mismatch");
});

// --- Identity and adoption -------------------------------------------------------

test("uniqueness is per project, so two projects may hold the same key", function () {
  var store = createClaimLeases({ file: tempFile("clay-scope-"), ttlMs: 60000 });
  assert.equal(store.acquire(req(PROJECT_A, "nightly", "a")).ok, true);
  assert.equal(store.acquire(req(PROJECT_B, "nightly", "b")).ok, true);
  assert.equal(store.list().length, 2);
});

test("a bare project-id string is rejected wherever a ProjectRef is required", function () {
  var file = tempFile("clay-typed-");
  var store = createClaimLeases({ file: file, ttlMs: 60000 });
  assert.equal(store.acquire({ projectRef: PROJECT_A, key: "k", holder: "h" }).reason, "invalid_project_ref");
  assert.equal(store.renew({ projectRef: PROJECT_A, key: "k", holder: "h" }).reason, "invalid_project_ref");
  assert.equal(store.release({ projectRef: PROJECT_A, key: "k", holder: "h" }).reason, "invalid_project_ref");
  assert.equal(store.get(PROJECT_A, "k"), null);
  assert.equal(store.acquire(req(PROJECT_A, "k", "h")).ok, true);
});

test("a provably dead holder's claim is adopted only with evidence of its session", function () {
  var store = createClaimLeases({ file: tempFile("clay-adopt-"), ttlMs: 60000 });
  toRunning(store, PROJECT_A, "k", "dead-process", { holderPid: 9999 });
  function dead(pid) { return pid !== 9999; }

  var adopted = store.resolveOrphan(req(PROJECT_A, "k", "successor"), {
    isHolderAlive: dead, sessionExists: true,
  });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.lease.state, "RUNNING");
  assert.equal(adopted.lease.holder, "successor");
  assert.equal(adopted.lease.generation, 2, "adoption must mint a new generation");
});

test("a dead holder with no session has its claim released, not adopted", function () {
  var store = createClaimLeases({ file: tempFile("clay-orphan-"), ttlMs: 60000 });
  toRunning(store, PROJECT_A, "k", "dead-process", { holderPid: 9999 });
  var freed = store.resolveOrphan(req(PROJECT_A, "k", "successor"), {
    isHolderAlive: function (pid) { return pid !== 9999; }, sessionExists: false,
  });
  assert.equal(freed.released, true);
  assert.equal(store.get({ projectId: PROJECT_A }, "k"), null);
});

test("a live holder's claim is never taken, and an unknown outcome is never guessed", function () {
  var store = createClaimLeases({ file: tempFile("clay-live-"), ttlMs: 60000 });
  toRunning(store, PROJECT_A, "k", "live-process", { holderPid: 9999 });

  assert.equal(store.resolveOrphan(req(PROJECT_A, "k", "successor"), {
    isHolderAlive: function () { return true; }, sessionExists: false,
  }).reason, "held", "a live holder keeps its claim");

  // Dead holder, but we cannot tell whether a session exists: refusing is the
  // only answer that cannot duplicate work.
  assert.equal(store.resolveOrphan(req(PROJECT_A, "k", "successor"), {
    isHolderAlive: function (pid) { return pid !== 9999; },
  }).reason, "ambiguous_intent");
  assert.equal(store.get({ projectId: PROJECT_A }, "k").holder, "live-process");
});

// --- Crash-safe committed epochs --------------------------------------------------

function epochFiles(file) {
  return fs.readdirSync(path.dirname(file))
    .filter(function (n) { return n.indexOf(path.basename(file) + ".") === 0; }).sort();
}

test("a crash before the COMMITTED marker leaves the store readable at the prior epoch", function () {
  var file = tempFile("clay-crash-commit-");
  var store = createClaimLeases({ file: file, ttlMs: 60000 });
  store.acquire(req(PROJECT_A, "good", "a"));

  // Simulate a writer that reserved and wrote an epoch, then died before
  // publishing: data present, marker absent, payload deliberately truncated.
  fs.writeFileSync(storeModule.dataPath(file, 99), "{ partial");

  var recovered = createClaimLeases({ file: file });
  assert.equal(recovered.getLoadError(), null, "an unpublished epoch must be invisible");
  assert.equal(recovered.list().length, 1);
  assert.equal(recovered.list()[0].key, "good");
  // And the store keeps working: the next commit skips the poisoned number.
  assert.equal(recovered.acquire(req(PROJECT_A, "next", "a")).ok, true);
});

test("a reserved-but-unpublished epoch number is never reused", function () {
  var file = tempFile("clay-skip-epoch-");
  var store = createClaimLeases({ file: file, ttlMs: 60000 });
  store.acquire(req(PROJECT_A, "a", "h"));
  fs.writeFileSync(storeModule.dataPath(file, 50), "{ partial");
  assert.equal(store.acquire(req(PROJECT_A, "b", "h")).ok, true);
  // The new commit must be above the abandoned reservation, not colliding.
  var committed = storeModule.scanEpochs(fs, file).committed;
  assert.equal(committed[0] > 50, true);
});

test("a successor that commits before a stale writer resumes is never overwritten", function () {
  var file = tempFile("clay-successor-");
  var victim = createClaimLeases({ file: file, ttlMs: 60000 });
  var successor = createClaimLeases({ file: file, ttlMs: 60000 });
  victim.acquire(req(PROJECT_A, "seed", "h"));

  // Inject the successor's commit exactly between the victim's read and its
  // own publish, by hooking the create the victim writes through.
  var injected = false;
  var racingFs = Object.create(fs);
  racingFs.openSync = function (target, flags, mode) {
    if (!injected && String(flags) === "wx" && String(target).indexOf(file + ".") === 0) {
      injected = true;
      successor.acquire(req(PROJECT_A, "successor-work", "other"));
    }
    return fs.openSync(target, flags, mode);
  };
  var racer = createClaimLeases({ fs: racingFs, file: file, ttlMs: 60000 });
  assert.equal(racer.acquire(req(PROJECT_A, "racer-work", "racer")).ok, true);

  var keys = createClaimLeases({ file: file }).list()
    .map(function (l) { return l.key; }).sort();
  assert.deepEqual(keys, ["racer-work", "seed", "successor-work"],
    "no commit may erase another, however they interleave");
});

test("two stores over one file never re-grant a live claim", function () {
  var file = tempFile("clay-twostore-");
  var first = createClaimLeases({ file: file, ttlMs: 60000 });
  var second = createClaimLeases({ file: file, ttlMs: 60000 });
  assert.equal(first.acquire(req(PROJECT_A, "k", "daemon-a")).ok, true);
  var attempt = second.acquire(req(PROJECT_A, "k", "daemon-b"));
  assert.equal(attempt.ok, false);
  assert.equal(attempt.reason, "held");
});

// --- Durability rollback -----------------------------------------------------------

test("a durability failure denies the claim and leaves nothing visible", function () {
  var file = tempFile("clay-durability-");
  var failingFs = Object.create(fs);
  failingFs.fsyncSync = function (descriptor) {
    if (fs.fstatSync(descriptor).isDirectory()) {
      var error = new Error("simulated"); error.code = "EIO"; throw error;
    }
    return fs.fsyncSync(descriptor);
  };
  var store = createClaimLeases({ fs: failingFs, file: file, ttlMs: 60000 });
  var result = store.acquire(req(PROJECT_A, "k", "h"));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "durability_failed");

  // A denied acquisition must not be observable to anyone.
  assert.equal(createClaimLeases({ file: file }).list().length, 0);
  assert.equal(storeModule.scanEpochs(fs, file).committed.length, 0);
});

test("a filesystem that cannot fsync a directory is tolerated", function () {
  var file = tempFile("clay-durability-ok-");
  var pickyFs = Object.create(fs);
  pickyFs.fsyncSync = function (descriptor) {
    if (fs.fstatSync(descriptor).isDirectory()) {
      var error = new Error("unsupported"); error.code = "EINVAL"; throw error;
    }
    return fs.fsyncSync(descriptor);
  };
  assert.equal(createClaimLeases({ fs: pickyFs, file: file, ttlMs: 60000 })
    .acquire(req(PROJECT_A, "k", "h")).ok, true);
});

test("a failed payload write rolls back and stays invisible", function () {
  var file = tempFile("clay-write-fail-");
  var failingFs = Object.create(fs);
  var fail = false;
  failingFs.writeFileSync = function (target, data, options) {
    if (fail) throw new Error("disk full");
    return fs.writeFileSync(target, data, options);
  };
  var store = createClaimLeases({ fs: failingFs, file: file, ttlMs: 60000 });
  store.acquire(req(PROJECT_A, "kept", "a"));
  fail = true;
  assert.equal(store.acquire(req(PROJECT_A, "new", "b")).reason, "persistence_failed");
  fail = false;
  var onDisk = createClaimLeases({ file: file }).list();
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].key, "kept");
});

// --- Fail-closed loading ------------------------------------------------------------

test("malformed committed state fails closed on every mutation", function () {
  var file = tempFile("clay-corrupt-");
  fs.writeFileSync(storeModule.dataPath(file, 1), "{not json");
  fs.writeFileSync(storeModule.committedPath(file, 1), "");
  var store = createClaimLeases({ file: file });
  assert.equal(store.getLoadError(), "malformed_state");
  assert.equal(store.acquire(req(PROJECT_A, "k", "h")).reason, "malformed_state");
  assert.equal(store.sweep().reason, "malformed_state");
  assert.deepEqual(store.list(), []);
});

test("bad envelopes and duplicate records are all malformed", function () {
  var bad = [
    { schema: "wrong", version: 2, leases: [] },
    { schema: "clay.automation_claim_leases", version: 99, leases: [] },
    { schema: "clay.automation_claim_leases", version: 2, leases: "nope" },
    { schema: "clay.automation_claim_leases", version: 2, leases: [
      { projectId: PROJECT_A, key: "d", state: "RUNNING", generation: 1, token: "t",
        holder: "h", acquiredAt: 1, updatedAt: 1, expiresAt: 9, renewals: 0 },
      { projectId: PROJECT_A, key: "d", state: "RUNNING", generation: 1, token: "t",
        holder: "h", acquiredAt: 1, updatedAt: 1, expiresAt: 9, renewals: 0 },
    ] },
  ];
  for (var i = 0; i < bad.length; i++) {
    var file = tempFile("clay-bad-" + i + "-");
    fs.writeFileSync(storeModule.dataPath(file, 1), JSON.stringify(bad[i]));
    fs.writeFileSync(storeModule.committedPath(file, 1), "");
    assert.equal(createClaimLeases({ file: file }).getLoadError(), "malformed_state",
      "envelope " + i + " must fail closed");
  }
});

test("invalid refs, keys and holders are rejected without writing", function () {
  var file = tempFile("clay-invalid-");
  var store = createClaimLeases({ file: file, ttlMs: 60000 });
  assert.equal(store.acquire(req("nope", "k", "h")).reason, "invalid_project_ref");
  assert.equal(store.acquire(req(PROJECT_A, "  ", "h")).reason, "invalid_claim");
  assert.equal(store.acquire(req(PROJECT_A, "k", "")).reason, "invalid_claim");
  assert.equal(epochFiles(file).length, 0);
});

test("legacy version-1 state loads as RUNNING claims", function () {
  var file = tempFile("clay-legacy-");
  fs.writeFileSync(file, JSON.stringify({
    schema: "clay.automation_claim_leases", version: 1,
    leases: [{ projectId: PROJECT_A, key: "old", holder: "h", acquiredAt: 1, expiresAt: 9e15, renewals: 0 }],
  }));
  var store = createClaimLeases({ file: file });
  assert.equal(store.getLoadError(), null);
  assert.equal(store.list()[0].state, "RUNNING");
  // And the next commit moves it onto the epoch layout.
  assert.equal(store.acquire(req(PROJECT_A, "new", "h")).ok, true);
  assert.equal(storeModule.scanEpochs(fs, file).committed.length, 1);
});

test("sweep removes expired claims but never in-flight ones", function () {
  var time = clock(0);
  var file = tempFile("clay-sweep-");
  var store = createClaimLeases({ file: file, now: time.now, ttlMs: 100 });
  store.acquire(req(PROJECT_A, "short", "a", { ttlMs: 10 }));
  var launching = store.acquire(req(PROJECT_A, "inflight", "b"));
  store.beginLaunch(req(PROJECT_A, "inflight", "b", { token: launching.lease.token }));

  time.set(50);
  assert.deepEqual(store.sweep(), { ok: true, removed: 1 });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].key, "inflight");
});

test("claims survive a restart and still block a different holder", function () {
  var file = tempFile("clay-restart-");
  var store = createClaimLeases({ file: file, ttlMs: 900000 });
  toRunning(store, PROJECT_A, "k", "worker-a");
  var restarted = createClaimLeases({ file: file, ttlMs: 900000 });
  assert.equal(restarted.getLoadError(), null);
  assert.equal(restarted.get({ projectId: PROJECT_A }, "k").state, "RUNNING");
  assert.equal(restarted.acquire(req(PROJECT_A, "k", "worker-b")).reason, "held");
});
