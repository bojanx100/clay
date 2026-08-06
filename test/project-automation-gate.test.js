// Tests for the project automation gate — the composed enforcement point that
// project automation calls before it claims, launches, or authorizes an
// externally visible action.
//
// These are the cutover's end-to-end safety regressions: no duplicate launch,
// no duplicate claim, no comment/merge/close without claim + completion
// evidence + approval, fail-closed on policy failure, correct restart
// migration, and an exact legacy pass-through with Lead mode off.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var gateModule = require("../lib/project-automation-gate");
var claimLeases = require("../lib/automation-claim-leases");
var automationAudit = require("../lib/project-automation-audit");

var PROJECT_A = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
var PROJECT_B = "11111111-2222-4333-8444-555555555555";

var BUG_RECIPE = {
  id: "assigned-to-me",
  source: { provider: "github", repo: "trialview/v2", kind: "issue" },
  filter: { type: "bug", skipProjectStatuses: ["Done"] },
};
var PR_RECIPE = {
  id: "pr-review",
  source: { provider: "github", repo: "trialview/v2", kind: "pr-reviews" },
  filter: {},
};

function workspace(recipes) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-gate-"));
  var tasks = path.join(dir, ".clay", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  var list = recipes || [];
  for (var i = 0; i < list.length; i++) {
    fs.writeFileSync(path.join(tasks, list[i].id + ".json"), JSON.stringify(list[i]));
  }
  return dir;
}

function clock(start) {
  var value = start;
  return {
    now: function () { return value; },
    set: function (next) { value = next; },
  };
}

// A gate wired entirely to temp state so nothing touches the real config dir.
function makeGate(options) {
  var opts = options || {};
  var dir = opts.cwd || workspace([BUG_RECIPE]);
  var time = opts.clock || clock(1000);
  var leadMode = opts.leadMode !== false;
  var store = opts.leases || claimLeases.createClaimLeases({
    file: path.join(dir, "claims.json"), now: time.now,
  });
  var gate = gateModule.createAutomationGate({
    cwd: dir,
    slug: opts.slug || "webapp",
    projectRef: { projectId: opts.projectId || PROJECT_A },
    now: time.now,
    policyTtlMs: 0,
    claimTtlMs: opts.claimTtlMs || 5000,
    holder: opts.holder,
    getLeadMode: function () { return leadMode; },
    leases: store,
    audit: automationAudit.createAutomationAudit({
      file: path.join(dir, "audit.jsonl"), slug: "webapp", now: time.now,
    }),
  });
  return { gate: gate, dir: dir, clock: time, leases: store };
}

function bug(key) {
  return { itemKey: key, item: { labels: [{ name: "bug" }] }, recipeKind: "issue" };
}
function feature(key) {
  return { itemKey: key, item: { labels: [{ name: "feature" }] }, recipeKind: "issue" };
}
function unlabeled(key) {
  return { itemKey: key, item: { labels: [] }, recipeKind: "issue" };
}
function evidence() {
  return { status: "completed", summary: "fixed", verification: "suite green", escalationRequired: "no" };
}

// --- No duplicate launch / no duplicate claim --------------------------------

test("a project's own bug autonomy launches once and only once", function () {
  var h = makeGate();
  var first = h.gate.evaluateLaunch(bug("trialview/v2#1"));
  assert.strictEqual(first.decision, "execute");
  assert.strictEqual(first.reason, "policy_autonomous");
  assert.ok(first.lease, "an executing launch must carry its claim");

  // The overlapping-tick case the old check-then-start sequence allowed.
  var second = h.gate.evaluateLaunch(bug("trialview/v2#1"));
  assert.strictEqual(second.decision, "deny");
  assert.strictEqual(second.reason, "claim_already_active");
});

test("a claim held by another runtime blocks a launch here", function () {
  var h = makeGate();
  h.leases.acquire({
    projectRef: { projectId: PROJECT_A },
    key: gateModule.claimKeyFor("trialview/v2#7"),
    holder: "some-other-daemon",
    ttlMs: 5000,
  });
  var out = h.gate.evaluateLaunch(bug("trialview/v2#7"));
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "claim_held_elsewhere");
});

test("a released claim frees the item for a later tick", function () {
  var h = makeGate();
  assert.strictEqual(h.gate.evaluateLaunch(bug("trialview/v2#2")).decision, "execute");
  assert.strictEqual(h.gate.releaseClaim("trialview/v2#2").ok, true);
  assert.strictEqual(h.gate.evaluateLaunch(bug("trialview/v2#2")).decision, "execute");
});

test("an expired claim is reclaimable so a crashed runner cannot pin work forever", function () {
  var h = makeGate({ claimTtlMs: 1000 });
  assert.strictEqual(h.gate.evaluateLaunch(bug("trialview/v2#3")).decision, "execute");
  h.clock.set(1000 + 1000 + 1);
  assert.strictEqual(h.gate.evaluateLaunch(bug("trialview/v2#3")).decision, "execute");
});

