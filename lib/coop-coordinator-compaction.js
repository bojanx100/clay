var plane = require("./coop-control-plane");

function waitForStream(stream, timeoutMs) {
  return new Promise(function (resolve) {
    var timer = setTimeout(function () { resolve(false); }, timeoutMs || 5000);
    Promise.resolve(stream).catch(function () {}).then(function () {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function isResident(session, manager) {
  var policy = plane.projectCoordinatorPolicy(session);
  return !!(policy && manager && manager.sessions.get(session.localId) === session &&
    plane.projectCoordinatorFor(manager, policy.projectRef) === session);
}

// A resident coordinator's TaskRefs and execution bindings name its storage
// identity. Renew its provider conversation in place; never move that graph
// into a new Clay session or rewrite its admitted assignment identities.
function compactResident(ctx, session, prompt, images) {
  session._compactionInProgress = true;
  var oldHandle = session.queryInstance;
  var priorStream = session.streamPromise;
  var recovery = session.contextRecovery;
  function failed(message) {
    session._compactionInProgress = false;
    session.isProcessing = false;
    if (recovery && session.contextRecovery === recovery) {
      recovery.status = "blocked";
      recovery.reason = "renewal_failed";
      try { ctx.sm.saveSessionFile(session, { durable: true }); } catch (error) {}
    }
    ctx.sendToSession(session.localId, { type: "error", text: message });
    ctx.sm.broadcastSessionList();
  }
  if (ctx.validateRenewal && !ctx.validateRenewal(session)) {
    failed("The session is no longer authorized to renew its provider conversation.");
    return null;
  }
  try {
    if (oldHandle && typeof oldHandle.close === "function") oldHandle.close();
    else if (oldHandle && typeof oldHandle.abort === "function") oldHandle.abort();
    else if (oldHandle) { failed("The coordinator provider cannot be stopped for renewal."); return null; }
  } catch (error) { failed("The coordinator provider could not be stopped for renewal."); return null; }
  session._coordinatorRenewal = waitForStream(priorStream, ctx.renewalTimeoutMs).then(async function (stopped) {
    if (!stopped) { failed("The provider did not stop in time. No replacement was started."); return; }
    if (session._deleted || session.hidden || ctx.sm.sessions.get(session.localId) !== session ||
        session.queryInstance && session.queryInstance !== oldHandle) {
      session._compactionInProgress = false;
      return;
    }
    if (ctx.validateRenewal && !ctx.validateRenewal(session)) {
      failed("The session's execution changed while its provider was stopping.");
      return;
    }
    var previous = { cliSessionId: session.cliSessionId, handoffContext: session.handoffContext,
      handoffContextTurnsRemaining: session.handoffContextTurnsRemaining };
    session.queryInstance = null;
    session.messageQueue = null;
    session._coordinatorContextDelivery = null;
    session.cliSessionId = null;
    // Persist the continuation before launch so failed provider creation still
    // leaves the next turn with the same discussion and durable task graph.
    session.handoffContext = prompt;
    session.handoffContextTurnsRemaining = 1;
    try {
      if (ctx.sm.saveSessionFile(session, { durable: true }) === false) throw new Error("save failed");
    } catch (error) {
      Object.assign(session, previous);
      failed("Coordinator renewal could not be saved. Its assignments remain in the same session.");
      return;
    }
    session.isProcessing = true;
    if (ctx.onProcessingChanged) ctx.onProcessingChanged();
    ctx.sm.broadcastSessionList();
    try {
      var result = await ctx.sdk.startQuery(session, prompt, images,
        ctx.ensureProjectAccessForSession ? ctx.ensureProjectAccessForSession(session) : null);
      if (result && result.ok === false) failed("The coordinator provider could not restart. Its saved work is available for retry.");
      else if (recovery && session.contextRecovery === recovery) {
        recovery.status = "started";
        ctx.sm.saveSessionFile(session, { durable: true });
        require("./recovery-log").recordRecoveryEvent({ kind: "context_recovery",
          sessionId: session.localId, outcome: "started", sourceCliSessionId: previous.cliSessionId });
      }
    } catch (error) { failed("The coordinator provider could not restart. Its saved work is available for retry."); }
    finally { session._compactionInProgress = false; }
  });
  return session;
}

module.exports = { isResident: isResident, compactResident: compactResident };
