// The one owner-authorized repair for the stale Governance Lifecycle R6
// control execution. This module has no target parameter by design.

var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var provenance = require("./coop-control-provenance");
var ownerRequestsModule = require("./coop-owner-requests");
var bindingModule = require("./portfolio-execution-bindings");
var runtime = require("./coop-control-runtime");

var TARGET = Object.freeze({
  authorityId: "auth:48bf4f02412fe2304d33df318158879523a9761f495fb206",
  executionId: "exec:be91239338f9ed24b8354eb39a4019918312fb6c780c9f0c",
  expectedEpoch: 24,
  expectedIncarnationId: "inc:d995172c-9709-4f15-82b6-2b064ef40cfc",
  idempotencyKey: "governance-lifecycle-r6-approved-20260828",
  mode: "project_coordinator",
  portfolioTaskId: "clay-coherent-role-routing-and-project-coordinator-control-20260828",
  revisionOneCompletedAt: 1788100198858,
  revisionOneCompletionEventId: "project-terminal-v1-project-coordinator-b77b6957-59be-4b86-bfb4-852fb2abcd11",
  revisionOneResultEventId: "project-coordinator-b77b6957-59be-4b86-bfb4-852fb2abcd11",
  revisionOneSessionId: "80c37b78-fc12-4e7b-9bfc-2c629561a4d5",
  revisionTwoCompletedAt: 1788138990523,
  revisionTwoSessionId: "5dfa79dd-0f2c-4dd3-a0b5-dcaaa0762b4e",
  role: "coordinator",
  sourceProjectId: projectIdentity.LEAD_PROJECT_ID,
  sourceSessionId: "457f9fa1-7024-40cc-acee-2cef6b2b8445",
  targetProjectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
});

var REQUEST = Object.freeze({
  idempotencyKey: "stale-r6-control-execution-reconciliation-20260831-r1",
  ownerDecisionId: "owner-decision-70ddde95d680834bdcb76d6d",
  ownerIngressId: "coop:ba715db2-6fc8-4bae-a410-497bc6f27adb:19",
  planDigest: "d68e0a9e28d1d15b39011b2b41494303d1f8c93ba8f79f1ae1ff5b860e6f2f91",
  planRevision: 1,
  authorityId: TARGET.authorityId,
  executionId: TARGET.executionId,
  expectedEpoch: TARGET.expectedEpoch,
  expectedIncarnationId: TARGET.expectedIncarnationId,
});

var RECEIPT_ID = "receipt:stale-r6-control-execution-reconciliation-20260831-r1";

function digest(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function requestDigest() {
  return digest(JSON.stringify(REQUEST));
}

function result(value, isError) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: !!isError };
}

