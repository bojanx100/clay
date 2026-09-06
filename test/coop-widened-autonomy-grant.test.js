var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var grant = require("../lib/coop-autonomy-grant");
var itemApproval = require("../lib/coop-item-approval");
var bindingsModule = require("../lib/portfolio-execution-bindings");

var CLAY_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var WEBAPP_ID = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
var OTHER_ID = "f2b7c47a-bb03-5b3d-89ff-dd32ddb2be53";
var SELF_REPAIR_TASK = "clay-fix-coop-self-recovery-steering-20260902";
var SELF_REPAIR_TOPIC = "coop-self-recovery-steering";

var SHIPPED_FILE = path.join(__dirname, "..", "scoped-autonomy-policy.json");

function policyFile(overrides) {
  var base = JSON.parse(fs.readFileSync(SHIPPED_FILE, "utf8"));
  Object.keys(overrides || {}).forEach(function (key) {
    if (overrides[key] === undefined) delete base[key];
    else base[key] = overrides[key];
  });
  var file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clay-autonomy-")),
    "scoped-autonomy-policy.json");
  fs.writeFileSync(file, JSON.stringify(base, null, 2) + "\n");
  return file;
}

function dispatch(overrides) {
  return Object.assign({
    title: "Audit the session ledger",
    objective: "Investigate and report on stale ledger rows. Do not change anything.",
    context: "Read-only diagnosis requested by the Lead.",
    acceptanceCriteria: "Report findings with file and line evidence.",
    ownedPaths: "read-only: lib/lead-ledger.js",
  }, overrides || {});
}

function request(overrides) {
  return Object.assign({
    portfolioTaskId: "clay-ledger-audit-2026-08-21",
    bindingRevision: 1,
    targetProject: { projectId: CLAY_ID },
    coopTopicRef: { topicId: "owner-ledger-audit" },
    idempotencyKey: "staff-clay-ledger-audit-2026-08-21-r1",
  }, overrides || {});
}

function ownerRequestsWith(entries) {
  return { list: function () { return entries; } };
}

// A REAL binding store holding the binding that the approved revision actually
// dispatched. The store computes and persists the payload digest itself, so the
// grant has to discover it from disk rather than be handed the answer it is
// meant to find. Nothing here supplies a taskPayloadDigest.
function bindingsWithApproved(brief, revision) {
  var directory = fs.mkdtempSync(path.join(os.tmpdir(), "clay-autonomy-bind-"));
  var store = bindingsModule.createPortfolioExecutionBindings({
    file: path.join(directory, "bindings.json"),
  });
  var reserved = store.reserve(Object.assign({}, brief, {
    portfolioTaskId: "clay-ledger-audit-2026-08-21",
    mode: "direct_leaf",
    targetProject: { projectId: CLAY_ID },
    bindingRevision: revision,
    idempotencyKey: "staff-clay-ledger-audit-2026-08-21-r" + revision,
  }));
  assert.equal(reserved.ok, true, "the approved-revision binding must reserve");
  assert.match(String(store.get("clay-ledger-audit-2026-08-21", revision).taskPayloadDigest),
    /^[a-f0-9]{64}$/, "the store must have persisted a real digest to compare against");
  return store;
}

function approvedScope(overrides) {
  return Object.assign({
    ingressId: "coop:lead:400",
    expectsExecution: true,
    implementationDecision: { intent: "implement", source: "explicit_item_approval", at: 1 },
    implementationScope: {
      projectRef: { projectId: CLAY_ID },
      topicRef: { topicId: "owner-ledger-audit" },
      portfolioTaskId: "clay-ledger-audit-2026-08-21",
      bindingRevision: 1,
      idempotencyKey: "staff-clay-ledger-audit-2026-08-21-r1",
    },
    response: { state: "unanswered" },
  }, overrides || {});
}

function selfRepairControl(enabled) {
  return {
    enabled: enabled,
    projectRef: { projectId: CLAY_ID },
    portfolioTaskId: SELF_REPAIR_TASK,
    bindingRevision: 2,
  };
}

function selfRepairDispatch(overrides) {
  return Object.assign({
    title: "Perform the exact admitted Coop self-fix",
    objective: "Repair the exact admitted Coop recovery revision with the existing project scope.",
    context: "Keep existing owner gates for external actions.",
    acceptanceCriteria: "Run focused tests and report the verified result.",
    ownedPaths: "lib/coop-autonomy-grant.js; test/coop-widened-autonomy-grant.test.js",
    targetProject: { projectId: CLAY_ID },
    portfolioTaskId: SELF_REPAIR_TASK,
    bindingRevision: 2,
    idempotencyKey: SELF_REPAIR_TASK + "-r2",
    mode: "project_coordinator",
    controlRole: "project_coordinator",
  }, overrides || {});
}

