// Narrow, auditable repair for a historical session-ledger projection that
// treated technical completion as owner acceptance. It never edits execution
// evidence and can touch only one exact ProjectRef/SessionRef/binding revision.

function attachOwnerAcceptanceRepair(ctx) {
  function requireOwnerAcceptance(ref, bindingRef, evidence) {
    if (ctx.getUnreadable()) return { ok: false, reason: "persistence_unreadable" };
    var normalized = ctx.projectIdentity.normalizeSessionRef(ref);
    var taskId = ctx.cleanText(bindingRef && bindingRef.portfolioTaskId, 256);
    var revision = Number(bindingRef && bindingRef.bindingRevision);
    var correctionEventId = ctx.cleanText(evidence && evidence.correctionEventId, 256);
    if (!normalized || !taskId || !Number.isInteger(revision) || revision < 1 ||
        !correctionEventId) return { ok: false, reason: "invalid_owner_acceptance_repair" };
    var state = ctx.getState();
    var wanted = ctx.keyFor(normalized.projectId, normalized.sessionStorageId);
    var index = -1;
    for (var i = 0; i < state.entries.length; i++) {
      if (ctx.keyFor(state.entries[i].projectRef.projectId,
          state.entries[i].sessionStorageId) === wanted) index = i;
    }
    if (index === -1) return { ok: false, reason: "session_ledger_entry_not_found" };
    var entry = state.entries[index];
    var binding = entry.portfolioBinding;
    if (!binding || binding.portfolioTaskId !== taskId ||
        Number(binding.bindingRevision) !== revision || binding.status !== "completed") {
      return { ok: false, reason: "owner_acceptance_repair_mismatch" };
    }
    if (entry.ownerAcceptanceRepair &&
        entry.ownerAcceptanceRepair.correctionEventId === correctionEventId) {
      return { ok: true, duplicate: true, entry: ctx.clone(entry) };
    }
    var repairedAt = ctx.finite(evidence && evidence.repairedAt) || ctx.now();
    var previous = ctx.clone(entry);
    entry.ownerAcceptanceRepair = {
      schema: "clay.owner_acceptance_repair",
      version: 1,
      repairedAt: repairedAt,
      correctionEventId: correctionEventId,
      previousProjection: {
        lifecycleState: entry.lifecycleState,
        workState: entry.workState,
        closedAt: entry.closedAt,
        terminalOutcome: ctx.clone(entry.terminalOutcome),
        lastCoopAction: ctx.clone(entry.lastCoopAction),
      },
      reason: "owner_acceptance_missing",
    };
    entry.lifecycleState = "needs_input";
    entry.workState = "needs_input";
    entry.closedAt = null;
    entry.terminalOutcome = null;
    entry.lastCoopAction = {
      type: "owner_acceptance_pending",
      at: repairedAt,
      report: "Implementation verified; awaiting explicit owner acceptance.",
    };
    entry.updatedAt = Math.max(ctx.finite(entry.updatedAt), repairedAt);
    entry.portfolioBinding.ownerAcceptanceRequired = true;
    entry.portfolioBinding.ownerAcceptance = {
      status: "pending", source: "owner_acceptance_repair",
    };
    var summaries = Array.isArray(entry.portfolioBindings) ? entry.portfolioBindings : [];
    for (var si = 0; si < summaries.length; si++) {
      if (summaries[si].portfolioTaskId === taskId &&
          Number(summaries[si].bindingRevision) === revision) {
        summaries[si].ownerAcceptanceRequired = true;
        summaries[si].ownerAcceptance = {
          status: "pending", source: "owner_acceptance_repair",
        };
      }
    }
    try { ctx.writeState(state); }
    catch (error) {
      state.entries[index] = previous;
      return { ok: false, reason: "persistence_failed", code: error && error.code };
    }
    return { ok: true, entry: ctx.clone(entry) };
  }

  return { requireOwnerAcceptance: requireOwnerAcceptance };
}

module.exports = { attachOwnerAcceptanceRepair: attachOwnerAcceptanceRepair };
