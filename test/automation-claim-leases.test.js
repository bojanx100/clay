var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var leasesModule = require("../lib/automation-claim-leases");
var createClaimLeases = leasesModule.createClaimLeases;

var PROJECT_A = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
var PROJECT_B = "system-lead";

function tempFile(name) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  return path.join(dir, "automation-claims.json");
}

// Deterministic clock so absolute expiry timestamps are exact in assertions.
function clock(start) {
  var value = start;
  return {
    now: function () { return value; },
    set: function (next) { value = next; },
  };
}

function claim(projectId, key, holder, ttlMs) {
  var input = { projectRef: { projectId: projectId }, key: key, holder: holder };
  if (ttlMs !== undefined) input.ttlMs = ttlMs;
  return input;
}

test("a held claim refuses a second holder and is idempotent for its own holder", function () {
  var file = tempFile("clay-claim-leases-");
  var time = clock(1000);
  var store = createClaimLeases({ file: file, now: time.now, ttlMs: 500 });

  var first = store.acquire(claim(PROJECT_A, "issue-42", "worker-a"));
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.deepEqual(first.lease, {
    projectId: PROJECT_A,
    key: "issue-42",
    holder: "worker-a",
    acquiredAt: 1000,
    expiresAt: 1500,
    renewals: 0,
  });

  // The no-duplicate-claim regression: a different holder must be refused.
  time.set(1200);
  var second = store.acquire(claim(PROJECT_A, "issue-42", "worker-b"));
  assert.equal(second.ok, false);
  assert.equal(second.reason, "held");
  assert.equal(second.lease.holder, "worker-a");

  // Same holder re-acquire is idempotent and must NOT extend the expiry.
  var again = store.acquire(claim(PROJECT_A, "issue-42", "worker-a"));
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.lease.expiresAt, 1500);
  assert.equal(again.lease.acquiredAt, 1000);
  assert.equal(store.get({ projectId: PROJECT_A }, "issue-42").expiresAt, 1500);
});

test("an expired lease is reclaimable and hidden from get and list", function () {
  var file = tempFile("clay-claim-expiry-");
  var time = clock(100);
  var store = createClaimLeases({ file: file, now: time.now, ttlMs: 50 });

  assert.equal(store.acquire(claim(PROJECT_A, "pr-7", "worker-a")).created, true);
  assert.equal(store.list().length, 1);

  // expiresAt is 150, and expiry is inclusive of the boundary.
  time.set(150);
  assert.equal(store.get({ projectId: PROJECT_A }, "pr-7"), null);
  assert.deepEqual(store.list(), []);

  var reclaimed = store.acquire(claim(PROJECT_A, "pr-7", "worker-b"));
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.created, true);
  assert.equal(reclaimed.lease.holder, "worker-b");
  assert.equal(reclaimed.lease.renewals, 0);
  assert.equal(reclaimed.lease.acquiredAt, 150);
  assert.equal(reclaimed.lease.expiresAt, 200);
  assert.equal(store.list().length, 1);
});

test("renew extends the lease for its holder and rejects everyone else", function () {
  var file = tempFile("clay-claim-renew-");
  var time = clock(10);
  var store = createClaimLeases({ file: file, now: time.now, ttlMs: 100 });
  store.acquire(claim(PROJECT_A, "issue-1", "worker-a"));

  time.set(60);
  var renewed = store.renew(claim(PROJECT_A, "issue-1", "worker-a"));
  assert.equal(renewed.ok, true);
  assert.equal(renewed.lease.expiresAt, 160);
  assert.equal(renewed.lease.renewals, 1);
  assert.equal(renewed.lease.acquiredAt, 10);

  // Per-call ttl overrides the store default.
  var overridden = store.renew(claim(PROJECT_A, "issue-1", "worker-a", 400));
  assert.equal(overridden.lease.expiresAt, 460);
  assert.equal(overridden.lease.renewals, 2);

  // A non-positive ttl silently falls back to the store default.
  assert.equal(store.renew(claim(PROJECT_A, "issue-1", "worker-a", -5)).lease.expiresAt, 160);

  assert.deepEqual(store.renew(claim(PROJECT_A, "issue-1", "worker-b")),
    { ok: false, reason: "holder_mismatch" });
  assert.deepEqual(store.renew(claim(PROJECT_A, "issue-unknown", "worker-a")),
    { ok: false, reason: "not_held" });

  time.set(500);
  assert.deepEqual(store.renew(claim(PROJECT_A, "issue-1", "worker-a")),
    { ok: false, reason: "lease_expired" });
});

