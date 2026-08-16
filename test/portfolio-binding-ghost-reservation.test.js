var test = require("node:test");
var assert = require("node:assert/strict");
var bindings = require("../lib/portfolio-execution-bindings");

// A delegation that fails BEFORE any task exists must not strand a reservation.
//
// The real incident: delegate_task failed routing with "No healthy candidate was
// present in an exact-route verified catalog". createAndCommitExecution had
// already called reserve(), which persists status "pending", and returned early
// without rolling back. `pending` is in CURRENT_STATUSES, so latestCurrent()
// returned the ghost and every later revision was refused with
// active_binding_exists; and changeStatus() refuses "pending" as a target and
// refuses ref-requiring statuses on a ref-less record, so there was no supported
// way to terminalize it. Five real bindings ended up in exactly that state, all
// with createdAt === updatedAt and no worker/coordinator ref.

var TARGET = { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" };
var SOURCE = { projectId: "system-lead", sessionStorageId: "lead-home" };

// writeState opens a temp path, writes through the DESCRIPTOR, then renames, so
// this fake has to model descriptors -- not just paths -- or nothing persists
// and every restart test silently reads an empty store.
function memoryFs(seed) {
  var files = Object.assign({}, seed || {});
  var handles = {};
  var nextFd = 1;
  return {
    files: files,
    existsSync: function (p) { return Object.prototype.hasOwnProperty.call(files, p); },
    readFileSync: function (p) {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error("ENOENT");
      return files[p];
    },
    writeFileSync: function (target, data) {
      var key = typeof target === "number" ? handles[target] : target;
      files[key] = String(data);
    },
    renameSync: function (a, b) {
      if (!Object.prototype.hasOwnProperty.call(files, a)) throw new Error("ENOENT");
      files[b] = files[a];
      delete files[a];
    },
    mkdirSync: function () {},
    openSync: function (p) { handles[nextFd] = p; return nextFd++; },
    fsyncSync: function () {},
    closeSync: function () {},
    unlinkSync: function (p) { delete files[p]; },
  };
}

var STATE_FILE = "/state/portfolio-execution-bindings.json";

function seedState(records) {
  var seed = {};
  seed[STATE_FILE] = JSON.stringify({
    schema: "clay.portfolio_execution_bindings",
    version: 2,
    bindings: records,
  });
  return memoryFs(seed);
}

function clock(start) {
  var t = { value: start || 1000 };
  var fn = function () { return t.value; };
  fn.advance = function (ms) { t.value += ms; return t.value; };
  return fn;
}

function store(options) {
  var opts = options || {};
  return bindings.createBindingStore({
    fs: opts.fs || memoryFs(),
    file: STATE_FILE,
    now: opts.now || clock(),
    reconcileOnLoad: opts.reconcileOnLoad,
  });
}

function request(taskId, revision, extra) {
  return Object.assign({
    portfolioTaskId: taskId,
    targetProject: TARGET,
    bindingRevision: revision || 1,
    idempotencyKey: taskId + "-r" + (revision || 1),
    mode: "direct_leaf",
    source: SOURCE,
  }, extra || {});
}

function cleanupLegacyBindingForTest() {
  return {
    portfolioTaskId: "legacy-task",
    mode: "project_coordinator",
    targetProject: TARGET,
    bindingRevision: 1,
    idempotencyKey: "legacy-task-r1",
    source: SOURCE,
    status: "unrouted",
    createdAt: 1000,
    updatedAt: 1001,
    unroutedAt: 1001,
    statusReason: "pre_task_failure: delivery_error",
  };
}

// --- the defect itself -------------------------------------------------------

test("a released reservation stops blocking the next revision", function () {
  var api = store();
  assert.equal(api.reserve(request("t", 1)).ok, true);

  // Before release: r2 is refused, which is exactly what was observed live.
  var blocked = api.reserve(request("t", 2));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "active_binding_exists");

  var released = api.releaseReservation("t", 1, "pre_task_failure: no healthy candidate");
  assert.equal(released.ok, true);
  assert.equal(released.binding.status, "unrouted");

  var retried = api.reserve(request("t", 2));
  assert.equal(retried.ok, true, "a new revision must not be blocked by a ghost");
  assert.equal(retried.created, true);
});

test("the same idempotent revision may retry after a pre-task failure", function () {
  var api = store();
  api.reserve(request("t", 1));
  api.releaseReservation("t", 1, "pre_task_failure: no healthy candidate");

  var again = api.reserve(request("t", 1));
  assert.equal(again.ok, true, "exact-r1 retry must be safe");
  assert.equal(again.rearmed, true);
  assert.equal(again.binding.status, "pending", "re-armed, not handed back dead");
  assert.equal(again.binding.attempts, 2, "the retry is counted");
  // And it is committable, so the retry can actually produce a worker.
  var committed = api.commit("t", 1, { projectId: TARGET.projectId, sessionStorageId: "w1" });
  assert.equal(committed.ok, true);
  assert.equal(committed.binding.status, "active");
});

