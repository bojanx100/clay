var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var authority = require("../lib/project-automation-authority");
var authorization = require("../lib/project-automation-execution-authorization");
var candidatesModule = require("../lib/project-automation-candidates");
var identity = require("../lib/project-automation-identity");

var PROJECT = "51e67388-cea0-52b7-8e01-cde68cae713c";
var OTHER = "11111111-2222-4333-8444-555555555555";
var PASS = "current-pass";

function policy(digest) {
  return {
    projectRef: { projectId: PROJECT },
    digest: digest,
    derived: false,
    autonomy: {
      bug: "propose", feature: "propose", ambiguous: "autonomous",
      pr_review: "propose", default: "propose",
    },
    externalActions: {
      comment: "approval", done_workflow: "approval", merge: "approval", close: "approval",
    },
  };
}

function candidate() {
  return {
    candidateKey: "launch:bojanx100/urban-stay-web#198",
    itemKey: "bojanx100/urban-stay-web#198",
    itemClass: "ambiguous",
    admission: "auto",
    projectRef: { projectId: PROJECT },
    policyDigest: "policy-current",
    recipeId: "all-issues",
    eligibilityPass: PASS,
    eligibility: {
      assignedToOwner: false,
      recipeAllowsUnassigned: true,
      reason: "recipe_allows_unassigned",
    },
    intent: { recipeId: "all-issues", number: 198, title: "Stuck until refresh" },
  };
}

function request(record) {
  var portfolioTaskId = identity.portfolioTaskIdFor(record);
  return {
    targetProject: { projectId: PROJECT },
    portfolioTaskId: portfolioTaskId,
    bindingRevision: 1,
    idempotencyKey: identity.idempotencyKeyFor(portfolioTaskId, 1),
    mode: "project_coordinator",
  };
}

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-auto-auth-"));
  var store = candidatesModule.createCandidateStore({ cwd: dir });
  store.upsert(candidate());
  var record = store.get({ projectId: PROJECT }, candidate().candidateKey);
  var currentPolicy = policy(record.policyDigest);
  var scope = request(record);
  var typed = authorization.createAuthorization(record, scope);
  var validator = authorization.createAuthorizationValidator({
    candidates: store,
    getLeadMode: function () { return true; },
    loadPolicy: function () { return { ok: true, policy: currentPolicy }; },
    now: function () { return 1000; },
  });
  return {
    authorization: typed,
    dir: dir,
    policy: currentPolicy,
    request: scope,
    store: store,
    validator: validator,
  };
}

test("current autonomous candidate evidence yields one strict typed authorization", function () {
  var h = harness();
  try {
    assert.deepEqual(h.validator.validate({
      authorization: h.authorization,
      request: h.request,
    }).ok, true);
    assert.deepEqual(h.authorization.threadRef,
      identity.threadRefFor(candidate()));
    assert.equal(authorization.normalizeAuthorization(Object.assign({}, h.authorization, {
      unexpected: true,
    })), null, "unknown provenance fields fail closed");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("stale, malformed, foreign, owner-gated, and non-autonomous evidence fails closed", function () {
  var h = harness();
  try {
    var cases = [{
      name: "foreign ProjectRef",
      mutate: function (value) {
        value.projectRef = { projectId: OTHER };
        value.threadRef = identity.threadRefFor({
          projectRef: { projectId: OTHER }, itemKey: value.itemKey,
        });
      },
      reason: "automation_project_mismatch",
    }, {
      name: "stale policy",
      mutate: function (value) { value.policyDigest = "policy-stale"; },
      reason: "automation_policy_stale",
    }, {
      name: "stale eligibility",
      mutate: function (value) { value.eligibilityPass = "old-pass"; },
      reason: "automation_eligibility_stale",
    }, {
      name: "foreign source",
      mutate: function (value) { value.source.recipeId = "another-recipe"; },
      reason: "automation_source_mismatch",
    }, {
      name: "scope mismatch",
      mutate: function (value) { value.scope.portfolioTaskId = "auto:foreign"; },
      reason: "automation_scope_mismatch",
    }];
    for (var i = 0; i < cases.length; i++) {
      var changed = JSON.parse(JSON.stringify(h.authorization));
      cases[i].mutate(changed);
      var outcome = h.validator.validate({ authorization: changed, request: h.request });
      assert.equal(outcome.ok, false, cases[i].name);
      assert.equal(outcome.reason, cases[i].reason, cases[i].name);
    }

    h.store.upsert(Object.assign({}, candidate(), {
      admission: "owner_approval",
    }));
    var gated = h.store.get({ projectId: PROJECT }, candidate().candidateKey);
    var gatedAuthorization = authorization.createAuthorization(gated, request(gated));
    assert.equal(h.validator.validate({
      authorization: gatedAuthorization,
      request: request(gated),
    }).reason, "owner_approval_required");

    h.store.upsert(candidate());
    h.policy.autonomy.ambiguous = "propose";
    assert.equal(h.validator.validate({
      authorization: authorization.createAuthorization(
        h.store.get({ projectId: PROJECT }, candidate().candidateKey), h.request),
      request: h.request,
    }).reason, "automation_policy_not_autonomous");

    h.policy.autonomy.ambiguous = "autonomous";
    var file = path.join(h.dir, ".clay", "tasks", "automation-candidates.json");
    var persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    persisted.candidates[0].digest = "tampered-current-candidate";
    fs.writeFileSync(file, JSON.stringify(persisted));
    assert.equal(h.validator.validate({
      authorization: authorization.createAuthorization(persisted.candidates[0], h.request),
      request: h.request,
    }).reason, "automation_candidate_malformed");
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("typed launch admission does not weaken configured external approval gates", function () {
  var current = policy("policy-current");
  var kinds = ["comment", "done_workflow", "merge", "close"];
  for (var i = 0; i < kinds.length; i++) {
    var verdict = authority.decideAutomation({
      leadMode: true,
      action: "external",
      externalKind: kinds[i],
      projectRef: { projectId: PROJECT },
      policy: current,
      claim: { held: true, holder: "coop", expiresAt: 2000 },
      holder: "coop",
      completion: { status: "completed", summary: "done", verification: "tests",
        escalationRequired: "no" },
      approval: null,
      now: 1000,
    });
    assert.equal(verdict.decision, "deny", kinds[i]);
    assert.equal(verdict.reason, "approval_required", kinds[i]);
  }
});
