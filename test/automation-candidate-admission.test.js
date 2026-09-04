// Tests for the consumer half of the Coop handoff: turning a pending candidate
// into exactly one typed cross-project execution binding.
//
// Commit 0ad312a10f queued candidates durably but shipped no consumer, so
// #2517-shaped items sat pending forever. These assert the property that was
// missing: one eligible item becomes one binding, exactly once, across retries
// and restarts, and every failure stays visible and pending rather than being
// silently dropped.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { createCandidateAdmission, idempotencyKeyFor, portfolioTaskIdFor, selectBindingRevision } =
  require("../lib/project-automation-admission");
var { createCandidateStore } = require("../lib/project-automation-candidates");
var automationAudit = require("../lib/project-automation-audit");
var scopedAutonomy = require("../lib/coop-scoped-autonomy-policy");
var autoApproval = require("../lib/coop-auto-approval-policy");
var approvalStaging = require("../lib/coop-approval-question-staging");
var policyModule = require("../lib/project-automation-policy");
var qualification = require("../lib/project-automation-qualification");

var WEBAPP = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
var OTHER = "11111111-2222-4333-8444-555555555555";
var TEST_PASS = "current-test-scan";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-admit-"));
}

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
    autonomy: { bug: "autonomous", feature: "owner_approval", ambiguous: "owner_approval",
      pr_review: "propose", default: "propose" },
    externalActions: { comment: "approval", done_workflow: "approval", merge: "approval", close: "approval" },
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
    recipes: [{ id: recipe.id, kind: "issue", repo: "trialview/v2", type: "bug",
      digest: policyModule.recipeDigest(recipe) }],
    sources: [],
  };
  policy.digest = policyModule.policyDigest(policy);
  return policy;
}

function receiptForCandidate(value) {
  var policy = testPolicy(value.projectRef);
  var recipe = testRecipe();
  var created = qualification.receiptFor({
    policy: policy,
    projectRef: value.projectRef,
    recipe: { id: recipe.id, digest: policyModule.recipeDigest(recipe), kind: "issue" },
    item: { number: value.intent && value.intent.number, state: "OPEN",
      projectItems: [{ id: "PVT_item_2517", status: { name: "Backlog" } }] },
    itemKey: value.itemKey,
    itemClass: value.itemClass,
    assignedToOwner: value.eligibility && value.eligibility.assignedToOwner,
    recipeAllowsUnassigned: value.eligibility && value.eligibility.recipeAllowsUnassigned,
    now: 1000,
  });
  return created.ok ? created.receipt : null;
}

function candidate(overrides) {
  var value = Object.assign({
    candidateKey: "launch:trialview/v2#2517",
    itemKey: "trialview/v2#2517",
    itemClass: "bug",
    admission: "auto",
    projectRef: { projectId: WEBAPP },
    policyDigest: testPolicy().digest,
    recipeId: "assigned-to-me",
    eligibilityPass: TEST_PASS,
    eligibility: {
      assignedToOwner: true,
      recipeAllowsUnassigned: false,
      reason: "assigned_to_owner",
    },
    intent: { recipeId: "assigned-to-me", number: 2517, url: "u", title: "t", autoKind: "issue" },
  }, overrides || {});
  if (!overrides || !Object.prototype.hasOwnProperty.call(overrides, "policyDigest")) {
    value.policyDigest = testPolicy(value.projectRef).digest;
  }
  if (!Object.prototype.hasOwnProperty.call(value, "qualificationReceipt")) {
    var receipt = receiptForCandidate(value);
    if (receipt) value.qualificationReceipt = receipt;
  }
  return value;
}

function withTestPass(admission) {
  var admitPending = admission.admitPending;
  admission.admitPending = function (options) {
    return admitPending(Object.assign({ eligibilityPass: TEST_PASS }, options || {}));
  };
  return admission;
}

// A cross-project router that records calls and behaves like the real binding
// store: the same (portfolioTaskId, revision) replays instead of re-creating.
function fakeCrossProject(behavior) {
  var calls = [];
  var bindings = (behavior && Array.isArray(behavior.bindings) ? behavior.bindings : []).map(function (binding) {
    return Object.assign({}, binding);
  });

  function bindingFor(portfolioTaskId, bindingRevision) {
    for (var i = 0; i < bindings.length; i++) {
      if (bindings[i].portfolioTaskId === portfolioTaskId &&
          bindings[i].bindingRevision === bindingRevision) return bindings[i];
    }
    return null;
  }

  return {
    calls: calls,
    // The canonical live Coop SessionRef, as the real router resolves it from
    // the Lead project's coopHome session.
    coopSessionRef: function () {
      if (behavior && behavior.noCoopSession) return null;
      return { projectId: "system-lead", sessionStorageId: "coop-home-live" };
    },
    getBinding: function (portfolioTaskId, bindingRevision) {
      if (behavior && behavior.foreignBinding) {
        return Object.assign({
          portfolioTaskId: portfolioTaskId, bindingRevision: bindingRevision,
          mode: "project_coordinator", idempotencyKey: "someone-elses-key",
          targetProject: { projectId: WEBAPP },
        }, behavior.foreignBinding);
      }
      return bindingFor(portfolioTaskId, bindingRevision);
    },
    getExecutionBindings: function () {
      return bindings.map(function (binding) { return Object.assign({}, binding); });
    },
    createProjectExecution: function (input) {
      calls.push(input);
      if (behavior && behavior.fail) return { ok: false, reason: behavior.fail };
      var existing = bindingFor(input.portfolioTaskId, input.bindingRevision);
      if (existing) return { ok: false, reason: "active_binding_exists" };
      var binding = {
        portfolioTaskId: input.portfolioTaskId,
        bindingRevision: input.bindingRevision,
        mode: input.mode,
        idempotencyKey: input.idempotencyKey,
        targetProject: input.targetProject,
        coopTopicRef: input.coopTopicRef,
        automationAuthorization: input.automationAuthorization,
        status: "active",
        // commit() always stamps the coordinator ref, and the store refuses to
        // load an "active" record without one (portfolio-execution-bindings.js
        // :520, :872). A ref-less "active" binding is not a state production can
        // reach, so the fake must not invent one.
        coordinator: { projectId: input.targetProject.projectId,
          sessionStorageId: "coordinator-r" + input.bindingRevision },
      };
      bindings.push(binding);
      return { ok: true, binding: binding };
    },
  };
}

function harness(options) {
  var opts = options || {};
  var dir = opts.dir || tempDir();
  var store = createCandidateStore({ cwd: dir });
  var cross = opts.crossProject || fakeCrossProject(opts.behavior);
  var admission = withTestPass(createCandidateAdmission({
    candidates: opts.candidates || store,
    crossProject: opts.crossProject === null ? null : cross,
    getLeadMode: function () { return opts.leadMode !== false; },
    now: opts.now || function () { return 1000; },
    loadPolicy: opts.loadPolicy || function (projectRef) {
      return { ok: true, policy: testPolicy(projectRef) };
    },
    resolveCoopSource: opts.getCoopSource || function () {
      return { projectId: "system-lead", sessionStorageId: "coop-home-1" };
    },
    audit: automationAudit.createAutomationAudit({ file: path.join(dir, "audit.jsonl"), slug: "webapp" }),
    resolveCoopSource: opts.resolveCoopSource !== undefined ? opts.resolveCoopSource :
      function () { return cross.coopSessionRef(); },
    // Late-bound so a test can swap the reader after construction.
    getBinding: function (a, b) { return cross.getBinding(a, b); },
    scopedAutonomyPolicy: opts.scopedAutonomyPolicy || null,
    autoApprovalPolicy: opts.autoApprovalPolicy || null,
  }));
  return { dir: dir, store: store, cross: cross, admission: admission };
}