function selfRepairRequest(overrides) {
  return Object.assign({
    targetProject: { projectId: CLAY_ID },
    portfolioTaskId: SELF_REPAIR_TASK,
    bindingRevision: 2,
    idempotencyKey: SELF_REPAIR_TASK + "-r2",
    mode: "project_coordinator",
    coopTopicRef: { topicId: SELF_REPAIR_TOPIC },
  }, overrides || {});
}

function selfRepairScope() {
  return approvedScope({
    implementationScope: {
      projectRef: { projectId: CLAY_ID },
      topicRef: { topicId: SELF_REPAIR_TOPIC },
      portfolioTaskId: SELF_REPAIR_TASK,
      bindingRevision: 1,
      idempotencyKey: SELF_REPAIR_TASK + "-r1",
    },
  });
}

function bindingsWithApprovedSelfRepair(brief) {
  var directory = fs.mkdtempSync(path.join(os.tmpdir(), "clay-self-repair-bind-"));
  var store = bindingsModule.createPortfolioExecutionBindings({
    file: path.join(directory, "bindings.json"),
  });
  var reserved = store.reserve(Object.assign({}, brief, {
    portfolioTaskId: SELF_REPAIR_TASK,
    mode: "project_coordinator",
    targetProject: { projectId: CLAY_ID },
    bindingRevision: 1,
    idempotencyKey: SELF_REPAIR_TASK + "-r1",
    coopTopicRef: { topicId: SELF_REPAIR_TOPIC },
  }));
  assert.equal(reserved.ok, true, "the admitted self-repair binding must reserve");
  return store;
}

// --- The switch OFF ------------------------------------------------------------

// The shipped file is the OWNER's switch, so its `enabled` value is data, not an
// invariant. This test used to assert `shipped.enabled === false` and to reach
// the grant through an empty deps object, which resolves to the shipped file via
// loadPolicy's defaultFile() fallback. Both coupled the suite to the owner's
// current setting: flipping the switch on -- the supported way to use the
// feature -- turned this test red, and `npm test` backstops every commit, so the
// owner could not durably enable their own grant without a failing suite. That
// is the same approval friction this subsystem is supposed to remove.
//
// What is actually invariant is checked instead: the shipped file must remain
// well formed, and its permanently-gated set must stay intact, because no edit
// to that file may widen it. The behavioral claim -- OFF is byte-identical to
// having no grant -- is property 1 of coop-autonomy-grant and is now proven
// against a temporary OFF policy, so it holds whatever the owner has shipped.
test("the shipped policy file stays well formed and cannot widen what is gated", function () {
  var loaded = grant.loadPolicy({});
  assert.ok(loaded, "the shipped file must be well formed");
  var shipped = JSON.parse(fs.readFileSync(SHIPPED_FILE, "utf8"));
  assert.equal(typeof shipped.enabled, "boolean",
    "enabled is the owner's switch, but it must stay a boolean");
  assert.ok(Array.isArray(shipped.permanentlyGated) && shipped.permanentlyGated.length,
    "the shipped file must still carry a permanently-gated set");
  // normalizePolicy returns null unless permanentlyGated matches the hard-coded
  // forbidden-action ids exactly, so a well-formed load already proves the set
  // was not narrowed. Assert it survived the round trip rather than restating it.
  assert.ok(loaded.projects.length, "the shipped file must still name its projects");
});

test("with the grant off, behavior is identical to having no grant at all", function () {
  var off = policyFile({ enabled: false });

  var loaded = grant.loadPolicy({ autonomyPolicyFile: off });
  assert.ok(loaded, "the off policy must be well formed");
  assert.equal(loaded.enabled, false);

  // The dispatch shape that IS covered once the switch flips stays refused while
  // it is off: a read-only audit of an allowlisted project.
  assert.equal(grant.standingAdmission(dispatch(), request(),
    { autonomyPolicyFile: off }), null);

  // And the real gate the dispatcher calls still declines, so
  // server-cross-project falls through to owner_implementation_decision_required.
  assert.equal(itemApproval.executionAdmission(dispatch(), request(), null,
    { autonomyPolicyFile: off }), null,
    "with the switch off the approval gate must return null, not an admission");
});

