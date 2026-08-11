// Tests for the project automation gate — the boundary that makes Coop the
// only launcher.
//
// The invariant is structural rather than concurrent: under Lead mode ON a
// project controller cannot start work or grant external authority AT ALL. It
// discovers and proposes; Coop admits and dedupes through the canonical
// ProjectRef binding. There is one writer, so there is no race to lose.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var gateModule = require("../lib/project-automation-gate");
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

// Committed bindings the fixture is willing to attest, keyed taskId:revision.
var committedBindings = {};

function attestBinding(taskId, revision, overrides) {
  committedBindings[taskId + ":" + revision] = Object.assign({
    portfolioTaskId: taskId, bindingRevision: revision, status: "active",
    mode: "project_coordinator", targetProject: { projectId: PROJECT_A },
  }, overrides || {});
}

function makeGate(options) {
  var opts = options || {};
  var dir = opts.cwd || workspace([BUG_RECIPE]);
  var leadMode = opts.leadMode !== false;
  var candidates = [];
  var gate = gateModule.createAutomationGate({
    cwd: dir,
    slug: opts.slug || "webapp",
    projectRef: { projectId: opts.projectId || PROJECT_A },
    policyTtlMs: 0,
    getLeadMode: function () { return leadMode; },
    emitCandidate: function (candidate) {
      candidates.push(candidate);
      // Typed: a handoff that does not report success is now a failed handoff.
      return { ok: true, created: true, changed: true };
    },
    // External authorization is now PROVEN against a committed binding, so the
    // fixture must supply one rather than relying on shape.
    getExecutionBinding: function (taskId, revision) {
      return committedBindings[taskId + ":" + revision] || null;
    },
    audit: automationAudit.createAutomationAudit({
      file: path.join(dir, "audit.jsonl"), slug: "webapp",
    }),
  });
  return { gate: gate, dir: dir, candidates: candidates };
}

// Board fixtures are the owner's OWN assigned work, because that is the only
// work automatic pickup may consider at all. `assignedToOwner` is the proof
// project-task-sources stamps on each item; the unassigned case is covered
// deliberately by the ownership tests rather than leaking into every fixture.
function bug(key) {
  return { itemKey: key, item: { labels: [{ name: "bug" }] }, recipeKind: "issue",
    assignedToOwner: true };
}
function feature(key) {
  return { itemKey: key, item: { labels: [{ name: "feature" }] }, recipeKind: "issue",
    assignedToOwner: true };
}
function unlabeled(key) {
  return { itemKey: key, item: { labels: [] }, recipeKind: "issue",
    assignedToOwner: true };
}
function unassigned(key) {
  return { itemKey: key, item: { labels: [{ name: "bug" }] }, recipeKind: "issue",
    recipeType: "bug", assignedToOwner: false };
}
function evidence() {
  return { status: "completed", summary: "fixed", verification: "suite green", escalationRequired: "no" };
}

// --- Lead ON: propose, never launch ------------------------------------------

test("a project's own bug autonomy yields a candidate, never a launch", function () {
  var h = makeGate();
  var out = h.gate.evaluateLaunch(bug("trialview/v2#1"));
  assert.strictEqual(out.decision, "propose");
  assert.strictEqual(out.reason, "proposed_to_coop");
  assert.strictEqual(h.candidates.length, 1);
  // The project's own policy still decides HOW it may be admitted.
  assert.strictEqual(h.candidates[0].admission, "auto");
  assert.strictEqual(h.candidates[0].itemKey, "trialview/v2#1");
  assert.strictEqual(h.candidates[0].projectRef.projectId, PROJECT_A);
});

test("no launch decision can ever be execute under lead mode on", function () {
  var h = makeGate({ cwd: workspace([BUG_RECIPE, PR_RECIPE]) });
  var probes = [bug("a#1"), feature("a#2"), unlabeled("a#3"),
    { itemKey: "a#4", item: { labels: [{ name: "bug" }] }, recipeKind: "pr-reviews",
      assignedToOwner: true }];
  for (var i = 0; i < probes.length; i++) {
    assert.notStrictEqual(h.gate.evaluateLaunch(probes[i]).decision, "execute",
      "probe " + i + " must not authorize a local launch");
  }
});

test("feature and ambiguous work is proposed owner-gated", function () {
  var h = makeGate();
  var featured = h.gate.evaluateLaunch(feature("trialview/v2#2"));
  assert.strictEqual(featured.decision, "propose");
  assert.strictEqual(featured.requiresApproval, true);
  assert.strictEqual(h.candidates[0].admission, "owner_approval");

  var ambiguous = h.gate.evaluateLaunch(unlabeled("trialview/v2#3"));
  assert.strictEqual(ambiguous.requiresApproval, true);
});

