// Board auto-launch recovery, against the REAL durable binding store.
//
// The unit tests in automation-candidate-admission.test.js stub the router.
// This one wires admission to lib/portfolio-execution-bindings so the reserve →
// release → re-arm → commit sequence is the production one, and asserts the
// property that actually matters to the board: an item whose delivery failed
// must launch on a later scan instead of being stranded.
//
// Live incident this reproduces: board issue trialview/v2#2725. Binding
// auto:344dd511172b31317028bdd4:trialview-v2-2725 r2 was released to "unrouted"
// at 1788343227520 and the candidate was marked "admitted" 16ms later at
// 1788343227536, so no coordinator ever existed and no later scan retried it.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var bindingsModule = require("../lib/portfolio-execution-bindings");
var { createCandidateStore } = require("../lib/project-automation-candidates");
var { createCandidateAdmission } = require("../lib/project-automation-admission");
var automationIdentity = require("../lib/project-automation-identity");
var policyModule = require("../lib/project-automation-policy");
var qualification = require("../lib/project-automation-qualification");

var WEBAPP = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
var PASS = "recovery-scan-pass";

function setup(failures, strandFirst) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-recovery-"));
  var store = createCandidateStore({ cwd: dir });
  var bindingStore = bindingsModule.createBindingStore({ file: path.join(dir, "bindings.json") });
  var recipe = { id: "assigned-to-me",
    source: { provider: "github", kind: "issue", repo: "trialview/v2", includeProjectItems: true },
    filter: { state: "open", assigned: "me", type: "bug" } };
  var policy = {
    projectRef: { projectId: WEBAPP }, derived: false,
    autonomy: { bug: "autonomous", feature: "owner_approval", ambiguous: "owner_approval",
      pr_review: "propose", default: "propose" },
    externalActions: { comment: "approval", done_workflow: "approval", merge: "approval",
      close: "approval" },
    boardExclusions: [],
    qualification: { version: 1, normalIssueIntake: {
      issueStates: ["open"], boardStatuses: ["Backlog", "Ready for development"],
      requireAllBoardItems: true, assignment: "owner",
      classification: { autonomous: ["bug"], ownerApproval: ["feature", "ambiguous"] } } },
    providerRules: { vendors: {} },
    recipes: [{ id: recipe.id, kind: "issue", repo: "trialview/v2", type: "bug",
      digest: policyModule.recipeDigest(recipe) }],
    sources: [],
  };
  policy.digest = policyModule.policyDigest(policy);
  function loadPolicy() { return { ok: true, policy: policy }; }

  var candidate = {
    candidateKey: "launch:trialview/v2#2725",
    itemKey: "trialview/v2#2725",
    itemClass: "bug",
    admission: "auto",
    projectRef: { projectId: WEBAPP },
    policyDigest: policy.digest,
    recipeId: "assigned-to-me",
    eligibilityPass: PASS,
    eligibility: { assignedToOwner: true, recipeAllowsUnassigned: false, reason: "assigned_to_owner" },
    intent: { recipeId: "assigned-to-me", number: 2725, url: "u", title: "board item", autoKind: "issue" },
  };
  candidate.qualificationReceipt = qualification.receiptFor({
    policy: policy, projectRef: candidate.projectRef,
    recipe: { id: recipe.id, digest: policyModule.recipeDigest(recipe), kind: "issue" },
    item: { number: 2725, state: "OPEN",
      projectItems: [{ id: "PVT_item_2725", status: { name: "Backlog" } }] },
    itemKey: candidate.itemKey, itemClass: candidate.itemClass,
    assignedToOwner: true, recipeAllowsUnassigned: false, now: 1000,
  }).receipt;

  // The target refuses the first delivery exactly as the live guard does
  // (project-task-orchestrator-external.js:291), then accepts.
  var deliveryAttempts = 0;
  function deliver() {
    deliveryAttempts++;
    if (deliveryAttempts <= failures) return { ok: false, reason: "active_binding_exists" };
    return { ok: true, sessionRef: { projectId: WEBAPP, sessionStorageId: "coordinator-1" } };
  }

  // The real createAndCommitExecution sequence, reduced to the store calls it makes.
  var crossProject = {
    coopSessionRef: function () { return { projectId: "system-lead", sessionStorageId: "coop-home" }; },
    getBinding: function (taskId, rev) { return bindingStore.get(taskId, rev); },
    getExecutionBindings: function () { return bindingStore.list().bindings || []; },
    createProjectExecution: function (request) {
      var reserved = bindingStore.reserve(request);
      if (!reserved.ok) return reserved;
      // Strand the reservation the way a crash between reserve() and commit()
      // does: the record stays "pending" with no coordinator and nothing
      // releases it.
      if (strandFirst && deliveryAttempts === 0) {
        deliveryAttempts++;
        return { ok: false, reason: "delivery_error" };
      }
      var delivered = deliver();
      if (!delivered.ok) {
        // createAndCommitExecution releases only a reservation THIS call
        // created; an observed one belongs to a concurrent caller.
        if (reserved.created) {
          bindingStore.releaseReservation(request.portfolioTaskId, request.bindingRevision,
            delivered.reason);
        }
        return { ok: false, reason: delivered.reason };
      }
      return bindingStore.commit(request.portfolioTaskId, request.bindingRevision,
        delivered.sessionRef, {});
    },
  };

  var admission = createCandidateAdmission({
    candidates: store,
    crossProject: crossProject,
    getLeadMode: function () { return true; },
    now: function () { return 1000; },
    loadPolicy: loadPolicy,
    resolveCoopSource: function () { return crossProject.coopSessionRef(); },
  });

  function pass() {
    store.upsert(candidate);
    return admission.admitPending({ eligibilityPass: PASS, maxAdmissions: 5 });
  }
  var taskId = automationIdentity.portfolioTaskIdFor(candidate);
  return {
    dir: dir, store: store, bindingStore: bindingStore, pass: pass,
    candidateKey: candidate.candidateKey, taskId: taskId,
    deliveries: function () { return deliveryAttempts; },
  };
}