test("release requires the owning holder and frees the key for re-acquisition", function () {
  var file = tempFile("clay-claim-release-");
  var time = clock(0);
  var store = createClaimLeases({ file: file, now: time.now, ttlMs: 100 });
  store.acquire(claim(PROJECT_A, "issue-9", "worker-a"));

  assert.deepEqual(store.release(claim(PROJECT_A, "issue-9", "worker-b")),
    { ok: false, reason: "holder_mismatch" });
  assert.deepEqual(store.release(claim(PROJECT_A, "issue-none", "worker-a")),
    { ok: false, reason: "not_held" });
  assert.deepEqual(store.release(claim(PROJECT_A, "issue-9", "worker-a")), { ok: true });
  assert.equal(store.get({ projectId: PROJECT_A }, "issue-9"), null);

  var reacquired = store.acquire(claim(PROJECT_A, "issue-9", "worker-b"));
  assert.equal(reacquired.ok, true);
  assert.equal(reacquired.created, true);

  // An expired lease is still releasable by its own holder.
  time.set(1000);
  assert.deepEqual(store.release(claim(PROJECT_A, "issue-9", "worker-b")), { ok: true });
  assert.deepEqual(store.list(), []);
});

test("uniqueness is per project so two projects may hold the same key", function () {
  var file = tempFile("clay-claim-scope-");
  var store = createClaimLeases({ file: file, now: function () { return 1; }, ttlMs: 1000 });

  assert.equal(store.acquire(claim(PROJECT_A, "nightly-pass", "worker-a")).created, true);
  var other = store.acquire(claim(PROJECT_B, "nightly-pass", "worker-b"));
  assert.equal(other.ok, true);
  assert.equal(other.created, true);
  assert.equal(store.list().length, 2);
  assert.equal(store.get({ projectId: PROJECT_A }, "nightly-pass").holder, "worker-a");
  assert.equal(store.get({ projectId: PROJECT_B }, "nightly-pass").holder, "worker-b");
});

test("leases survive a restart and keep blocking a different holder", function () {
  var file = tempFile("clay-claim-restart-");
  var time = clock(5000);
  var store = createClaimLeases({ file: file, now: time.now, ttlMs: 900000 });
  var acquired = store.acquire(claim(PROJECT_A, "issue-77", "worker-a"));
  assert.equal(acquired.ok, true);

  // A fresh store over the same file stands in for a daemon restart.
  var restarted = createClaimLeases({ file: file, now: time.now, ttlMs: 900000 });
  assert.equal(restarted.getLoadError(), null);
  assert.deepEqual(restarted.get({ projectId: PROJECT_A }, "issue-77"), acquired.lease);
  var blocked = restarted.acquire(claim(PROJECT_A, "issue-77", "worker-b"));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "held");
  assert.equal(blocked.lease.holder, "worker-a");
  assert.equal(restarted.acquire(claim(PROJECT_A, "issue-77", "worker-a")).created, false);

  // Absolute expiry means the restarted store still lets it lapse on time.
  time.set(5000 + 900000);
  assert.equal(restarted.get({ projectId: PROJECT_A }, "issue-77"), null);
  assert.equal(restarted.acquire(claim(PROJECT_A, "issue-77", "worker-b")).created, true);
});

