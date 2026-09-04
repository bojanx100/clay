// Tests for the automation concurrency limiter: how much automatic work is in
// flight, and how many slots are free.
//
// The defect these pin down: `recipe.launch.defaultLimit` bounds sessions PER
// TICK, not sessions ACTIVE, so repeated ticks accumulate unbounded concurrency.
// The properties asserted here are (a) both in-flight populations occupy slots,
// (b) a finished worker frees exactly one slot so the next item backfills, and
// (c) every unknown counts as in flight, never as free capacity.
var test = require("node:test");
var assert = require("node:assert");

var { createConcurrencyLimiter } = require("../lib/project-automation-concurrency");
var { portfolioTaskIdFor } = require("../lib/project-automation-identity");

// A session manager shaped like the real one: sessions is a Map with forEach.
function sessionManager(sessions) {
  var map = new Map();
  for (var i = 0; i < sessions.length; i++) {
    map.set(String(i), sessions[i]);
  }
  return { sessions: map };
}

function autoSession(itemKey, overrides) {
  return Object.assign({
    storageId: "s-" + itemKey,
    taskLauncher: Object.assign({
      autoLaunch: true,
      workflowCompleted: false,
      automationClaimKey: itemKey,
    }, (overrides || {}).taskLauncher || {}),
  }, overrides || {});
}

// A candidate store stub exposing only what the limiter reads.
function candidateStore(admitted, behavior) {
  return {
    pending: function (filter) {
      assert.deepStrictEqual(filter, { statuses: ["admitted"] },
        "the limiter must ask only for admitted candidates");
      if (behavior && behavior.throws) throw new Error("corrupt");
      if (behavior && behavior.fail) return { ok: false, reason: behavior.fail, candidates: [] };
      if (behavior && behavior.malformed) return { ok: true, candidates: null };
      return { ok: true, candidates: admitted };
    },
  };
}

function admittedCandidate(itemKey, taskId) {
  return {
    candidateKey: "launch:" + itemKey,
    itemKey: itemKey,
    status: "admitted",
    binding: { portfolioTaskId: taskId || ("task-" + itemKey), bindingRevision: 1 },
  };
}

// A binding reader over a mutable status table, so a test can complete a worker
// mid-test and re-read the slots.
function bindingReader(statuses, behavior) {
  return function (portfolioTaskId, bindingRevision) {
    if (behavior && behavior.throws) throw new Error("binding store down");
    assert.strictEqual(bindingRevision, 1);
    if (!Object.prototype.hasOwnProperty.call(statuses, portfolioTaskId)) return null;
    var status = statuses[portfolioTaskId];
    return status === null ? null : { portfolioTaskId: portfolioTaskId, status: status };
  };
}

function limiter(options) {
  var opts = options || {};
  return createConcurrencyLimiter({
    sm: opts.sm === undefined ? sessionManager([]) : opts.sm,
    candidates: opts.candidates,
    getBinding: opts.getBinding,
    getBindings: opts.getBindings,
    getLimit: opts.getLimit === undefined ? function () { return 3; } : opts.getLimit,
    now: function () { return 1700000000000; },
  });
}

// --- Live legacy sessions occupy slots ----------------------------------------

test("concurrency: only live auto-launched sessions count", function () {
  var sm = sessionManager([
    autoSession("org/repo#1"),
    autoSession("org/repo#2"),
    // Manual session: a human started it, automation must not own its capacity.
    { storageId: "manual", taskLauncher: { autoLaunch: false, itemKey: "org/repo#3" } },
    // No launcher at all.
    { storageId: "plain" },
  ]);
  var result = limiter({ sm: sm }).inFlight();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.count, 2);
  assert.deepStrictEqual(result.items.sort(), ["org/repo#1", "org/repo#2"]);
});