test("a dedicated self-repair control is off by default and admits only its exact typed revision", function () {
  var brief = selfRepairDispatch();
  var request = selfRepairRequest();
  var bindings = bindingsWithApprovedSelfRepair(brief);
  var ownerRequests = ownerRequestsWith([selfRepairScope()]);
  var off = policyFile({ enabled: true, coopSelfRepair: selfRepairControl(false) });
  var offDeps = { autonomyPolicyFile: off, ownerRequests: ownerRequests, bindings: bindings };

  assert.equal(grant.standingAdmission(brief, request, offDeps), null,
    "OFF leaves the existing manual self-modification gate in charge");
  assert.equal(itemApproval.executionAdmission(brief, request, null, offDeps), null,
    "the real approval seam also remains manual while the dedicated control is off");

  var on = policyFile({ enabled: true, coopSelfRepair: selfRepairControl(true) });
  var onDeps = { autonomyPolicyFile: on, ownerRequests: ownerRequests, bindings: bindings };
  var admitted = grant.standingAdmission(brief, request, onDeps);
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  assert.deepEqual(admitted.standingGrant, {
    category: "coop_self_repair",
    projectId: CLAY_ID,
    portfolioTaskId: SELF_REPAIR_TASK,
    bindingRevision: 2,
    approvedIngressId: "coop:lead:400",
    approvedRevision: 1,
  });
  assert.equal(itemApproval.executionAdmission(brief, request, null, onDeps).ok, true,
    "the exact typed repair reaches the real admission seam without a second owner prompt");

  function gated(label, input, scopedRequest, reason) {
    assert.deepEqual(grant.standingAdmission(input, scopedRequest, onDeps),
      { ok: false, reason: reason }, label);
  }

  gated("missing project-coordinator authority stays manual", selfRepairDispatch({
    controlRole: undefined,
  }), request, "autonomy_grant_self_repair_authority_required");
  gated("spend work stays manual", selfRepairDispatch({ spendRequired: true }), request,
    "autonomy_grant_spend_or_budget_exception_gated");
  gated("budget exceptions stay manual", selfRepairDispatch({ budgetException: true }), request,
    "autonomy_grant_spend_or_budget_exception_gated");
  gated("scope expansion stays manual", selfRepairDispatch({ scopeExpansion: true }), request,
    "autonomy_grant_scope_expansion_gated");
  gated("a conflicting input ProjectRef stays manual", selfRepairDispatch({
    targetProject: { projectId: WEBAPP_ID },
  }), request, "autonomy_grant_self_repair_authority_required");

  assert.deepEqual(grant.standingAdmission(dispatch({
    title: "Perform an unrelated Coop self-fix",
    objective: "Repair a different Coop control path.",
    ownedPaths: "lib/coop-autonomy-grant.js",
  }), selfRepairRequest({
    portfolioTaskId: "clay-unrelated-coop-self-fix-20260902",
    bindingRevision: 1,
    idempotencyKey: "clay-unrelated-coop-self-fix-20260902-r1",
  }), onDeps), {
    ok: false, reason: "autonomy_grant_approval_policy_change_gated",
  }, "an unrelated self-fix cannot inherit the generic revision-bump grant");

  assert.deepEqual(grant.standingAdmission(brief, selfRepairRequest({
    targetProject: { projectId: WEBAPP_ID },
  }), onDeps), {
    ok: false, reason: "autonomy_grant_approval_policy_change_gated",
  }, "cross-project drift remains permanently gated");
  assert.equal(grant.standingAdmission(brief, selfRepairRequest({ bindingRevision: 3 }), onDeps), null,
    "a later revision cannot reuse this exact repair admission");
  assert.equal(grant.standingAdmission(selfRepairDispatch({
    ownedPaths: "lib/coop-autonomy-grant.js; lib/server.js; lib/project.js",
  }), request, onDeps), null, "a widened brief cannot reuse the original admission");
});

test("a cited approval ingress is unaffected by the grant in either state", function () {
  // The standing grant is consulted ONLY where no approval ingress was cited.
  // A dispatch that DOES cite one keeps failing closed on its own evidence, so
  // the grant can never overturn a refusal.
  ["off", "on"].forEach(function (state) {
    var file = policyFile({ enabled: state === "on" });
    var result = itemApproval.executionAdmission(
      Object.assign(dispatch(), { coopApprovalIngressId: "coop:lead:578" }),
      request(), null, { autonomyPolicyFile: file });
    assert.deepEqual(result, { ok: false, reason: "owner_implementation_decision_unavailable" },
      "switch " + state + ": a cited ingress must be judged on its own evidence");
  });
});