test("the same item proposed twice yields two candidates and no local state", function () {
  var h = makeGate();
  h.gate.evaluateLaunch(bug("trialview/v2#4"));
  h.gate.evaluateLaunch(bug("trialview/v2#4"));
  // Dedupe is Coop's job via the canonical binding; the controller stays
  // stateless so there is nothing here to get out of sync.
  assert.strictEqual(h.candidates.length, 2);
  assert.strictEqual(h.candidates[0].candidateKey, h.candidates[1].candidateKey,
    "both must name the same work so Coop can dedupe them");
});

test("discovery is always allowed", function () {
  var h = makeGate();
  var out = h.gate.evaluateDiscovery({ recipeId: "assigned-to-me" });
  assert.strictEqual(out.decision, "execute");
  assert.strictEqual(out.reason, "discovery_always_allowed");
});

// --- Per-project policy isolation ------------------------------------------------

test("two projects with different policies produce different candidates", function () {
  var autonomous = makeGate({ cwd: workspace([BUG_RECIPE]), projectId: PROJECT_A });
  var restrictive = makeGate({ cwd: workspace([]), projectId: PROJECT_B, slug: "clay" });
  autonomous.gate.evaluateLaunch(bug("a#1"));
  restrictive.gate.evaluateLaunch(bug("b#1"));

  assert.strictEqual(autonomous.candidates[0].admission, "auto");
  assert.strictEqual(restrictive.candidates[0].admission, "owner_approval");
  assert.strictEqual(autonomous.candidates[0].projectRef.projectId, PROJECT_A);
  assert.strictEqual(restrictive.candidates[0].projectRef.projectId, PROJECT_B);
  assert.notStrictEqual(
    autonomous.gate.policyState().digest, restrictive.gate.policyState().digest);
});

test("PR-review work is never auto-admitted, even where bugs are", function () {
  var h = makeGate({ cwd: workspace([BUG_RECIPE, PR_RECIPE]) });
  h.gate.evaluateLaunch({
    itemKey: "trialview/v2#900", item: { labels: [{ name: "bug" }] }, recipeKind: "pr-reviews",
  });
  assert.strictEqual(h.candidates[0].admission, "owner_approval");
});

// --- Fail closed -------------------------------------------------------------------

test("a malformed project policy proposes nothing", function () {
  var dir = workspace([]);
  fs.writeFileSync(path.join(dir, ".clay", "tasks", "broken.json"), "{not json");
  var h = makeGate({ cwd: dir });
  var out = h.gate.evaluateLaunch(bug("x#1"));
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "policy_malformed");
  assert.strictEqual(h.candidates.length, 0);
});

test("an unusable ProjectRef proposes nothing", function () {
  var h = makeGate({ projectId: "not-a-project-id" });
  assert.strictEqual(h.gate.evaluateLaunch(bug("x#2")).reason, "invalid_project_ref");
  assert.strictEqual(h.candidates.length, 0);
});

// --- External actions need Coop's authorization ------------------------------------

test("an external action is refused without a canonical Coop binding", function () {
  var h = makeGate();
  var kinds = ["comment", "done_workflow", "merge", "close"];
  for (var i = 0; i < kinds.length; i++) {
    var out = h.gate.evaluateExternal({
      itemKey: "trialview/v2#10", externalKind: kinds[i],
      completion: evidence(), approval: { granted: true, by: "owner" },
      ownerTriggered: true,
    });
    assert.strictEqual(out.decision, "deny", kinds[i] + " must be refused locally");
    assert.strictEqual(out.reason, "coop_authorization_required");
  }
});

test("a Coop binding plus completion evidence authorizes an external action", function () {
  var h = makeGate();
  attestBinding("task-1", 1);
  var out = h.gate.evaluateExternal({
    itemKey: "trialview/v2#11", externalKind: "merge",
    coopAuthorization: { portfolioTaskId: "task-1", bindingRevision: 1 },
    completion: evidence(), approval: { granted: true, by: "owner" },
  });
  assert.strictEqual(out.decision, "execute");
});

test("a Coop binding still cannot skip completion evidence for merge or close", function () {
  var h = makeGate();
  attestBinding("task-1", 1);
  var kinds = ["merge", "close"];
  for (var i = 0; i < kinds.length; i++) {
    var out = h.gate.evaluateExternal({
      itemKey: "trialview/v2#12", externalKind: kinds[i],
      coopAuthorization: { portfolioTaskId: "task-1", bindingRevision: 1 },
      completion: null, approval: { granted: true, by: "owner" }, ownerTriggered: true,
    });
    assert.strictEqual(out.reason, "completion_evidence_required", kinds[i]);
  }
});

