var test = require("node:test");
var assert = require("node:assert/strict");

var provenance = require("../lib/coop-control-provenance");

test("deriveControlledBy uses the canonical Coop session for home and channel coordinators", function () {
  assert.deepEqual(provenance.deriveControlledBy({
    storageId: "coop-home",
    coopHome: true,
  }, 123), {
    coopSessionStorageId: "coop-home",
    since: 123,
  });
  assert.deepEqual(provenance.deriveControlledBy({
    storageId: "coop-webapp",
    coopChannel: { projectSlug: "webapp" },
  }, 456), {
    coopSessionStorageId: "coop-webapp",
    since: 456,
  });
});

test("deriveControlledBy propagates an existing canonical Coop session id", function () {
  assert.deepEqual(provenance.deriveControlledBy({
    storageId: "child-coordinator",
    coopControlledBy: {
      coopSessionStorageId: "coop-home",
      since: 1,
    },
  }, 789), {
    coopSessionStorageId: "coop-home",
    since: 789,
  });
  assert.equal(provenance.deriveControlledBy({ storageId: "ordinary" }, 789), null);
});

test("isCoopControlled only reflects the explicit persisted descendant flag", function () {
  assert.equal(provenance.isCoopControlled({
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  }), true);
  assert.equal(provenance.isCoopControlled({ coopHome: true, storageId: "coop-home" }), false);
  assert.equal(provenance.isCoopControlled({ coopChannel: { projectSlug: "webapp" } }), false);
});

test("shouldSuppressOwnerNotification only suppresses controlled descendants while lead mode is on", function () {
  var usersOn = {
    getLeadMode: function () { return true; },
  };
  var usersOff = {
    getLeadMode: function () { return false; },
  };
  var controlled = {
    ownerId: "owner-1",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  };
  assert.equal(provenance.shouldSuppressOwnerNotification(controlled, usersOn), true);
  assert.equal(provenance.shouldSuppressOwnerNotification(controlled, usersOff), false);
  assert.equal(provenance.shouldSuppressOwnerNotification({
    ownerId: "owner-1",
    coopHome: true,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  }, usersOn), false);
  assert.equal(provenance.shouldSuppressOwnerNotification({
    ownerId: "owner-1",
  }, usersOn), false);
});

test("resolveSessionOwnerId prefers an explicit session.ownerId", function () {
  var users = { getAllUsers: function () { return [{ id: "a" }, { id: "b" }]; } };
  assert.equal(provenance.resolveSessionOwnerId({ ownerId: "owner-x" }, users), "owner-x");
});

test("resolveSessionOwnerId falls back to the sole registered user (single-admin reality)", function () {
  // sessions.js's ensureCoopHomeSession creates the Coop home with no
  // ownerId (proven against the real creation path in
  // test/coop-controlled-by-persistence.test.js), so single-admin Lead-mode
  // suppression depends entirely on this fallback resolving correctly.
  var users = { getAllUsers: function () { return [{ id: "solo-admin" }]; } };
  assert.equal(provenance.resolveSessionOwnerId({ ownerId: null }, users), "solo-admin");
  assert.equal(provenance.resolveSessionOwnerId({}, users), "solo-admin");
});

test("resolveSessionOwnerId refuses to guess across multiple users with no explicit ownerId", function () {
  var users = { getAllUsers: function () { return [{ id: "a" }, { id: "b" }]; } };
  assert.equal(provenance.resolveSessionOwnerId({ ownerId: null }, users), null);
  assert.equal(provenance.resolveSessionOwnerId({}, users), null);
});

test("resolveSessionOwnerId returns null when usersModule cannot enumerate users", function () {
  assert.equal(provenance.resolveSessionOwnerId({}, null), null);
  assert.equal(provenance.resolveSessionOwnerId({}, {}), null);
  var throwing = { getAllUsers: function () { throw new Error("boom"); } };
  assert.equal(provenance.resolveSessionOwnerId({}, throwing), null);
});

test("shouldSuppressOwnerNotification suppresses a single-admin controlled worker with no ownerId stamped", function () {
  var users = {
    getAllUsers: function () { return [{ id: "solo-admin" }]; },
    getLeadMode: function (id) { return id === "solo-admin"; },
  };
  var worker = {
    ownerId: null,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  };
  assert.equal(provenance.shouldSuppressOwnerNotification(worker, users), true);
});

test("shouldSuppressOwnerNotification never guesses the wrong owner in true multi-user installs", function () {
  var users = {
    getAllUsers: function () { return [{ id: "owner-a" }, { id: "owner-b" }]; },
    getLeadMode: function (id) { return id === "owner-a"; },
  };
  // Worker with no explicit ownerId and 2+ registered users: ambiguous, must
  // NOT suppress (favors the safe default of notifying, never silently
  // suppressing for a possibly-wrong owner).
  var ambiguousWorker = {
    ownerId: null,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  };
  assert.equal(provenance.shouldSuppressOwnerNotification(ambiguousWorker, users), false);

  // Explicit ownerId isolates correctly per-owner.
  var ownerAWorker = {
    ownerId: "owner-a",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  };
  var ownerBWorker = {
    ownerId: "owner-b",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  };
  assert.equal(provenance.shouldSuppressOwnerNotification(ownerAWorker, users), true);
  assert.equal(provenance.shouldSuppressOwnerNotification(ownerBWorker, users), false);
});

test("shouldSuppressOwnerNotification is unaffected by Lead mode for a direct session (never coopControlledBy)", function () {
  var users = {
    getAllUsers: function () { return [{ id: "solo-admin" }]; },
    getLeadMode: function () { return true; },
  };
  var directSession = { ownerId: null };
  assert.equal(provenance.shouldSuppressOwnerNotification(directSession, users), false);
});

test("shouldSuppressOwnerNotification exempts the canonical Coop session even with no ownerId and lead on", function () {
  var users = {
    getAllUsers: function () { return [{ id: "solo-admin" }]; },
    getLeadMode: function () { return true; },
  };
  var coopHome = {
    ownerId: null,
    coopHome: true,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
  };
  assert.equal(provenance.shouldSuppressOwnerNotification(coopHome, users), false);
});

test("normalizeControlledBy validates shape strictly", function () {
  assert.equal(provenance.normalizeControlledBy(null), null);
  assert.equal(provenance.normalizeControlledBy("coop-home"), null);
  assert.equal(provenance.normalizeControlledBy({ coopSessionStorageId: "" , since: 1 }), null);
  assert.equal(provenance.normalizeControlledBy({ coopSessionStorageId: "coop-home" }), null);
  assert.equal(provenance.normalizeControlledBy({ coopSessionStorageId: "coop-home", since: "x" }), null);
  assert.deepEqual(
    provenance.normalizeControlledBy({ coopSessionStorageId: "coop-home", since: 5, extra: "drop-me" }),
    { coopSessionStorageId: "coop-home", since: 5 }
  );
});