// --- Switched on ---------------------------------------------------------------

test("switched on, a read-only diagnosis dispatch proceeds", function () {
  var file = policyFile({ enabled: true });
  var admitted = grant.standingAdmission(dispatch(), request(), { autonomyPolicyFile: file });
  assert.ok(admitted, "a read-only audit in an allowlisted project must be admitted");
  assert.equal(admitted.ok, true);
  assert.equal(admitted.reviewOnly, true, "it must be admitted as read-only work");
  assert.equal(admitted.standingGrant.category, "read_only_diagnosis");

  // Reached through the real gate the dispatcher calls, not just the helper.
  var viaGate = itemApproval.executionAdmission(dispatch(), request(), null,
    { autonomyPolicyFile: file });
  assert.ok(viaGate && viaGate.ok === true);
  assert.equal(viaGate.standingGrant.category, "read_only_diagnosis");

  // The second allowlisted project works the same way.
  assert.equal(grant.standingAdmission(dispatch(),
    request({ targetProject: { projectId: WEBAPP_ID } }),
    { autonomyPolicyFile: file }).ok, true);
});

test("diagnosis framing cannot borrow the read-only standing grant for mutation in any brief field", function () {
  var file = policyFile({ enabled: true, categories: ["read_only_diagnosis"] });
  ["title", "objective", "context", "acceptanceCriteria"].forEach(function (field) {
    var input = dispatch({ title: "Diagnose the parser regression", objective: "Investigate the parser." });
    input[field] += " Edit lib/parser.js to fix it.";
    assert.equal(grant.standingAdmission(input, request(), { autonomyPolicyFile: file }), null, field);
    var result = itemApproval.executionAdmission(input, request(), null, { autonomyPolicyFile: file });
    assert.notEqual(result && result.ok, true, "real admission gate: " + field);
  });
});

test("Clay On admits newly named ordinary internal Clay and Coop implementations", function () {
  var file = policyFile({ enabled: true });
  [
    ["clay-rebuild-session-search-2026-09-05", "Implement the Clay session-search result repair"],
    ["coop-reconcile-visible-worker-status-2026-09-05", "Implement the Coop visible-worker status reconciliation"],
  ].forEach(function (entry) {
    var admitted = grant.standingAdmission(dispatch({
      title: entry[1],
      objective: "Make the internal implementation and verify it locally.",
      ownedPaths: "lib/server-cross-project.js; test/server-cross-project.test.js",
      coopStandingAutonomy: true,
    }), request({ portfolioTaskId: entry[0], coopTopicRef: undefined }),
    { autonomyPolicyFile: file });
    assert.equal(admitted.ok, true, entry[0] + ": " + JSON.stringify(admitted));
    assert.deepEqual(admitted.standingGrant, {
      category: "ordinary_internal_clay_coop_work",
      projectId: CLAY_ID,
    });
  });
});

test("Clay On keeps external state, Lead self-modification, and spend exceptions gated", function () {
  var file = policyFile({ enabled: true });
  [
    ["external state", { externalStateChange: true }, "autonomy_grant_external_state_change_gated"],
    ["Lead self-modification", { leadSelfModification: true },
      "autonomy_grant_lead_self_modification_gated"],
    ["spend exception", { budgetException: true },
      "autonomy_grant_spend_or_budget_exception_gated"],
  ].forEach(function (entry) {
    var admitted = grant.standingAdmission(dispatch(Object.assign({
      title: "Implement the Clay internal admission repair",
      objective: "Make the internal Clay change.",
      ownedPaths: "lib/server-cross-project.js",
      coopStandingAutonomy: true,
    }, entry[1])), request({ portfolioTaskId: "clay-internal-admission-repair",
      coopTopicRef: undefined }),
    { autonomyPolicyFile: file });
    assert.deepEqual(admitted, { ok: false, reason: entry[2] }, entry[0]);
  });

  assert.equal(grant.standingAdmission(dispatch({
    title: "Implement the Coop internal admission repair",
    ownedPaths: "lib/server-cross-project.js",
  }), request({ portfolioTaskId: "coop-internal-admission-repair",
    targetProject: { projectId: OTHER_ID }, coopTopicRef: undefined }),
  { autonomyPolicyFile: file }), null,
  "the ordinary Clay scope must not widen another project");
});