test("a proposal never leaves a claim behind", function () {
  var h = makeGate();
  var out = h.gate.evaluateLaunch(feature("trialview/v2#4"));
  assert.strictEqual(out.decision, "propose");
  assert.deepStrictEqual(h.leases.list(), [], "proposed work must hold no lease");
});

// --- Discovery and proposal survive; unilateral action does not --------------

test("discovery is always allowed under Coop", function () {
  var h = makeGate();
  var out = h.gate.evaluateDiscovery({ recipeId: "assigned-to-me" });
  assert.strictEqual(out.decision, "execute");
  assert.strictEqual(out.reason, "discovery_always_allowed");
});

test("ambiguous capability work is proposed, never launched", function () {
  var h = makeGate();
  var out = h.gate.evaluateLaunch(unlabeled("trialview/v2#5"));
  assert.strictEqual(out.decision, "propose");
});

test("PR-review work is proposed even in a project whose bugs are autonomous", function () {
  var h = makeGate({ cwd: workspace([BUG_RECIPE, PR_RECIPE]) });
  var out = h.gate.evaluateLaunch({
    itemKey: "trialview/v2#900", item: { labels: [{ name: "bug" }] }, recipeKind: "pr-reviews",
  });
  assert.strictEqual(out.decision, "propose");
});

// --- Mixed project rules: no global flattening -------------------------------

test("two projects with different policies reach different decisions", function () {
  var autonomous = makeGate({ cwd: workspace([BUG_RECIPE]), projectId: PROJECT_A });
  var restrictive = makeGate({ cwd: workspace([]), projectId: PROJECT_B, slug: "clay" });
  assert.strictEqual(autonomous.gate.evaluateLaunch(bug("a#1")).decision, "execute");
  assert.strictEqual(restrictive.gate.evaluateLaunch(bug("b#1")).decision, "propose");
  assert.notStrictEqual(
    autonomous.gate.policyState().digest, restrictive.gate.policyState().digest);
});

// --- Fail closed --------------------------------------------------------------

test("a malformed project policy denies launches instead of falling back", function () {
  var dir = workspace([]);
  fs.writeFileSync(path.join(dir, ".clay", "tasks", "broken.json"), "{not json");
  var h = makeGate({ cwd: dir });
  var out = h.gate.evaluateLaunch(bug("x#1"));
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "policy_malformed");
  assert.strictEqual(h.gate.policyState().ok, false);
  assert.deepStrictEqual(h.leases.list(), [], "a failed policy must not take a claim");
});

test("an unusable ProjectRef denies launches", function () {
  var h = makeGate({ projectId: "not-a-project-id" });
  var out = h.gate.evaluateLaunch(bug("x#2"));
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "invalid_project_ref");
});

// --- Externally visible / destructive actions --------------------------------

test("an external action needs claim, completion evidence and approval together", function () {
  var h = makeGate();
  var key = "trialview/v2#10";

  // No claim yet.
  assert.strictEqual(
    h.gate.evaluateExternal({ itemKey: key, externalKind: "merge", completion: evidence(),
      approval: { granted: true, by: "owner" } }).reason, "claim_required");

  assert.strictEqual(h.gate.evaluateLaunch(bug(key)).decision, "execute");

  // Claim held, but the project coordinator has not finished.
  assert.strictEqual(
    h.gate.evaluateExternal({ itemKey: key, externalKind: "merge", completion: null,
      approval: { granted: true, by: "owner" } }).reason, "completion_evidence_required");

  // Finished, but nobody approved.
  assert.strictEqual(
    h.gate.evaluateExternal({ itemKey: key, externalKind: "merge", completion: evidence(),
      approval: null }).reason, "approval_required");

  // All three present.
  var allowed = h.gate.evaluateExternal({
    itemKey: key, externalKind: "merge", completion: evidence(),
    approval: { granted: true, by: "owner" },
  });
  assert.strictEqual(allowed.decision, "execute");
  assert.strictEqual(allowed.reason, "external_action_authorized");
});

test("comment, merge and close are all gated, and an expired claim revokes authority", function () {
  var h = makeGate({ claimTtlMs: 1000 });
  var key = "trialview/v2#11";
  assert.strictEqual(h.gate.evaluateLaunch(bug(key)).decision, "execute");
  var kinds = ["comment", "merge", "close"];
  for (var i = 0; i < kinds.length; i++) {
    assert.strictEqual(h.gate.evaluateExternal({
      itemKey: key, externalKind: kinds[i], completion: evidence(),
      approval: { granted: true, by: "owner" },
    }).decision, "execute", kinds[i] + " should be authorized while claimed");
  }
  h.clock.set(1000 + 1000 + 1);
  assert.strictEqual(h.gate.evaluateExternal({
    itemKey: key, externalKind: "merge", completion: evidence(),
    approval: { granted: true, by: "owner" },
  }).reason, "claim_required", "an expired claim must revoke external authority");
});

