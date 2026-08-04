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
