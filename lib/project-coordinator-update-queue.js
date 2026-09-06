var crypto = require("crypto");
var fence = require("./coop-control-fence");
var MAX_ATTEMPTS = 3;
var RETRY_MS = 60000;

function attachCoordinatorUpdateQueue(ctx) {
  var sm = ctx.sm;
  var active = new WeakMap();
  var now = ctx.now || Date.now;

  function current(session) {
    return session && !session._deleted && !session.hidden && !session.destroying &&
      sm.sessions.get(session.localId) === session;
  }

  function save(session) {
    try { return sm.saveSessionFile(session, { durable: true }) === true; }
    catch (error) { return false; }
  }

  function changed(session) {
    ctx.sendState(session);
    sm.broadcastSessionList();
  }

  function replace(session, entries, silent) {
    var before = session.pendingCoordinatorUpdates;
    session.pendingCoordinatorUpdates = entries;
    if (save(session)) { if (!silent) changed(session); return true; }
    session.pendingCoordinatorUpdates = before;
    return false;
  }

  function queue(session, text) {
    if (!current(session) || typeof text !== "string" || !text.trim()) return false;
    var entries = (session.pendingCoordinatorUpdates || []).concat({
      updateId: crypto.randomUUID(), text: text, queuedAt: now(), state: "pending", attempts: 0,
    });
    if (!replace(session, entries)) return false;
    flush(session);
    return true;
  }

  function available(session) {
    if (!current(session) || session.isProcessing || session._queryStarting || active.has(session)) return false;
    if (ctx.canDispatch && !ctx.canDispatch(session)) return false;
    if (!fence.isCurrent(session, "provider_start")) return false;
    if (session.restartResumeEligible || session.restartAutoContinueQueued) return false;
    if ((session.pendingUserMessageQueue || []).length || (session.pendingCoopIngress || []).length) return false;
    return true;
  }

  function settle(session, token, result) {
    if (active.get(session) !== token) return;
    active.delete(session);
    if (!current(session) || !fence.isIncarnationCurrent(session, token.fence)) return;
    var accepted = result === true || result && result.ok === true;
    var definiteFailure = result === false || result && result.ok === false && result.submission === "not_submitted";
    var entries = (session.pendingCoordinatorUpdates || []).map(function (entry) {
      if (entry.batchId !== token.batchId) return entry;
      return Object.assign({}, entry, { state: accepted ? "submitted" : definiteFailure ?
        (entry.attempts >= MAX_ATTEMPTS ? "attention" : "pending") : "uncertain",
      nextAttemptAt: now() + RETRY_MS, reason: accepted ? "" : String(result && result.reason || "submission_uncertain") });
    });
    // Keep a successful in-process receipt even if its disk acknowledgement
    // fails. The clock retries only the save. A crash in this window restores
    // 'submitting', which requires an explicit review before resubmission.
    session.pendingCoordinatorUpdates = entries;
    if (accepted) {
      session.history.forEach(function (item) {
        if (item.coordinatorUpdateBatchId === token.batchId) item.coordinatorUpdateSubmission = "submitted";
      });
      session._historyNeedsRewrite = true;
      replace(session, entries.filter(function (entry) { return entry.state !== "submitted"; }));
    }
    else save(session);
    if (result === false && token.handle && session.queryInstance === token.handle) {
      session.queryInstance = null;
      session.messageQueue = null;
      try { if (token.handle.close) token.handle.close(); } catch (ignored) {}
    }
    if (!accepted && session._watchdogTurnSeq === token.turnSeq) {
      session.isProcessing = false;
      ctx.onProcessingChanged();
      ctx.sendToSession(session.localId, { type: "status", status: "idle" });
    }
    changed(session);
  }

  function flush(session) {
    if (!current(session) || active.has(session)) return false;
    var pending = session.pendingCoordinatorUpdates || [];
    if (!pending.length) return false;
    if (pending.some(function (entry) { return entry.state === "submitted"; })) {
      if (!replace(session, pending.filter(function (entry) { return entry.state !== "submitted"; }))) return false;
      pending = session.pendingCoordinatorUpdates;
    }
    // A persisted in-flight record is uncertain after process loss. Never
    // infer consumption from a history marker, an error, or a done event.
    if (pending.some(function (entry) { return entry.state === "submitting"; })) {
      replace(session, pending.map(function (entry) {
        return entry.state === "submitting" ? Object.assign({}, entry, { state: "uncertain" }) : entry;
      }));
      return false;
    }
    if (!available(session) || pending.some(function (entry) {
      return entry.state === "uncertain" || entry.state === "attention" || Number(entry.nextAttemptAt || 0) > now();
    })) return false;
    var batchId = pending[0].batchId || crypto.randomUUID();
    var selected = pending.filter(function (entry) { return pending[0].batchId ? entry.batchId === batchId : !entry.batchId; });
    var entries = pending.map(function (entry) {
      return selected.indexOf(entry) === -1 ? entry : Object.assign({}, entry, {
        updateId: entry.updateId || crypto.randomUUID(), batchId: batchId, state: "submitting",
        attempts: Number(entry.attempts || 0) + 1,
      });
    });
    var text = selected.map(function (entry) { return entry.text; }).join("\n\n---\n\n");
    var history = session.history;
    var existing = history.some(function (item) { return item.coordinatorUpdateBatchId === batchId; });
    if (!existing) history.push({ type: "user_message", text: text, synthetic: true,
      origin: { kind: "task-notification" }, fromName: "Clay workers", internalOnly: true,
      coordinatorUpdateBatchId: batchId, coordinatorUpdateSubmission: "staged", _ts: now() });
    if (!replace(session, entries, true)) {
      if (!existing) { history.pop(); session._historyNeedsRewrite = true; }
      return false;
    }
    var token = { batchId: batchId, fence: fence.fenceFor(session), handle: session.queryInstance };
    active.set(session, token);
    session.isProcessing = true;
    session._queryStartTs = Date.now();
    session.sentToolResults = {};
    ctx.onProcessingChanged();
    changed(session);
    ctx.sendToSession(session.localId, { type: "status", status: "processing" });
    var result;
    try {
      if (!session.queryInstance && (!session.worker || session.messageQueue !== "worker")) {
        result = ctx.sdk.startQuery(session, text, null, ctx.ensureProjectAccessForSession(session));
      } else {
        result = ctx.sdk.pushMessage(session, text, null, { requireImmediate: true });
      }
      token.turnSeq = session._watchdogTurnSeq;
    } catch (error) {
      token.turnSeq = session._watchdogTurnSeq;
      result = { ok: false, submission: "uncertain", reason: error.message };
    }
    if (result && typeof result.then === "function") {
      result.then(function (receipt) { settle(session, token, receipt); }, function (error) {
        settle(session, token, { ok: false, submission: "uncertain", reason: error.message });
      });
    } else settle(session, token, result);
    sm.broadcastSessionList();
    return true;
  }

  function resolve(session, input) {
    if (!current(session) || session.isProcessing || session._queryStarting || active.has(session) ||
        !input || !Array.isArray(input.updateIds) || !input.updateIds.length ||
        (input.action !== "retry" && input.action !== "acknowledge")) return false;
    var pending = session.pendingCoordinatorUpdates || [];
    var selected = pending.filter(function (entry) { return input.updateIds.indexOf(entry.updateId) !== -1; });
    if (selected.length !== input.updateIds.length || selected.some(function (entry) {
      return entry.state !== "attention" && entry.state !== "uncertain";
    })) return false;
    var entries = pending.filter(function (entry) { return selected.indexOf(entry) === -1; });
    if (input.action === "retry") entries = selected.map(function (entry) {
      return Object.assign({}, entry, { state: "pending", attempts: 0, nextAttemptAt: 0 });
    }).concat(entries);
    if (!replace(session, entries)) return false;
    flush(session);
    return true;
  }

  return { queue: queue, flush: flush, resolve: resolve };
}

module.exports = { attachCoordinatorUpdateQueue: attachCoordinatorUpdateQueue };