test("a malformed authorization is not an authorization", function () {
  var h = makeGate();
  var bogus = [{ portfolioTaskId: "t" }, { bindingRevision: 1 },
    { portfolioTaskId: "t", bindingRevision: 0 }, {}];
  for (var i = 0; i < bogus.length; i++) {
    assert.strictEqual(h.gate.evaluateExternal({
      itemKey: "x", externalKind: "merge", coopAuthorization: bogus[i],
      completion: evidence(), approval: { granted: true, by: "owner" },
    }).reason, "coop_authorization_required", "shape " + i);
  }
});

// --- Lead mode off: byte-for-byte legacy ---------------------------------------------

test("lead mode off executes, reads no policy and emits no candidate", function () {
  var dir = workspace([BUG_RECIPE]);
  var loads = 0;
  var candidates = [];
  var gate = gateModule.createAutomationGate({
    cwd: dir, slug: "off", projectRef: { projectId: PROJECT_A }, policyTtlMs: 0,
    getLeadMode: function () { return false; },
    loadPolicy: function () { loads++; return { ok: true, policy: null }; },
    emitCandidate: function (c) { candidates.push(c); },
    audit: automationAudit.createAutomationAudit({
      file: path.join(dir, "audit.jsonl"), slug: "off" }),
  });

  var launch = gate.evaluateLaunch(unlabeled("x#1"));
  assert.strictEqual(launch.decision, "execute");
  assert.strictEqual(launch.reason, "lead_mode_off_legacy");

  var external = gate.evaluateExternal({ itemKey: "x#1", externalKind: "merge" });
  assert.strictEqual(external.decision, "execute");
  assert.strictEqual(external.reason, "lead_mode_off_legacy");

  assert.strictEqual(loads, 0, "lead mode off must not read project policy");
  assert.deepStrictEqual(candidates, [], "lead mode off must not propose");
});

test("lead mode off works even when the project policy is broken", function () {
  var dir = workspace([]);
  fs.writeFileSync(path.join(dir, ".clay", "tasks", "broken.json"), "{not json");
  var h = makeGate({ cwd: dir, leadMode: false });
  assert.strictEqual(h.gate.evaluateLaunch(bug("x#3")).decision, "execute");
});

// --- Audit ----------------------------------------------------------------------------

test("every decision is audited, proposals included", function () {
  var h = makeGate();
  h.gate.evaluateLaunch(bug("trialview/v2#60"));
  h.gate.evaluateExternal({ itemKey: "trialview/v2#60", externalKind: "merge" });
  var entries = h.gate.audit.read();
  assert.ok(entries.length >= 2);
  var proposal = entries[0];
  assert.strictEqual(proposal.decision, "propose");
  assert.strictEqual(proposal.reason, "proposed_to_coop");
  assert.strictEqual(proposal.admission, "auto");
  assert.strictEqual(proposal.policyReason, "policy_autonomous",
    "the audit must still say why it was admissible");
  assert.strictEqual(proposal.projectId, PROJECT_A);
  assert.ok(proposal.policyDigest);
});

test("a candidate delivery failure is a typed denial, not a proposal", function () {
  var dir = workspace([BUG_RECIPE]);
  var gate = gateModule.createAutomationGate({
    cwd: dir, slug: "boom", projectRef: { projectId: PROJECT_A }, policyTtlMs: 0,
    getLeadMode: function () { return true; },
    emitCandidate: function () { throw new Error("delivery down"); },
    audit: automationAudit.createAutomationAudit({
      file: path.join(dir, "audit.jsonl"), slug: "boom" }),
  });
  var out = gate.evaluateLaunch(bug("x#9"));
  // A proposal nobody received is not a proposal. Reporting proposed_to_coop
  // here claimed the work had been handed over when no durable record existed.
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "candidate_delivery_threw");
  assert.strictEqual(out.handoffFailed, true);
  assert.strictEqual(out.candidate, null);
});

test("a sink that reports failure is a typed denial too", function () {
  var dir = workspace([BUG_RECIPE]);
  var gate = gateModule.createAutomationGate({
    cwd: dir, slug: "sink", projectRef: { projectId: PROJECT_A }, policyTtlMs: 0,
    getLeadMode: function () { return true; },
    emitCandidate: function () { return { ok: false, reason: "persistence_failed" }; },
    audit: automationAudit.createAutomationAudit({
      file: path.join(dir, "audit.jsonl"), slug: "sink" }),
  });
  var out = gate.evaluateLaunch(bug("x#10"));
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "persistence_failed");
});