test("release keeps durable evidence rather than deleting the attempt", function () {
  var api = store();
  api.reserve(request("t", 1));
  api.releaseReservation("t", 1, "pre_task_failure: no healthy candidate in catalog");
  var record = api.get("t", 1);
  assert.ok(record, "the record must survive for diagnosis");
  assert.equal(record.status, "unrouted");
  assert.match(record.statusReason, /no healthy candidate/);
  assert.equal(typeof record.unroutedAt, "number");
});

// --- what release must refuse to touch ---------------------------------------

test("a committed binding can never be released as a reservation", function () {
  var api = store();
  api.reserve(request("t", 1));
  api.commit("t", 1, { projectId: TARGET.projectId, sessionStorageId: "worker-1" });
  var out = api.releaseReservation("t", 1, "should not happen");
  assert.equal(out.ok, false);
  assert.equal(out.reason, "binding_not_releasable",
    "releasing live work would orphan a real worker");
  assert.equal(api.get("t", 1).status, "active");
});

test("release is a no-op on an unknown or already released binding", function () {
  var api = store();
  assert.equal(api.releaseReservation("nope", 1, "x").reason, "binding_not_releasable");
  api.reserve(request("t", 1));
  assert.equal(api.releaseReservation("t", 1, "first").ok, true);
  assert.equal(api.releaseReservation("t", 1, "second").ok, false,
    "a second release must not rewrite the recorded reason");
});

// --- bounded reconciliation of already-stranded records -----------------------

test("reconciliation releases only provably orphaned reservations", function () {
  var time = clock(1000);
  var api = store({ now: time });
  api.reserve(request("old", 1));
  time.advance(20 * 60 * 1000);
  api.reserve(request("starting", 1));

  var swept = api.reconcileStrandedReservations({});
  assert.equal(swept.released.length, 1, "only the aged one");
  assert.equal(swept.released[0].portfolioTaskId, "old");
  assert.equal(api.get("starting", 1).status, "pending",
    "a binding that is legitimately mid-start must never be cancelled");
});

test("reconciliation never touches a reservation that already has a worker", function () {
  var time = clock(1000);
  var api = store({ now: time });
  api.reserve(request("live", 1));
  api.commit("live", 1, { projectId: TARGET.projectId, sessionStorageId: "worker-1" });
  time.advance(60 * 60 * 1000);

  var swept = api.reconcileStrandedReservations({});
  assert.deepEqual(swept.released, []);
  assert.equal(api.get("live", 1).status, "active");
});

test("a daemon restart sweeps its own ghosts on load", function () {
  var time = clock(1000);
  var fs = memoryFs();
  var first = store({ fs: fs, now: time });
  first.reserve(request("ghost", 1));
  assert.equal(first.get("ghost", 1).status, "pending");

  // Restart well after the grace window, reading the same persisted file.
  time.advance(30 * 60 * 1000);
  var second = store({ fs: fs, now: time });
  assert.equal(second.get("ghost", 1).status, "unrouted",
    "a restart must clear a reservation whose task never started");
  assert.match(second.get("ghost", 1).statusReason, /on_load/);
  // And the task is immediately usable again.
  assert.equal(second.reserve(request("ghost", 2)).ok, true);
});

test("a restart mid-start does not cancel the binding that is starting", function () {
  var time = clock(1000);
  var fs = memoryFs();
  var first = store({ fs: fs, now: time });
  first.reserve(request("starting", 1));

  time.advance(5 * 1000);
  var second = store({ fs: fs, now: time });
  assert.equal(second.get("starting", 1).status, "pending",
    "five seconds is inside any legitimate start");
});

// --- concurrency -------------------------------------------------------------

test("a concurrent duplicate call observes the reservation and creates no second one", function () {
  var api = store();
  var first = api.reserve(request("t", 1));
  var second = api.reserve(request("t", 1));
  assert.equal(first.created, true);
  assert.equal(second.ok, true);
  assert.equal(second.created, false, "only one caller owns the reservation");
  assert.equal(api.list().filter(function (b) { return b.portfolioTaskId === "t"; }).length, 1,
    "exactly one binding record, so no duplicate worker can be created");
});