// --- Lead mode off: explicit legacy behavior ---------------------------------

test("lead mode off restores legacy behavior and takes no claims at all", function () {
  var h = makeGate({ leadMode: false });
  var out = h.gate.evaluateLaunch(unlabeled("trialview/v2#20"));
  assert.strictEqual(out.decision, "execute");
  assert.strictEqual(out.reason, "lead_mode_off_legacy");
  assert.deepStrictEqual(h.leases.list(), [], "legacy mode must not change claim state");

  var ext = h.gate.evaluateExternal({ itemKey: "trialview/v2#20", externalKind: "merge" });
  assert.strictEqual(ext.decision, "execute");
  assert.strictEqual(ext.reason, "lead_mode_off_legacy");
});

test("lead mode off still works when the project policy is broken", function () {
  var dir = workspace([]);
  fs.writeFileSync(path.join(dir, ".clay", "tasks", "broken.json"), "{not json");
  var h = makeGate({ cwd: dir, leadMode: false });
  assert.strictEqual(h.gate.evaluateLaunch(bug("x#3")).decision, "execute");
});

// --- Restart and migration ----------------------------------------------------

test("claims survive a restart and still block a different runtime", function () {
  var dir = workspace([BUG_RECIPE]);
  var time = clock(1000);
  var file = path.join(dir, "claims.json");
  var first = makeGate({
    cwd: dir, clock: time,
    leases: claimLeases.createClaimLeases({ file: file, now: time.now }),
  });
  assert.strictEqual(first.gate.evaluateLaunch(bug("trialview/v2#30")).decision, "execute");

  // A different runtime coming up against the same durable claim state.
  var other = makeGate({
    cwd: dir, clock: time, holder: "project-automation:other-runtime",
    leases: claimLeases.createClaimLeases({ file: file, now: time.now }),
  });
  var out = other.gate.evaluateLaunch(bug("trialview/v2#30"));
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "claim_held_elsewhere");
});

test("reconcile adopts claims whose work is still running and releases the rest", function () {
  var h = makeGate();
  assert.strictEqual(h.gate.evaluateLaunch(bug("trialview/v2#40")).decision, "execute");
  assert.strictEqual(h.gate.evaluateLaunch(bug("trialview/v2#41")).decision, "execute");

  h.clock.set(2000);
  var result = h.gate.reconcileClaims(["trialview/v2#40"]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.adopted, 1);
  assert.strictEqual(result.released, 1);

  // The adopted claim still blocks; the released one is free again.
  assert.strictEqual(h.gate.evaluateLaunch(bug("trialview/v2#40")).reason, "claim_already_active");
  assert.strictEqual(h.gate.evaluateLaunch(bug("trialview/v2#41")).decision, "execute");
});

test("reconcile never touches another holder's claim", function () {
  var h = makeGate();
  h.leases.acquire({
    projectRef: { projectId: PROJECT_A },
    key: gateModule.claimKeyFor("trialview/v2#50"),
    holder: "another-runtime",
    ttlMs: 5000,
  });
  h.gate.reconcileClaims([]);
  var survivor = h.leases.get({ projectId: PROJECT_A }, gateModule.claimKeyFor("trialview/v2#50"));
  assert.ok(survivor, "a foreign claim must survive reconciliation");
  assert.strictEqual(survivor.holder, "another-runtime");
});

// --- Audit --------------------------------------------------------------------

test("every decision is audited, including the legacy pass-through", function () {
  var h = makeGate();
  h.gate.evaluateLaunch(bug("trialview/v2#60"));
  h.gate.evaluateLaunch(feature("trialview/v2#61"));
  h.gate.evaluateExternal({ itemKey: "trialview/v2#60", externalKind: "merge" });
  var entries = h.gate.audit.read();
  assert.ok(entries.length >= 3);
  var decisions = {};
  for (var i = 0; i < entries.length; i++) decisions[entries[i].reason] = entries[i];
  assert.ok(decisions.policy_autonomous, "an autonomous launch must be audited");
  assert.ok(decisions.policy_requires_proposal, "a proposal must be audited");
  assert.strictEqual(decisions.policy_autonomous.projectId, PROJECT_A);
  assert.strictEqual(decisions.policy_autonomous.projectSlug, "webapp");
  assert.ok(decisions.policy_autonomous.policyDigest, "the policy digest must be recorded");

  var off = makeGate({ leadMode: false });
  off.gate.evaluateLaunch(bug("trialview/v2#62"));
  var legacy = off.gate.audit.read();
  assert.strictEqual(legacy[legacy.length - 1].reason, "lead_mode_off_legacy");
});

test("reconciliation is audited", function () {
  var h = makeGate();
  h.gate.reconcileClaims([]);
  var entries = h.gate.audit.read();
  assert.strictEqual(entries[entries.length - 1].type, "project_automation_reconcile");
});
