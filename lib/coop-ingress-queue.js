var coopForegroundIngress = require("./project-user-message-coop");
var coopIngressInterruption = require("./coop-ingress-interruption");

function ingressItem(args) {
  return {
    ingressId: args.ingressId,
    ingressSequence: args.ingressSequence,
    actorUserId: args.actorUserId || null,
    finalText: args.finalText,
    images: args.images || null,
    displayText: args.displayText || "",
    imageCount: args.imageCount || 0,
    clientMessageId: args.clientMessageId || null,
    pastes: args.pastes || null,
    intent: args.intent || "chat",
    coopThreadRef: args.coopThreadRef || null,
    coopTopicRef: args.coopTopicRef || null,
    coopProjectRef: args.coopProjectRef || null,
  };
}

function ingressFromHistory(session, item, deps) {
  if (!item || !item.coopIngressId || !item.coopIngressPending) return null;
  var reservation = {
    coop: true,
    ingressId: item.coopIngressId,
    sequence: item.coopIngressSequence || 0,
    kind: item.coopIngressKind || "text",
  };
  var finalText = item.coopIngressPreparedText || item.text || "";
  // Rebuilt from the durable record, reply anchor included, so a restart
  // reproduces exactly the threading the live path would have produced.
  if (!item.coopIngressPreparedText) {
    finalText = coopForegroundIngress.withTopicContext(
      finalText, item.coopTopicRef, item.coopProjectRef, item.coopTopicAnchor);
  }
  if (!item.coopIngressPreparedText && item.coopProjectRef) {
    finalText = [
      "<coop_project_context>",
      JSON.stringify({ projectRef: item.coopProjectRef }),
      "</coop_project_context>",
      "",
      finalText,
    ].join("\n");
  }
  if (!item.coopIngressPreparedText && deps.coopControl) {
    finalText = deps.coopControl.foregroundText(reservation, finalText);
  }
  return ingressItem({
    ingressId: reservation.ingressId,
    ingressSequence: reservation.sequence,
    finalText: finalText,
    displayText: item.text || "",
    imageCount: item.imageCount || 0,
    clientMessageId: item.clientMessageId || null,
    pastes: item.pastes || null,
    intent: "chat",
    coopThreadRef: item.coopThreadRef || null,
    coopTopicRef: item.coopTopicRef || null,
    coopProjectRef: item.coopProjectRef || null,
    // Rebuilt from history after a restart, so the sender comes from the
    // history record (`from` is stamped with ws._clayUser.id when the turn was
    // received). Losing it here would make a replayed "mark as done" fail the
    // Done-workflow owner check for no visible reason.
    actorUserId: item.from || null,
  });
}

function sort(items) {
  items.sort(function (a, b) { return (a.ingressSequence || 0) - (b.ingressSequence || 0); });
}

function rebuildFromHistory(session, deps) {
  if (!session || !Array.isArray(session.history)) return false;
  if (!Array.isArray(session.pendingCoopIngress)) session.pendingCoopIngress = [];
  var byIngressId = {};
  for (var qi = 0; qi < session.pendingCoopIngress.length; qi++) {
    var queued = session.pendingCoopIngress[qi];
    if (queued && queued.ingressId) byIngressId[queued.ingressId] = true;
  }
  var restored = false;
  for (var hi = 0; hi < session.history.length; hi++) {
    var fromHistory = ingressFromHistory(session, session.history[hi], deps);
    if (!fromHistory || byIngressId[fromHistory.ingressId]) continue;
    session.pendingCoopIngress.push(fromHistory);
    byIngressId[fromHistory.ingressId] = true;
    restored = true;
  }
  if (restored) sort(session.pendingCoopIngress);
  return restored;
}

function hasDispatchBlocker(session) {
  return !session || !!(session.destroying || session.isProcessing || session.taskStopRequested ||
    session.providerFailoverPending || session._providerFailoverQueued || session._providerFailoverClosing);
}

function flush(session, deps, dispatch) {
  if (!session || session.destroying) return false;
  if (!session.pendingCoopIngress || session.pendingCoopIngress.length === 0) {
    if (deps.coopControl) deps.coopControl.markIdle(session);
    return false;
  }
  if (hasDispatchBlocker(session)) {
    if (deps.coopControl) deps.coopControl.publish(session);
    return false;
  }
  var next = session.pendingCoopIngress.shift();
  deps.sm.saveSessionFile(session);
  if (deps.coopControl) deps.coopControl.markDispatched(session, next.ingressId);
  dispatch(session, Object.assign({}, next, {
    coopIngress: true,
    coopDispatching: true,
    fromQueue: false,
  }), deps);
  // The dispatch is what sets session.isProcessing, so the state published by
  // markDispatched above still described an idle session. Publish once more
  // after the turn is really running.
  if (deps.coopControl) deps.coopControl.publish(session);
  return true;
}

function enqueue(session, args, deps, dispatch) {
  if (!session.pendingCoopIngress) session.pendingCoopIngress = [];
  for (var i = 0; i < session.pendingCoopIngress.length; i++) {
    if (session.pendingCoopIngress[i].ingressId === args.ingressId) return false;
  }
  session.pendingCoopIngress.push(ingressItem(args));
  sort(session.pendingCoopIngress);
  if (session.scheduledMessage && session.scheduledMessage.autoAction &&
      typeof deps.cancelScheduledMessage === "function") deps.cancelScheduledMessage(session);
  else if (session.scheduledMessage && session.scheduledMessage.autoAction) session.scheduledMessage = null;
  deps.sm.saveSessionFile(session);
  if (deps.coopControl) deps.coopControl.publish(session);
  if (session.isProcessing) {
    // A second owner message queues behind the exact active owner answer. Clay
    // may still preempt a background tick (which has no active ingress), but it
    // never aborts an owner answer without a resumable semantic checkpoint.
    var ingressState = session.coopConversationIngress;
    if (ingressState && ingressState.activeIngressId) {
      coopIngressInterruption.request(session, deps.sm);
      return true;
    }
    session.coopPriorityInterruptRequested = true;
    session.steerInterruptRequested = true;
    session.taskStopRequested = true;
    deps.sm.saveSessionFile(session);
    if (session.abortController) session.abortController.abort();
    return true;
  }
  return flush(session, deps, dispatch);
}

module.exports = {
  enqueue: enqueue,
  flush: flush,
  rebuildFromHistory: rebuildFromHistory,
};
