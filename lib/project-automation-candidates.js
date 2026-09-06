// project-automation-candidates.js - The durable handoff between a project's
// automation and Coop.
//
// Under the cutover a project controller does not launch; it proposes. But a
// proposal that is only written to the audit log is not a handoff — it is a
// log line. That gap is exactly how an eligible bug (trialview/v2#2517) could
// be re-evaluated every five minutes for hours while Coop never saw it: the
// candidate was computed, audited, and dropped on the floor because nothing
// was wired to receive it.
//
// So candidates live here instead: one durable record per (project, item),
// which Coop reads to admit exactly once through the canonical ProjectRef
// binding.
//
// IDEMPOTENCE IS THE POINT. A scheduled scan re-proposes the same eligible
// item on every tick, forever, until Coop admits it. That is correct — the
// controller is stateless and must not decide when to stop. What must NOT
// happen is a new record, a new notification, or a new activity line each
// time. So `upsert` creates once and thereafter merely refreshes `lastSeenAt`,
// reporting `created: false` so callers can stay quiet. A candidate only looks
// "new" again if its content genuinely changed (different class, admission,
// policy digest or intent), which is a real event worth surfacing.

var fs = require("fs");
var path = require("path");
var projectIdentity = require("./project-identity");
var bookkeepingRepair = require("./project-automation-bookkeeping-repair");
var candidateReconciliation = require("./project-automation-candidate-reconciliation");
var candidateCompletion = require("./project-automation-candidate-completion");
var recordHelpers = require("./project-automation-candidate-record");
var contentDigest = recordHelpers.contentDigest;
var normalize = recordHelpers.normalize;
var stickyStatus = recordHelpers.stickyStatus;
var canRevalidateLegacyAwaitingOwner = recordHelpers.canRevalidateLegacyAwaitingOwner;
var completionEligibility = candidateCompletion.completionEligibility;

var SCHEMA = "clay.automation_candidates";
var SCHEMA_VERSION = 1;
var MAX_CANDIDATES = 2048;

function defaultFile(cwd) {
  return path.join(cwd, ".clay", "tasks", "automation-candidates.json");
}

function clone(value) {
  return value === undefined || value === null ? null : JSON.parse(JSON.stringify(value));
}