test("sweep removes only expired leases and reports the count", function () {
  var file = tempFile("clay-claim-sweep-");
  var time = clock(0);
  var store = createClaimLeases({ file: file, now: time.now, ttlMs: 100 });
  store.acquire(claim(PROJECT_A, "short-a", "worker-a", 10));
  store.acquire(claim(PROJECT_A, "short-b", "worker-b", 20));
  store.acquire(claim(PROJECT_A, "long", "worker-c", 5000));

  assert.deepEqual(store.sweep(), { ok: true, removed: 0 });
  time.set(50);
  assert.deepEqual(store.sweep(), { ok: true, removed: 2 });
  assert.deepEqual(store.sweep(), { ok: true, removed: 0 });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].key, "long");

  var persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(persisted.schema, "clay.automation_claim_leases");
  assert.equal(persisted.version, 1);
  assert.equal(persisted.leases.length, 1);
});

test("invalid project refs, keys and holders are rejected", function () {
  var file = tempFile("clay-claim-invalid-");
  var store = createClaimLeases({ file: file, now: function () { return 1; } });

  assert.deepEqual(store.acquire({ key: "k", holder: "h" }),
    { ok: false, reason: "invalid_project_ref" });
  assert.deepEqual(store.acquire(claim("not-a-project-id", "k", "h")),
    { ok: false, reason: "invalid_project_ref" });
  assert.deepEqual(store.acquire(claim(PROJECT_A, "   ", "h")),
    { ok: false, reason: "invalid_claim" });
  assert.deepEqual(store.acquire(claim(PROJECT_A, "k", "")),
    { ok: false, reason: "invalid_claim" });
  assert.deepEqual(store.acquire(claim(PROJECT_A, "k".repeat(257), "h")),
    { ok: false, reason: "invalid_claim" });
  assert.deepEqual(store.renew(claim(PROJECT_A, "k", 5)), { ok: false, reason: "invalid_claim" });
  assert.deepEqual(store.release(claim("bad", "k", "h")),
    { ok: false, reason: "invalid_project_ref" });
  assert.equal(store.get("bad", "k"), null);
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(file), false);
});

// The cutover invariant is that project work is addressed through an explicit
// typed ProjectRef. A bare project-id string is a valid id but an untyped
// reference, and accepting it is exactly how an unverified identifier reaches
// a path whose whole job is to prove which project it is acting for.
test("a bare project-id string is rejected everywhere a ProjectRef is required", function () {
  var file = tempFile("clay-claim-typed-");
  var time = clock(1000);
  var store = createClaimLeases({ file: file, now: time.now, ttlMs: 500 });

  function bare(key, holder) {
    return { projectRef: PROJECT_A, key: key, holder: holder };
  }

  assert.deepEqual(store.acquire(bare("issue-1", "worker-a")),
    { ok: false, reason: "invalid_project_ref" });
  assert.deepEqual(store.renew(bare("issue-1", "worker-a")),
    { ok: false, reason: "invalid_project_ref" });
  assert.deepEqual(store.release(bare("issue-1", "worker-a")),
    { ok: false, reason: "invalid_project_ref" });
  assert.equal(store.get(PROJECT_A, "issue-1"), null);

  // Nothing was written, and the typed form still works on the same store.
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.acquire(claim(PROJECT_A, "issue-1", "worker-a")).ok, true);
  assert.equal(store.get({ projectId: PROJECT_A }, "issue-1").holder, "worker-a");
});

