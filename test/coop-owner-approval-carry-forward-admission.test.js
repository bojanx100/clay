require("./helpers/isolated-clay-home");

var test = require("node:test");
var assert = require("node:assert/strict");
var os = require("os");
var path = require("path");
var fs = require("fs");
var createCrossProjectRouter = require("../lib/server-cross-project").createCrossProjectRouter;
var ownerRequestsModule = require("../lib/coop-owner-requests");
var createExternalTaskCoordinator =
  require("../lib/project-task-orchestrator-external-delegation").createExternalTaskCoordinator;
var createBindings = require("../lib/portfolio-execution-bindings")
  .createPortfolioExecutionBindings;

// Approval carry-forward, exercised through the real admission gate against a
// real owner-request ledger and a real binding store.
//
// An owner approval is spent on a task AT A REVISION, so a retry that bumps the
// revision loses it -- correctly, because otherwise one "yes" would authorize
// arbitrarily rewritten work. The owner's rule admits a narrow exception needing
// ALL of: same project, same task, same Thread scope, exactly the next revision,
// the approved revision ended failed, and no same-scope revision completed at or
// after the explicit approval. A completion before a later approval cannot
// consume it.
//
// These cases also pin the interaction with stale `requestRef.eventIndex`
// resolution (see coop-owner-event-resolution, which resolves an owner turn by
// its immutable `coopIngressId` because delta coalescing renumbered the
// transcript out from under every stored offset). Resolving those entries has to
// make them REACHABLE without making any of them more AUTHORIZED, so each case
// that admits a resolved turn has a sibling proving an unqualified turn is still
// refused after being located.

var CANONICAL = "871a194b-8879-40f7-a1fe-656e48e722af";
var PROJECT = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
var OTHER_PROJECT = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var TOPIC = { topicId: "owner-65d0dc78c4e6d085002842c1" };
var TASK = "healing-task";
var INGRESS = "coop:" + CANONICAL + ":459";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-admission-healing-"));
}

function ownerTurn(extra) {
  return Object.assign({
    type: "user_message",
    coopIngressId: INGRESS,
    coopComposerScope: "main",
    text: "Implement the approved change.",
    _ts: 5000,
  }, extra || {});
}

// Padding that is deliberately NOT a user_message, so a stale offset landing
// here is the "wrong but real event" case rather than an absent one.
function noise(index) {
  return { type: "tool_executing", text: "noise " + index, _ts: 100 + index };
}

// Builds a history whose owner turn sits at `at`, padded to `length` items.
function historyWith(at, length, turnExtra) {
  var history = [];
  for (var i = 0; i < length; i++) history.push(noise(i));
  history[at] = ownerTurn(turnExtra);
  return history;
}

// The live shape the router has to cope with, and the one the direct-admission
// harness above cannot produce: the authorizing owner turn is NOT the newest owner
// turn any more, because the owner has since said something conversational.
//
// That detail is load-bearing. `unscopedIngressCoverage` short-circuits to ok for
// the latest owner ingress, so while the authorizing turn is still the newest one
// the revision check never runs. Only once a later turn exists does coverage have
// to prove the durable scope covers the requested revision -- which is exactly the
// gate that swallowed the carry-forward in production.
function historyWithFollowUp(at, length) {
  var history = historyWith(at, length, { coopImplementationDecision: { intent: "implement" } });
  history[at + 180] = {
    type: "user_message",
    coopIngressId: "coop:" + CANONICAL + ":503",
    coopComposerScope: "main",
    text: "thanks, that makes sense",
    _ts: 6000,
  };
  return history;
}

function bindingRecord(revision, status, extra) {
  return Object.assign({
    portfolioTaskId: TASK,
    mode: "project_coordinator",
    targetProject: { projectId: PROJECT },
    bindingRevision: revision,
    idempotencyKey: TASK + "-r" + revision,
    source: { projectId: "system-lead", sessionStorageId: CANONICAL },
    coopTopicRef: TOPIC,
    controlPlaneProvenance: { schema: "clay.coop_control_plane_reservation", version: 1 },
    taskPayloadDigest: "d".repeat(64),
    provider: "codex",
    model: "gpt-5.6-luna",
    status: status,
    completedAt: status === "failed" ? 6000 : undefined,
    createdAt: 1000,
    updatedAt: 2000,
    coordinator: { projectId: PROJECT, sessionStorageId: "coordinator-session" },
    projectCoordinator: { projectId: "system-lead", sessionStorageId: "lead-session" },
  }, extra || {});
}