test("a conflicting idempotency key on the same revision is refused", function () {
  var api = store();
  api.reserve(request("t", 1));
  var conflict = api.reserve(request("t", 1, { idempotencyKey: "different" }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "idempotency_conflict");
});

test("new reservations persist versioned control-plane provenance and a normalized task digest", function () {
  var fs = memoryFs();
  var api = store({ fs: fs, reconcileOnLoad: false });
  var created = api.reserve(request("provenance", 1, {
    title: "  Durable task  ",
    objective: "  Preserve the exact task payload.  ",
    context: " Context ",
    acceptanceCriteria: " Exact replay is safe. ",
    ownedPaths: " lib/example.js ",
    dependencies: [{ taskId: "dependency-b" }, { taskId: "dependency-a" }],
    provider: " codex ",
    model: " gpt-5.6-sol ",
  }));

  assert.equal(created.ok, true);
  assert.deepEqual(created.binding.controlPlaneProvenance, {
    schema: "clay.coop_control_plane_reservation",
    version: 1,
  });
  assert.match(created.binding.taskPayloadDigest, /^[a-f0-9]{64}$/);
  assert.equal(created.binding.provider, "codex");
  assert.equal(created.binding.model, "gpt-5.6-sol");

  var reloaded = store({ fs: fs, reconcileOnLoad: false });
  assert.deepEqual(reloaded.get("provenance", 1), created.binding,
    "provenance and digest must reach disk before delivery can begin");
});

test("same-revision equivalence includes normalized task payload, provider, and model", function () {
  var api = store();
  var original = request("equivalence", 1, {
    title: "Task title",
    objective: "Do the exact work.",
    context: "Context",
    acceptanceCriteria: "Tests pass.",
    ownedPaths: "lib/example.js",
    dependencies: [{ taskId: "dependency-a" }, { taskId: "dependency-b" }],
    provider: "codex",
    model: "gpt-5.6-sol",
  });
  assert.equal(api.reserve(original).ok, true);

  var normalizedReplay = api.reserve(Object.assign({}, original, {
    title: "  Task title  ",
    objective: "  Do the exact work.  ",
    dependencies: [{ taskId: "dependency-b" }, { taskId: "dependency-a" }],
    provider: " codex ",
    model: " gpt-5.6-sol ",
  }));
  assert.equal(normalizedReplay.ok, true);
  assert.equal(normalizedReplay.created, false);

  [
    { provider: "claude" },
    { model: "gpt-5.6-terra" },
    { objective: "Do different work." },
  ].forEach(function (change) {
    var conflict = api.reserve(Object.assign({}, original, change));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, "idempotency_conflict");
  });
});

test("legacy records remain identifiable while new reservations are not legacy", function () {
  var legacy = cleanupLegacyBindingForTest();
  var fs = seedState([legacy]);
  var api = store({ fs: fs, reconcileOnLoad: false });
  var legacyRecord = api.get("legacy-task", 1);
  assert.equal(bindings.isLegacyReservation(legacyRecord), true);
  assert.equal(bindings.requestEquivalence(legacyRecord,
    bindings.normalizeRequest(request("legacy-task", 1, {
      mode: "project_coordinator",
      objective: "Retry legacy task.",
    }))), "legacy");
  assert.equal(bindings.requestEquivalence(legacyRecord,
    bindings.normalizeRequest(request("legacy-task", 1, {
      mode: "project_coordinator",
      idempotencyKey: "legacy-task-rival-key",
      objective: "Retry legacy task.",
    }))), "conflict", "a rival key is a conflict even before legacy migration");

  var created = api.reserve(request("current-task", 1, {
    objective: "Current control-plane task.",
  }));
  assert.equal(created.ok, true);
  assert.equal(bindings.isLegacyReservation(created.binding), false);
});

test("structured pre-task failure code and details survive persistence", function () {
  var fs = memoryFs();
  var api = store({ fs: fs, reconcileOnLoad: false });
  api.reserve(request("structured-failure", 1, { objective: "Route work." }));
  var released = api.releaseReservation("structured-failure", 1, {
    code: "provider_route_unavailable",
    message: "No healthy exact-route provider was available.",
    details: { provider: "codex", model: "gpt-5.6-sol", retryable: true },
  });
  assert.equal(released.ok, true);
  assert.equal(released.binding.failureCode, "provider_route_unavailable");
  assert.deepEqual(released.binding.failureDetails,
    { provider: "codex", model: "gpt-5.6-sol", retryable: true });

  var reloaded = store({ fs: fs, reconcileOnLoad: false });
  assert.equal(reloaded.get("structured-failure", 1).failureCode,
    "provider_route_unavailable");
  assert.deepEqual(reloaded.get("structured-failure", 1).failureDetails,
    released.binding.failureDetails);
});