test("concurrency: hidden and workflow-completed sessions free their slots", function () {
  var sm = sessionManager([
    autoSession("org/repo#1"),
    autoSession("org/repo#2", { hidden: true }),
    autoSession("org/repo#3", { taskLauncher: { workflowCompleted: true } }),
  ]);
  var slots = limiter({ sm: sm, getLimit: function () { return 3; } }).slots();
  assert.strictEqual(slots.ok, true);
  assert.strictEqual(slots.inFlight, 1, "a finished or hidden session is not capacity");
  assert.strictEqual(slots.available, 2);
});

test("concurrency: a live auto session with no item key still occupies a slot", function () {
  // Unattributable, so it cannot dedupe — but it is real running work and must
  // never be invisible to the limit.
  var sm = sessionManager([
    { storageId: "ghost", taskLauncher: { autoLaunch: true } },
  ]);
  var result = limiter({ sm: sm }).inFlight();
  assert.strictEqual(result.count, 1);
  assert.deepStrictEqual(result.items, ["session:ghost"]);
});

test("concurrency: a missing or unusable session manager is simply zero sessions", function () {
  var shapes = [null, {}, { sessions: null }, { sessions: {} }];
  for (var i = 0; i < shapes.length; i++) {
    var result = limiter({ sm: shapes[i] }).inFlight();
    assert.strictEqual(result.ok, true, "shape " + i);
    assert.strictEqual(result.count, 0, "shape " + i);
  }
});

test("concurrency: a throwing session scan fails closed", function () {
  var sm = { sessions: { forEach: function () { throw new Error("boom"); } } };
  var result = limiter({ sm: sm }).inFlight();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "session_scan_failed");
  assert.strictEqual(limiter({ sm: sm }).slots().available, 0);
});

// --- Admitted candidates occupy slots -----------------------------------------

test("concurrency: admitted candidates with active bindings occupy slots", function () {
  var statuses = { "task-a": "active", "task-b": "pending" };
  var l = limiter({
    candidates: candidateStore([admittedCandidate("a", "task-a"), admittedCandidate("b", "task-b")]),
    getBinding: bindingReader(statuses),
    getLimit: function () { return 4; },
  });
  var slots = l.slots();
  assert.strictEqual(slots.ok, true);
  assert.strictEqual(slots.inFlight, 2, "active and pending bindings are both running work");
  assert.strictEqual(slots.available, 2);
});

test("concurrency: both populations count together", function () {
  var l = limiter({
    sm: sessionManager([autoSession("legacy#1")]),
    candidates: candidateStore([admittedCandidate("a", "task-a")]),
    getBinding: bindingReader({ "task-a": "active" }),
    getLimit: function () { return 5; },
  });
  var slots = l.slots();
  assert.strictEqual(slots.inFlight, 2,
    "counting only one population would make the limit meaningless during cutover");
  assert.strictEqual(slots.available, 3);
});