// A real ledger, a real binding store and the real router. The point of these
// tests is the interaction between durable owner state and the admission gate,
// so stubbing either side would test the stub.
function harness(options) {
  var opts = options || {};
  var dir = tempDir();
  var ledgerFile = path.join(dir, "coop-owner-requests.json");
  var bindingFile = path.join(dir, "bindings.json");
  fs.writeFileSync(bindingFile, JSON.stringify({
    schema: "clay.portfolio_execution_bindings",
    version: 1,
    bindings: opts.bindings || [],
  }));

  var ownerRequests = ownerRequestsModule.attachCoopOwnerRequests({ file: ledgerFile });
  var bindingStore = createBindings({ file: bindingFile });

  ownerRequests.record({
    ingressId: INGRESS,
    ingressSequence: 459,
    sessionRef: { projectId: "system-lead", sessionStorageId: CANONICAL },
    requestRef: {
      projectId: "system-lead",
      sessionStorageId: CANONICAL,
      eventIndex: opts.storedIndex,
    },
  });
  ownerRequests.classify(INGRESS, {
    kind: "existing_topic",
    source: "transcript_replay",
    topicRef: TOPIC,
    projectRefs: [{ projectId: PROJECT }],
    implementationDecision: { intent: "implement", source: "explicit_owner_turn", at: 5000 },
  });
  if (opts.priorScope) {
    var scoped = ownerRequests.scopeImplementation(INGRESS, {
      projectRef: { projectId: opts.priorScope.projectId || PROJECT },
      topicRef: TOPIC,
      portfolioTaskId: opts.priorScope.portfolioTaskId || TASK,
      bindingRevision: opts.priorScope.bindingRevision,
      idempotencyKey: (opts.priorScope.portfolioTaskId || TASK) + "-r" +
        opts.priorScope.bindingRevision,
    });
    assert.equal(scoped.ok, true, "prior scope must be established");
  }
  (opts.additionalScopes || []).forEach(function (additional) {
    ownerRequests.record({
      ingressId: additional.ingressId,
      ingressSequence: additional.ingressSequence,
      sessionRef: { projectId: "system-lead", sessionStorageId: CANONICAL },
      requestRef: {
        projectId: "system-lead",
        sessionStorageId: CANONICAL,
        eventIndex: additional.eventIndex,
      },
    });
    ownerRequests.classify(additional.ingressId, {
      kind: "existing_topic",
      source: "owner_named_approval",
      topicRef: TOPIC,
      projectRefs: [{ projectId: additional.projectId }],
      implementationDecision: { intent: "implement", source: "explicit_item_approval", at: 4000 },
    });
    var extraScoped = ownerRequests.scopeImplementation(additional.ingressId, {
      projectRef: { projectId: additional.projectId },
      topicRef: TOPIC,
      portfolioTaskId: additional.portfolioTaskId,
      bindingRevision: additional.bindingRevision,
      idempotencyKey: additional.portfolioTaskId + "-r" + additional.bindingRevision,
    });
    assert.equal(extraScoped.ok, true, "additional scope must be established");
  });

  var delivered = [];
  var leadSessions = new Map([[1, {
    coopHome: true,
    storageId: CANONICAL,
    history: opts.history || [],
  }]]);
  var router = createCrossProjectRouter({
    allowLeadSourcedExecution: true,
    bindingStore: bindingStore,
    bindingFile: bindingFile,
    deliveryFile: path.join(dir, "delivery.json"),
    ownerRequests: ownerRequests,
    requireOwnerImplementationDecision: true,
    readLeadEvents: function () { return []; },
    onThreadHandedOff: function () { return { ok: true }; },
  });
  router.registerProjectResolver({
    getProjectId: function () { return "system-lead"; },
    getSessionManager: function () {
      return {
        sessions: leadSessions,
        createSessionRaw: function (input) {
          var session = Object.assign({ localId: leadSessions.size + 1, history: [] },
            input || {});
          leadSessions.set(session.localId, session);
          return session;
        },
        saveSessionFile: function () {},
      };
    },
  });
  [PROJECT, OTHER_PROJECT].forEach(function (projectId) {
    router.registerProjectResolver({
      getProjectId: function () { return projectId; },
      deliverCrossProjectEnvelope: function (envelope) {
        delivered.push(envelope);
        return {
          ok: true,
          created: true,
          sessionRef: { projectId: projectId, sessionStorageId: "worker-session" },
          projectCoordinatorRef: envelope.payload.targetProjectCoordinator,
        };
      },
    });
  });

  // The seam the live daemon actually dispatches through: project-task-orchestrator
  // wires createExternalTaskCoordinator's createProjectExecution straight to
  // crossProject.createProjectExecution, so currentExecutionRoute runs FIRST and
  // admission only ever sees a route the router agreed to propose.
  var routed = [];
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return leadSessions.get(1); },
    projectId: function () { return "system-lead"; },
    ownerRequests: ownerRequests,
    readLeadEvents: function () { return []; },
    createProjectExecution: function (request) {
      routed.push(request);
      return router.createProjectExecution(request);
    },
  });

  return {
    router: router,
    ownerRequests: ownerRequests,
    ledgerFile: ledgerFile,
    delivered: delivered,
    // What the router proposed, per dispatch. Empty coopIngressId/coopTopicRef here
    // means the router refused to route and admission was never given a chance.
    routed: routed,
    // Drives the router + admission path end to end. Supplies NEITHER coopTopicRef
    // NOR coopIngressId -- both have to be derived from history by
    // currentExecutionRoute, which is what makes unscopedIngressCoverage run.
    dispatchViaRouter: function (spec) {
      var input = spec || {};
      var revision = input.bindingRevision || 1;
      var taskId = input.portfolioTaskId || TASK;
      var request = {
        coordinatorSessionId: CANONICAL,
        portfolioTaskId: taskId,
        bindingRevision: revision,
        idempotencyKey: taskId + "-r" + revision,
        mode: "project_coordinator",
        targetProject: { projectId: input.projectId || PROJECT },
        objective: "Implement the approved change.",
        title: "Implement the approved change.",
      };
      if (input.coopTopicRef) request.coopTopicRef = input.coopTopicRef;
      return coordinate(request);
    },
    dispatch: function (spec) {
      var input = spec || {};
      var revision = input.bindingRevision || 1;
      var taskId = input.portfolioTaskId || TASK;
      var request = {
        source: { projectId: "system-lead", sessionStorageId: CANONICAL },
        portfolioTaskId: taskId,
        bindingRevision: revision,
        idempotencyKey: taskId + "-r" + revision,
        mode: "project_coordinator",
        targetProject: { projectId: input.projectId || PROJECT },
        coopIngressId: INGRESS,
        objective: "Implement the approved change.",
        title: "Implement the approved change.",
      };
      if (input.omitTopic !== true) request.coopTopicRef = TOPIC;
      return router.createProjectExecution(request);
    },
    storedIndex: function () {
      var entry = ownerRequests.get(INGRESS);
      return entry && entry.requestRef ? entry.requestRef.eventIndex : null;
    },
    // Re-reads the file through a fresh ledger instance, so assertions about the
    // durable scope prove it survived a restart rather than only living in the
    // copy the router already holds.
    diskEntry: function () {
      var fresh = ownerRequestsModule.attachCoopOwnerRequests({ file: ledgerFile });
      return fresh.get(INGRESS);
    },
  };
}

