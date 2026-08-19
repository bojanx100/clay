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
      code: "recovery_target_conflict",
      terminal: false,
      result: { ok: false, code: "recovery_target_conflict" },
    }]);
    assert.equal(result.noop, false, "a failed migration is never reported as a no-op");
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
    assert.equal(result.failures[0].terminal, false,
      "an exception may still succeed on a later restart");
    assert.equal(result.migrations[0].message, "broken Voice target");
  } finally {
    for (var i = 0; i < migrations.length; i++) {
      migrations[i].migrateProductionFromSessionManager = originals[i];
    }
  }
});

function withStubs(results, assertions) {
  var migrations = [voice, threads, urbanStayAutoLaunch, urbanStayPolicy];
  var keys = ["voice", "threads", "urbanStayAutoLaunch", "urbanStayPolicy"];
  var originals = migrations.map(function (item) {
    return item.migrateProductionFromSessionManager;
  });
  keys.forEach(function (key, position) {
    migrations[position].migrateProductionFromSessionManager = function () {
      return results[key];
    };
  });
  try {
    assertions(admission.migrateProductionFromSessionManager({}, {}, {}));
  } finally {
    for (var i = 0; i < migrations.length; i++) {
      migrations[i].migrateProductionFromSessionManager = originals[i];
    }
  }
}

// Retirement grade: a finished family reports itself, so "has this migration completed?"
// is answerable from the result alone instead of only from the absence of failures.
test("every completed migration reports an explicit no-op success entry", function () {
  withStubs({
    voice: { ok: true, migrationId: "voice-id", noop: true, moved: 0, created: false,
      decisionBackfilled: false, threadRef: { threadId: "voice-thread" } },
    threads: { ok: true, migrationId: "threads-id", noop: true,
      decisionBackfilled: false, threadRef: { threadId: "threads-thread" } },
    urbanStayAutoLaunch: { ok: true, migrationId: "autolaunch-id", noop: true,
      threadCreated: false, membershipAdded: false, decisionBackfilled: false },
    urbanStayPolicy: { ok: true, migrationId: "policy-id", noop: true,
      threadCreated: false, membershipAdded: false, decisionBackfilled: false },
  }, function (result) {
    assert.equal(result.ok, true);
    assert.equal(result.noop, true);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.migrations.map(function (entry) { return entry.key; }),
      ["voice", "threads", "urbanStayAutoLaunch", "urbanStayPolicy"]);
    assert.deepEqual(result.migrations[0], {
      key: "voice", ok: true, noop: true, terminal: false, code: null, message: null,
      migrationId: "voice-id", decisionBackfilled: false, threadCreated: null,
      membershipAdded: null, created: false, moved: 0,
    });
    assert.deepEqual(result.migrations[1], {
      key: "threads", ok: true, noop: true, terminal: false, code: null, message: null,
      migrationId: "threads-id", decisionBackfilled: false, threadCreated: null,
      membershipAdded: null, created: null, moved: null,
    });
    assert.deepEqual(result.migrations[3], {
      key: "urbanStayPolicy", ok: true, noop: true, terminal: false, code: null,
      message: null, migrationId: "policy-id", decisionBackfilled: false,
      threadCreated: false, membershipAdded: false, created: null, moved: null,
    });
  });
});

test("a migration that wrote something is a success but never a no-op", function () {
  withStubs({
    voice: { ok: true, migrationId: "voice-id", noop: true, moved: 0, created: false,
      decisionBackfilled: false },
    threads: { ok: true, migrationId: "threads-id", noop: false, decisionBackfilled: true },
    urbanStayAutoLaunch: { ok: true, migrationId: "autolaunch-id", noop: false,
      threadCreated: true, membershipAdded: true, decisionBackfilled: true },
    urbanStayPolicy: { ok: true, migrationId: "policy-id", noop: true,
      threadCreated: false, membershipAdded: false, decisionBackfilled: false },
  }, function (result) {
    assert.equal(result.ok, true);
    assert.equal(result.noop, false, "one write makes the whole startup run non-noop");
    assert.deepEqual(result.migrations.map(function (entry) { return entry.noop; }),
      [true, false, false, true]);
    assert.equal(result.migrations[2].threadCreated, true);
    assert.equal(result.migrations[2].membershipAdded, true);
  });
});