test("concurrency: legacy admitted records without receipts or bindings do not leak capacity", function () {
  // These records predate typed candidate receipts and typed bindings. A real
  // legacy worker is counted directly from the session manager, so treating a
  // record with neither proof as running forever prevents later qualified
  // candidates from ever reaching Coop admission.
  var legacy = {
    candidateKey: "launch:trialview/v2#2522",
    itemKey: "trialview/v2#2522",
    status: "admitted",
    projectRef: { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" },
    policyDigest: "legacy-policy-digest",
    recipeId: "assigned-to-me",
    intent: { recipeId: "assigned-to-me", autoKind: "issue" },
  };
  var l = limiter({
    sm: sessionManager([autoSession("trialview/v2#2725")]),
    candidates: candidateStore([legacy, admittedCandidate("trialview/v2#2726", "task-2726")]),
    getBinding: bindingReader({ "task-2726": "active" }),
    getBindings: function () { return []; },
    getLimit: function () { return 3; },
  });
  var slots = l.slots();
  assert.strictEqual(slots.ok, true);
  assert.strictEqual(slots.inFlight, 2,
    "only the actual legacy session and the live typed binding consume capacity");
  assert.deepStrictEqual(slots.items.sort(), ["trialview/v2#2725", "trialview/v2#2726"]);
  assert.strictEqual(slots.available, 1,
    "the next qualified candidate can be admitted through the normal queue");
});

test("concurrency: a legacy unbound record stays capacity-bearing without a complete binding snapshot", function () {
  var legacy = {
    candidateKey: "launch:trialview/v2#2522",
    itemKey: "trialview/v2#2522",
    status: "admitted",
    projectRef: { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" },
    policyDigest: "legacy-policy-digest",
    recipeId: "assigned-to-me",
    intent: { recipeId: "assigned-to-me", autoKind: "issue" },
  };
  var l = limiter({
    candidates: candidateStore([legacy]),
    getLimit: function () { return 1; },
  });
  assert.strictEqual(l.inFlight().count, 1,
    "without the authoritative binding snapshot, an old record remains unknown");
  assert.strictEqual(l.slots().available, 0);
});

test("concurrency: a matching active binding keeps a legacy unbound record capacity-bearing", function () {
  var legacy = {
    candidateKey: "launch:trialview/v2#2522",
    itemKey: "trialview/v2#2522",
    status: "admitted",
    projectRef: { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" },
    policyDigest: "legacy-policy-digest",
    recipeId: "assigned-to-me",
    intent: { recipeId: "assigned-to-me", autoKind: "issue" },
  };
  var l = limiter({
    candidates: candidateStore([legacy]),
    getBindings: function () {
      return [{
        portfolioTaskId: portfolioTaskIdFor(legacy),
        bindingRevision: 1,
        status: "active",
        targetProject: legacy.projectRef,
      }];
    },
    getLimit: function () { return 1; },
  });
  assert.strictEqual(l.inFlight().count, 1,
    "a crash before pointer persistence cannot make a committed worker invisible");
  assert.strictEqual(l.slots().available, 0);
});

test("concurrency: a malformed canonical binding snapshot stays fail-closed", function () {
  var legacy = {
    candidateKey: "launch:trialview/v2#2522",
    itemKey: "trialview/v2#2522",
    status: "admitted",
    projectRef: { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" },
    policyDigest: "legacy-policy-digest",
    recipeId: "assigned-to-me",
    intent: { recipeId: "assigned-to-me", autoKind: "issue" },
  };
  var l = limiter({
    candidates: candidateStore([legacy]),
    getBindings: function () {
      return [{
        portfolioTaskId: portfolioTaskIdFor(legacy),
        bindingRevision: 1,
        status: "active",
      }];
    },
    getLimit: function () { return 1; },
  });
  assert.strictEqual(l.inFlight().count, 1,
    "an incomplete snapshot cannot prove a record has no committed worker");
  assert.strictEqual(l.slots().available, 0);
});

// --- The backfill property ------------------------------------------------------

test("concurrency: a completed binding frees exactly one slot and lets work backfill", function () {
  var statuses = { "task-a": "active", "task-b": "active", "task-c": "active" };
  var l = limiter({
    candidates: candidateStore([
      admittedCandidate("a", "task-a"),
      admittedCandidate("b", "task-b"),
      admittedCandidate("c", "task-c"),
    ]),
    getBinding: bindingReader(statuses),
    getLimit: function () { return 3; },
  });

  var full = l.slots();
  assert.strictEqual(full.inFlight, 3);
  assert.strictEqual(full.available, 0, "at the limit nothing new may start");

  // A worker finishes.
  statuses["task-b"] = "completed";
  var afterOne = l.slots();
  assert.strictEqual(afterOne.inFlight, 2);
  assert.strictEqual(afterOne.available, 1,
    "a finished worker must free exactly one slot for the next item");
  assert.ok(afterOne.available > full.available, "available must grow as work completes");

  // And every other terminal status frees its slot too.
  statuses["task-a"] = "failed";
  statuses["task-c"] = "superseded";
  var drained = l.slots();
  assert.strictEqual(drained.inFlight, 0);
  assert.strictEqual(drained.available, 3);

  var deletedOnly = limiter({
    candidates: candidateStore([admittedCandidate("a", "task-a")]),
    getBinding: bindingReader({ "task-a": "deleted" }),
    getLimit: function () { return 2; },
  }).slots();
  assert.strictEqual(deletedOnly.inFlight, 0, "a deleted binding runs nothing");
  assert.strictEqual(deletedOnly.available, 2);
});

// --- Fail closed: unknown means in flight ---------------------------------------

test("concurrency: an unreadable binding counts as in flight", function () {
  // The reader has no record for this task id at all.
  var l = limiter({
    candidates: candidateStore([admittedCandidate("a", "task-missing")]),
    getBinding: bindingReader({}),
    getLimit: function () { return 1; },
  });
  assert.strictEqual(l.inFlight().count, 1);
  assert.strictEqual(l.slots().available, 0,
    "an unknown binding must never be assumed finished");
});

test("concurrency: a null binding counts as in flight", function () {
  var l = limiter({
    candidates: candidateStore([admittedCandidate("a", "task-a")]),
    getBinding: bindingReader({ "task-a": null }),
    getLimit: function () { return 1; },
  });
  assert.strictEqual(l.inFlight().count, 1);
  assert.strictEqual(l.slots().available, 0);
});

test("concurrency: a throwing binding reader counts as in flight", function () {
  var l = limiter({
    candidates: candidateStore([admittedCandidate("a", "task-a")]),
    getBinding: bindingReader({ "task-a": "completed" }, { throws: true }),
    getLimit: function () { return 2; },
  });
  assert.strictEqual(l.inFlight().count, 1,
    "a binding store outage must not read as idle capacity");
  assert.strictEqual(l.slots().available, 1);
});

test("concurrency: no binding reader at all counts every admitted candidate as in flight", function () {
  var l = limiter({
    candidates: candidateStore([admittedCandidate("a", "task-a"), admittedCandidate("b", "task-b")]),
    getBinding: undefined,
    getLimit: function () { return 5; },
  });
  assert.strictEqual(l.inFlight().count, 2);
  assert.strictEqual(l.slots().available, 3);
});

// `unrouted` is NOT an unknown status and must not be treated as one. It is the
// binding store's positive record that a reservation was released because no
// task was ever created, which is why it is kept out of CURRENT_STATUSES there.
// Counting it as in flight leaked capacity permanently: the live activation
// produced 22 unrouted bindings from one broken scan, and every one of them
// would have held a slot forever against a limit of 5.
test("concurrency: an unrouted binding frees its slot — no worker ever started", function () {
  var l = limiter({
    candidates: candidateStore([admittedCandidate("a", "task-a")]),
    getBinding: bindingReader({ "task-a": "unrouted" }),
    getLimit: function () { return 1; },
  });
  assert.strictEqual(l.inFlight().count, 0,
    "a released reservation holds no worker and so holds no slot");
  assert.strictEqual(l.slots().available, 1,
    "a routing failure must cost a retry, never capacity");
});

test("concurrency: an unknown binding status counts as in flight", function () {
  var unknown = ["unavailable", "", "weird-new-status"];
  for (var i = 0; i < unknown.length; i++) {
    var l = limiter({
      candidates: candidateStore([admittedCandidate("a", "task-a")]),
      getBinding: bindingReader({ "task-a": unknown[i] }),
      getLimit: function () { return 1; },
    });
    assert.strictEqual(l.inFlight().count, 1, unknown[i] + " must count as in flight");
    assert.strictEqual(l.slots().available, 0, unknown[i] + " must not free a slot");
  }
});

test("concurrency: a malformed candidate binding field counts as in flight", function () {
  var malformed = [
    { candidateKey: "launch:a", itemKey: "a", status: "admitted" },
    { candidateKey: "launch:b", itemKey: "b", status: "admitted", binding: null },
    { candidateKey: "launch:c", itemKey: "c", status: "admitted", binding: {} },
    { candidateKey: "launch:d", itemKey: "d", status: "admitted", binding: "task-d" },
  ];
  var l = limiter({
    candidates: candidateStore(malformed),
    // A reader that would happily call everything completed if it were asked.
    getBinding: function () { return { status: "completed" }; },
    getLimit: function () { return 10; },
  });
  var result = l.inFlight();
  assert.strictEqual(result.count, 4,
    "a candidate we cannot resolve to a binding must hold its slot");
  assert.strictEqual(l.slots().available, 6);
});

test("concurrency: a candidate with no usable key still occupies a slot", function () {
  var l = limiter({
    candidates: candidateStore([{ status: "admitted" }]),
    getLimit: function () { return 1; },
  });
  var result = l.inFlight();
  assert.strictEqual(result.count, 1);
  assert.deepStrictEqual(result.items, ["candidate:0"]);
  assert.strictEqual(l.slots().available, 0);
});

// --- Fail closed: the candidate store itself ------------------------------------

test("concurrency: an unreadable candidate store yields ok:false and zero slots", function () {
  var l = limiter({
    sm: sessionManager([autoSession("legacy#1")]),
    candidates: candidateStore([], { fail: "malformed_state" }),
    getLimit: function () { return 10; },
  });
  var result = l.inFlight();
  assert.strictEqual(result.ok, false, "corruption must never read as an empty queue");
  assert.strictEqual(result.reason, "malformed_state");
  assert.strictEqual(result.count, 1, "the live session count is still reported honestly");

  var slots = l.slots();
  assert.strictEqual(slots.ok, false);
  assert.strictEqual(slots.reason, "malformed_state");
  assert.strictEqual(slots.available, 0, "launch nothing rather than launching unbounded");
});

test("concurrency: a throwing candidate store fails closed", function () {
  var l = limiter({
    candidates: candidateStore([], { throws: true }),
    getLimit: function () { return 10; },
  });
  assert.strictEqual(l.inFlight().reason, "candidate_store_threw");
  assert.strictEqual(l.slots().available, 0);
});

test("concurrency: a candidate store with no pending() fails closed", function () {
  var l = limiter({ candidates: {}, getLimit: function () { return 10; } });
  assert.strictEqual(l.inFlight().ok, false);
  assert.strictEqual(l.inFlight().reason, "candidate_store_unreadable");
  assert.strictEqual(l.slots().available, 0);
});

test("concurrency: a candidate store returning a non-array fails closed", function () {
  var l = limiter({
    candidates: candidateStore([], { malformed: true }),
    getLimit: function () { return 10; },
  });
  assert.strictEqual(l.inFlight().reason, "malformed_candidates");
  assert.strictEqual(l.slots().available, 0);
});

test("concurrency: no candidate store configured is zero candidates, not a failure", function () {
  // A legacy-only project has no candidate population. Failing closed there
  // would stall automation forever; the session count still bounds it.
  var l = limiter({
    sm: sessionManager([autoSession("legacy#1")]),
    candidates: null,
    getLimit: function () { return 2; },
  });
  var slots = l.slots();
  assert.strictEqual(slots.ok, true);
  assert.strictEqual(slots.inFlight, 1);
  assert.strictEqual(slots.available, 1);
});

// --- Deduplication ----------------------------------------------------------------

test("concurrency: an item that is both a live session and an admitted candidate counts once", function () {
  var l = limiter({
    sm: sessionManager([autoSession("trialview/v2#2517")]),
    candidates: candidateStore([admittedCandidate("trialview/v2#2517", "task-2517")]),
    getBinding: bindingReader({ "task-2517": "active" }),
    getLimit: function () { return 3; },
  });
  var result = l.inFlight();
  assert.strictEqual(result.count, 1, "double counting would silently halve the limit");
  assert.deepStrictEqual(result.items, ["trialview/v2#2517"]);
  assert.strictEqual(l.slots().available, 2);
});

test("concurrency: the launch: prefix on a legacy candidate key does not defeat dedup", function () {
  var l = limiter({
    sm: sessionManager([autoSession("org/repo#7")]),
    // No itemKey, only the prefixed candidate key the adoption path writes.
    candidates: candidateStore([{
      candidateKey: "launch:org/repo#7",
      status: "admitted",
      binding: { portfolioTaskId: "task-7", bindingRevision: 1 },
    }]),
    getBinding: bindingReader({ "task-7": "active" }),
    getLimit: function () { return 2; },
  });
  var result = l.inFlight();
  assert.strictEqual(result.count, 1);
  assert.deepStrictEqual(result.items, ["org/repo#7"]);
});

test("concurrency: duplicate live sessions for one item count once", function () {
  var sm = sessionManager([
    autoSession("org/repo#1"),
    autoSession("org/repo#1", { storageId: "dup" }),
  ]);
  assert.strictEqual(limiter({ sm: sm }).inFlight().count, 1);
});

test("concurrency: an item key that collides with Object.prototype is handled", function () {
  var sm = sessionManager([
    autoSession("__proto__"),
    autoSession("constructor"),
    autoSession("__proto__", { storageId: "dup" }),
  ]);
  var result = limiter({ sm: sm }).inFlight();
  assert.strictEqual(result.count, 2, "prototype keys must dedupe like any other key");
});

// --- Limit arithmetic ---------------------------------------------------------------

test("concurrency: a zero limit means no automatic work may start", function () {
  var slots = limiter({ getLimit: function () { return 0; } }).slots();
  assert.strictEqual(slots.available, 0);
  assert.strictEqual(slots.limit, 0);
});

test("concurrency: a negative, NaN, missing or non-numeric limit yields zero slots", function () {
  var bad = [
    function () { return -1; },
    function () { return NaN; },
    function () { return Infinity; },
    function () { return undefined; },
    function () { return null; },
    function () { return "5"; },
    function () { throw new Error("config unreadable"); },
    undefined,
    null,
  ];
  for (var i = 0; i < bad.length; i++) {
    // Built directly so the harness default cannot mask a missing getLimit.
    var slots = createConcurrencyLimiter({ getLimit: bad[i] }).slots();
    assert.strictEqual(slots.ok, false, "limit shape " + i + " must not be usable");
    assert.strictEqual(slots.available, 0, "limit shape " + i + " must free no slots");
  }
});

test("concurrency: available never goes negative when in flight exceeds the limit", function () {
  // The limit was lowered while five workers were already running.
  var sm = sessionManager([
    autoSession("a"), autoSession("b"), autoSession("c"), autoSession("d"), autoSession("e"),
  ]);
  var slots = limiter({ sm: sm, getLimit: function () { return 2; } }).slots();
  assert.strictEqual(slots.ok, true);
  assert.strictEqual(slots.inFlight, 5);
  assert.strictEqual(slots.available, 0, "an over-subscribed system drains, it does not launch");
});

test("concurrency: a fractional limit is floored rather than rounded up", function () {
  var slots = limiter({ getLimit: function () { return 2.9; } }).slots();
  assert.strictEqual(slots.limit, 2);
  assert.strictEqual(slots.available, 2);
});

test("concurrency: slots reports limit, inFlight and the item keys behind the count", function () {
  var l = limiter({
    sm: sessionManager([autoSession("org/repo#1")]),
    candidates: candidateStore([admittedCandidate("b", "task-b")]),
    getBinding: bindingReader({ "task-b": "active" }),
    getLimit: function () { return 4; },
  });
  var slots = l.slots();
  assert.strictEqual(slots.ok, true);
  assert.strictEqual(slots.limit, 4);
  assert.strictEqual(slots.inFlight, 2);
  assert.strictEqual(slots.available, 2);
  assert.deepStrictEqual(slots.items.sort(), ["b", "org/repo#1"]);
  assert.strictEqual(slots.checkedAt, 1700000000000);
});