test("terminal read-only attention releases the portfolio for an authorized repair revision", function () {
  var api = store();
  var review = request("review-to-repair", 1, {
    mode: "project_coordinator",
  });
  assert.equal(api.reserve(review).ok, true);
  assert.equal(api.commit("review-to-repair", 1, {
    projectId: TARGET.projectId,
    sessionStorageId: "council-review",
  }).ok, true);

  var attention = api.complete("review-to-repair", 1, {
    eventId: "review-attention-1",
    terminalStatus: "needs_input",
    executionMode: "project_coordinator",
    completedAt: 1200,
    controlRole: "council",
    reviewOnly: true,
  });
  assert.equal(attention.ok, true);
  assert.equal(attention.binding.status, "needs_input");
  assert.equal(attention.binding.controlRole, "council");
  assert.equal(attention.binding.reviewOnly, true);

  var repair = api.reserve(request("review-to-repair", 2, {
    mode: "project_coordinator",
  }));
  assert.equal(repair.ok, true,
    "a terminal verification finding must not deadlock the separately authorized repair");
});

test("a re-armed reservation is still a single record", function () {
  var api = store();
  api.reserve(request("t", 1));
  api.releaseReservation("t", 1, "pre_task_failure");
  api.reserve(request("t", 1));
  api.reserve(request("t", 1));
  var all = api.list().filter(function (b) { return b.portfolioTaskId === "t"; });
  assert.equal(all.length, 1, "retrying must not accumulate duplicate bindings");
  assert.equal(all[0].status, "pending");
});

// --- the five real stranded records ------------------------------------------

test("the five real stranded records are reconciled by the supported path", function () {
  // Verbatim shape from ~/.clay/lead/portfolio-execution-bindings.json: every
  // one is direct_leaf, status pending, createdAt === updatedAt, and carries no
  // worker ref. Two are the ones the owner reported; three older ones share the
  // identical signature and were stranded the same way.
  var real = [
    ["clay-remove-misplaced-webapp-launcher-files", 1786037256578],
    ["clay-mobile-project-switcher-regression-review", 1786107873719],
    ["clay-mobile-project-switcher-regression-final-review", 1786110858836],
    ["lead-project-automation-policy-cutover-independent-review", 1786241775866],
    ["clay-owner-facing-ux-final-review", 1786246445687],
  ];
  var fs = seedState(real.map(function (entry) {
    return {
      portfolioTaskId: entry[0], mode: "direct_leaf", targetProject: TARGET,
      bindingRevision: 1, idempotencyKey: entry[0] + "-r1",
      source: SOURCE, status: "pending", createdAt: entry[1], updatedAt: entry[1],
    };
  }));
  var time = clock(1786246445687 + 60 * 60 * 1000);

  var api = store({ fs: fs, now: time });
  assert.equal(api.getLoadError(), null, "the real state must load cleanly");

  real.forEach(function (entry) {
    var record = api.get(entry[0], 1);
    assert.equal(record.status, "unrouted", entry[0] + " must be reconciled");
    assert.match(record.statusReason, /stranded_reservation_reconciled/);
  });

  // The blocked reviews can now be re-delegated at the same revision.
  ["lead-project-automation-policy-cutover-independent-review",
   "clay-owner-facing-ux-final-review"].forEach(function (taskId) {
    var retry = api.reserve(request(taskId, 1, { idempotencyKey: taskId + "-r1" }));
    assert.equal(retry.ok, true, taskId + " must be re-reservable at r1");
    assert.equal(retry.rearmed, true);
  });
});

test("reconciliation is idempotent across repeated restarts", function () {
  var time = clock(1000);
  var fs = memoryFs();
  store({ fs: fs, now: time }).reserve(request("ghost", 1));
  time.advance(30 * 60 * 1000);

  var a = store({ fs: fs, now: time });
  var firstReason = a.get("ghost", 1).statusReason;
  var firstAt = a.get("ghost", 1).unroutedAt;
  time.advance(30 * 60 * 1000);
  var b = store({ fs: fs, now: time });
  assert.equal(b.get("ghost", 1).status, "unrouted");
  assert.equal(b.get("ghost", 1).statusReason, firstReason, "the record must not be rewritten");
  assert.equal(b.get("ghost", 1).unroutedAt, firstAt);
});

test("an unrouted binding is not reported as current work", function () {
  var api = store();
  api.reserve(request("t", 1));
  assert.equal(api.listCurrent().filter(function (b) { return b.portfolioTaskId === "t"; }).length, 1);
  api.releaseReservation("t", 1, "pre_task_failure");
  assert.equal(api.listCurrent().filter(function (b) { return b.portfolioTaskId === "t"; }).length, 0,
    "a task that never started must not read as active portfolio work");
});
