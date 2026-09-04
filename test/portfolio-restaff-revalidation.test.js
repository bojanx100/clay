var test = require("node:test");
var assert = require("node:assert");
var revalidation = require("../lib/portfolio-restaff-revalidation");

var NOW = 1788440000000;

function policy(overrides) {
  var base = {
    ownerLogin: "bojantv",
    boardExclusions: ["🔧 Dev Complete", "Ready for production", "Done"],
    recipeAllowsUnassigned: false,
  };
  if (overrides) {
    Object.keys(overrides).forEach(function (key) { base[key] = overrides[key]; });
  }
  return base;
}

function observation(overrides) {
  var base = {
    itemKey: "trialview/v2#2778",
    assignees: ["bojantv"],
    boardStatus: "In progress",
    state: "open",
    observedAt: NOW - 1000,
  };
  if (overrides) {
    Object.keys(overrides).forEach(function (key) { base[key] = overrides[key]; });
  }
  return base;
}

function verdict(input) {
  return revalidation.restaffEligibility({
    observation: input && input.observation !== undefined ? input.observation : observation(),
    policy: input && input.policy !== undefined ? input.policy : policy(),
    override: input && input.override,
    now: NOW,
  });
}

test("a live owner-assigned issue in an allowed column revalidates", function () {
  var result = verdict({});
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.eligible, true);
  assert.strictEqual(result.reason, "revalidated");
});

// The exact production incident: admitted while assigned to the owner, later
// delivered, reassigned and moved to Dev Complete, then restaffed anyway.
test("trialview/v2#2777 is refused on BOTH reassignment and board column", function () {
  var excluded = verdict({
    observation: observation({
      itemKey: "trialview/v2#2777",
      assignees: ["quinnovelandres04"],
      boardStatus: "🔧 Dev Complete",
    }),
  });
  assert.strictEqual(excluded.eligible, false);
  assert.strictEqual(excluded.reason, "board_status_excluded");

  // Board column alone must not be the only thing standing between the owner
  // and someone else's issue, so assignment is independently disqualifying.
  var reassigned = verdict({
    observation: observation({
      itemKey: "trialview/v2#2777",
      assignees: ["quinnovelandres04"],
      boardStatus: "In progress",
    }),
  });
  assert.strictEqual(reassigned.eligible, false);
  assert.strictEqual(reassigned.reason, "not_assigned_to_owner");
  assert.deepStrictEqual(reassigned.detail.assignees, ["quinnovelandres04"]);
});

test("board exclusions match despite emoji, case and spacing noise", function () {
  ["🔧 Dev Complete", "dev complete", "DEV  COMPLETE", "Dev-Complete"].forEach(function (status) {
    var result = verdict({ observation: observation({ boardStatus: status }) });
    assert.strictEqual(result.eligible, false, status);
    assert.strictEqual(result.reason, "board_status_excluded", status);
  });
});

test("every live board card status is checked", function () {
  var result = verdict({
    observation: observation({
      boardStatus: undefined,
      boardStatuses: ["In progress", "Ready for production"],
    }),
  });
  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.reason, "board_status_excluded");
  assert.strictEqual(result.detail.boardStatus, "Ready for production");
});

test("an owner among several assignees still qualifies", function () {
  var result = verdict({
    observation: observation({ assignees: ["quinnovelandres04", "bojantv"] }),
  });
  assert.strictEqual(result.eligible, true);
});

test("unassigned qualifies only when the recipe allows it", function () {
  var refused = verdict({ observation: observation({ assignees: [] }) });
  assert.strictEqual(refused.eligible, false);
  assert.strictEqual(refused.reason, "not_assigned_to_owner");

  var allowed = revalidation.restaffEligibility({
    observation: observation({ assignees: [] }),
    policy: policy({ recipeAllowsUnassigned: true }),
    now: NOW,
  });
  assert.strictEqual(allowed.eligible, true);
  assert.strictEqual(allowed.reason, "revalidated_unassigned_allowed");
});

test("a closed issue is never restaffed", function () {
  var result = verdict({ observation: observation({ state: "closed" }) });
  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.reason, "issue_closed");
});