test("read-only safety constraints do not request the forbidden actions they prohibit", function () {
  var file = policyFile({ enabled: true });
  var brief = dispatch({
    title: "Reconcile archived wrong-auto-launch inventory",
    objective: "Investigate and reconcile the archived read-only inventory.",
    context: "Do not modify files, ask the owner, or mutate GitHub/board state.",
    acceptanceCriteria: "No file, GitHub, board, daemon, or external-state mutations.",
    ownedPaths: "read-only: Webapp session/portfolio/topic ledgers",
  });
  var scopedRequest = request({ targetProject: { projectId: WEBAPP_ID } });
  var admitted = grant.standingAdmission(brief, scopedRequest,
    { autonomyPolicyFile: file });

  assert.equal(grant.forbiddenAction(brief), "issue_or_board_mutation",
    "the default gate must remain mention-based for non-read-only admission paths");
  assert.ok(admitted, "the explicit no-mutation boundary must not suppress read-only admission");
  assert.equal(admitted.ok, true);
  assert.equal(admitted.reviewOnly, true);
  assert.equal(itemApproval.executionAdmission(brief, scopedRequest, null,
    { autonomyPolicyFile: file }).ok, true,
  "the live execution-admission seam must admit the same read-only brief");

  assert.deepEqual(grant.standingAdmission(dispatch({
    objective: "Investigate the backlog, then mutate the GitHub/board state.",
  }), request({ targetProject: { projectId: WEBAPP_ID } }),
  { autonomyPolicyFile: file }), {
    ok: false, reason: "autonomy_grant_issue_or_board_mutation_gated",
  }, "an actual board mutation in a read-only brief must stay gated");

  [
    "Do not inspect; move the card to Done.",
    "Do not change board state, but update the board.",
    "No file edits, git push the result.",
  ].forEach(function (context) {
    assert.ok(grant.standingAdmission(dispatch({ context: context }), request({
      targetProject: { projectId: WEBAPP_ID },
    }), { autonomyPolicyFile: file }).ok === false,
    "a contrastive or unscoped action must fail closed: " + context);
  });
});

test("switched on, an approved-at-earlier-revision re-dispatch proceeds", function () {
  // Both categories declared explicitly. The shipped file currently ships only
  // read_only_diagnosis, and inheriting that would make every assertion below
  // pass for the wrong reason -- undeclared category rather than the predicate
  // under test.
  var file = policyFile({ enabled: true,
    categories: ["read_only_diagnosis", "approved_revision_bump"] });
  var approvedBrief = dispatch({ ownedPaths: "lib/lead-ledger.js" });
  var deps = {
    autonomyPolicyFile: file,
    ownerRequests: ownerRequestsWith([approvedScope()]),
    bindings: bindingsWithApproved(approvedBrief, 1),
  };
  // rev1 was approved by ingress 400. rev2 changes ONLY the revision.
  var retry = request({ bindingRevision: 2, ownedPaths: "lib/lead-ledger.js" });
  var admitted = grant.standingAdmission(dispatch({ ownedPaths: "lib/lead-ledger.js" }),
    retry, deps);
  assert.ok(admitted, "a revision bump of already-approved work must be admitted");
  assert.equal(admitted.ok, true);
  assert.equal(admitted.standingGrant.category, "approved_revision_bump");
  assert.equal(admitted.standingGrant.approvedIngressId, "coop:lead:400");
  assert.equal(admitted.standingGrant.approvedRevision, 1);
  assert.notEqual(admitted.reviewOnly, true, "a re-dispatch is not read-only work");

  // Anything other than the revision changing is NOT covered.
  function refusedChange(label, overrides) {
    assert.equal(grant.standingAdmission(dispatch({ ownedPaths: "lib/lead-ledger.js" }),
      Object.assign({}, retry, overrides), deps), null, label);
  }
  refusedChange("a different task id is different work",
    { portfolioTaskId: "clay-something-else-2026-08-21" });
  refusedChange("a different Thread is not the approved scope",
    { coopTopicRef: { topicId: "owner-other-thread" } });
  refusedChange("a different project is not the approved scope",
    { targetProject: { projectId: WEBAPP_ID } });
  // Re-assert the baseline AFTER the refusals. Without this, a stray mutation in
  // the loop above could make every refusal pass for the wrong reason.
  assert.equal(grant.standingAdmission(dispatch({ ownedPaths: "lib/lead-ledger.js" }),
    retry, deps).ok, true, "the unmodified revision bump must still be admitted");

  // A revision the owner never got past, or the same one, is not a bump.
  assert.equal(grant.standingAdmission(dispatch({ ownedPaths: "lib/lead-ledger.js" }),
    request({ bindingRevision: 1, ownedPaths: "lib/lead-ledger.js" }), deps), null,
  "the originally approved revision still needs its own approval");

  // A withdrawn approval carries nothing forward.
  assert.equal(grant.standingAdmission(dispatch({ ownedPaths: "lib/lead-ledger.js" }),
    request({ bindingRevision: 2, ownedPaths: "lib/lead-ledger.js" }),
    // bindings supplied so the refusal is attributable to the withdrawal alone,
    // not to the brief-proof being unavailable.
    { autonomyPolicyFile: file, bindings: deps.bindings,
      ownerRequests: ownerRequestsWith([approvedScope({
        response: { state: "superseded" } })]) }), null,
  "a superseded owner turn cannot authorize a later revision");

  // A turn that never expected execution is not an approval either.
  assert.equal(grant.standingAdmission(dispatch({ ownedPaths: "lib/lead-ledger.js" }),
    request({ bindingRevision: 2, ownedPaths: "lib/lead-ledger.js" }),
    { autonomyPolicyFile: file, bindings: deps.bindings,
      ownerRequests: ownerRequestsWith([approvedScope({
        expectsExecution: false })]) }), null,
  "a conversational turn cannot authorize a later revision");
});