test("no candidate sink at all is a denial rather than a silent success", function () {
  var dir = workspace([BUG_RECIPE]);
  var gate = gateModule.createAutomationGate({
    cwd: dir, slug: "nosink", projectRef: { projectId: PROJECT_A }, policyTtlMs: 0,
    getLeadMode: function () { return true; },
    audit: automationAudit.createAutomationAudit({
      file: path.join(dir, "audit.jsonl"), slug: "nosink" }),
  });
  assert.strictEqual(gate.evaluateLaunch(bug("x#11")).reason, "candidate_sink_unavailable");
});

// --- External authorization must be PROVEN, not shaped ------------------------

test("a fabricated task id cannot authorize a merge", function () {
  var h = makeGate();
  var out = h.gate.evaluateExternal({
    itemKey: "trialview/v2#12", externalKind: "merge",
    // Well-shaped and completely invented.
    coopAuthorization: { portfolioTaskId: "totally-made-up", bindingRevision: 1 },
    completion: evidence(), approval: { granted: true, by: "owner" },
    ownerTriggered: true,
  });
  assert.strictEqual(out.decision, "deny");
  assert.strictEqual(out.reason, "coop_authorization_unknown");
});

test("a reserved-but-uncommitted binding does not authorize", function () {
  var h = makeGate();
  attestBinding("task-pending", 1, { status: "pending" });
  assert.strictEqual(h.gate.evaluateExternal({
    itemKey: "x", externalKind: "merge",
    coopAuthorization: { portfolioTaskId: "task-pending", bindingRevision: 1 },
    completion: evidence(), approval: { granted: true, by: "owner" },
  }).reason, "coop_authorization_not_committed");
});

test("a binding for another project does not authorize this one", function () {
  var h = makeGate();
  attestBinding("task-foreign", 1, { targetProject: { projectId: PROJECT_B } });
  assert.strictEqual(h.gate.evaluateExternal({
    itemKey: "x", externalKind: "merge",
    coopAuthorization: { portfolioTaskId: "task-foreign", bindingRevision: 1 },
    completion: evidence(), approval: { granted: true, by: "owner" },
  }).reason, "coop_authorization_foreign_project");
});

test("a mismatched revision does not authorize", function () {
  var h = makeGate();
  attestBinding("task-rev", 1);
  assert.strictEqual(h.gate.evaluateExternal({
    itemKey: "x", externalKind: "merge",
    coopAuthorization: { portfolioTaskId: "task-rev", bindingRevision: 7 },
    completion: evidence(), approval: { granted: true, by: "owner" },
  }).reason, "coop_authorization_unknown");
});

test("the owner-triggered carve-out needs authentic provenance too", function () {
  var h = makeGate();
  // Owner-triggered done_workflow normally skips completion evidence — but only
  // on a real binding. A fabricated one must not unlock it.
  assert.strictEqual(h.gate.evaluateExternal({
    itemKey: "x", externalKind: "done_workflow", ownerTriggered: true,
    coopAuthorization: { portfolioTaskId: "invented", bindingRevision: 1 },
    completion: null, approval: { granted: true, by: "owner" },
  }).decision, "deny");

  attestBinding("task-real", 1);
  assert.strictEqual(h.gate.evaluateExternal({
    itemKey: "x", externalKind: "done_workflow", ownerTriggered: true,
    coopAuthorization: { portfolioTaskId: "task-real", bindingRevision: 1 },
    completion: null, approval: { granted: true, by: "owner" },
  }).decision, "execute");
});

test("without a binding reader nothing external is authorized", function () {
  var dir = workspace([BUG_RECIPE]);
  var gate = gateModule.createAutomationGate({
    cwd: dir, slug: "noreader", projectRef: { projectId: PROJECT_A }, policyTtlMs: 0,
    getLeadMode: function () { return true; },
    emitCandidate: function () { return { ok: true }; },
    audit: automationAudit.createAutomationAudit({
      file: path.join(dir, "audit.jsonl"), slug: "noreader" }),
  });
  assert.strictEqual(gate.evaluateExternal({
    itemKey: "x", externalKind: "merge",
    coopAuthorization: { portfolioTaskId: "t", bindingRevision: 1 },
    completion: evidence(), approval: { granted: true, by: "owner" },
  }).reason, "coop_authorization_unverifiable");
});
