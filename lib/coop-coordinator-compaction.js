var plane = require("./coop-control-plane");

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
  function failed(message) {
    session._compactionInProgress = false;
    session.isProcessing = false;
    ctx.sendToSession(session.localId, { type: "error", text: message });
    ctx.sm.broadcastSessionList();
  }
  try {
    if (oldHandle && typeof oldHandle.close === "function") oldHandle.close();
    else if (oldHandle && typeof oldHandle.abort === "function") oldHandle.abort();
    else if (oldHandle) { failed("The coordinator provider cannot be stopped for renewal."); return null; }
  } catch (error) { failed("The coordinator provider could not be stopped for renewal."); return null; }
  session._coordinatorRenewal = Promise.resolve(priorStream).catch(function () {}).then(async function () {
    if (session._deleted || session.hidden || ctx.sm.sessions.get(session.localId) !== session ||
        session.queryInstance && session.queryInstance !== oldHandle) {
      session._compactionInProgress = false;
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
    } catch (error) { failed("The coordinator provider could not restart. Its saved work is available for retry."); }
    finally { session._compactionInProgress = false; }
  });
  return session;
}

module.exports = { isResident: isResident, compactResident: compactResident };