// --- A bump must carry the brief the owner approved --------------------------
//
// The regression this pins: the approved scope on the owner record holds
// coordinates only (projectRef, topicRef, portfolioTaskId, bindingRevision,
// idempotencyKey) and no description of the work. Matching coordinates alone
// therefore admitted ARBITRARY new work under a previously approved task id, at
// any higher revision, without limit.
test("switched on, a revision bump with a different brief is refused", function () {
  var file = policyFile({ enabled: true,
    categories: ["read_only_diagnosis", "approved_revision_bump"] });
  // What the owner actually approved at revision 1: a read-only ledger audit.
  var approvedBrief = dispatch({ ownedPaths: "lib/lead-ledger.js" });
  var deps = {
    autonomyPolicyFile: file,
    ownerRequests: ownerRequestsWith([approvedScope()]),
    bindings: bindingsWithApproved(approvedBrief, 1),
  };
  var retry = request({ bindingRevision: 2, ownedPaths: "lib/lead-ledger.js" });

  // Baseline first: the same brief at a higher revision IS still admitted, so a
  // refusal below cannot be the category simply being broken or undeclared.
  assert.equal(grant.standingAdmission(approvedBrief, retry, deps).ok, true,
    "the approved brief must still be admitted at a higher revision");

  // Same task id, same Thread, same project, same revision bump -- but the work
  // is something the owner never saw. Every coordinate the old predicate looked
  // at is identical, so only the brief can be causing the refusal.
  function refusedBrief(label, overrides) {
    assert.equal(grant.standingAdmission(
      Object.assign({}, approvedBrief, overrides), retry, deps), null, label);
  }
  refusedBrief("a rewritten objective is not the approved work",
    { objective: "Replace the reconnect backoff and delete the legacy migration path." });
  refusedBrief("a rewritten title is not the approved work",
    { title: "Rewrite the daemon supervisor" });
  refusedBrief("widened owned paths are not the approved work",
    { ownedPaths: "lib/daemon.js; lib/session-store.js; lib/project.js" });
  refusedBrief("changed acceptance criteria are not the approved work",
    { acceptanceCriteria: "Ship it to production." });

  // The old hole ran unbounded: rev 3, 9, 500 all rode one approval. A
  // mismatched brief must be refused at every one of them.
  [3, 9, 500].forEach(function (revision) {
    assert.equal(grant.standingAdmission(
      Object.assign({}, approvedBrief, { title: "Rewrite the daemon supervisor" }),
      request({ bindingRevision: revision, ownedPaths: "lib/lead-ledger.js" }), deps), null,
    "a mismatched brief must be refused at revision " + revision);
  });

  // Fail closed when the proof is simply unavailable, rather than falling back
  // to the coordinates-only behaviour this test exists to prevent.
  assert.equal(grant.standingAdmission(approvedBrief, retry,
    Object.assign({}, deps, { bindings: null })), null,
  "with no binding store there is no proof, so no bump is admitted");
  assert.equal(grant.standingAdmission(approvedBrief, retry,
    Object.assign({}, deps, {
      bindings: bindingsModule.createPortfolioExecutionBindings({
        file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clay-autonomy-empty-")),
          "bindings.json"),
      }),
    })), null,
  "a released or pruned approved-revision binding leaves no proof either");
});

