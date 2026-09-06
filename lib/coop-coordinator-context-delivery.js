var prepareControlTurn = require("./coop-control-role-prompt").prepareControlTurn;

function record(ctx, session, handle, context, state) {
  if (!context || context.role !== "project_coordinator") return;
  var manifest = context.instructionManifest;
  var receipt = { version: 1, at: Date.now(), state: state,
    projectRef: context.projectRef, vendor: session.vendor || null,
    model: session.model || null, contextReady: context.ok === true,
    reason: context.reason || null, missing: context.missing || [],
    instructions: manifest || null,
    assignmentCount: context.work && context.work.assignments ? context.work.assignments.length : null };
  session.coordinatorContextReceipt = receipt;
  // A persisted receipt is historical evidence only. Current authority requires
  // this exact live handle, current route, and current on-disk rule digest.
  session._coordinatorContextDelivery = state === "supplied" && context.ok === true ?
    { handle: handle, digest: manifest && manifest.digest, vendor: session.vendor,
      model: session.model, projectId: context.projectRef.projectId } : null;
  try {
    if (ctx.sm.saveSessionFile(session, { durable: true }) === false) receipt.persistenceFailed = true;
  } catch (error) { receipt.persistenceFailed = true; }
  if (typeof ctx.sm.broadcastSessionList === "function") ctx.sm.broadcastSessionList();
}

function pushControlInput(ctx, session, handle, text, images) {
  var turn = prepareControlTurn(ctx, session, text);
  var result;
  try { result = handle.pushMessage(turn.text, images); }
  catch (error) { record(ctx, session, handle, turn.context, "uncertain"); throw error; }
  record(ctx, session, handle, turn.context, result === false ? "rejected" : "supplied");
  return result;
}

function currentContext(session, context) {
  var delivery = session && session._coordinatorContextDelivery;
  return !!(delivery && context && context.ok && context.instructionManifest &&
    delivery.handle === session.queryInstance && delivery.vendor === session.vendor &&
    delivery.model === session.model && delivery.projectId === context.projectRef.projectId &&
    delivery.digest === context.instructionManifest.digest);
}

module.exports = { pushControlInput: pushControlInput, currentContext: currentContext };
