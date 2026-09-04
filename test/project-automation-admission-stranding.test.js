// Regressions for silently stranded candidates (2026-09-04).
//
// Refusing stale scan evidence is correct: a durable candidate is a queue entry,
// not continuing authority, so only a candidate re-seen through every gate in
// the CURRENT scan may reach a binding. But the refusal was a bare `continue`,
// so nothing was written anywhere.
//
// Live consequence on webapp: 34 candidates sat `pending` and were skipped on
// every tick, while the real admission audit emitted ZERO records for over 32
// hours (last entry 2026-09-03T12:03) even though proposals kept flowing. A
// permanently stranded queue was indistinguishable from an empty one, which is
// how work went missing with nobody able to see it — and why the third attempt
// at this defect still had no evidence to read.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { createCandidateAdmission } = require("../lib/project-automation-admission");
var { createCandidateStore } = require("../lib/project-automation-candidates");
var automationAudit = require("../lib/project-automation-audit");
var policyModule = require("../lib/project-automation-policy");
var qualification = require("../lib/project-automation-qualification");

var WEBAPP = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
var TEST_PASS = "current-test-scan";

function testRecipe() {
  return {
    id: "assigned-to-me",
    source: { provider: "github", kind: "issue", repo: "trialview/v2", includeProjectItems: true },
    filter: { state: "open", assigned: "me", type: "bug" },
  };
}

function testPolicy(ref) {
  var recipe = testRecipe();
  var policy = {
    projectRef: ref || { projectId: WEBAPP },
    derived: false,
    autonomy: {
      bug: "autonomous", feature: "owner_approval", ambiguous: "owner_approval",
      pr_review: "propose", default: "propose",
    },
    externalActions: {
      comment: "approval", done_workflow: "approval", merge: "approval", close: "approval",
    },
    boardExclusions: [],
    qualification: {
      version: 1,
      normalIssueIntake: {
        issueStates: ["open"], boardStatuses: ["Backlog", "Ready for development"],
        requireAllBoardItems: true, assignment: "owner",
        classification: { autonomous: ["bug"], ownerApproval: ["feature", "ambiguous"] },
      },
    },
    providerRules: { vendors: {} },
    recipes: [{
      id: recipe.id, kind: "issue", repo: "trialview/v2", type: "bug",
      digest: policyModule.recipeDigest(recipe),
    }],
    sources: [],
  };
  policy.digest = policyModule.policyDigest(policy);
  return policy;
}

function candidate(overrides) {
  var value = Object.assign({
    candidateKey: "launch:trialview/v2#2517",
    itemKey: "trialview/v2#2517",
    itemClass: "bug",
    admission: "auto",
    projectRef: { projectId: WEBAPP },
    recipeId: "assigned-to-me",
    eligibilityPass: TEST_PASS,
    eligibility: {
      assignedToOwner: true, recipeAllowsUnassigned: false, reason: "assigned_to_owner",
    },
    intent: { recipeId: "assigned-to-me", number: 2517, url: "u", title: "t", autoKind: "issue" },
  }, overrides || {});
  value.policyDigest = testPolicy(value.projectRef).digest;
  var recipe = testRecipe();
  var created = qualification.receiptFor({
    policy: testPolicy(value.projectRef),
    projectRef: value.projectRef,
    recipe: { id: recipe.id, digest: policyModule.recipeDigest(recipe), kind: "issue" },
    item: {
      number: 2517, state: "OPEN",
      projectItems: [{ id: "PVT_item_2517", status: { name: "Backlog" } }],
    },
    itemKey: value.itemKey,
    itemClass: value.itemClass,
    assignedToOwner: true,
    recipeAllowsUnassigned: false,
    now: 1000,
  });
  assert.ok(created.ok, "fixture receipt must build: " + created.reason);
  value.qualificationReceipt = created.receipt;
  return value;
}