// Silence is not permission. Every unresolvable premise must block.
test("missing, malformed or stale evidence fails closed", function () {
  var cases = [
    [{ observation: null }, "live_observation_unresolvable"],
    [{ observation: observation({ assignees: null }) }, "live_observation_unresolvable"],
    [{ observation: observation({ observedAt: 0 }) }, "live_observation_unresolvable"],
    [{ observation: observation({ observedAt: NOW + 60000 }) }, "live_observation_unresolvable"],
    [{ policy: null }, "revalidation_policy_unresolvable"],
    [{ policy: policy({ ownerLogin: "" }) }, "revalidation_policy_unresolvable"],
  ];
  cases.forEach(function (entry) {
    var result = verdict(entry[0]);
    assert.strictEqual(result.ok, false, entry[1]);
    assert.strictEqual(result.eligible, false, entry[1]);
    assert.strictEqual(result.reason, entry[1]);
  });
});

test("an observation older than the freshness window is stale, not permission", function () {
  var result = verdict({
    observation: observation({
      observedAt: NOW - revalidation.MAX_OBSERVATION_AGE_MS - 1,
    }),
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.reason, "live_observation_stale");
});

// An issue with no board card cannot be proven outside the excluded set.
test("an absent or empty board status is unresolvable, not allowed", function () {
  var absent = observation();
  delete absent.boardStatus;
  var result = verdict({ observation: absent });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "board_status_unresolvable");

  var empty = verdict({ observation: observation({ boardStatus: "   " }) });
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.reason, "board_status_unresolvable");
});

test("an explicit source-stamped include overrides only its exact item", function () {
  var target = observation({
    itemKey: "trialview/v2#2777",
    assignees: ["quinnovelandres04"],
    boardStatus: "🔧 Dev Complete",
  });
  var allowed = verdict({
    observation: target,
    override: { itemKey: "trialview/v2#2777", source: "owner-ingress:coop:abc:7" },
  });
  assert.strictEqual(allowed.eligible, true);
  assert.strictEqual(allowed.reason, "explicit_source_stamped_include");

  // A bare truthy override, an unsourced one, or one naming a different item
  // must never widen into a blanket bypass.
  [true, { itemKey: "trialview/v2#2777" }, { itemKey: "trialview/v2#2778", source: "x" }]
    .forEach(function (override) {
      var refused = verdict({ observation: target, override: override });
      assert.strictEqual(refused.eligible, false, JSON.stringify(override));
    });
});

test("restaffEligibility never throws on hostile input", function () {
  [undefined, null, 0, "x", [], { observation: [], policy: [] }].forEach(function (input) {
    var result = revalidation.restaffEligibility(input);
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(typeof result.reason, "string");
  });
});

test("a disqualification event carries the owner-visible reason", function () {
  var refused = verdict({
    observation: observation({ itemKey: "trialview/v2#2777", assignees: ["quinnovelandres04"] }),
  });
  var event = revalidation.disqualificationEvent({
    verdict: refused,
    itemKey: "trialview/v2#2777",
    portfolioTaskId: "portfolio-webapp-2777",
    bindingRevision: 2,
    now: NOW,
  });
  assert.strictEqual(event.type, "binding_auto_retired");
  assert.strictEqual(event.reason, "not_assigned_to_owner");
  assert.strictEqual(event.portfolioTaskId, "portfolio-webapp-2777");
  assert.strictEqual(event.bindingRevision, 2);
  assert.strictEqual(event.resolvable, true);
  assert.strictEqual(event.at, NOW);
});

test("no disqualification event is minted for eligible or incomplete input", function () {
  assert.strictEqual(revalidation.disqualificationEvent({
    verdict: verdict({}), itemKey: "trialview/v2#2778",
    portfolioTaskId: "portfolio-webapp-2778", bindingRevision: 1,
  }), null);
  var refused = verdict({ observation: observation({ assignees: ["someone-else"] }) });
  [{ itemKey: "" }, { portfolioTaskId: "" }, { bindingRevision: 0 }].forEach(function (patch) {
    var input = {
      verdict: refused, itemKey: "trialview/v2#2777",
      portfolioTaskId: "portfolio-webapp-2777", bindingRevision: 2,
    };
    Object.keys(patch).forEach(function (key) { input[key] = patch[key]; });
    assert.strictEqual(revalidation.disqualificationEvent(input), null);
  });
});