// --- Permanently gated, in both states ----------------------------------------

test("switched on, the permanently gated actions are still refused", function () {
  var file = policyFile({ enabled: true });
  var deps = {
    autonomyPolicyFile: file,
    ownerRequests: ownerRequestsWith([approvedScope()]),
  };
  // Each of these is otherwise a perfect candidate: allowlisted project,
  // read-only owned paths, diagnosis framing. Only the gated action differs, so
  // the refusal can come from nothing else.
  var gated = [
    ["push_to_remote", "Audit the branch and then git push the result"],
    ["push_to_remote", "Review the commits and push to origin"],
    ["pull_request_comment_or_merge", "Audit PR 2592 and merge the pull request"],
    ["pull_request_comment_or_merge", "Review the diff and comment on the pull request"],
    ["pull_request_comment_or_merge", "Investigate, then gh pr merge 2592"],
    ["issue_or_board_mutation", "Audit the backlog and close issues 198 and 200"],
    ["issue_or_board_mutation", "Diagnose the board and move the card to Done"],
    ["approval_policy_change", "Audit and widen the scoped autonomy grant"],
    ["approval_policy_change", "Review the approval policy and relax the gate"],
  ];
  gated.forEach(function (entry) {
    var admitted = grant.standingAdmission(dispatch({ objective: entry[1] }),
      request(), deps);
    assert.deepEqual(admitted, { ok: false, reason: "autonomy_grant_" + entry[0] + "_gated" },
      "must refuse: " + entry[1]);
  });

  // A gated action is refused even when it arrives as a revision bump of work
  // the owner did approve, so the bump category cannot smuggle one through.
  assert.deepEqual(grant.standingAdmission(
    dispatch({ ownedPaths: "lib/lead-ledger.js", objective: "Retry and git push the fix" }),
    request({ bindingRevision: 2, ownedPaths: "lib/lead-ledger.js" }), deps),
  { ok: false, reason: "autonomy_grant_push_to_remote_gated" });

  // The gate reads the whole brief, not just the objective.
  assert.deepEqual(grant.standingAdmission(
    dispatch({ acceptanceCriteria: "Finish by merging the pull request." }), request(), deps),
  { ok: false, reason: "autonomy_grant_pull_request_comment_or_merge_gated" });

  // The refusal reaches the real gate too, rather than only the helper.
  assert.deepEqual(itemApproval.executionAdmission(
    dispatch({ objective: "Audit the branch and then git push the result" }),
    request(), null, deps),
  { ok: false, reason: "autonomy_grant_push_to_remote_gated" });
});

// --- Scope of the allowlist ---------------------------------------------------

test("the grant covers only allowlisted projects and declared categories", function () {
  var on = policyFile({ enabled: true });
  assert.equal(grant.standingAdmission(dispatch(),
    request({ targetProject: { projectId: OTHER_ID } }), { autonomyPolicyFile: on }), null,
  "a project outside the allowlist is not covered");

  // A gated action outside the allowlist is not even reached -- the project
  // check comes first, so an unlisted project stays entirely fail-closed.
  assert.equal(grant.standingAdmission(dispatch({ objective: "git push the fix" }),
    request({ targetProject: { projectId: OTHER_ID } }), { autonomyPolicyFile: on }), null);

  var noCategories = policyFile({ enabled: true, categories: [] });
  assert.equal(grant.standingAdmission(dispatch(), request(),
    { autonomyPolicyFile: noCategories }), null,
  "with no categories declared, nothing is covered");

  var readOnlyOnly = policyFile({ enabled: true, categories: ["read_only_diagnosis"] });
  assert.equal(grant.standingAdmission(dispatch({ ownedPaths: "lib/lead-ledger.js" }),
    request({ bindingRevision: 2, ownedPaths: "lib/lead-ledger.js" }),
    { autonomyPolicyFile: readOnlyOnly,
      ownerRequests: ownerRequestsWith([approvedScope()]) }), null,
  "an undeclared category stays gated even when its evidence is present");
});