test("a dispatch is admitted when the pinned offset points past the end of history",
  function () {
    // The 445-record case: the transcript shrank underneath the ledger, so the
    // stored coordinate indexes nothing at all.
    var h = harness({ storedIndex: 200452, history: historyWith(120, 400) });
    var result = h.dispatch({ bindingRevision: 1 });
    assert.equal(result.ok, true, result.reason);
  });

test("a dispatch is admitted when the pinned offset points at a wrong but real event",
  function () {
    // The 57-record case, and the dangerous one: the old offset lands on a
    // genuine `tool_executing` event, so nothing looks broken from the outside
    // while authorization fails silently.
    var h = harness({ storedIndex: 37, history: historyWith(120, 400) });
    var result = h.dispatch({ bindingRevision: 1 });
    assert.equal(result.ok, true, result.reason);
  });

test("a pinned offset landing on a DIFFERENT owner turn does not authorize that turn",
  function () {
    // The worst shape of the wrong-but-real case: the pinned event IS a
    // `user_message`, so a type check alone would accept it and admit a dispatch
    // against an owner turn the owner never aimed at this work. Only the
    // `coopIngressId` comparison rejects it, and resolution then finds the right
    // turn by identity.
    var history = historyWith(120, 400);
    history[37] = ownerTurn({ coopIngressId: "coop:" + CANONICAL + ":999" });
    var h = harness({ storedIndex: 37, history: history });
    var result = h.dispatch({ bindingRevision: 1 });
    assert.equal(result.ok, true, result.reason);
  });

