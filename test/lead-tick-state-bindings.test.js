// Guards the binding slices that scripts/lead-tick-state.js hands to the tick.
//
// The turn needs TWO different slices and they are not interchangeable:
//   * capacity ("is a slot taken")      -> only CURRENT_STATUSES
//   * completion eligibility ("done?")  -> must include terminal `completed`
//
// Narrowing both to listCurrent() to save context makes an already-completed
// GitHub issue look eligible and staffs the same work twice. That is the exact
// duplicate-staffing failure the typed binding store exists to prevent, so it
// gets a test rather than a comment.
var test = require("node:test");
var assert = require("node:assert");

var candidates = require("../lib/project-automation-candidates");
var staffing = require("../lib/lead-staffing");

var PROJECT_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var CURRENT_STATUSES = { pending: true, active: true, unavailable: true, deleted: true };

// Defers entirely to the binding check, which is the path under test.
var NO_LAUNCH_ENTRY = {
  hasEntry: function () { return false; },
  shouldRelaunch: function () { return false; },
};

function candidate() {
  return {
    source: "github",
    project: "clay",
    itemKey: "bojanx100/clay#2507",
    number: 2507,
    projectRef: { projectId: PROJECT_ID },
  };
}

// Mirrors eligibilityProjection() in scripts/lead-tick-state.js: the five
// properties latestCandidateBinding() reads.
function project(binding) {
  return {
    portfolioTaskId: binding.portfolioTaskId,
    targetProject: binding.targetProject,
    bindingRevision: binding.bindingRevision,
    mode: binding.mode,
    status: binding.status,
  };
}

function bindingWith(status, revision) {
  return {
    portfolioTaskId: staffing.portfolioTaskIdForCandidate(candidate()),
    targetProject: { projectId: PROJECT_ID },
    bindingRevision: revision || 1,
    mode: "project_coordinator",
    status: status,
  };
}

function eligibility(bindings) {
  return candidates.completionEligibility(NO_LAUNCH_ENTRY, candidate(), bindings);
}

test("candidate identity resolves, so these assertions exercise the binding path", function () {
  // Without this the predicate short-circuits on an unresolvable identity and
  // every slice agrees trivially -- a green result proving nothing.
  assert.strictEqual(staffing.portfolioTaskIdForCandidate(candidate()), "portfolio-clay-2507");
  assert.strictEqual(eligibility([bindingWith("completed")]).reason, "already_completed_or_in_flight");
});

test("the five-field projection matches the full binding list for every status", function () {
  ["completed", "active", "failed", "superseded", "unrouted", "deleted", "pending"].forEach(function (status) {
    var full = [bindingWith(status)];
    assert.deepStrictEqual(
      eligibility(full.map(project)),
      eligibility(full),
      "projection diverged for status " + status
    );
  });
});

test("a capacity-only slice would report completed work as eligible", function () {
  var completed = bindingWith("completed");
  var full = [completed];
  var capacityOnly = full.filter(function (b) { return CURRENT_STATUSES[b.status]; });

  assert.strictEqual(eligibility(full).eligible, false, "completed work is not eligible");
  assert.strictEqual(eligibility(full).reason, "already_completed_or_in_flight");
  // The regression this guards: filtering to CURRENT_STATUSES drops the
  // completed record and the same work becomes stageable again.
  assert.strictEqual(capacityOnly.length, 0);
  assert.strictEqual(eligibility(capacityOnly).eligible, true);
});

test("lower-revision records must not be pre-deduped away", function () {
  // latestCandidateBinding fails CLOSED on a malformed record even when a newer
  // valid revision exists, so a projection that kept only the latest revision
  // would turn ok:false into ok:true.
  var malformedOld = bindingWith("completed", 1);
  malformedOld.mode = "not_a_mode";
  var validNew = bindingWith("failed", 2);

  var withBoth = eligibility([malformedOld, validNew]);
  var latestOnly = eligibility([validNew]);

  assert.strictEqual(withBoth.ok, false, "a malformed record must fail closed");
  assert.strictEqual(withBoth.reason, "completion_state_unresolvable");
  assert.strictEqual(latestOnly.ok, true, "dropping it would silently open the gate");
  assert.notDeepStrictEqual(withBoth, latestOnly);
});

// The snapshot's `typedHistory` slice: full-shape current records plus
// field-thinned terminal records. `inFlightForTick` echoes a matched binding
// into its result and only ever matches current records, so thinning terminal
// ones is invisible to it while keeping restaff-blocking correct.
test("the typedHistory slice keeps restaff blocking that a capacity slice loses", function () {
  var loop = require("../lib/lead-loop");
  var completed = bindingWith("completed", 2);
  var active = bindingWith("active", 1);
  active.portfolioTaskId = "portfolio-clay-9999";
  var full = [active, completed];
  var typedHistory = [active].concat([completed].map(project));
  var capacityOnly = full.filter(function (b) { return CURRENT_STATUSES[b.status]; });

  assert.deepStrictEqual(
    loop.inFlightForTick({ portfolioBindings: typedHistory, inFlight: [] }),
    loop.inFlightForTick({ portfolioBindings: full, inFlight: [] }),
    "thinning terminal records must not change the in-flight set"
  );
  // The capacity slice silently loses the completed record entirely.
  assert.strictEqual(capacityOnly.length, 1);
  assert.strictEqual(
    typedHistory.filter(function (b) { return b.status === "completed"; }).length,
    1,
    "typedHistory must retain the completed record that blocks a restaff"
  );
});

test("the projection preserves the same-revision status conflict guard", function () {
  var a = bindingWith("completed", 3);
  var b = bindingWith("failed", 3);
  var full = [a, b];

  assert.strictEqual(eligibility(full).ok, false, "conflicting statuses at one revision fail closed");
  assert.deepStrictEqual(eligibility(full.map(project)), eligibility(full));
});