function sameObject(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sessionById(sm, value) {
  if (!sm || !sm.sessions) return null;
  var wanted = String(value || "");
  var found = null;
  if (typeof sm.sessions.forEach === "function") {
    sm.sessions.forEach(function (session) {
      var id = session && (session.storageId || session.cliSessionId);
      if (!found && id === wanted) found = session;
    });
  }
  return found;
}

function canonicalCoopSession(deps, input) {
  var session = sessionById(deps.sm, input && input.sessionId);
  var projectId = deps.sm && typeof deps.sm.getProjectId === "function" ? deps.sm.getProjectId() : null;
  return session && projectId === projectIdentity.LEAD_PROJECT_ID &&
    provenance.isCanonicalCoopSession(session) ? session : null;
}

function exactRequest(input) {
  var source = input && input.reconciliationRequest;
  if (!source || typeof source !== "object" || Array.isArray(source) ||
      Object.getPrototypeOf(source) !== Object.prototype) return false;
  var keys = Object.keys(source).sort();
  var expectedKeys = Object.keys(REQUEST).sort();
  if (!sameObject(keys, expectedKeys)) return false;
  return sameObject(source, REQUEST);
}

function records(deps) {
  if (Array.isArray(deps.bindings)) return deps.bindings.slice();
  if (deps.bindings && typeof deps.bindings.list === "function") return deps.bindings.list();
  var read = bindingModule.readPortfolioExecutionBindings();
  return read.ok ? read.bindings : [];
}

function bindingFor(all, revision) {
  var found = null;
  for (var i = 0; i < all.length; i++) {
    if (!all[i] || all[i].portfolioTaskId !== TARGET.portfolioTaskId ||
        Number(all[i].bindingRevision) !== revision) continue;
    if (found) return null;
    found = all[i];
  }
  return found;
}

function exactRef(ref, projectId, sessionStorageId) {
  return !!ref && ref.projectId === projectId && ref.sessionStorageId === sessionStorageId;
}

function exactTerminalEvidence(all) {
  var one = bindingFor(all, 1);
  var two = bindingFor(all, 2);
  var oneValid = !!one && one.status === "failed" && one.mode === TARGET.mode &&
    one.idempotencyKey === TARGET.idempotencyKey &&
    exactRef(one.coordinator, TARGET.targetProjectId, TARGET.revisionOneSessionId) &&
    Number(one.completedAt) === TARGET.revisionOneCompletedAt &&
    one.completionEventId === TARGET.revisionOneCompletionEventId &&
    one.resultEventId === TARGET.revisionOneResultEventId;
  var twoValid = !!two && two.status === "completed" && two.mode === TARGET.mode &&
    exactRef(two.coordinator, TARGET.targetProjectId, TARGET.revisionTwoSessionId) &&
    Number(two.completedAt) === TARGET.revisionTwoCompletedAt;
  return { one: oneValid, two: twoValid };
}

function ownerApproval(deps) {
  var ledger = deps.ownerRequests || ownerRequestsModule.getDefaultOwnerRequests();
  var record = ledger && typeof ledger.get === "function" ? ledger.get(REQUEST.ownerIngressId) : null;
  return !!record && record.ingressId === REQUEST.ownerIngressId && record.response &&
    record.response.state === "answered";
}

function currentIdentity(control) {
  var durable = control.inspect(TARGET.executionId);
  var current = durable && durable.current;
  var execution = durable && durable.execution;
  var authority = durable && durable.authority;
  var leases = durable && durable.leases;
  var lease = Array.isArray(leases) && leases.length === 1 ? leases[0] : null;
  return !!execution && !!authority && !!current && !!lease &&
    execution.executionId === TARGET.executionId &&
    execution.portfolioTaskId === TARGET.portfolioTaskId &&
    execution.bindingRevision === 1 && execution.idempotencyKey === TARGET.idempotencyKey &&
    execution.targetProject && execution.targetProject.projectId === TARGET.targetProjectId &&
    execution.mode === TARGET.mode && execution.authorityId === TARGET.authorityId &&
    execution.currentEpoch === TARGET.expectedEpoch && execution.status === "running" &&
    authority.authorityId === TARGET.authorityId && authority.source &&
    authority.source.projectId === TARGET.sourceProjectId &&
    authority.source.sessionStorageId === TARGET.sourceSessionId &&
    authority.portfolioTaskId === TARGET.portfolioTaskId && authority.bindingRevision === 1 &&
    authority.targetProject && authority.targetProject.projectId === TARGET.targetProjectId &&
    authority.role === TARGET.role && authority.actionMask === 31 && authority.revokedAt === null &&
    current.incarnationId === TARGET.expectedIncarnationId && current.epoch === TARGET.expectedEpoch &&
    current.sessionRef && current.sessionRef.projectId === TARGET.targetProjectId &&
    current.sessionRef.sessionStorageId === TARGET.revisionOneSessionId && current.startState === "started" &&
    lease.executionId === TARGET.executionId && lease.role === TARGET.role &&
    lease.incarnationId === TARGET.expectedIncarnationId && lease.epoch === TARGET.expectedEpoch &&
    lease.authorityId === TARGET.authorityId;
}

function noPendingRecovery(control) {
  var store = control.getStore && control.getStore();
  if (!store || typeof store.listHandoffs !== "function" || typeof store.listOutbox !== "function" ||
      typeof store.listEffectsWithInbox !== "function") return false;
  var handoffs = store.listHandoffs().filter(function (row) {
    return row.execution_id === TARGET.executionId &&
      (row.state === "prepared" || row.state === "cutover" || row.state === "replaying");
  });
  var outbox = store.listOutbox(true).filter(function (row) {
    return row.reference_id === TARGET.executionId;
  });
  var effects = store.listEffectsWithInbox(true).filter(function (row) {
    return row.reference_id === TARGET.executionId;
  });
  return handoffs.length === 0 && outbox.length === 0 && effects.length === 0;
}

function reconcile(deps, input) {
  if (!canonicalCoopSession(deps, input)) return result({ ok: false, code: "not_authorized" }, true);
  if (!exactRequest(input)) return result({ ok: false, code: "reconciliation_request_conflict" }, true);
  if (!ownerApproval(deps)) return result({ ok: false, code: "owner_approval_mismatch" }, true);
  var evidence = exactTerminalEvidence(records(deps));
  if (!evidence.one) return result({ ok: false, code: "revision_one_terminal_evidence_mismatch" }, true);
  if (!evidence.two) return result({ ok: false, code: "revision_two_terminal_evidence_mismatch" }, true);
  var control = deps.executionControl || runtime.getExecutionControl();
  if (!control || control.enabled !== true ||
      typeof control.reconcileStaleR6ControlExecution !== "function") {
    return result({ ok: false, code: "execution_control_unavailable" }, true);
  }
  var existing = typeof control.getStaleR6ReconciliationReceipt === "function" ?
    control.getStaleR6ReconciliationReceipt(RECEIPT_ID) : null;
  if (!existing && !currentIdentity(control)) {
    return result({ ok: false, code: "current_execution_identity_mismatch" }, true);
  }
  if (!existing && !noPendingRecovery(control)) {
    return result({ ok: false, code: "pending_recovery_reference" }, true);
  }
  try {
    var applied = control.reconcileStaleR6ControlExecution({
      authorityId: TARGET.authorityId,
      epoch: TARGET.expectedEpoch,
      executionId: TARGET.executionId,
      incarnationId: TARGET.expectedIncarnationId,
      receiptId: RECEIPT_ID,
      requestDigest: requestDigest(),
      role: TARGET.role,
    });
    return result({ ok: true, duplicate: applied.duplicate === true, receipt: applied.receipt });
  } catch (error) {
    return result({ ok: false, code: error && error.code || "reconciliation_failed" }, true);
  }
}

function getToolDefs(deps) {
  var z;
  try { z = require("zod"); } catch (error) { z = null; }
  var requestSchema = z ? z.object({
    idempotencyKey: z.string(), ownerDecisionId: z.string(), ownerIngressId: z.string(),
    planDigest: z.string(), planRevision: z.number().int(), authorityId: z.string(),
    executionId: z.string(), expectedEpoch: z.number().int(), expectedIncarnationId: z.string(),
  }).strict() : {};
  return [{
    name: "reconcile_stale_r6_control_execution",
    description: "Canonical-Coop-only, one-time reconciliation of the exact stale R6 revision-1 control execution. It cannot abandon any other execution.",
    inputSchema: {
      sessionId: z ? z.union([z.string(), z.number()]) : {},
      reconciliationRequest: requestSchema,
    },
    handler: function (input) { return Promise.resolve(reconcile(deps, input || {})); },
  }];
}

module.exports = {
  RECEIPT_ID: RECEIPT_ID,
  REQUEST: REQUEST,
  TARGET: TARGET,
  exactTerminalEvidence: exactTerminalEvidence,
  getToolDefs: getToolDefs,
  reconcile: reconcile,
  requestDigest: requestDigest,
};