// A cross-project router that behaves like the real binding store.
function fakeCrossProject() {
  var bindings = [];
  return {
    coopSessionRef: function () {
      return { projectId: "system-lead", sessionStorageId: "coop-home-live" };
    },
    getBinding: function (portfolioTaskId, bindingRevision) {
      for (var i = 0; i < bindings.length; i++) {
        if (bindings[i].portfolioTaskId === portfolioTaskId &&
            bindings[i].bindingRevision === bindingRevision) return bindings[i];
      }
      return null;
    },
    getExecutionBindings: function () { return bindings.slice(); },
    createProjectExecution: function (input) {
      var binding = {
        portfolioTaskId: input.portfolioTaskId,
        bindingRevision: input.bindingRevision,
        mode: input.mode,
        idempotencyKey: input.idempotencyKey,
        targetProject: input.targetProject,
        status: "active",
        coordinator: {
          projectId: input.targetProject.projectId, sessionStorageId: "coordinator-1",
        },
      };
      bindings.push(binding);
      return { ok: true, binding: binding, session: { storageId: "coordinator-1" } };
    },
  };
}

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-strand-"));
  var store = createCandidateStore({ cwd: dir });
  var cross = fakeCrossProject();
  var admission = createCandidateAdmission({
    candidates: store,
    crossProject: cross,
    getLeadMode: function () { return true; },
    now: function () { return 1000; },
    loadPolicy: function (projectRef) { return { ok: true, policy: testPolicy(projectRef) }; },
    resolveCoopSource: function () { return cross.coopSessionRef(); },
    getBinding: function (a, b) { return cross.getBinding(a, b); },
    audit: automationAudit.createAutomationAudit({
      file: path.join(dir, "audit.jsonl"), slug: "webapp",
    }),
  });
  return { dir: dir, store: store, cross: cross, admission: admission };
}

function auditLines(dir) {
  try {
    return fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8")
      .split("\n").filter(Boolean).map(function (line) { return JSON.parse(line); });
  } catch (e) { return []; }
}

function strandedIn(dir) {
  return auditLines(dir).filter(function (r) { return r.stranded === true; });
}

test("a candidate skipped for stale evidence is durably visible, not silent", function () {
  var h = harness();
  try {
    h.store.upsert(candidate({ eligibilityPass: "a-previous-scan" }));
    var out = h.admission.admitPending({ eligibilityPass: TEST_PASS });

    assert.strictEqual(out.admitted, 0);
    assert.strictEqual(out.revalidationDeferred, 1);

    // Durable attention on the candidate itself — the thing an owner can see.
    var stored = h.store.list()[0];
    assert.ok(stored.attention, "a stranded candidate must carry attention");
    assert.strictEqual(stored.attention.reason, "current_eligibility_required");
    assert.strictEqual(stored.attention.needsOwner, false);

    // It stays pending: this is not a denial, it is unadmitted work.
    assert.strictEqual(stored.status, "pending");

    // And the pass is auditable rather than leaving an empty log.
    var stranded = strandedIn(h.dir);
    assert.strictEqual(stranded.length, 1, "the stranding must be audited");
    assert.strictEqual(stranded[0].reason, "current_eligibility_required");
    assert.strictEqual(stranded[0].itemKey, "trialview/v2#2517");
    assert.strictEqual(stranded[0].projectId, WEBAPP);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a candidate stranded for many ticks is loud once, not once per tick", function () {
  var h = harness();
  try {
    h.store.upsert(candidate({ eligibilityPass: "a-previous-scan" }));
    for (var i = 0; i < 10; i++) h.admission.admitPending({ eligibilityPass: TEST_PASS });

    // One durable record whose count carries the persistence — not ten records,
    // and not a fresh audit line every five minutes forever. Loud is the
    // requirement; a storm is the failure this codebase already knows about.
    var stored = h.store.list()[0];
    assert.strictEqual(stored.attention.reason, "current_eligibility_required");
    assert.strictEqual(stored.attention.count, 10);
    assert.strictEqual(strandedIn(h.dir).length, 1,
      "10 identical passes must audit once, got " + strandedIn(h.dir).length);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a candidate re-seen by the current scan is admitted, never left stranded", function () {
  var h = harness();
  try {
    h.store.upsert(candidate({ eligibilityPass: "a-previous-scan" }));
    h.admission.admitPending({ eligibilityPass: TEST_PASS });
    assert.ok(h.store.list()[0].attention, "precondition: it starts stranded");

    // The next scan re-proposes it with current evidence, which is the only
    // thing that may grant admission. Making the strand visible must not have
    // made it permanent.
    h.store.upsert(candidate({}));
    var out = h.admission.admitPending({ eligibilityPass: TEST_PASS });
    assert.strictEqual(out.admitted, 1, "current evidence must admit");
    assert.strictEqual(h.store.list()[0].status, "admitted");
    assert.ok(h.store.list()[0].binding, "admission must leave a typed binding");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});