test("read-only means every owned path, not just the first", function () {
  var on = policyFile({ enabled: true });
  assert.equal(grant.fullyReadOnly("read-only: a.js; read-only: b.js"), true);
  assert.equal(grant.fullyReadOnly("read-only: a.js; b.js"), false,
    "a writable segment after a read-only one is not read-only work");
  assert.equal(grant.fullyReadOnly("a.js; read-only: b.js"), false);
  assert.equal(grant.fullyReadOnly(""), false, "no owned paths is not read-only");

  assert.equal(grant.standingAdmission(
    dispatch({ ownedPaths: "read-only: lib/lead-ledger.js; lib/daemon.js" }),
    request(), { autonomyPolicyFile: on }), null,
  "a mixed owned-path string must not pass as read-only diagnosis");

  // Read-only paths with no diagnosis framing are not this category either.
  assert.equal(grant.standingAdmission(
    dispatch({ title: "Rewrite the ledger writer",
      objective: "Change how rows are written." }),
    request(), { autonomyPolicyFile: on }), null);
});

// --- The file cannot lie about the boundary ------------------------------------

test("a policy file that misdeclares the permanent gates is off, not widened", function () {
  assert.deepEqual(grant.forbiddenIds(), ["push_to_remote",
    "pull_request_comment_or_merge", "issue_or_board_mutation", "approval_policy_change"]);

  function off(label, overrides) {
    var file = policyFile(Object.assign({ enabled: true }, overrides));
    assert.equal(grant.loadPolicy({ autonomyPolicyFile: file }), null, label);
    assert.equal(grant.standingAdmission(dispatch(), request(),
      { autonomyPolicyFile: file }), null, label + " (admission)");
  }

  off("dropping a gate switches the whole grant off",
    { permanentlyGated: ["push_to_remote", "pull_request_comment_or_merge",
      "issue_or_board_mutation"] });
  off("an empty gate list switches the whole grant off", { permanentlyGated: [] });
  off("a renamed gate switches the whole grant off",
    { permanentlyGated: ["push_to_remote", "pull_request_comment_or_merge",
      "issue_or_board_mutation", "approval_policy_change_but_not_really"] });
  off("a removed gate list switches the whole grant off", { permanentlyGated: undefined });
  off("an unknown category switches the whole grant off",
    { categories: ["read_only_diagnosis", "everything_else"] });
  off("a malformed project entry switches the whole grant off",
    { projects: [{ name: "clay", projectId: "not-a-uuid" }] });
  off("an unknown top-level key switches the whole grant off", { surprise: true });
  off("a wrong schema switches the whole grant off", { schema: "clay.something_else" });
  off("a wrong version switches the whole grant off", { version: 2 });
  // A truthy non-boolean must not read as on.
  off("a string \"true\" is not a boolean switch", { enabled: "true" });

  // A missing or unparseable file is off, and silently so: it must leave the
  // caller's own fail-closed default in charge rather than invent a refusal.
  assert.equal(grant.loadPolicy({ autonomyPolicyFile: "/nonexistent/policy.json" }), null);
  assert.equal(grant.standingAdmission(dispatch(), request(),
    { autonomyPolicyFile: "/nonexistent/policy.json" }), null);
  var torn = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clay-autonomy-")), "p.json");
  fs.writeFileSync(torn, "{ not json");
  assert.equal(grant.standingAdmission(dispatch(), request(),
    { autonomyPolicyFile: torn }), null);
});

// --- The named-approval rule is untouched -------------------------------------

test("the grant does not weaken the exactly-one-match rule for named approvals", function () {
  // A standing grant is a scope, not a matcher: it never reads owner wording.
  // Ambiguous and unmatched named approvals still refuse with the switch on.
  var file = policyFile({ enabled: true });
  var events = [
    { type: "staffing_attention", attentionKey: "clay-alpha-fix:1", itemId: "clay-alpha-fix",
      portfolioTaskId: "clay-alpha-fix", bindingRevision: 1, at: 1000, seq: 1 },
    { type: "staffing_attention", attentionKey: "clay-alpha-other:1", itemId: "clay-alpha-other",
      portfolioTaskId: "clay-alpha-other", bindingRevision: 1, at: 1001, seq: 2 },
  ];
  var snapshot = itemApproval.pendingApprovalSnapshotAt(events, 5000);
  assert.equal(snapshot.tasks.length, 2);
  assert.deepEqual(itemApproval.resolveApprovedTask(snapshot, "alpha"),
    { ok: false, reason: "owner_approval_ambiguous" },
    "two candidates still refuse to pick a winner");
  assert.deepEqual(itemApproval.resolveApprovedTask(snapshot, "nothing queued here"),
    { ok: false, reason: "owner_approval_unmatched_item" });
  // And the grant itself has no opinion on that wording at all.
  assert.equal(grant.standingAdmission({ title: "approve alpha", ownedPaths: "lib/x.js" },
    request({ portfolioTaskId: "clay-alpha-fix" }), { autonomyPolicyFile: file }), null);
});