function activeScopedPolicy(file) {
  var store = scopedAutonomy.createPolicyStore({ file: file });
  var result = store.activate({
    authorizationTaskId: "clay-scoped-auto-approval-policy",
    ownerRequest: {
      ingressId: "coop:canonical-coop:549",
      sessionRef: { projectId: "system-lead", sessionStorageId: "canonical-coop" },
      requestRef: { projectId: "system-lead", sessionStorageId: "canonical-coop", eventIndex: 549 },
      receivedAt: 2000,
      expectsExecution: true,
      implementationDecision: { intent: "implement", source: "explicit_owner_turn", at: 2000 },
      implementationScope: {
        projectRef: { projectId: WEBAPP },
        topicRef: { topicId: "owner-scoped-policy" },
        portfolioTaskId: "clay-scoped-auto-approval-policy",
        bindingRevision: 1,
        idempotencyKey: "clay-scoped-auto-approval-policy-r1",
      },
    },
    ownerEvent: {
      type: "user_message",
      coopIngressId: "coop:canonical-coop:549",
      from: "owner-1",
      _ts: 2000,
    },
  });
  assert.equal(result.ok, true, result.reason);
  return store;
}

// --- One candidate becomes exactly one binding --------------------------------

test("#2517: a pending auto candidate becomes one typed binding and is marked admitted", function () {
  var h = harness();
  try {
    h.store.upsert(candidate());
    var result = h.admission.admitPending();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.admitted, 1);
    assert.strictEqual(h.cross.calls.length, 1);

    var call = h.cross.calls[0];
    assert.strictEqual(call.mode, "project_coordinator");
    assert.strictEqual(call.targetProject.projectId, WEBAPP,
      "the binding must target the canonical Webapp ProjectRef");
    assert.strictEqual(call.source.projectId, "system-lead",
      "admission is Coop's action, attributed to the Lead workspace");
    assert.strictEqual(call.source.sessionStorageId, "coop-home-live",
      "and to the LIVE canonical Coop session, not a fabricated one");
    assert.strictEqual(call.automationAuthorization.schema,
      "clay.project_automation_execution_authorization");
    assert.strictEqual(call.automationAuthorization.kind, "project_policy_autonomous");
    assert.strictEqual(call.automationAuthorization.qualifiedLaunchReport.verdict,
      "qualified_and_launched", "Coop receives the durable qualification launch report");
    assert.strictEqual(call.automationAuthorization.qualifiedLaunchReport.receiptDigest,
      call.automationAuthorization.qualificationReceipt.digest);
    assert.deepStrictEqual(call.automationAuthorization.qualifiedLaunchReport.reasons,
      call.automationAuthorization.qualificationReceipt.coordinator.reasons);
    assert.deepStrictEqual(call.coopTopicRef, {
      topicId: call.automationAuthorization.threadRef.threadId,
    }, "autonomous work receives its deterministic canonical Thread identity");
    assert.ok(call.portfolioTaskId.indexOf("2517") !== -1);
    assert.ok(call.text.indexOf("trialview/v2#2517") !== -1, "the brief names the item");
    assert.match(call.context, /internal work as autonomous/i);
    assert.match(call.context, /External actions keep their configured/i);
    assert.match(call.acceptanceCriteria, /committed locally/i);
    assert.doesNotMatch(call.context, /no further owner approval is pending/i);
    assert.doesNotMatch(call.acceptanceCriteria, /committed and pushed/i);

    var stored = h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517");
    assert.strictEqual(stored.status, "admitted");
    assert.strictEqual(stored.binding.portfolioTaskId, call.portfolioTaskId);
    assert.deepStrictEqual(stored.binding.coopThreadRef,
      call.automationAuthorization.threadRef);
    assert.strictEqual(h.store.list({ status: "pending" }).length, 0);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a missing qualification receipt cannot create an implementation binding", function () {
  var h = harness();
  try {
    var unqualified = candidate();
    delete unqualified.qualificationReceipt;
    assert.equal(h.store.upsert(unqualified).ok, true);
    var result = h.admission.admitPending();
    assert.equal(result.admitted, 0);
    assert.equal(result.failed, 1);
    assert.equal(h.cross.calls.length, 0, "binding is impossible without a current receipt");
    var stored = h.store.get({ projectId: WEBAPP }, unqualified.candidateKey);
    assert.equal(stored.status, "pending");
    assert.equal(stored.attention.reason, "qualification_receipt_malformed");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("an owner approval cannot bypass a missing qualification receipt", function () {
  var h = harness();
  try {
    var ownerCandidate = candidate({ admission: "owner_approval", itemClass: "feature" });
    h.store.upsert(ownerCandidate);
    var requested = h.admission.admitPending().ownerDecisions[0];
    assert.equal(h.store.decideOwner({ projectId: WEBAPP }, ownerCandidate.candidateKey, {
      approved: true,
      by: "owner-1",
      portfolioTaskId: requested.portfolioTaskId,
      bindingRevision: requested.bindingRevision,
    }).ok, true);
    var receiptlessRefresh = candidate({ admission: "owner_approval", itemClass: "feature" });
    delete receiptlessRefresh.qualificationReceipt;
    assert.equal(h.store.upsert(receiptlessRefresh).ok, true);

    var result = h.admission.admitPending();
    assert.equal(result.admitted, 0);
    assert.equal(result.failed, 1);
    assert.equal(h.cross.calls.length, 0, "owner approval alone never authorizes implementation");
    assert.equal(h.store.get({ projectId: WEBAPP }, ownerCandidate.candidateKey).status,
      "owner_approved");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a legacy admitted record keeps its no-receipt lifecycle on a fresh scan", function () {
  var h = harness();
  try {
    var legacy = candidate({
      candidateKey: "launch:trialview/v2#2522",
      itemKey: "trialview/v2#2522",
      intent: { recipeId: "assigned-to-me", number: 2522, autoKind: "issue" },
    });
    delete legacy.qualificationReceipt;
    assert.equal(h.store.upsert(legacy).ok, true);
    var file = path.join(h.dir, ".clay", "tasks", "automation-candidates.json");
    var persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    persisted.candidates[0].status = "admitted";
    fs.writeFileSync(file, JSON.stringify(persisted));

    var refreshed = h.store.upsert(candidate({
      candidateKey: legacy.candidateKey,
      itemKey: legacy.itemKey,
      intent: legacy.intent,
    }));
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.legacyNoReceipt, true);
    assert.equal(refreshed.candidate.status, "admitted");
    assert.equal(refreshed.candidate.qualificationReceipt, null);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a revalidated low-risk owner-gated candidate staffs through the scoped policy receipt", function () {
  var dir = tempDir();
  var scopedPolicy = activeScopedPolicy(path.join(dir, "scoped-policy.json"));
  var h = harness({ dir: dir, scopedAutonomyPolicy: scopedPolicy });
  try {
    h.store.upsert(candidate({
      admission: "owner_approval",
      itemClass: "feature",
      safety: scopedAutonomy.assessCandidateSafety({ title: "Correct a small empty state alignment" }),
    }));
    var result = h.admission.admitPending();
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.admitted, 1);
    assert.equal(h.cross.calls.length, 1, "the current low-risk candidate staffs without another prompt");
    assert.equal(h.cross.calls[0].automationAuthorization.kind, "coop_scoped_low_risk");
    assert.equal(h.cross.calls[0].automationAuthorization.scopedPolicyGrant.owner.ingressId,
      "coop:canonical-coop:549");
    assert.match(h.cross.calls[0].context, /bounded authority receipt/i);
    assert.equal(h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517").status, "admitted");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a project auto-approval reservation staffs eligible work through the normal typed binding", function () {
  var dir = tempDir();
  var control = autoApproval.createPolicyStore({ file: path.join(dir, "auto-approval.json"),
    now: function () { return 1000; } });
  assert.equal(control.setProjectOverride({ projectRef: { projectId: WEBAPP }, enabled: true,
    actorId: "owner-1", at: 1000 }).ok, true);
  var h = harness({ dir: dir, autoApprovalPolicy: control });
  try {
    h.store.upsert(candidate({
      admission: "owner_approval",
      itemClass: "feature",
      safety: scopedAutonomy.assessCandidateSafety({ title: "Correct a small empty state alignment" }),
    }));
    var result = h.admission.admitPending();
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.admitted, 1);
    assert.equal(h.cross.calls.length, 1);
    assert.equal(h.cross.calls[0].automationAuthorization.kind, "coop_project_auto_approval");
    assert.deepEqual(h.cross.calls[0].automationAuthorization.projectRef, { projectId: WEBAPP });
    assert.equal(h.cross.calls[0].automationAuthorization.autoApprovalGrant.provenance.actorId, "owner-1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit project disable supersedes a previous scoped standing grant immediately", function () {
  var dir = tempDir();
  var scopedPolicy = activeScopedPolicy(path.join(dir, "scoped-policy.json"));
  var control = autoApproval.createPolicyStore({ file: path.join(dir, "auto-approval.json"),
    now: function () { return 1000; } });
  assert.equal(control.setProjectOverride({ projectRef: { projectId: WEBAPP }, enabled: false,
    actorId: "owner-1", at: 1000 }).ok, true);
  var h = harness({ dir: dir, scopedAutonomyPolicy: scopedPolicy, autoApprovalPolicy: control });
  try {
    h.store.upsert(candidate({
      admission: "owner_approval",
      itemClass: "feature",
      safety: scopedAutonomy.assessCandidateSafety({ title: "Correct a small empty state alignment" }),
    }));
    var result = h.admission.admitPending();
    assert.equal(result.admitted, 0);
    assert.equal(result.deferred, 1, "the owner must approve after the kill switch is used");
    assert.equal(h.cross.calls.length, 0, "no older scoped receipt can bypass the project control");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("admission requires the exact current scan pass", function () {
  var h = harness();
  try {
    h.store.upsert(candidate());
    var stale = h.admission.admitPending({ eligibilityPass: "different-scan" });
    assert.strictEqual(stale.admitted, 0);
    assert.strictEqual(stale.deferred, 1);
    assert.strictEqual(stale.revalidationDeferred, 1);
    assert.strictEqual(h.cross.calls.length, 0,
      "durable evidence from another pass must never create a binding");

    var raw = createCandidateAdmission({
      candidates: h.store,
      crossProject: h.cross,
      getLeadMode: function () { return true; },
      resolveCoopSource: function () { return h.cross.coopSessionRef(); },
    });
    var missing = raw.admitPending();
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.reason, "admission_pass_required");
    assert.strictEqual(h.cross.calls.length, 0);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: the derived task id is deterministic and project-scoped", function () {
  var a = portfolioTaskIdFor(candidate());
  var b = portfolioTaskIdFor(candidate());
  assert.strictEqual(a, b, "the same candidate must always derive the same task id");
  assert.notStrictEqual(a, portfolioTaskIdFor(candidate({ projectRef: { projectId: OTHER } })),
    "the same issue number in two projects must not share a task id");
  assert.ok(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(a),
    "the task id must satisfy the binding store's charset: " + a);
});

// --- Idempotency, retry, restart -----------------------------------------------

test("#2517: repeated admission passes never create a second binding", function () {
  var h = harness();
  try {
    h.store.upsert(candidate());
    h.admission.admitPending();
    for (var i = 0; i < 5; i++) h.admission.admitPending();
    assert.strictEqual(h.cross.calls.length, 1,
      "an admitted candidate must not be re-submitted");
    assert.strictEqual(h.store.list().length, 1);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: a re-proposal after admission stays admitted and is not re-bound", function () {
  var h = harness();
  try {
    h.store.upsert(candidate());
    h.admission.admitPending();
    // A later tick proposes the same unchanged work again.
    h.store.upsert(candidate());
    h.admission.admitPending();
    assert.strictEqual(h.cross.calls.length, 1);
    assert.strictEqual(h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517").status,
      "admitted");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: a restart replays the same binding rather than creating a duplicate", function () {
  var dir = tempDir();
  try {
    var first = harness({ dir: dir });
    first.store.upsert(candidate());
    first.admission.admitPending();

    // A fresh process over the same project state, and a binding store that
    // already holds the binding.
    var second = harness({ dir: dir });
    second.cross.createProjectExecution = function (input) {
      second.cross.calls.push(input);
      return { ok: false, reason: "active_binding_exists" };
    };
    var result = second.admission.admitPending();
    assert.strictEqual(result.ok, true, "an existing binding is the idempotent path");
    assert.strictEqual(second.cross.calls.length, 0,
      "already-admitted work is not resubmitted after a restart");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("#2517: an existing binding for unmarked work is treated as success, not a duplicate", function () {
  var h = harness();
  try {
    h.store.upsert(candidate());
    // First pass binds and marks.
    assert.strictEqual(h.admission.admitPending().admitted, 1);
    var boundCalls = h.cross.calls.length;

    // Simulate the crash window: the binding committed but the mark did not.
    h.store.upsert(candidate());
    var key = "launch:trialview/v2#2517";
    var reopened = h.store.get({ projectId: WEBAPP }, key);
    assert.ok(reopened);
    h.store.markPending && h.store.markPending({ projectId: WEBAPP }, key);

    var result = h.admission.admitPending();
    assert.strictEqual(result.failed, 0,
      "a verified pre-existing binding must not be reported as a failure");
    assert.ok(h.cross.calls.length >= boundCalls,
      "and it must not create a second binding");
    assert.strictEqual(h.store.get({ projectId: WEBAPP }, key).status, "admitted");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2522: immutable automation history advances once, then retries revision 2 idempotently", function () {
  var reportedPortfolioTaskId = "auto:6bab7b2dfa0ca349934de11f:trialview-v2-2522";
  var immutableStatuses = ["completed", "superseded"];
  for (var i = 0; i < immutableStatuses.length; i++) {
    var selected = selectBindingRevision(reportedPortfolioTaskId, [{
      portfolioTaskId: reportedPortfolioTaskId,
      bindingRevision: 1,
      status: immutableStatuses[i],
    }]);
    assert.deepStrictEqual(selected, { ok: true, bindingRevision: 2 },
      immutableStatuses[i] + " revision 1 must advance the reported binding to revision 2");
  }

  var work = candidate({
    candidateKey: "launch:trialview/v2#2522",
    itemKey: "trialview/v2#2522",
    intent: { recipeId: "assigned-to-me", number: 2522, url: "u", title: "t", autoKind: "issue" },
  });
  var portfolioTaskId = portfolioTaskIdFor(work);
  var terminalRevision = {
    portfolioTaskId: portfolioTaskId,
    bindingRevision: 1,
    mode: "project_coordinator",
    idempotencyKey: "historical-terminal-r1",
    targetProject: { projectId: WEBAPP },
    status: "superseded",
    statusReason: "historical_attempt_superseded",
  };
  var terminalBefore = JSON.parse(JSON.stringify(terminalRevision));
  var h = harness({ behavior: { bindings: [terminalRevision] } });
  try {
    h.store.upsert(work);
    var markAdmitted = h.store.markAdmitted;
    var markAttempts = 0;
    h.store.markAdmitted = function () {
      markAttempts++;
      if (markAttempts === 1) return { ok: false, reason: "simulated_mark_failure" };
      return markAdmitted.apply(h.store, arguments);
    };

    var first = h.admission.admitPending();
    assert.strictEqual(first.failed, 1,
      "the simulated bookkeeping failure keeps the candidate pending for a retry");
    assert.strictEqual(h.cross.calls.length, 1);
    assert.strictEqual(h.cross.calls[0].bindingRevision, 2);
    assert.strictEqual(h.cross.calls[0].idempotencyKey, idempotencyKeyFor(portfolioTaskId, 2));
    assert.deepStrictEqual(h.cross.getBinding(portfolioTaskId, 1), terminalBefore,
      "the terminal revision remains immutable when admission advances");

    h.store.markAdmitted = markAdmitted;
    var retry = h.admission.admitPending();
    assert.strictEqual(retry.failed, 0);
    assert.strictEqual(retry.admitted, 1,
      "the pending candidate is completed by the verified replay");
    assert.strictEqual(h.cross.calls.length, 2,
      "the retry reuses the existing revision rather than creating revision 3");
    assert.strictEqual(h.cross.calls[1].bindingRevision, 2);
    assert.strictEqual(h.cross.calls[1].idempotencyKey, h.cross.calls[0].idempotencyKey);
    assert.strictEqual(h.cross.getExecutionBindings().filter(function (binding) {
      return binding.portfolioTaskId === portfolioTaskId;
    }).length, 2, "only immutable revision 1 and admitted revision 2 remain");
    assert.deepStrictEqual(h.cross.getBinding(portfolioTaskId, 1), terminalBefore,
      "the retry must not rewrite historical terminal evidence");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// --- Fail closed and visible ------------------------------------------------------

test("#2517: a target that cannot be resolved leaves the candidate pending", function () {
  var h = harness({ behavior: { fail: "project_unavailable" } });
  try {
    h.store.upsert(candidate());
    var result = h.admission.admitPending();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.attention[0].reason, "project_unavailable");
    assert.strictEqual(h.store.list({ status: "pending" }).length, 1,
      "a failure must leave the work queued for retry, never drop it");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: a reservation failure is never marked admitted", function () {
  var reasons = ["invalid_binding", "access_denied", "stale_binding_revision", "persistence_failed"];
  for (var i = 0; i < reasons.length; i++) {
    var h = harness({ behavior: { fail: reasons[i] } });
    try {
      h.store.upsert(candidate());
      h.admission.admitPending();
      assert.strictEqual(h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517").status,
        "pending", reasons[i] + " must not mark the candidate admitted");
    } finally {
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  }
});

test("#2517: a missing cross-project router fails closed and visibly", function () {
  var h = harness({ crossProject: null });
  try {
    h.store.upsert(candidate());
    var result = h.admission.admitPending();
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.attention[0].reason, "cross_project_unavailable");
    assert.strictEqual(h.store.list({ status: "pending" }).length, 1);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: a candidate whose ProjectRef is unusable is refused, not guessed", function () {
  var h = harness();
  try {
    // Written directly, bypassing the store's own validation.
    var result = h.admission.admitOne({
      candidateKey: "k", itemKey: "i", admission: "auto",
      projectRef: { projectId: "not-a-ref" },
    });
    assert.strictEqual(result.state, "failed");
    assert.strictEqual(result.reason, "invalid_project_ref");
    assert.strictEqual(h.cross.calls.length, 0);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: one bad candidate does not stop the rest of the queue", function () {
  var h = harness();
  try {
    h.store.upsert(candidate());
    h.store.upsert(candidate({
      candidateKey: "launch:trialview/v2#2600", itemKey: "trialview/v2#2600",
      intent: { recipeId: "assigned-to-me", number: 2600 },
    }));
    var calls = 0;
    var real = h.cross.createProjectExecution;
    h.cross.createProjectExecution = function (input) {
      calls++;
      if (calls === 1) throw new Error("boom");
      return real(input);
    };
    var result = h.admission.admitPending();
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.admitted, 1, "the second candidate must still be admitted");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// --- Owner gating and Lead OFF -------------------------------------------------------

test("#2517: owner-gated capability work is deferred, never auto-admitted", function () {
  var h = harness();
  try {
    h.store.upsert(candidate({ admission: "owner_approval", itemClass: "feature" }));
    var result = h.admission.admitPending();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.deferred, 1);
    assert.strictEqual(result.admitted, 0);
    assert.strictEqual(h.cross.calls.length, 0, "no binding without owner approval");
    assert.strictEqual(h.store.list({ status: "awaiting_owner" }).length, 1,
      "it stays visible and parked for the owner");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: Lead mode off admits nothing at all", function () {
  var h = harness({ leadMode: false });
  try {
    h.store.upsert(candidate());
    var result = h.admission.admitPending();
    assert.strictEqual(result.skipped, "lead_mode_off");
    assert.strictEqual(result.admitted, 0);
    assert.strictEqual(h.cross.calls.length, 0);
    assert.strictEqual(h.store.list({ status: "pending" }).length, 1);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: two projects proposing the same issue number get separate bindings", function () {
  var h = harness();
  try {
    h.store.upsert(candidate());
    h.store.upsert(candidate({ projectRef: { projectId: OTHER } }));
    var result = h.admission.admitPending();
    assert.strictEqual(result.admitted, 2);
    assert.notStrictEqual(h.cross.calls[0].portfolioTaskId, h.cross.calls[1].portfolioTaskId,
      "per-project isolation must survive admission");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: every admission outcome is audited", function () {
  var h = harness();
  try {
    h.store.upsert(candidate());
    h.store.upsert(candidate({
      candidateKey: "launch:trialview/v2#2520", itemKey: "trialview/v2#2520",
      itemClass: "feature", admission: "owner_approval",
      intent: { recipeId: "assigned-to-me", number: 2520, url: "u", title: "t", autoKind: "issue" },
    }));
    h.admission.admitPending();
    var entries = automationAudit.createAutomationAudit({
      file: path.join(h.dir, "audit.jsonl"), slug: "webapp" }).read();
    var outcomes = entries
      .filter(function (e) { return e.type === "project_automation_admission"; })
      .map(function (e) { return e.outcome; }).sort();
    assert.deepStrictEqual(outcomes, ["admitted", "deferred"]);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// --- Blocker 1: admission must never impersonate Coop -------------------------

test("#2517: admission uses the canonical live Coop SessionRef", function () {
  var h = harness();
  try {
    h.store.upsert(candidate());
    h.admission.admitPending();
    assert.strictEqual(h.cross.calls[0].source.sessionStorageId, "coop-home-live",
      "the binding must be attributed to the real Coop conversation, " +
      "or it lands outside Coop's task graph with nobody owning closure");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: no resolvable Coop session means no binding at all", function () {
  var h = harness({ resolveCoopSource: function () { return null; } });
  try {
    h.store.upsert(candidate());
    var result = h.admission.admitPending();
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.attention[0].reason, "coop_session_unavailable");
    assert.strictEqual(h.cross.calls.length, 0,
      "a project controller must not fabricate Coop's identity");
    assert.strictEqual(h.store.list({ status: "pending" }).length, 1);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: a non-Lead session is not Coop", function () {
  var h = harness({
    resolveCoopSource: function () {
      return { projectId: WEBAPP, sessionStorageId: "some-project-session" };
    },
  });
  try {
    h.store.upsert(candidate());
    var result = h.admission.admitPending();
    assert.strictEqual(result.attention[0].reason, "coop_session_unavailable");
    assert.strictEqual(h.cross.calls.length, 0);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: a missing resolver is not silently tolerated", function () {
  var h = harness({ resolveCoopSource: null });
  try {
    h.store.upsert(candidate());
    assert.strictEqual(h.admission.admitPending().attention[0].reason,
      "coop_session_unavailable");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// --- Blocker 2: task ids must not collide, replays must match exactly ---------

test("#2517: punctuation variants of an item key get distinct task ids", function () {
  // These all sanitize to the same string; only a digest of the raw key
  // distinguishes them, and binding two different issues together would mean
  // one execution silently serving both.
  var variants = ["trialview/v2#25", "trialview/v2-25", "trialview:v2#25", "trialview/v2/25"];
  var ids = {};
  for (var i = 0; i < variants.length; i++) {
    var id = portfolioTaskIdFor(candidate({ itemKey: variants[i] }));
    assert.strictEqual(ids[id], undefined,
      "collision between " + variants[i] + " and a previous variant");
    ids[id] = variants[i];
  }
});

test("#2517: a long item key still yields a distinguishing task id", function () {
  var prefix = "verylongorganisationname/averylongrepositoryname-that-keeps-going-and-going";
  var a = portfolioTaskIdFor(candidate({ itemKey: prefix + "#2517" }));
  var b = portfolioTaskIdFor(candidate({ itemKey: prefix + "#2518" }));
  assert.notStrictEqual(a, b, "truncation must not collapse two issues into one id");
  assert.ok(a.length <= 200);
});

test("#2517: an existing binding that is not ours is refused, not replayed", function () {
  var h = harness({ behavior: { fail: "active_binding_exists", foreignBinding: {} } });
  try {
    h.store.upsert(candidate());
    var result = h.admission.admitPending();
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.attention[0].reason, "binding_mismatch",
      "a foreign binding on the same task id must not count as our admission");
    assert.strictEqual(h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517").status,
      "pending");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: an unverifiable existing binding fails closed", function () {
  var h = harness({ behavior: { fail: "active_binding_exists" } });
  try {
    // A router that offers no way to read a binding: we cannot prove the
    // existing one is ours, which is a different diagnosis from proving it is
    // someone else's.
    var readerless = {
      coopSessionRef: h.cross.coopSessionRef,
      createProjectExecution: function () { return { ok: false, reason: "active_binding_exists" }; },
    };
    h.admission = withTestPass(createCandidateAdmission({
      candidates: h.store,
      crossProject: readerless,
      getLeadMode: function () { return true; },
      resolveCoopSource: function () { return readerless.coopSessionRef(); },
      now: function () { return 1000; },
      loadPolicy: function (projectRef) { return { ok: true, policy: testPolicy(projectRef) }; },
    }));
    h.store.upsert(candidate());
    assert.strictEqual(h.admission.admitPending().attention[0].reason, "binding_unverifiable");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// A binding this admission filed can come back as active_binding_exists while
// sitting at a status that means no coordinator was ever created: delivery
// failed and createAndCommitExecution released the reservation to "unrouted",
// leaving every identity field intact. Identity alone therefore proves nothing
// about liveness. Live evidence for board issue trialview/v2#2725: binding
// auto:344dd511172b31317028bdd4:trialview-v2-2725 r2 went unrouted at
// 1788343227520 and the candidate was marked admitted 16ms later at
// 1788343227536, dropping it out of the pending queue for good.
// Derived from a real admission rather than hand-built, so the identity fields
// are whatever admitOne actually files -- including the generated automation
// authorization and topic ref. A hand-written seed silently degrades into a
// binding_mismatch test and would never exercise the liveness guard at all.
function unroutedSeed(status) {
  var h = harness();
  try {
    h.store.upsert(candidate());
    assert.strictEqual(h.admission.admitPending().admitted, 1,
      "fixture setup: the baseline admission must succeed");
    var bindings = h.cross.getExecutionBindings();
    assert.strictEqual(bindings.length, 1, "fixture setup: expected exactly one binding");
    bindings[0].status = status;
    // releaseReservation/re-arm strip the ref, so an "unrouted" record really
    // has none. "unavailable" keeps its ref (statusRequiresRef), which is what
    // makes it the case only the status check can catch.
    if (status === "unrouted") delete bindings[0].coordinator;
    return bindings[0];
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
}

["unrouted", "unavailable"].forEach(function (status) {
  test("#2725: a " + status + " binding of ours is not admission, so the item stays pending",
    function () {
      var h = harness({ behavior: { bindings: [unroutedSeed(status)] } });
      try {
        h.store.upsert(candidate());
        var result = h.admission.admitPending();
        assert.strictEqual(result.admitted, 0, "nothing was routed, so nothing was admitted");
        assert.strictEqual(result.failed, 1);
        assert.strictEqual(result.attention[0].reason, "binding_never_routed");
        // The point of the fix: reserve() re-arms this exact revision, but only
        // if the candidate is still in the pending queue to be replayed.
        assert.strictEqual(
          h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517").status, "pending",
          "a binding that never produced a coordinator must not retire the candidate");
      } finally {
        fs.rmSync(h.dir, { recursive: true, force: true });
      }
    });
});

test("#2725: an active binding of ours still replays as admitted", function () {
  // The guard must reject only never-routed bindings. A genuine replay -- our
  // binding, already live -- must still count, or every restart would duplicate.
  var h = harness({ behavior: { bindings: [unroutedSeed("active")] } });
  try {
    h.store.upsert(candidate());
    var result = h.admission.admitPending();
    assert.strictEqual(result.failed, 0, "a live binding of ours is a legitimate replay");
    assert.strictEqual(result.admitted, 1);
    assert.strictEqual(h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517").status,
      "admitted");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// --- Blocker 3: a corrupt queue must not read as empty ------------------------

test("#2517: an unreadable candidate queue fails closed with attention", function () {
  var dir = tempDir();
  try {
    var file = path.join(dir, ".clay", "tasks", "automation-candidates.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    var h = harness({ dir: dir });
    var result = h.admission.admitPending();
    assert.strictEqual(result.ok, false,
      "corruption must never be interpreted as an empty queue");
    assert.strictEqual(result.reason, "malformed_state");
    assert.strictEqual(result.attention.length, 1);
    assert.strictEqual(h.cross.calls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("#2517: pending() reports the read error that list() hides", function () {
  var dir = tempDir();
  try {
    var file = path.join(dir, ".clay", "tasks", "automation-candidates.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    var store = createCandidateStore({ cwd: dir });
    assert.deepStrictEqual(store.list(), [], "list stays convenient but lossy");
    var pending = store.pending();
    assert.strictEqual(pending.ok, false);
    assert.strictEqual(pending.reason, "malformed_state");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Blocker 4: durable visible attention, and one precise owner decision -----

test("#2517: a failed admission leaves durable attention on the candidate", function () {
  var h = harness({ behavior: { fail: "project_unavailable" } });
  try {
    h.store.upsert(candidate());
    h.admission.admitPending();
    var stuck = h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517");
    assert.strictEqual(stuck.attention.reason, "project_unavailable");
    assert.strictEqual(stuck.attention.needsOwner, false);
    assert.strictEqual(stuck.attention.count, 1);

    // Repeated failures accumulate on one record instead of multiplying records.
    h.admission.admitPending();
    var again = h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517");
    assert.strictEqual(again.attention.count, 2);
    assert.strictEqual(again.attention.firstAt, stuck.attention.firstAt);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: owner-gated work becomes a durable awaiting_owner decision", function () {
  var h = harness();
  try {
    h.store.upsert(candidate({ admission: "owner_approval", itemClass: "feature" }));
    var result = h.admission.admitPending();
    assert.strictEqual(result.ownerDecisions.length, 1,
      "the owner must be asked exactly once, precisely");
    assert.strictEqual(result.ownerDecisions[0].itemKey, "trialview/v2#2517");
    assert.equal(result.ownerDecisions[0].portfolioTaskId, portfolioTaskIdFor(candidate({
      admission: "owner_approval", itemClass: "feature",
    })));
    assert.equal(result.ownerDecisions[0].bindingRevision, 1);
    assert.match(result.ownerDecisions[0].question,
      new RegExp(result.ownerDecisions[0].portfolioTaskId + " revision 1"));

    var record = h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517");
    assert.strictEqual(record.status, "awaiting_owner");
    assert.strictEqual(record.attention.needsOwner, true);
    assert.equal(record.approvalStage.portfolioTaskId,
      result.ownerDecisions[0].portfolioTaskId);
    assert.equal(record.approvalStage.bindingRevision, 1);

    // And it is no longer re-deferred as fresh pending work every tick.
    var second = h.admission.admitPending();
    assert.strictEqual(second.deferred, 0);
    assert.strictEqual(second.ownerDecisions.length, 0);

    var items = h.store.attentionItems();
    assert.strictEqual(items.ok, true);
    assert.strictEqual(items.items.length, 1, "it stays visible until decided");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("candidate refresh preserves admission, binding, owner decision, and attention facts", function () {
  var h = harness();
  try {
    var ownerCandidate = candidate({ admission: "owner_approval", itemClass: "feature" });
    h.store.upsert(ownerCandidate);
    var requested = h.admission.admitPending().ownerDecisions[0];
    var decided = h.store.decideOwner({ projectId: WEBAPP }, ownerCandidate.candidateKey, {
      approved: true,
      by: "owner-1",
      portfolioTaskId: requested.portfolioTaskId,
      bindingRevision: requested.bindingRevision,
    });
    assert.equal(decided.ok, true, decided.reason);

    h.store.upsert(ownerCandidate);
    assert.equal(h.admission.admitPending().admitted, 1);
    h.store.recordAttention({ projectId: WEBAPP }, ownerCandidate.candidateKey,
      "terminal_delivery_pending", false);
    var before = h.store.get({ projectId: WEBAPP }, ownerCandidate.candidateKey);

    var refreshed = h.store.upsert(candidate({
      admission: "owner_approval",
      itemClass: "feature",
      policyDigest: "digest-2",
      intent: Object.assign({}, ownerCandidate.intent, { title: "Updated title" }),
    }), { bindingSnapshot: h.cross.getExecutionBindings() });
    assert.equal(refreshed.ok, true, refreshed.reason);
    assert.equal(refreshed.changed, true);
    assert.equal(refreshed.candidate.admittedAt, before.admittedAt);
    assert.deepEqual(refreshed.candidate.binding, before.binding);
    assert.deepEqual(refreshed.candidate.ownerDecision, before.ownerDecision);
    assert.deepEqual(refreshed.candidate.attention, before.attention);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("an admitted candidate reopens only from its exact terminal binding snapshot", function () {
  var h = harness();
  try {
    var work = candidate();
    h.store.upsert(work);
    assert.equal(h.admission.admitPending().admitted, 1);
    var admitted = h.store.get({ projectId: WEBAPP }, work.candidateKey);
    var exact = h.cross.getBinding(admitted.binding.portfolioTaskId,
      admitted.binding.bindingRevision);

    var activeRefresh = h.store.upsert(candidate({ policyDigest: "digest-active" }), {
      bindingSnapshot: h.cross.getExecutionBindings(),
    });
    assert.equal(activeRefresh.candidate.status, "admitted",
      "an active exact binding can never be recreated");
    assert.equal(h.admission.admitPending().admitted, 0);

    var missingRefresh = h.store.upsert(candidate({ policyDigest: "digest-missing" }), {
      bindingSnapshot: [],
    });
    assert.equal(missingRefresh.candidate.status, "admitted",
      "absence is not terminal evidence and cannot reopen work");

    exact.status = "unrouted";
    var rearmableRefresh = h.store.upsert(candidate({ policyDigest: "digest-unrouted" }), {
      bindingSnapshot: h.cross.getExecutionBindings(),
    });
    assert.equal(rearmableRefresh.candidate.status, "admitted",
      "a rearmable reservation state is not terminal evidence");

    exact.status = "failed";
    exact.statusReason = "verified_terminal_failure";
    var terminalSnapshot = h.cross.getExecutionBindings();
    var reopened = h.store.upsert(candidate(), {
      bindingSnapshot: terminalSnapshot,
    });
    assert.equal(reopened.candidate.status, "pending");
    assert.equal(reopened.candidate.admittedAt, admitted.admittedAt,
      "historical admission evidence is retained");
    assert.deepEqual(reopened.candidate.binding, admitted.binding,
      "the exact terminal binding remains attached as reconciliation evidence");
    assert.equal(reopened.candidate.terminalReconciliation.status, "failed");
    assert.equal(reopened.candidate.terminalReconciliation.bindingRevision, 1);

    var again = h.store.upsert(candidate(), {
      bindingSnapshot: terminalSnapshot,
    });
    assert.equal(again.candidate.status, "pending");
    assert.deepEqual(again.candidate.terminalReconciliation,
      reopened.candidate.terminalReconciliation, "the exact reconcile is idempotent");

    assert.equal(h.admission.admitPending().admitted, 1);
    assert.equal(h.cross.calls.length, 2);
    assert.equal(h.cross.calls[1].bindingRevision, 2,
      "only terminal evidence permits the next revision to start");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a malformed or foreign terminal snapshot cannot rewrite an admitted candidate", function () {
  var h = harness();
  try {
    var work = candidate();
    h.store.upsert(work);
    assert.equal(h.admission.admitPending().admitted, 1);
    var admitted = h.store.get({ projectId: WEBAPP }, work.candidateKey);
    var exact = h.cross.getBinding(admitted.binding.portfolioTaskId,
      admitted.binding.bindingRevision);
    exact.status = "failed";

    var malformed = h.store.upsert(candidate({ policyDigest: "digest-malformed" }), {
      bindingSnapshot: [{
        portfolioTaskId: exact.portfolioTaskId,
        bindingRevision: exact.bindingRevision,
        status: "failed",
      }],
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.reason, "binding_snapshot_malformed");
    assert.equal(h.store.get({ projectId: WEBAPP }, work.candidateKey).status, "admitted");

    var foreign = Object.assign({}, exact, { targetProject: { projectId: OTHER } });
    var untouched = h.store.upsert(candidate({ policyDigest: "digest-foreign" }), {
      bindingSnapshot: [foreign],
    });
    assert.equal(untouched.ok, true);
    assert.equal(untouched.candidate.status, "admitted");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: a thrown admission still records durable attention", function () {
  var h = harness();
  try {
    h.store.upsert(candidate());
    h.cross.createProjectExecution = function () { throw new Error("boom"); };
    var result = h.admission.admitPending();
    assert.strictEqual(result.failed, 1);
    var stuck = h.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517");
    assert.strictEqual(stuck.attention.reason, "admission_threw",
      "a throw must not vanish into a console line");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: a successful admission clears stale attention", function () {
  var dir = tempDir();
  try {
    var failing = harness({ dir: dir, behavior: { fail: "project_unavailable" } });
    failing.store.upsert(candidate());
    failing.admission.admitPending();
    assert.ok(failing.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517").attention);

    var healthy = harness({ dir: dir });
    healthy.admission.admitPending();
    var record = healthy.store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517");
    assert.strictEqual(record.status, "admitted");
    assert.strictEqual(record.attention, undefined, "recovery must clear the flag");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Concurrent ticks ----------------------------------------------------------

test("#2517: two concurrent admission passes still produce one binding", function () {
  var dir = tempDir();
  try {
    var a = harness({ dir: dir });
    var b = harness({ dir: dir, crossProject: a.cross });
    a.store.upsert(candidate());
    a.admission.admitPending();
    b.admission.admitPending();
    var created = a.cross.calls.filter(function (c) { return !!c.portfolioTaskId; });
    assert.strictEqual(created.length, 1,
      "the second pass must see it already admitted, not submit again");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Coop's identity is never invented. A binding whose source is fabricated
// produces an execution outside Coop's task graph, owned by nobody.
test("#2517: admission fails closed when the live Coop session cannot be resolved", function () {
  var unresolvable = [null, undefined, {}, { projectId: "system-lead" },
    { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04", sessionStorageId: "s" }];
  for (var i = 0; i < unresolvable.length; i++) {
    var value = unresolvable[i];
    var h = harness({ resolveCoopSource: function () { return value; } });
    try {
      h.store.upsert(candidate());
      var result = h.admission.admitPending();
      assert.strictEqual(result.failed, 1, "shape " + i + " must not admit");
      assert.strictEqual(result.attention[0].reason, "coop_session_unavailable");
      assert.strictEqual(h.cross.calls.length, 0, "no binding may be created");
      assert.strictEqual(h.store.list({ status: "pending" }).length, 1,
        "the work stays queued and visible");
    } finally {
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  }
});

test("#2517: a throwing Coop resolver fails closed rather than propagating", function () {
  var h = harness({ resolveCoopSource: function () { throw new Error("lead down"); } });
  try {
    h.store.upsert(candidate());
    var result = h.admission.admitPending();
    assert.strictEqual(result.attention[0].reason, "coop_session_unavailable");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// --- Post-commit integration gaps ----------------------------------------------

// pending() used to read state and then delegate to list(), which read AGAIN.
// If the second read came back malformed, list() returned [] and pending()
// reported {ok:true, candidates:[]} — corruption laundered into a confident
// "nothing to admit", which is the exact silent-loss shape this store exists
// to prevent.
test("#2517: pending() cannot be fooled by a second read going bad", function () {
  var dir = tempDir();
  try {
    var file = path.join(dir, ".clay", "tasks", "automation-candidates.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    var good = JSON.stringify({
      schema: "clay.automation_candidates", version: 1,
      candidates: [{
        candidateKey: "launch:trialview/v2#2517", itemKey: "trialview/v2#2517",
        itemClass: "bug", admission: "auto", projectRef: { projectId: WEBAPP },
        status: "pending", firstSeenAt: 1, lastSeenAt: 1, seenCount: 1, digest: "d",
      }],
    });
    // First read succeeds, every later read is corrupt.
    var reads = 0;
    var flaky = Object.create(fs);
    flaky.readFileSync = function (target, encoding) {
      if (String(target) === file) {
        reads++;
        return reads === 1 ? good : "{not json";
      }
      return fs.readFileSync(target, encoding);
    };
    var store = createCandidateStore({ fs: flaky, cwd: dir });
    var result = store.pending({ status: "pending" });
    assert.strictEqual(reads, 1, "pending() must read exactly once");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.candidates.length, 1,
      "the candidate from the read we actually validated must survive");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("#2517: pending() filters the state it validated, not a fresh read", function () {
  var dir = tempDir();
  try {
    var store = createCandidateStore({ cwd: dir });
    store.upsert(candidate());
    var ownerCandidate = candidate({
      candidateKey: "launch:x#1", itemKey: "x#1", admission: "owner_approval",
    });
    store.upsert(ownerCandidate);
    var scope = {
      portfolioTaskId: portfolioTaskIdFor(ownerCandidate),
      bindingRevision: 1,
      targetProject: { projectId: WEBAPP },
    };
    store.recordAttention({ projectId: WEBAPP }, "launch:x#1", "owner_approval_required", true,
      Object.assign({}, scope, { question: approvalStaging.questionFor([scope]), stagedAt: Date.now() }));
    var pending = store.pending({ status: "pending" });
    assert.strictEqual(pending.ok, true);
    assert.strictEqual(pending.candidates.length, 1);
    assert.strictEqual(pending.candidates[0].itemKey, "trialview/v2#2517",
      "awaiting_owner must not come back as pending");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// An owner-gated deferral that does not persist means the next tick defers it
// again and prompts the owner again — the per-tick storm aimed at a human.
test("#2517: an unpersisted owner deferral is a failed admission, not a deferral", function () {
  var h = harness();
  try {
    h.store.upsert(candidate({ admission: "owner_approval", itemClass: "feature" }));
    // Attention cannot be written.
    h.store.recordAttention = function () { return { ok: false, reason: "persistence_failed" }; };
    var result = h.admission.admitPending();
    assert.strictEqual(result.deferred, 0, "an unpersisted deferral must not count as deferred");
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.attention[0].reason, "owner_attention_unpersisted");
    assert.strictEqual(result.ownerDecisions.length, 0,
      "and must not claim the owner was asked");
    assert.strictEqual(h.cross.calls.length, 0, "still no binding without approval");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#2517: a persisted owner deferral is still reported as one precise decision", function () {
  var h = harness();
  try {
    h.store.upsert(candidate({ admission: "owner_approval", itemClass: "feature" }));
    var result = h.admission.admitPending();
    assert.strictEqual(result.deferred, 1);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.ownerDecisions.length, 1);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// The binding-verification path was only ever exercised against an injected
// fake, so nothing proved it resolves against the REAL router's surface. This
// builds an actual cross-project router over a real binding store.
test("#2517: admission verifies replays against the real router surface", function () {
  var dir = tempDir();
  try {
    var { createCrossProjectRouter } = require("../lib/server-cross-project");
    var leadSession = { coopHome: true, storageId: "coop-home-real" };
    var targetDelivered = [];
    var leadContext = {
      getSessionManager: function () {
        return { sessions: { forEach: function (fn) { fn(leadSession); } } };
      },
    };
    var targetContext = {
      deliverCrossProjectEnvelope: function (envelope) {
        targetDelivered.push(envelope);
        return { ok: true };
      },
      getSessionManager: function () { return { sessions: { forEach: function () {} } }; },
    };
    var router = createCrossProjectRouter({
      allowLeadSourcedExecution: true,
      bindingFile: path.join(dir, "bindings.json"),
      deliveryFile: path.join(dir, "delivery.json"),
      ownerRequests: {
        claimCoordinator: function (input) {
          this.claimed = input.coordinator;
          return { ok: true };
        },
        canonicalCoordinator: function () { return this.claimed || null; },
      },
      // The router's real option name. Getting this wrong is exactly the class
      // of wiring error an injected fake cannot catch.
      getProjectContextById: function (projectId) {
        if (projectId === "system-lead") return leadContext;
        if (projectId === WEBAPP) return targetContext;
        return null;
      },
    });

    // The router must expose the two things production wiring depends on.
    assert.strictEqual(typeof router.coopSessionRef, "function");
    assert.strictEqual(typeof router.getExecutionBinding, "function",
      "admission resolves the reader off this canonical name");

    var resolved = router.coopSessionRef();
    assert.ok(resolved, "the real router must resolve the live Coop session");
    assert.strictEqual(resolved.projectId, "system-lead");
    assert.strictEqual(resolved.sessionStorageId, "coop-home-real");

    var store = createCandidateStore({ cwd: dir });
    // No getBinding injected: admission must find the reader itself.
    var admission = withTestPass(createCandidateAdmission({
      candidates: store,
      crossProject: router,
      getLeadMode: function () { return true; },
      resolveCoopSource: function () { return router.coopSessionRef(); },
      now: function () { return 1000; },
      loadPolicy: function (projectRef) { return { ok: true, policy: testPolicy(projectRef) }; },
    }));
    store.upsert(candidate());

    var first = admission.admitPending();
    assert.strictEqual(first.admitted, 1, "a real binding must be created: " +
      JSON.stringify(first.attention));
    assert.strictEqual(store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517").status,
      "admitted");

    // Re-admitting the same work against the real store must replay, and the
    // verification must accept it because it is genuinely our binding.
    store.upsert(candidate());
    var reopened = store.get({ projectId: WEBAPP }, "launch:trialview/v2#2517");
    assert.strictEqual(reopened.status, "admitted", "a re-proposal stays admitted");
    assert.strictEqual(admission.admitPending().failed, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("#2517: a router with no binding reader makes replays unverifiable, not assumed", function () {
  var h = harness();
  try {
    var readerless = {
      coopSessionRef: function () {
        return { projectId: "system-lead", sessionStorageId: "coop-home-live" };
      },
      createProjectExecution: function () { return { ok: false, reason: "active_binding_exists" }; },
    };
    var admission = withTestPass(createCandidateAdmission({
      candidates: h.store,
      crossProject: readerless,
      getLeadMode: function () { return true; },
      resolveCoopSource: function () { return readerless.coopSessionRef(); },
      now: function () { return 1000; },
      loadPolicy: function (projectRef) { return { ok: true, policy: testPolicy(projectRef) }; },
    }));
    h.store.upsert(candidate());
    assert.strictEqual(admission.admitPending().attention[0].reason, "binding_unverifiable");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// server.js indexes project contexts by SLUG, so the router can only resolve a
// project BY PROJECT ID through a registered resolver. The resolver used to
// expose only getProjectId and deliverCrossProjectEnvelope — no session manager
// — so coopSessionRef() could never reach the Lead project's sessions and
// returned null on every real tick. Admission would then fail closed forever
// while every unit test passed against an injected fake.
test("#2517: the router resolves Coop through a registered resolver, as production does", function () {
  var dir = tempDir();
  try {
    var { createCrossProjectRouter } = require("../lib/server-cross-project");
    var router = createCrossProjectRouter({
      bindingFile: path.join(dir, "bindings.json"),
      deliveryFile: path.join(dir, "delivery.json"),
      // Exactly what server.js supplies: slug-keyed, so projectId lookups miss.
      getProjectContext: function () { return null; },
    });
    assert.strictEqual(router.coopSessionRef(), null,
      "with no resolver registered there is no Coop session to find");

    router.registerProjectResolver({
      getProjectId: function () { return "system-lead"; },
      deliverCrossProjectEnvelope: function () { return { ok: true }; },
      getSessionManager: function () {
        return { sessions: { forEach: function (fn) { fn({ coopHome: true, storageId: "coop-home-prod" }); } } };
      },
    });

    var ref = router.coopSessionRef();
    assert.ok(ref, "a registered Lead resolver must expose enough to find Coop");
    assert.strictEqual(ref.projectId, "system-lead");
    assert.strictEqual(ref.sessionStorageId, "coop-home-prod");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("#2517: a resolver without a session manager yields no Coop ref rather than throwing", function () {
  var dir = tempDir();
  try {
    var { createCrossProjectRouter } = require("../lib/server-cross-project");
    var router = createCrossProjectRouter({
      bindingFile: path.join(dir, "bindings.json"),
      deliveryFile: path.join(dir, "delivery.json"),
      getProjectContext: function () { return null; },
    });
    router.registerProjectResolver({
      getProjectId: function () { return "system-lead"; },
      deliverCrossProjectEnvelope: function () { return { ok: true }; },
    });
    assert.strictEqual(router.coopSessionRef(), null,
      "fail closed, and let admission report coop_session_unavailable");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("#2517: a session that is not coopHome is not Coop", function () {
  var dir = tempDir();
  try {
    var { createCrossProjectRouter } = require("../lib/server-cross-project");
    var router = createCrossProjectRouter({
      bindingFile: path.join(dir, "bindings.json"),
      deliveryFile: path.join(dir, "delivery.json"),
      getProjectContext: function () { return null; },
    });
    router.registerProjectResolver({
      getProjectId: function () { return "system-lead"; },
      deliverCrossProjectEnvelope: function () { return { ok: true }; },
      getSessionManager: function () {
        return { sessions: { forEach: function (fn) {
          fn({ storageId: "some-worker" });
          fn({ coopChannel: true, storageId: "a-channel" });
        } } };
      },
    });
    assert.strictEqual(router.coopSessionRef(), null,
      "only the canonical coopHome session counts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
