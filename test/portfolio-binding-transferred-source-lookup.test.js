require("./helpers/isolated-clay-home");

var test = require("node:test");
var assert = require("node:assert/strict");
var os = require("os");
var path = require("path");
var fs = require("fs");
var portfolioBindings = require("../lib/portfolio-execution-bindings");
var createBindings = portfolioBindings.createPortfolioExecutionBindings;
var createCrossProjectRouter = require("../lib/server-cross-project").createCrossProjectRouter;

// Finding the governed session of a binding whose session has TRANSFERRED.
//
// `reconcileStrandedCompletions` could never terminalize a control-plane-routed
// coordinator binding after a session transfer. Every predicate in
// `transferredExecutionMatch` passed -- task, revision, mode, idempotencyKey --
// and `distanceFrom` returned 1, so lineage resolved exactly as designed. The
// successor was rejected on the source comparison alone, because the two sides
// are written by different writers from different vantage points:
//
//   binding.source   = {system-lead, 871a194b-...}  the Coop session that ASKED
//   metadata.source  = {system-lead, lead-project-coordinator}  the authority it RUNS UNDER
//
// The equality check could not succeed for ANY such binding, so this was latent
// for every control-plane-routed coordinator whose session transfers -- not one
// stuck task. It was masked, not fixed, by the compaction refusal in 3442831407:
// with no compaction the exact ref matches at distance 0 and the transferred
// path never runs. Transfer is still reachable through the other
// `transferSettledOrchestrationState` callers (the manual `compact_session` WS
// message, Coop self-cleanup rotation).
//
// These tests drive the REAL lookup against a real binding store and a real
// session manager. They deliberately do NOT pass a `sessionForBinding` closure
// that returns the successor: hand-feeding the answer to the lookup under test
// proves only that the downstream pipeline works once the successor is found,
// which was never the question (see dd65f86ef1, which retracts exactly that).

var CANONICAL = "871a194b-8879-40f7-a1fe-656e48e722af";  // Coop home: the dispatcher
var LEAD_COORD = "lead-project-coordinator";             // control-plane root (rootRef)
var RIVAL_COORD = "rival-project-coordinator";           // a DIFFERENT control-plane root
var PROJECT = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";
var TASK = "webapp-automation-policy-board-exclusions";
var PRED = "351a861b-521f-4691-9edb-5ce70f90fefc";       // the bound, pre-transfer session
var SUCC = "e30ec128-0d6c-478d-bb1c-136758a0bad5";       // the successor

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-transferred-lookup-"));
}

// A control-plane-routed coordinator binding, shaped as the store writes it:
// `source` from the pre-route request, `projectCoordinator` from commit().
function bindingRecord(extra) {
  return Object.assign({
    portfolioTaskId: TASK,
    mode: "project_coordinator",
    targetProject: { projectId: PROJECT },
    bindingRevision: 2,
    idempotencyKey: TASK + "-r2",
    source: { projectId: "system-lead", sessionStorageId: CANONICAL },
    controlPlaneProvenance: { schema: "clay.coop_control_plane_reservation", version: 1 },
    taskPayloadDigest: "d".repeat(64),
    status: "active",
    createdAt: 1000,
    updatedAt: 2000,
    coordinator: { projectId: PROJECT, sessionStorageId: PRED },
    projectCoordinator: { projectId: "system-lead", sessionStorageId: LEAD_COORD },
  }, extra || {});
}

// Metadata as `activeExecutionMetadata(null, request, input.source)` writes it at
// the target, where `input.source` is the create envelope's source. Terminal, with
// the delivery-event id `completionEvidence` requires, so the ONLY thing standing
// between this binding and terminalization is whether the lookup finds the session.
function executionMetadata(extra) {
  return Object.assign({
    portfolioTaskId: TASK,
    bindingRevision: 2,
    idempotencyKey: TASK + "-r2",
    mode: "project_coordinator",
    targetProject: { projectId: PROJECT },
    source: { projectId: "system-lead", sessionStorageId: LEAD_COORD },
    status: "failed",
    reason: "provider_wedged",
    terminalAt: 4000,
    projectCompletionDeliveryEventId: "evt-project-completion-1",
    projectCompletionResultEventId: "evt-result-1",
  }, extra || {});
}