test("a module that omits noop is classified from its own change flags", function () {
  withStubs({
    voice: { ok: true, moved: 2, created: true, decisionBackfilled: false },
    threads: { ok: true, decisionBackfilled: false },
    urbanStayAutoLaunch: { ok: true, threadCreated: false, membershipAdded: false,
      decisionBackfilled: false },
    urbanStayPolicy: { ok: true, threadCreated: false, membershipAdded: true,
      decisionBackfilled: false },
  }, function (result) {
    assert.deepEqual(result.migrations.map(function (entry) { return entry.noop; }),
      [false, true, true, false]);
    assert.equal(result.noop, false);
  });
});

// Terminal failures prove the immutable canonical evidence no longer matches, so they
// can never self-heal. Everything else is retryable on a later restart.
test("failure codes are classified as terminal or retryable", function () {
  withStubs({
    voice: { ok: false, code: "recovery_event_digest_mismatch" },
    threads: { ok: false, code: "threads_recovery_event_identity_mismatch" },
    urbanStayAutoLaunch: { ok: false, code: "urban_stay_recovery_event_ambiguous" },
    urbanStayPolicy: { ok: false, code: "urban_stay_policy_recovery_event_route_mismatch" },
  }, function (result) {
    assert.equal(result.ok, false);
    assert.deepEqual(result.migrations.map(function (entry) { return entry.terminal; }),
      [true, true, true, true]);
    assert.deepEqual(result.failures.map(function (item) { return item.terminal; }),
      [true, true, true, true]);
  });

  // A pinned eventIndex that no longer exists is terminal, not retryable. Delta
  // coalescing renumbered the canonical transcript and put all four pinned
  // coordinates past its end; a coordinate that is gone cannot come back, so
  // retrying on every boot forever only hides the real state.
  withStubs({
    voice: { ok: false, code: "recovery_canonical_event_missing" },
    threads: { ok: false, code: "threads_recovery_event_missing" },
    urbanStayAutoLaunch: { ok: false, code: "urban_stay_recovery_event_missing" },
    urbanStayPolicy: { ok: false, code: "urban_stay_policy_recovery_event_missing" },
  }, function (result) {
    assert.equal(result.ok, false);
    assert.deepEqual(result.migrations.map(function (entry) { return entry.terminal; }),
      [true, true, true, true]);
  });

  // The causes that genuinely do succeed on a later run stay retryable. These
  // used to share the _event_missing code, which is why it could not be marked
  // terminal and why this family was expensive to diagnose.
  withStubs({
    voice: { ok: false, code: "recovery_canonical_session_unavailable" },
    threads: { ok: false, code: "threads_recovery_session_unavailable" },
    urbanStayAutoLaunch: { ok: false, code: "urban_stay_recovery_session_unavailable" },
    urbanStayPolicy: { ok: false, code: "urban_stay_policy_recovery_session_unavailable" },
  }, function (result) {
    assert.equal(result.ok, false);
    assert.deepEqual(result.migrations.map(function (entry) { return entry.terminal; }),
      [false, false, false, false]);
  });

  withStubs({
    voice: { ok: false, code: "recovery_dependencies_unavailable" },
    threads: { ok: false, code: "threads_recovery_persistence_failed" },
    urbanStayAutoLaunch: { ok: false, code: "urban_stay_recovery_session_mismatch" },
    urbanStayPolicy: { ok: false, code: "urban_stay_policy_recovery_session_ambiguous" },
  }, function (result) {
    assert.equal(result.ok, false);
    assert.deepEqual(result.migrations.map(function (entry) { return entry.terminal; }),
      [false, false, false, false]);
  });

  withStubs({
    voice: { ok: false, code: "recovery_event_topic_mismatch" },
    threads: null,
    urbanStayAutoLaunch: { ok: true, noop: true, decisionBackfilled: false },
    urbanStayPolicy: { ok: true, noop: true, decisionBackfilled: false },
  }, function (result) {
    assert.equal(result.migrations[0].terminal, true);
    assert.deepEqual(result.migrations[1], {
      key: "threads", ok: false, noop: false, terminal: false,
      code: "recovery_migration_result_missing", message: null, migrationId: null,
      decisionBackfilled: null, threadCreated: null, membershipAdded: null,
      created: null, moved: null,
    });
    assert.equal(result.failures.length, 2);
  });
});