test("admission fails closed when the ingress id matches no turn at all", function () {
  var history = historyWith(120, 400, { coopIngressId: "coop:" + CANONICAL + ":777" });
  var h = harness({ storedIndex: 200452, history: history });
  var result = h.dispatch({ bindingRevision: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_implementation_decision_required");
});

test("admission fails closed when the ingress id matches more than one turn", function () {
  // Two candidates make the choice arbitrary. Picking either would invent
  // provenance, so resolution refuses rather than guessing -- and the gate then
  // has no canonical event and refuses too.
  var history = historyWith(120, 400);
  history[240] = ownerTurn();
  var h = harness({ storedIndex: 200452, history: history });
  var result = h.dispatch({ bindingRevision: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_implementation_decision_required");
});

test("a turn located by identity is still refused when it does not qualify", function () {
  // SAFETY BOUND: locating a turn is not authorizing it. This turn is reachable
  // only via the identity fallback and is then rejected for naming another
  // project, exactly as it would have been had the pinned offset still been
  // correct. Resolution may change HOW a turn is found, never WHICH qualify.
  var h = harness({ storedIndex: 200452, history: historyWith(120, 400) });
  var result = h.dispatch({ bindingRevision: 1, projectId: OTHER_PROJECT });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_implementation_project_mismatch");
});

test("an already-correct offset is used directly", function () {
  var h = harness({ storedIndex: 120, history: historyWith(120, 400) });
  var result = h.dispatch({ bindingRevision: 1 });
  assert.equal(result.ok, true, result.reason);
  assert.equal(h.storedIndex(), 120);
});

test("carry-forward is permitted when the exact approved revision failed",
  function () {
    var h = harness({
      storedIndex: 200452,
      history: historyWith(120, 400),
      priorScope: { bindingRevision: 1 },
      bindings: [bindingRecord(1, "failed")],
    });
    var result = h.dispatch({ bindingRevision: 2 });
    assert.equal(result.ok, true);
    var entry = h.diskEntry();
    assert.equal(entry.implementationScope.bindingRevision, 2);
    assert.equal(entry.classification.source, "owner_directed_execution_carry_forward",
      "the carry-forward must be durably recorded, not implicit");
  });

// A restart-recovery terminalization is not evidence that the approved work
// failed -- the execution was killed with its daemon, which says nothing about
// whether the work had finished. Live on 2026-08-22, eleven stranded controlled
// executions were terminalized this way so startup recovery could run, and four
// of the five resulting bindings described work that had SUCCEEDED (a worker
// reporting WORKER_STATUS: completed with 89/89, and three PRs already pushed).
// Each of those was then retry-shaped: same `failed` status, a valid
// post-approval completedAt, and every other carry-forward gate satisfied.
test("carry-forward is REFUSED when the approved revision was terminalized by restart recovery",
  function () {
    ["restart_recovery", "restart_recovery_superseded", "control_restart_recovery"]
      .forEach(function (code) {
        // failureCode is the field the completion writer mirrors...
        var byCode = harness({
          storedIndex: 200452,
          history: historyWith(120, 400),
          priorScope: { bindingRevision: 1 },
          bindings: [bindingRecord(1, "failed", { failureCode: code, statusReason: code })],
        });
        assert.equal(byCode.dispatch({ bindingRevision: 2 }).ok, false,
          code + " must not authorize a retry of work whose outcome is unestablished");

        // ...and statusReason alone must be enough, since a record written
        // before failureCode existed still carries the provenance there.
        var byReason = harness({
          storedIndex: 200452,
          history: historyWith(120, 400),
          priorScope: { bindingRevision: 1 },
          bindings: [bindingRecord(1, "failed", { statusReason: code })],
        });
        assert.equal(byReason.dispatch({ bindingRevision: 2 }).ok, false,
          code + " in statusReason alone must also refuse");
      });
  });

// The refusal must be scoped to indeterminate provenance only. Sixty live failed
// bindings predate the failureCode field entirely, and a determinate failure is
// still exactly what a carry-forward is for.
test("carry-forward still works for a determinate failure with unrelated provenance",
  function () {
    var h = harness({
      storedIndex: 200452,
      history: historyWith(120, 400),
      priorScope: { bindingRevision: 1 },
      bindings: [bindingRecord(1, "failed",
        { failureCode: "scope_expansion", statusReason: "scope_expansion" })],
    });
    assert.equal(h.dispatch({ bindingRevision: 2 }).ok, true,
      "an ordinary failure reason must still carry the approval forward");
  });

test("REGRESSION: an older completion before a later approved scope does not consume it",
  function () {
    // Voice has this exact history: rev1 completed for Clay before the owner
    // explicitly approved failed rev3 for clay-chrome. The old task-wide scan
    // saw rev1 and rejected rev4 before it checked either scope or time.
    var h = harness({
      storedIndex: 200452,
      history: historyWith(120, 400),
      priorScope: { bindingRevision: 3 },
      bindings: [
        bindingRecord(1, "completed", {
          targetProject: { projectId: OTHER_PROJECT },
          completedAt: 4000,
        }),
        bindingRecord(3, "failed", { completedAt: 6000 }),
      ],
    });
    var result = h.dispatch({ bindingRevision: 4 });
    assert.equal(result.ok, true, result.reason);
    assert.equal(h.diskEntry().implementationScope.bindingRevision, 4);
  });

test("carry-forward is REFUSED when a matching scope completed after approval",
  function () {
    // The completion timestamp, not revision ordering, consumes approval. A
    // still-running earlier revision can finish after the owner approved rev3.
    var h = harness({
      storedIndex: 200452,
      history: historyWith(120, 400),
      priorScope: { bindingRevision: 3 },
      bindings: [
        bindingRecord(2, "completed", { completedAt: 6000 }),
        bindingRecord(3, "failed", { completedAt: 6000 }),
      ],
    });
    var result = h.dispatch({ bindingRevision: 4 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "owner_implementation_scope_mismatch");
  });

test("carry-forward is REFUSED without timestamped failure evidence after approval",
  function () {
    [{ completedAt: null }, { completedAt: 4000 }].forEach(function (failureEvidence) {
      var h = harness({
        storedIndex: 200452,
        history: historyWith(120, 400),
        priorScope: { bindingRevision: 3 },
        bindings: [bindingRecord(3, "failed", failureEvidence)],
      });
      var result = h.dispatch({ bindingRevision: 4 });
      assert.equal(result.ok, false, JSON.stringify(failureEvidence));
      assert.equal(result.reason, "owner_implementation_scope_mismatch");
      assert.equal(h.diskEntry().implementationScope.bindingRevision, 3,
        "unproven failure evidence must not move durable authorization");
    });
  });

test("carry-forward is REFUSED by ambiguous post-approval completion evidence",
  function () {
    [
      { coopTopicRef: null },
      { targetProject: null },
    ].forEach(function (ambiguousEvidence) {
      var h = harness({
        storedIndex: 200452,
        history: historyWith(120, 400),
        priorScope: { bindingRevision: 3 },
        bindings: [
          bindingRecord(2, "completed", Object.assign({ completedAt: 6000 },
            ambiguousEvidence)),
          bindingRecord(3, "failed"),
        ],
      });
      var result = h.dispatch({ bindingRevision: 4 });
      assert.equal(result.ok, false, JSON.stringify(ambiguousEvidence));
      assert.equal(result.reason, "owner_implementation_scope_mismatch");
      assert.equal(h.diskEntry().implementationScope.bindingRevision, 3,
        "ambiguous completion evidence must not move durable authorization");
    });
  });

test("a scoped retry with no expected TopicRef fails closed instead of throwing", function () {
  var h = harness({
    storedIndex: 200452,
    history: historyWith(120, 400),
    priorScope: { bindingRevision: 3 },
    bindings: [bindingRecord(3, "failed")],
  });
  var result = h.dispatch({ bindingRevision: 4, omitTopic: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "thread_ref_required");
  assert.equal(h.diskEntry().implementationScope.bindingRevision, 3);
});

test("carry-forward is REFUSED when the approved revision has not finished", function () {
  // Nothing to retry yet: an active revision has not failed.
  var h = harness({
    storedIndex: 200452,
    history: historyWith(120, 400),
    priorScope: { bindingRevision: 1 },
    bindings: [bindingRecord(1, "active")],
  });
  var result = h.dispatch({ bindingRevision: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_implementation_scope_mismatch");
});

test("carry-forward is REFUSED for superseded, unrouted and deleted revisions", function () {
  // These mean withdrawn, never routed, or removed -- binding bookkeeping rather
  // than an attempt the owner watched fail. Admitting them would let routine
  // churn manufacture authorization.
  ["superseded", "unrouted", "deleted"].forEach(function (status) {
    var h = harness({
      storedIndex: 200452,
      history: historyWith(120, 400),
      priorScope: { bindingRevision: 1 },
      bindings: [bindingRecord(1, status)],
    });
    var result = h.dispatch({ bindingRevision: 2 });
    assert.equal(result.ok, false, status + " must not carry an approval forward");
    assert.equal(result.reason, "owner_implementation_scope_mismatch");
  });
});

// PIN, not a proposal. `approvalCarriesForward` requires the scoped revision's
// status to be `failed`, and this fixes the outcome for all four
// statuses that argument has ever been had about, so that changing ANY of them
// has to be a deliberate edit visible in a diff rather than a side effect of
// touching the gate for some other reason.
//
// Measured by driving the real gate against copies of the live binding store and
// owner ledger and changing ONLY the status (see dd65f86ef1 / 4fdd2bdb00).
//
// Why `superseded` is excluded, and must stay excluded: superseded means
// withdrawn or replaced. Admitting it would let ordinary binding churn
// manufacture authorization -- anything able to supersede a revision could then
// mint the owner's "yes" for a newer one.
//
// The nuance that was considered and DELIBERATELY not acted on: a
// reconciler-written supersede of an execution that ran zero turns is arguably
// not an owner withdrawal, and `statusReason` does carry that distinction (e.g.
// `compaction_orphan_reconciled`). Acting on it would WIDEN an authorization
// gate, which is an owner-authority decision -- not one to take from inside a
// test or a neighbouring bug fix. Re-approving costs the owner one sentence and
// keeps the gate strict. If that call is ever made it belongs in its own change
// with its own reasoning, and this test is what will force it to say so.
test("PIN: carry-forward across all four statuses, current strict behaviour", function () {
  var expected = [
    // The approved revision failed and the owner watched it fail. This is the
    // narrow exception the rule exists for.
    { status: "failed", carries: true },
    // Withdrawn or replaced -- bookkeeping, not a watched failure.
    { status: "cancelled", carries: false },
    { status: "superseded", carries: false },
    // Success CONSUMES the approval. Retrying delivered work needs a fresh yes.
    { status: "completed", carries: false },
  ];
  expected.forEach(function (item) {
    var h = harness({
      storedIndex: 200452,
      history: historyWith(120, 400),
      priorScope: { bindingRevision: 1 },
      bindings: [bindingRecord(1, item.status,
        item.status === "completed" ? { completedAt: 3000 } : null)],
    });
    var result = h.dispatch({ bindingRevision: 2 });
    assert.equal(result.ok, item.carries,
      item.status + " must " + (item.carries ? "" : "NOT ") + "carry an approval forward");
    if (item.carries) {
      assert.equal(h.diskEntry().implementationScope.bindingRevision, 2,
        item.status + " must move the durable scope to the retried revision");
      assert.equal(h.diskEntry().classification.source,
        "owner_directed_execution_carry_forward",
        item.status + " must record the carry-forward durably, not implicitly");
    } else {
      assert.equal(result.reason, "owner_implementation_scope_mismatch",
        item.status + " must be refused by the scope gate");
      assert.equal(h.diskEntry().implementationScope.bindingRevision, 1,
        "a refused carry-forward must not move the durable scope");
    }
  });
});

test("carry-forward is REFUSED when the requested revision is not newer", function () {
  var h = harness({
    storedIndex: 200452,
    history: historyWith(120, 400),
    priorScope: { bindingRevision: 3 },
    bindings: [bindingRecord(3, "failed")],
  });
  var result = h.dispatch({ bindingRevision: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_implementation_scope_mismatch");
});

test("carry-forward is REFUSED when the requested revision skips the next revision", function () {
  var h = harness({
    storedIndex: 200452,
    history: historyWith(120, 400),
    priorScope: { bindingRevision: 1 },
    bindings: [bindingRecord(1, "failed")],
  });
  var result = h.dispatch({ bindingRevision: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_implementation_scope_mismatch");
});

test("carry-forward is REFUSED across a different task", function () {
  var h = harness({
    storedIndex: 200452,
    history: historyWith(120, 400),
    priorScope: { bindingRevision: 1, portfolioTaskId: "some-other-task" },
    bindings: [bindingRecord(1, "failed")],
  });
  var result = h.dispatch({ bindingRevision: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_implementation_scope_mismatch");
});

test("carry-forward is REFUSED when the retry changes the approved task", function () {
  var h = harness({
    storedIndex: 200452,
    history: historyWith(120, 400),
    priorScope: { bindingRevision: 3 },
    bindings: [bindingRecord(3, "failed")],
  });
  var result = h.dispatch({ portfolioTaskId: "some-other-task", bindingRevision: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_implementation_scope_mismatch");
});

test("carry-forward is REFUSED when failed evidence changes ProjectRef or Thread scope", function () {
  [{ targetProject: { projectId: OTHER_PROJECT } }, { coopTopicRef: { topicId: "other-topic" } }]
    .forEach(function (changedEvidence) {
      var h = harness({
        storedIndex: 200452,
        history: historyWith(120, 400),
        priorScope: { bindingRevision: 3 },
        bindings: [bindingRecord(3, "failed", changedEvidence)],
      });
      var result = h.dispatch({ bindingRevision: 4 });
      assert.equal(result.ok, false, JSON.stringify(changedEvidence));
      assert.equal(result.reason, "owner_implementation_scope_mismatch");
      assert.equal(h.diskEntry().implementationScope.bindingRevision, 3,
        "a changed scope must not move durable authorization");
    });
});

test("carry-forward is REFUSED after the owner withdraws the approved request", function () {
  var h = harness({
    storedIndex: 200452,
    history: historyWith(120, 400),
    priorScope: { bindingRevision: 3 },
    bindings: [bindingRecord(3, "failed")],
  });
  assert.ok(h.ownerRequests.supersede(INGRESS, "owner withdrew approval"));
  var result = h.dispatch({ bindingRevision: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_implementation_decision_required");
});

test("carry-forward is REFUSED when there is no binding history to justify it", function () {
  // An empty store is not evidence that the approved revision failed.
  var h = harness({
    storedIndex: 200452,
    history: historyWith(120, 400),
    priorScope: { bindingRevision: 1 },
    bindings: [],
  });
  var result = h.dispatch({ bindingRevision: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_implementation_scope_mismatch");
});

// REGRESSION, and the reason this file grew a second entry point. The carry-forward
// above was verified only through `router.createProjectExecution`, which is handed a
// coopTopicRef and a coopIngressId by the test. The live daemon is not: it calls
// coordinateExternalTask, which runs `currentExecutionRoute` first, and that scan's
// coverage check demanded EXACT revision equality against the durable owner-request
// scope. So for any retry the router returned an empty route, admission bailed on
// the missing Thread, and `approvalCarriesForward` was never reached -- the rule was
// live in code and dead in production. These two cases fail without the router half
// of the fix, and the harness above cannot express them.
test("REGRESSION: a rev2 retry is routed AND admitted through the full router path",
  function () {
    var h = harness({
      storedIndex: 200452,
      history: historyWithFollowUp(120, 400),
      priorScope: { bindingRevision: 1 },
      bindings: [bindingRecord(1, "failed")],
    });

    var result = h.dispatchViaRouter({ bindingRevision: 2 });

    // The router ran, and it ran the coverage check rather than short-circuiting:
    // the caller supplied no ingress and no Thread, so both values below exist only
    // because currentExecutionRoute derived them from the rev1-scoped record.
    assert.equal(h.routed.length, 1);
    assert.equal(h.routed[0].coopIngressId, INGRESS,
      "the router must propose the rev1 owner turn as covering the rev2 retry");
    assert.deepEqual(h.routed[0].coopTopicRef, TOPIC,
      "and carry that turn's own Thread, so nothing is minted");

    assert.equal(result.ok, true, result.reason);
    assert.equal(h.diskEntry().implementationScope.bindingRevision, 2);
    assert.equal(h.diskEntry().classification.source,
      "owner_directed_execution_carry_forward");
  });

test("REGRESSION: a Thread with multiple approvals routes the one covering the retry",
  function () {
    var otherIngress = "coop:" + CANONICAL + ":458";
    var history = historyWith(120, 400, {
      text: "Approve " + TASK + " rev3.",
    });
    history[80] = ownerTurn({
      coopIngressId: otherIngress,
      text: "Approve unrelated-task rev1.",
      _ts: 4000,
    });
    history[300] = {
      type: "user_message",
      coopIngressId: "coop:" + CANONICAL + ":503",
      coopComposerScope: "main",
      text: "thanks, that makes sense",
      _ts: 6000,
    };
    var h = harness({
      storedIndex: 120,
      history: history,
      priorScope: { bindingRevision: 3 },
      bindings: [bindingRecord(3, "failed")],
      additionalScopes: [{
        ingressId: otherIngress,
        ingressSequence: 458,
        eventIndex: 80,
        projectId: OTHER_PROJECT,
        portfolioTaskId: "unrelated-task",
        bindingRevision: 1,
      }],
    });

    var result = h.dispatchViaRouter({ bindingRevision: 4, coopTopicRef: TOPIC });

    assert.equal(h.routed[0].coopIngressId, INGRESS,
      "the router must select the one durable scope covering this typed retry");
    assert.deepEqual(h.routed[0].coopTopicRef, TOPIC);
    assert.equal(result.ok, true, result.reason);
    assert.equal(h.diskEntry().implementationScope.bindingRevision, 4);
  });

test("REGRESSION: a stale approval offset still routes the matching Thread retry",
  function () {
    var otherIngress = "coop:" + CANONICAL + ":458";
    var history = historyWith(120, 400, {
      text: "Approve " + TASK + " rev3.",
    });
    history[80] = ownerTurn({
      coopIngressId: otherIngress,
      text: "Approve unrelated-task rev1.",
      _ts: 4000,
    });
    history[300] = {
      type: "user_message",
      coopIngressId: "coop:" + CANONICAL + ":503",
      coopComposerScope: "main",
      text: "thanks, that makes sense",
      _ts: 6000,
    };
    var h = harness({
      // The durable offset lands on a real, unrelated history item. The router
      // must resolve the immutable ingress identity before scope filtering.
      storedIndex: 37,
      history: history,
      priorScope: { bindingRevision: 3 },
      bindings: [bindingRecord(3, "failed")],
      additionalScopes: [{
        ingressId: otherIngress,
        ingressSequence: 458,
        eventIndex: 80,
        projectId: OTHER_PROJECT,
        portfolioTaskId: "unrelated-task",
        bindingRevision: 1,
      }],
    });

    var result = h.dispatchViaRouter({ bindingRevision: 4, coopTopicRef: TOPIC });

    assert.equal(h.routed[0].coopIngressId, INGRESS,
      "the router must recover the matching approval by immutable ingress id");
    assert.deepEqual(h.routed[0].coopTopicRef, TOPIC);
    assert.equal(result.ok, true, result.reason);
    assert.equal(h.diskEntry().implementationScope.bindingRevision, 4);
  });

test("an older exact approval is not shadowed by a later unrelated approval", function () {
  var taskId = "clay-coop-foreground-continuation-fix";
  var approvalIngress = "coop:" + CANONICAL + ":533";
  var source = { storageId: CANONICAL, history: [{
    type: "user_message",
    text: "Approve " + taskId + " rev1.\n\nWrite the remaining handoff.",
    coopIngressId: approvalIngress,
    coopComposerScope: "main",
    _ts: 5000,
  }, {
    type: "user_message",
    text: "Approve unrelated-task rev2.",
    coopIngressId: "coop:" + CANONICAL + ":535",
    coopComposerScope: "main",
    _ts: 6000,
  }] };
  var delivered = null;
  var coordinate = createExternalTaskCoordinator({
    sessionForInput: function () { return source; },
    projectId: function () { return "system-lead"; },
    readLeadEvents: function () { return []; },
    ensureOwnerThread: function (request) {
      assert.equal(request.ingressId, approvalIngress);
      return { ok: true, topicRef: TOPIC };
    },
    createProjectExecution: function (request) { delivered = request; return { ok: true }; },
  });

  var result = coordinate({
    coordinatorSessionId: CANONICAL,
    portfolioTaskId: taskId,
    bindingRevision: 1,
    idempotencyKey: taskId + "-r1",
    mode: "project_coordinator",
    targetProject: { projectId: OTHER_PROJECT },
  });

  assert.equal(result.ok, true);
  assert.equal(delivered.coopApprovalIngressId, approvalIngress);
  assert.deepEqual(delivered.coopTopicRef, TOPIC);
});

test("REGRESSION: an ever-completed task is routed by the router and REFUSED by admission",
  function () {
    // The other half of the asymmetry, and the check that the router widening did
    // not become an authorization. The router proposes the same rev1 turn here --
    // identity and monotonicity hold -- and admission alone kills it, because a
    // completed revision consumed the approval. A change that frees both this and
    // the case above is wrong.
    var h = harness({
      storedIndex: 200452,
      history: historyWithFollowUp(120, 400),
      priorScope: { bindingRevision: 1 },
      bindings: [bindingRecord(1, "completed", { completedAt: 3000 })],
    });

    var result = h.dispatchViaRouter({ bindingRevision: 2 });

    assert.equal(h.routed.length, 1);
    assert.equal(h.routed[0].coopIngressId, INGRESS,
      "the router still proposes -- refusing here would hide the real reason");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "owner_implementation_scope_mismatch");
    assert.equal(h.diskEntry().implementationScope.bindingRevision, 1,
      "a refused carry-forward must not move the durable scope");
  });

test("REGRESSION: the router still refuses to route a retry of ANOTHER task", function () {
  // The widening is scoped to the revision only. A scope for a different task must
  // not cover this work at any revision, so the route stays empty and the blocker
  // stays truthful rather than borrowing an unrelated owner turn.
  var h = harness({
    storedIndex: 200452,
    history: historyWithFollowUp(120, 400),
    priorScope: { bindingRevision: 1, portfolioTaskId: "some-other-task" },
    bindings: [bindingRecord(1, "failed")],
  });

  var result = h.dispatchViaRouter({ bindingRevision: 2 });

  assert.equal(h.routed.length, 1);
  assert.equal(h.routed[0].coopIngressId, undefined);
  assert.equal(h.routed[0].coopTopicRef, undefined);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "owner_implementation_decision_required");
});

test("REGRESSION: the router still refuses to walk an approval BACKWARDS a revision",
  function () {
    // Strict monotonicity is the shared predicate's job, and the router must honour
    // it too: an approval spent on rev3 does not cover rev2, which the owner has
    // already seen the outcome of.
    var h = harness({
      storedIndex: 200452,
      history: historyWithFollowUp(120, 400),
      priorScope: { bindingRevision: 3 },
      bindings: [bindingRecord(3, "failed")],
    });

    var result = h.dispatchViaRouter({ bindingRevision: 2 });

    assert.equal(h.routed[0].coopIngressId, undefined);
    assert.equal(result.ok, false);
  });

test("an exact re-dispatch of the approved revision is still a reuse, not a carry-forward",
  function () {
    // No binding for revision 1 yet, so this is a clean reservation rather than
    // a retry -- the scope is byte-identical and must take the reuse path.
    var h = harness({
      storedIndex: 200452,
      history: historyWith(120, 400),
      priorScope: { bindingRevision: 1 },
      bindings: [],
    });
    var result = h.dispatch({ bindingRevision: 1 });
    assert.equal(result.ok, true, result.reason);
    assert.equal(h.diskEntry().implementationScope.bindingRevision, 1);
    assert.equal(h.diskEntry().classification.source, "owner_directed_execution",
      "reuse must not be relabelled as a carry-forward");
  });