// The post-transfer shape `transferSettledOrchestrationState` produces: the
// predecessor keeps its identity but MOVES its orchestrationPolicy to the
// successor, which records `compactedFromStorageId` as its lineage edge.
function harness(options) {
  var opts = options || {};
  var dir = tempDir();
  var bindingFile = path.join(dir, "bindings.json");
  var record = opts.binding || bindingRecord();
  fs.writeFileSync(bindingFile, JSON.stringify({
    schema: "clay.portfolio_execution_bindings",
    version: 1,
    bindings: [record],
  }));

  var predecessor = { localId: 1, storageId: PRED, history: [] };
  var successor = {
    localId: 2,
    storageId: SUCC,
    history: [],
    orchestrationPolicy: { portfolioExecution: opts.metadata || executionMetadata() },
  };
  if (opts.lineage !== false) successor.compactedFromStorageId = PRED;
  if (opts.predecessorKeepsMetadata === true) {
    predecessor.orchestrationPolicy = { portfolioExecution: opts.metadata || executionMetadata() };
  }

  var saved = [];
  var sessions = new Map([[1, predecessor], [2, successor]]);
  var manager = {
    sessions: sessions,
    saveSessionFile: function (session) { saved.push(session); },
  };

  var bindingStore = createBindings({ file: bindingFile });
  var router = createCrossProjectRouter({
    allowLeadSourcedExecution: true,
    bindingStore: bindingStore,
    bindingFile: bindingFile,
    deliveryFile: path.join(dir, "delivery.json"),
    readLeadEvents: function () { return []; },
  });
  return {
    router: router,
    // Registration is deliberately deferred so a test can observe the binding
    // BEFORE and AFTER the real trigger. `registerProjectResolver` re-runs
    // `reconcileStrandedCompletions` precisely because the binding store is
    // initialized before projects finish restoring their sessions -- so this is
    // the live daemon's own startup path, not a synthetic poke.
    register: function () {
      router.registerProjectResolver({
        getProjectId: function () { return PROJECT; },
        getSessionManager: function () { return manager; },
      });
    },
    bindingStore: bindingStore,
    manager: manager,
    predecessor: predecessor,
    successor: successor,
    saved: saved,
    stored: function () { return bindingStore.get(TASK, 2); },
    // The real lookup, with nothing supplied for it.
    lookup: function () {
      return portfolioBindings.executionSessionForBinding(manager, bindingStore.get(TASK, 2));
    },
  };
}

test("the two sides of the source comparison are written by different writers", function () {
  // Pins the ASYMMETRY itself, so the reason the naive equality could never
  // succeed stays legible even if the lookup is later rewritten.
  var h = harness();
  var binding = h.stored();
  var metadata = h.successor.orchestrationPolicy.portfolioExecution;
  assert.equal(binding.source.sessionStorageId, CANONICAL);
  assert.equal(binding.projectCoordinator.sessionStorageId, LEAD_COORD);
  assert.equal(metadata.source.sessionStorageId, LEAD_COORD);
  assert.equal(portfolioBindings.sameSessionRef(metadata.source, binding.source), false,
    "the binding's own `source` is NOT what the session records -- comparing them " +
    "directly is the defect, and a fix that makes this true has changed the wrong side");
});

test("a transferred controlled session is found by the real lookup", function () {
  var h = harness();
  // Lineage and identity both resolve; before the fix this returned null.
  assert.equal(h.lookup(), h.successor);
});

test("the real reconciler terminalizes a transferred controlled binding end to end",
  function () {
    // The acceptance case: `reconcileStrandedCompletions` through the router's
    // own `sessionForBinding`, which resolves the project context and calls
    // `executionSessionForBinding` for real. Before the fix the binding stayed
    // `active` forever with no way to terminalize it in process.
    var h = harness();
    assert.equal(h.stored().status, "active", "precondition: nothing has reconciled yet");
    h.register();
    assert.equal(h.stored().status, "failed",
      "a transferred controlled binding must reach a terminal status");
    assert.equal(h.stored().completionEventId, "evt-project-completion-1",
      "and carry the delivery-event evidence from the SUCCESSOR's metadata, which is " +
      "the only session that still holds it after the transfer");
    assert.equal(h.stored().failureCode, "provider_wedged",
      "including why it ended, so a swept binding stays distinguishable");
  });

// ---------------------------------------------------------------------------
// The invariant is NARROWED to the ref both writers agree on, not deleted. Each
// case below must still be REJECTED; a lookup that finds the session by no
// longer checking anything would pass the three tests above and fail these.
// ---------------------------------------------------------------------------

