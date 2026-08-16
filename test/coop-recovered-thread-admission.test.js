var test = require("node:test");
var assert = require("node:assert/strict");
var admission = require("../lib/coop-recovered-thread-admission");
var voice = require("../lib/coop-main-ingress-recovery");
var threads = require("../lib/coop-threads-implementation-recovery");
var urbanStayAutoLaunch = require("../lib/coop-urban-stay-autolaunch-recovery");
var urbanStayPolicy = require("../lib/coop-urban-stay-policy-recovery");

test("one failed recovery cannot block later independent migrations", function () {
  var migrations = [voice, threads, urbanStayAutoLaunch, urbanStayPolicy];
  var originals = migrations.map(function (item) {
    return item.migrateProductionFromSessionManager;
  });
  var calls = [];
  voice.migrateProductionFromSessionManager = function () {
    calls.push("voice");
    return { ok: false, code: "recovery_target_conflict" };
  };
  threads.migrateProductionFromSessionManager = function () {
    calls.push("threads");
    return { ok: true, migrationId: "threads" };
  };
  urbanStayAutoLaunch.migrateProductionFromSessionManager = function () {
    calls.push("urbanStayAutoLaunch");
    return { ok: true, migrationId: "urban-stay-406" };
  };
  urbanStayPolicy.migrateProductionFromSessionManager = function () {
    calls.push("urbanStayPolicy");
    return { ok: true, migrationId: "urban-stay-409" };
  };

  try {
    var result = admission.migrateProductionFromSessionManager({}, {}, {});
    assert.deepEqual(calls, ["voice", "threads", "urbanStayAutoLaunch",
      "urbanStayPolicy"]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.voice, {
      ok: false, code: "recovery_target_conflict",
    });
    assert.deepEqual(result.urbanStayAutoLaunch, {
      ok: true, migrationId: "urban-stay-406",
    });
    assert.deepEqual(result.urbanStayPolicy, {
      ok: true, migrationId: "urban-stay-409",
    });
    assert.deepEqual(result.failures, [{
      migration: "voice",
      result: { ok: false, code: "recovery_target_conflict" },
    }]);
  } finally {
    for (var i = 0; i < migrations.length; i++) {
      migrations[i].migrateProductionFromSessionManager = originals[i];
    }
  }
});

test("a thrown migration is reported and isolated from later recoveries", function () {
  var migrations = [voice, threads, urbanStayAutoLaunch, urbanStayPolicy];
  var originals = migrations.map(function (item) {
    return item.migrateProductionFromSessionManager;
  });
  var calls = [];
  voice.migrateProductionFromSessionManager = function () {
    calls.push("voice");
    throw new Error("broken Voice target");
  };
  threads.migrateProductionFromSessionManager = function () {
    calls.push("threads");
    return { ok: true };
  };
  urbanStayAutoLaunch.migrateProductionFromSessionManager = function () {
    calls.push("urbanStayAutoLaunch");
    return { ok: true };
  };
  urbanStayPolicy.migrateProductionFromSessionManager = function () {
    calls.push("urbanStayPolicy");
    return { ok: true };
  };

  try {
    var result = admission.migrateProductionFromSessionManager({}, {}, {});
    assert.deepEqual(calls, ["voice", "threads", "urbanStayAutoLaunch",
      "urbanStayPolicy"]);
    assert.equal(result.ok, false);
    assert.equal(result.voice.code, "recovery_migration_exception");
    assert.equal(result.voice.message, "broken Voice target");
    assert.equal(result.failures.length, 1);
  } finally {
    for (var i = 0; i < migrations.length; i++) {
      migrations[i].migrateProductionFromSessionManager = originals[i];
    }
  }
});