test("malformed claim state fails closed without overwriting it", function () {
  var file = tempFile("clay-claim-corrupt-");
  fs.writeFileSync(file, "{not-json");
  var store = createClaimLeases({ file: file, now: function () { return 1; } });

  assert.equal(store.getLoadError(), "malformed_state");
  assert.deepEqual(store.acquire(claim(PROJECT_A, "k", "h")),
    { ok: false, reason: "malformed_state" });
  assert.deepEqual(store.renew(claim(PROJECT_A, "k", "h")),
    { ok: false, reason: "malformed_state" });
  assert.deepEqual(store.release(claim(PROJECT_A, "k", "h")),
    { ok: false, reason: "malformed_state" });
  assert.deepEqual(store.sweep(), { ok: false, reason: "malformed_state" });
  assert.equal(store.get({ projectId: PROJECT_A }, "k"), null);
  assert.equal(fs.readFileSync(file, "utf8"), "{not-json");
});

test("bad envelopes and duplicate claim records are all treated as malformed", function () {
  var cases = [
    { schema: "clay.other", version: 1, leases: [] },
    { schema: "clay.automation_claim_leases", version: 2, leases: [] },
    { schema: "clay.automation_claim_leases", version: 1, leases: {} },
    {
      schema: "clay.automation_claim_leases",
      version: 1,
      leases: [{ projectId: PROJECT_A, key: "k", holder: "h", acquiredAt: 1 }],
    },
    {
      schema: "clay.automation_claim_leases",
      version: 1,
      leases: [
        { projectId: PROJECT_A, key: "k", holder: "h", acquiredAt: 1, expiresAt: 2, renewals: 0 },
        { projectId: PROJECT_A, key: "k", holder: "other", acquiredAt: 1, expiresAt: 9, renewals: 0 },
      ],
    },
  ];
  for (var i = 0; i < cases.length; i++) {
    var file = tempFile("clay-claim-envelope-");
    fs.writeFileSync(file, JSON.stringify(cases[i]));
    var store = createClaimLeases({ file: file, now: function () { return 1; } });
    assert.equal(store.getLoadError(), "malformed_state", "case " + i);
    assert.deepEqual(store.acquire(claim(PROJECT_A, "k", "h")),
      { ok: false, reason: "malformed_state" }, "case " + i);
  }
});

test("a failed write rolls back the in-memory claim state", function () {
  var file = tempFile("clay-claim-write-fail-");
  var time = clock(0);
  var failing = Object.create(fs);
  var fail = false;
  failing.renameSync = function (from, to) {
    if (fail) throw new Error("disk full");
    return fs.renameSync(from, to);
  };
  var store = createClaimLeases({ fs: failing, file: file, now: time.now, ttlMs: 100 });
  store.acquire(claim(PROJECT_A, "kept", "worker-a"));

  fail = true;
  assert.deepEqual(store.acquire(claim(PROJECT_A, "new-key", "worker-b")),
    { ok: false, reason: "persistence_failed" });
  assert.deepEqual(store.renew(claim(PROJECT_A, "kept", "worker-a")),
    { ok: false, reason: "persistence_failed" });
  assert.deepEqual(store.release(claim(PROJECT_A, "kept", "worker-a")),
    { ok: false, reason: "persistence_failed" });

  // Nothing changed: the surviving lease is exactly the one on disk.
  fail = false;
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.get({ projectId: PROJECT_A }, "kept"), {
    projectId: PROJECT_A,
    key: "kept",
    holder: "worker-a",
    acquiredAt: 0,
    expiresAt: 100,
    renewals: 0,
  });
  assert.deepEqual(createClaimLeases({ file: file, now: time.now }).list(), store.list());
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["automation-claims.json"]);
});

test("store defaults expose the shared claim file and ttl", function () {
  assert.equal(leasesModule.DEFAULT_TTL_MS, 900000);
  assert.equal(path.basename(leasesModule.defaultFile()), "automation-claims.json");
  assert.equal(path.basename(path.dirname(leasesModule.defaultFile())), "lead");

  var file = tempFile("clay-claim-default-ttl-");
  var store = createClaimLeases({ file: file, now: function () { return 0; } });
  assert.equal(store.file, file);
  assert.equal(store.acquire(claim(PROJECT_A, "k", "h")).lease.expiresAt, 900000);
});