test("REJECTS a successor whose metadata names a DIFFERENT control-plane coordinator",
  function () {
    // The case the check exists for. Everything else matches -- task, revision,
    // mode, idempotencyKey, lineage at distance 1 -- and only the dispatch
    // authority differs. Admitting it would let one control-plane root
    // terminalize another root's binding on the strength of a lineage edge.
    var h = harness({
      metadata: executionMetadata({
        source: { projectId: "system-lead", sessionStorageId: RIVAL_COORD },
      }),
    });
    assert.equal(h.lookup(), null);
    h.register();
    assert.equal(h.stored().status, "active",
      "a rival authority's session must not terminalize this binding");
  });

test("REJECTS a successor with no lineage back to the bound session", function () {
  // Identity alone is not enough: without a `compactedFromStorageId` chain to
  // the ref the binding actually committed, `distanceFrom` returns null and the
  // candidate is not a continuation of THIS execution.
  var h = harness({ lineage: false });
  assert.equal(h.lookup(), null);
  h.register();
  assert.equal(h.stored().status, "active");
});

test("REJECTS a transferred session for a non-control-plane binding whose source differs",
  function () {
    // A legacy project-local binding is not control-plane routed, so the ref
    // both writers agree on is still `binding.source`. The narrowing must not
    // silently start accepting a project-local binding's mismatched source.
    var h = harness({
      binding: bindingRecord({
        projectCoordinator: { projectId: PROJECT, sessionStorageId: "legacy-local-coordinator" },
      }),
      metadata: executionMetadata({
        source: { projectId: "system-lead", sessionStorageId: RIVAL_COORD },
      }),
    });
    assert.equal(h.lookup(), null);
    h.register();
    assert.equal(h.stored().status, "active");
  });

test("a non-control-plane binding is still matched on binding.source, unchanged",
  function () {
    // The pre-existing behaviour for legacy bindings: `projectCoordinator` is
    // project-local, so the comparison falls back to `binding.source` exactly as
    // before. This case passed before the fix and must keep passing.
    var h = harness({
      binding: bindingRecord({
        projectCoordinator: { projectId: PROJECT, sessionStorageId: "legacy-local-coordinator" },
      }),
      metadata: executionMetadata({
        source: { projectId: "system-lead", sessionStorageId: CANONICAL },
      }),
    });
    assert.equal(h.lookup(), h.successor);
  });

test("finding a transferred session does NOT terminalize a still-running execution",
  function () {
    // The boundary between what this fix repairs and what it does not, and the
    // exact shape of the live board-exclusions rev2 orphan at 15:56 on 2026-08-19:
    // the metadata had moved to the successor but the execution had run ZERO
    // turns, so it read `status: running`. (The terminal `failed` /
    // `provider_start_failed` values on that record were the owner's hand
    // reconcile at 18:41Z, not a runtime verdict -- see
    // 2026-08-19-first-live-dispatch-result.md, whose retraction settles this.)
    //
    // So the lookup succeeds here and the binding still must not move: this fix
    // repairs WHICH SESSION is found, never whether there is completion evidence
    // to find. A future change that terminalizes on lookup success alone would
    // invent a terminal outcome for work that never ran, and fails here.
    var h = harness({ metadata: executionMetadata({
      status: "running",
      terminalAt: undefined,
      projectCompletionDeliveryEventId: undefined,
      projectCompletionResultEventId: undefined,
    }) });
    assert.equal(h.lookup(), h.successor, "the session is found");
    h.register();
    assert.equal(h.stored().status, "active",
      "but a running execution has nothing to reconcile and must stay active");
  });

test("REJECTS a successor bound to a different revision of the same task", function () {
  // The identity predicates are untouched by the narrowing.
  var h = harness({ metadata: executionMetadata({ bindingRevision: 3 }) });
  assert.equal(h.lookup(), null);
});

test("REJECTS a successor whose idempotencyKey differs", function () {
  var h = harness({ metadata: executionMetadata({ idempotencyKey: TASK + "-r2-other" }) });
  assert.equal(h.lookup(), null);
});

test("an untransferred session is still matched exactly, at distance 0", function () {
  // The masked-by-the-compaction-refusal path: when nothing transferred, the
  // bound ref matches directly through `basicExecutionMatch` and the
  // transferred branch never decides anything.
  var h = harness({ predecessorKeepsMetadata: true, lineage: false });
  assert.equal(h.lookup(), h.predecessor);
});