test("#2725: a board item whose delivery failed relaunches on the next scan", function () {
  var h = setup(1);
  try {
    var first = h.pass();
    assert.strictEqual(first.admitted, 0, "nothing was delivered, so nothing was admitted");
    assert.strictEqual(h.bindingStore.get(h.taskId, 1).status, "unrouted");
    assert.strictEqual(h.store.get({ projectId: WEBAPP }, h.candidateKey).status, "pending",
      "the item must stay queued or no later scan can ever retry it");

    var second = h.pass();
    assert.strictEqual(second.admitted, 1, "the next scan must actually launch it");
    var binding = h.bindingStore.get(h.taskId, 1);
    assert.strictEqual(binding.status, "active");
    assert.strictEqual(binding.bindingRevision, 1,
      "recovery re-arms the same revision rather than inflating the history");
    assert.strictEqual(h.store.get({ projectId: WEBAPP }, h.candidateKey).status, "admitted");
    assert.strictEqual(h.deliveries(), 2, "exactly one retry -- never two coordinators");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2725: a board item that delivers first time launches once, with no retry", function () {
  var h = setup(0);
  try {
    var only = h.pass();
    assert.strictEqual(only.admitted, 1);
    assert.strictEqual(h.bindingStore.get(h.taskId, 1).status, "active");
    assert.strictEqual(h.deliveries(), 1, "the guard must not introduce a spurious retry");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2725: a reservation stranded at pending is not admission either", function () {
  // Same silent-strand class as the unrouted case, reached by a different route:
  // reserve() succeeded, the process died before commit(), and nothing released
  // the record -- so it sits at "pending" with no coordinator. Status "pending"
  // is not re-armable, so only the missing coordinator ref distinguishes it from
  // a live binding.
  var h = setup(99, true);
  try {
    h.pass();
    var stranded = h.bindingStore.get(h.taskId, 1);
    assert.strictEqual(stranded.status, "pending", "fixture: the reservation is stranded");
    assert.ok(!stranded.coordinator && !stranded.projectCoordinator,
      "fixture: no coordinator ever committed");

    var second = h.pass();
    assert.strictEqual(second.admitted, 0,
      "a reservation with no coordinator must never count as a completed admission");
    assert.strictEqual(second.attention[0].reason, "binding_never_routed");
    assert.strictEqual(h.store.get({ projectId: WEBAPP }, h.candidateKey).status, "pending",
      "the item must stay queued so a later scan can still launch it");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});