function createCandidateStore(options) {
  var opts = options || {};
  var fsImpl = opts.fs || fs;
  var file = opts.file || defaultFile(opts.cwd || ".");
  var now = opts.now || Date.now;

  function read() {
    try {
      var parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
      if (!parsed || parsed.schema !== SCHEMA || !Array.isArray(parsed.candidates)) {
        return { ok: false, reason: "malformed_state", candidates: [] };
      }
      return { ok: true, candidates: parsed.candidates };
    } catch (e) {
      if (e && e.code === "ENOENT") return { ok: true, candidates: [] };
      return { ok: false, reason: "malformed_state", candidates: [] };
    }
  }

  // Persisted with the usual temp+rename so a torn write cannot be read. A
  // failure is REPORTED, never swallowed: a dropped candidate is the exact
  // defect this module exists to prevent, and the legacy launch-state stores
  // silently ignoring their own write errors is what let the storm run.
  function write(candidates) {
    var temp = file + ".tmp." + process.pid;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      fsImpl.writeFileSync(temp, JSON.stringify({
        schema: SCHEMA, version: SCHEMA_VERSION, candidates: candidates,
      }, null, 2) + "\n");
      fsImpl.renameSync(temp, file);
      return { ok: true };
    } catch (e) {
      try { fsImpl.unlinkSync(temp); } catch (unlinkError) {}
      return { ok: false, reason: "persistence_failed", error: e && e.message };
    }
  }

  function indexOf(candidates, projectId, key) {
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].candidateKey === key &&
          candidates[i].projectRef && candidates[i].projectRef.projectId === projectId) return i;
    }
    return -1;
  }

  // upsert -> { ok, created, changed, candidate }
  //   created: this is the first time we have proposed this item
  //   changed: we had proposed it before, but the proposal itself differs
  // Both are "news". Neither set means a quiet refresh — the caller should not
  // log, notify, or otherwise treat it as an event.
  function upsert(candidate, options) {
    var timestamp = now();
    var normalized = normalize(candidate, timestamp);
    if (!normalized.ok) return { ok: false, reason: normalized.reason };
    var record = normalized.record;
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason };
    var candidates = state.candidates;
    var index = indexOf(candidates, record.projectRef.projectId, record.candidateKey);
    if (index === -1) {
      if (candidates.length >= MAX_CANDIDATES) return { ok: false, reason: "candidate_store_full" };
      candidates.push(record);
      var created = write(candidates);
      if (!created.ok) return created;
      return { ok: true, created: true, changed: true, candidate: clone(record) };
    }
    var existing = candidates[index];
    var revalidatedLegacyAwaitingOwner = canRevalidateLegacyAwaitingOwner(existing, record);
    var reconciledChanged = false;
    if (options && Object.prototype.hasOwnProperty.call(options, "bindingSnapshot")) {
      var reconciled = candidateReconciliation.reconcile(existing, options.bindingSnapshot);
      if (!reconciled.ok) return { ok: false, reason: reconciled.reason };
      existing = reconciled.candidate;
      reconciledChanged = reconciled.changed === true;
    }
    // A historical admitted/owner-gated record was created before receipts
    // existed. Do not attach new evidence to it: that would falsely imply the
    // old execution was qualified, and could also alter its acceptance path.
    // The one exception is an awaiting-owner record with no binding or owner
    // decision. Another exception is an exact retryable binding reconciliation:
    // the old attempt did not create durable completed work, so a fresh receipt
    // describes the retry attempt rather than rewriting the old one.
    if (!existing.qualificationReceipt && record.qualificationReceipt &&
        (existing.status === "admitted" || existing.status === "awaiting_owner" ||
        existing.status === "owner_approved" || existing.status === "owner_declined") &&
        !revalidatedLegacyAwaitingOwner) {
      return { ok: true, created: false, changed: false, candidate: clone(existing), legacyNoReceipt: true };
    }
    var changed = revalidatedLegacyAwaitingOwner || reconciledChanged || existing.digest !== record.digest;
    var merged = Object.assign({}, existing, {
      lastSeenAt: timestamp,
      seenCount: (existing.seenCount || 0) + 1,
      // Every proposal replaces the prior pass evidence, including with null.
      // A caller that cannot attest the current scan must invalidate rather
      // than inherit an older scan's authority.
      eligibilityPass: record.eligibilityPass,
      qualificationReceipt: record.qualificationReceipt,
    });
    if (changed) {
      merged = Object.assign(candidateReconciliation.preserveRuntimeFields(record, existing), {
        firstSeenAt: existing.firstSeenAt || timestamp,
        seenCount: (existing.seenCount || 0) + 1,
        // A changed proposal for work Coop already admitted stays admitted;
        // re-opening it here would be a second admission. An owner DECISION is
        // also sticky — approved and declined both survive a re-proposal.
        //
        // But "awaiting_owner" must NOT be sticky when the reason for waiting is
        // gone: if the project's policy now auto-admits this class, holding the
        // record in awaiting_owner made it invisible to pending() forever, so
        // the item could never be admitted and no owner was ever asked again.
        status: stickyStatus(existing, record),
      });
      if (revalidatedLegacyAwaitingOwner) {
        // These fields describe the prior owner-gated proposal. Keeping them
        // would incorrectly project a decision still waiting on the owner
        // after the fresh automatic candidate has been admitted.
        merged.status = "pending";
        delete merged.attention;
        delete merged.approvalStage;
      }
    }
    candidates[index] = merged;
    var written = write(candidates);
    if (!written.ok) return written;
    return { ok: true, created: false, changed: changed, candidate: clone(merged) };
  }

  // Coop marks a candidate admitted once it holds the canonical binding, so
  // later ticks refresh it quietly instead of re-proposing it as new work.
  function markAdmitted(projectRef, candidateKey, binding) {
    var ref = projectIdentity.normalizeProjectRef(projectRef);
    if (!ref || !candidateKey) return { ok: false, reason: "invalid_candidate" };
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason };
    var index = indexOf(state.candidates, ref.projectId, candidateKey);
    if (index === -1) return { ok: false, reason: "not_found" };
    state.candidates[index] = Object.assign({}, state.candidates[index], {
      status: "admitted",
      admittedAt: now(),
      binding: binding ? clone(binding) : null,
    });
    var written = write(state.candidates);
    return written.ok ? { ok: true, candidate: clone(state.candidates[index]) } : written;
  }

  // pending() -> { ok, candidates } | { ok:false, reason }
  // The fail-closed reader. `list` returns a bare array for convenience, but a
  // corrupt or unreadable store would then be indistinguishable from an empty
  // queue — and interpreting corruption as "nothing to admit" is exactly how
  // work goes missing silently. Admission uses this instead.
  function pending(filter) {
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason, candidates: [] };
    // Filter the state WE read. Delegating to list() would read a second time,
    // and if that read came back malformed, list() returns [] — turning a
    // corrupt store into a confident "nothing to admit" behind an ok:true.
    // The whole point of this function is that corruption cannot hide.
    var wanted = filter && filter.status ? [filter.status] :
      (filter && Array.isArray(filter.statuses) ? filter.statuses : null);
    var result = [];
    for (var i = 0; i < state.candidates.length; i++) {
      if (wanted && wanted.indexOf(state.candidates[i].status) === -1) continue;
      result.push(clone(state.candidates[i]));
    }
    return { ok: true, candidates: result };
  }

  // Durable attention. A console line disappears; an audit entry is history.
  // An item that cannot be admitted has to stay visibly stuck ON THE RECORD, so
  // the queue itself can be asked "what needs a human?".
  function recordAttention(projectRef, candidateKey, reason, needsOwner, approvalStage) {
    var ref = projectIdentity.normalizeProjectRef(projectRef);
    if (!ref || !candidateKey) return { ok: false, reason: "invalid_candidate" };
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason };
    var index = indexOf(state.candidates, ref.projectId, candidateKey);
    if (index === -1) return { ok: false, reason: "not_found" };
    var existing = state.candidates[index];
    var previous = existing.attention || null;
    var staged = needsOwner ? candidateReconciliation.normalizeApprovalStage(approvalStage, ref) :
      existing.approvalStage;
    if (needsOwner && !staged) return { ok: false, reason: "invalid_approval_stage" };
    state.candidates[index] = Object.assign({}, existing, {
      status: needsOwner ? "awaiting_owner" : existing.status,
      approvalStage: staged,
      attention: {
        reason: String(reason || "unknown"),
        needsOwner: needsOwner === true,
        firstAt: previous && previous.reason === reason ? previous.firstAt : now(),
        lastAt: now(),
        count: previous && previous.reason === reason ? (previous.count || 0) + 1 : 1,
      },
    });
    var written = write(state.candidates);
    return written.ok ? { ok: true, candidate: clone(state.candidates[index]) } : written;
  }

  function clearAttention(projectRef, candidateKey) {
    var ref = projectIdentity.normalizeProjectRef(projectRef);
    if (!ref || !candidateKey) return { ok: false, reason: "invalid_candidate" };
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason };
    var index = indexOf(state.candidates, ref.projectId, candidateKey);
    if (index === -1) return { ok: false, reason: "not_found" };
    if (!state.candidates[index].attention) return { ok: true };
    var updated = Object.assign({}, state.candidates[index]);
    delete updated.attention;
    state.candidates[index] = updated;
    var written = write(state.candidates);
    return written.ok ? { ok: true } : written;
  }

  // adoptRunningLegacy -> { ok, created, changed, candidate }
  //
  // Records that a legacy auto-launched session is ALREADY running this item, so
  // the cutover neither kills it nor re-proposes it. The record is marked
  // `legacy_running` — deliberately not `pending`, so admission never binds it,
  // and not `admitted`, because Coop holds no binding for it. It is in-flight
  // work that predates the cutover, draining on its own.
  function adoptRunningLegacy(projectRef, itemKey, evidence) {
    var ref = projectIdentity.normalizeProjectRef(projectRef);
    var key = String(itemKey || "").trim();
    if (!ref || !key) return { ok: false, reason: "invalid_candidate" };
    var candidateKey = key.indexOf("launch:") === 0 ? key : "launch:" + key;
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason };
    var timestamp = now();
    var index = indexOf(state.candidates, ref.projectId, candidateKey);
    var legacy = {
      candidateKey: candidateKey,
      itemKey: key,
      itemClass: null,
      admission: "legacy",
      projectRef: { projectId: ref.projectId },
      policyDigest: null,
      recipeId: evidence && evidence.recipeId || null,
      intent: evidence ? clone(evidence) : null,
      status: "legacy_running",
      legacyAdoption: Object.assign({ adoptedAt: timestamp }, evidence || {}),
      firstSeenAt: index === -1 ? timestamp : (state.candidates[index].firstSeenAt || timestamp),
      lastSeenAt: timestamp,
      seenCount: index === -1 ? 1 : (state.candidates[index].seenCount || 0) + 1,
    };
    legacy.digest = contentDigest(legacy);
    if (index === -1) {
      if (state.candidates.length >= MAX_CANDIDATES) {
        return { ok: false, reason: "candidate_store_full" };
      }
      state.candidates.push(legacy);
      var created = write(state.candidates);
      return created.ok ? { ok: true, created: true, changed: true, candidate: clone(legacy) } : created;
    }
    var existing = state.candidates[index];
    // Already admitted through Coop: that binding wins, do not rewrite it.
    if (existing.status === "admitted") {
      return { ok: true, created: false, changed: false, candidate: clone(existing) };
    }
    var changed = existing.status !== "legacy_running";
    state.candidates[index] = legacy;
    var written = write(state.candidates);
    return written.ok ? { ok: true, created: false, changed: changed, candidate: clone(legacy) } : written;
  }

  // decideOwner -> { ok, candidate } | { ok:false, reason }
  //
  // The typed owner decision, and the exit from awaiting_owner. A YES makes the
  // candidate admissible exactly once after a fresh eligible scan (status
  // owner_approved; attention and old scan evidence are cleared). Its original
  // owner-gated policy remains intact. A NO is terminal: attention is cleared
  // and the item is never re-prompted.
  function decideOwner(projectRef, candidateKey, decision) {
    var ref = projectIdentity.normalizeProjectRef(projectRef);
    if (!ref || !candidateKey) return { ok: false, reason: "invalid_candidate" };
    var by = decision && typeof decision.by === "string" ? decision.by.trim() : "";
    if (!by) return { ok: false, reason: "owner_identity_required" };
    if (typeof decision.approved !== "boolean") {
      return { ok: false, reason: "owner_decision_required" };
    }
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason };
    var index = indexOf(state.candidates, ref.projectId, candidateKey);
    if (index === -1) return { ok: false, reason: "not_found" };
    var existing = state.candidates[index];
    var stage = candidateReconciliation.normalizeApprovalStage(existing.approvalStage, ref) || {};
    if (existing.status !== "awaiting_owner" ||
        !stage.portfolioTaskId || !Number.isInteger(stage.bindingRevision)) {
      return { ok: false, reason: "owner_approval_not_staged" };
    }
    if (stage.portfolioTaskId !== decision.portfolioTaskId ||
        stage.bindingRevision !== decision.bindingRevision) {
      return { ok: false, reason: "owner_approval_scope_mismatch" };
    }
    var updated = Object.assign({}, existing, {
      status: decision.approved ? "owner_approved" : "owner_declined",
      ownerDecision: {
        approved: decision.approved,
        by: by,
        at: now(),
        portfolioTaskId: stage.portfolioTaskId,
        bindingRevision: stage.bindingRevision,
      },
      // Approval is not eligibility. Force a later scan to re-see this item
      // through the current recipe, ownership, status and collision gates.
      eligibilityPass: null,
    });
    // The decision resolves the attention either way: an approved item is no
    // longer waiting, and a declined one must never prompt again.
    delete updated.attention;
    state.candidates[index] = updated;
    var written = write(state.candidates);
    return written.ok ? { ok: true, candidate: clone(updated) } : written;
  }

  // Explicit owner-requested bounce repair. This is deliberately separate from
  // upsert(): ordinary scans preserve completed/admitted history, while this
  // operation only clears stale launch authority after the caller supplies the
  // owner request, no-live-work evidence, and exact completed-history proof.
  function requestReconsideration(projectRef, candidateKey, evidence, options) {
    var ref = projectIdentity.normalizeProjectRef(projectRef);
    var key = String(candidateKey || "").trim();
    if (!ref || !key) return { ok: false, reason: "invalid_candidate" };
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason };
    var index = indexOf(state.candidates, ref.projectId, key);
    if (index === -1) return { ok: false, reason: "not_found" };
    var existing = state.candidates[index];
    var primitiveRepair = require("./project-automation-primitive-reconsideration");
    var prepare = evidence && evidence.schema === primitiveRepair.REQUEST_SCHEMA ?
      primitiveRepair.prepare : bookkeepingRepair.prepareCandidateReconsideration;
    var prepared = prepare(existing, evidence, options || {}, now());
    if (!prepared.ok) return { ok: false, reason: prepared.reason };
    if (prepared.changed !== true) return prepared;
    state.candidates[index] = prepared.candidate;
    var written = write(state.candidates);
    return written.ok ? prepared : written;
  }

  // Everything a human or Coop must look at: stuck admissions and work the
  // project's own policy says an owner must decide.
  function attentionItems() {
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason, items: [] };
    var items = [];
    for (var i = 0; i < state.candidates.length; i++) {
      var c = state.candidates[i];
      if (c.attention || c.status === "awaiting_owner") items.push(clone(c));
    }
    return { ok: true, items: items };
  }

  function list(filter) {
    var state = read();
    if (!state.ok) return [];
    var wanted = filter && filter.status;
    var result = [];
    for (var i = 0; i < state.candidates.length; i++) {
      if (wanted && state.candidates[i].status !== wanted) continue;
      result.push(clone(state.candidates[i]));
    }
    return result;
  }

  function get(projectRef, candidateKey) {
    var ref = projectIdentity.normalizeProjectRef(projectRef);
    if (!ref) return null;
    var state = read();
    if (!state.ok) return null;
    var index = indexOf(state.candidates, ref.projectId, candidateKey);
    return index === -1 ? null : clone(state.candidates[index]);
  }

  return {
    adoptRunningLegacy: adoptRunningLegacy,
    attentionItems: attentionItems,
    clearAttention: clearAttention,
    decideOwner: decideOwner,
    file: file,
    get: get,
    list: list,
    markAdmitted: markAdmitted,
    pending: pending,
    recordAttention: recordAttention,
    requestReconsideration: requestReconsideration,
    upsert: upsert,
  };
}

module.exports = {
  MAX_CANDIDATES: MAX_CANDIDATES,
  SCHEMA: SCHEMA,
  completionEligibility: completionEligibility,
  contentDigest: contentDigest,
  createCandidateStore: createCandidateStore,
  defaultFile: defaultFile,
};
