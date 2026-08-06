var projectIdentity = require("./project-identity");

function withTopicContext(fullText, topicRef, projectRef) {
  if (!topicRef) return fullText;
  return [
    "<coop_topic_context>",
    JSON.stringify({ topicRef: topicRef, projectRef: projectRef || null }),
    "</coop_topic_context>",
    "",
    fullText,
  ].join("\n");
}

function messageIntent(msg) {
  return msg.intent === "task" || msg.intent === "queue" || msg.intent === "steer"
    ? msg.intent : "chat";
}

function attachCoopForegroundIngress(ctx) {
  function buildMetadata(session, msg, reservation) {
    var isCoopIngress = !!(reservation && reservation.coop);
    var intent = isCoopIngress ? "chat" : messageIntent(msg);
    var steer = !isCoopIngress && (msg.steer === true || intent === "steer");
    var wasProcessing = !!session.isProcessing;
    var shouldQueue = !isCoopIngress && intent !== "task" &&
      (intent === "queue" || wasProcessing || (!steer && ctx.shouldQueueMessage(session)));
    return {
      intent: intent,
      steer: steer,
      wasProcessing: wasProcessing,
      shouldQueue: shouldQueue,
      queueId: shouldQueue ? ctx.queue.makeQueueId() : null,
      clientMessageId: typeof msg.clientMessageId === "string" ? msg.clientMessageId : null,
      displayImageCount: msg.images ? msg.images.length : 0,
      coopIngress: isCoopIngress ? reservation : null,
    };
  }

  function applyHistoryMetadata(item, metadata) {
    if (!metadata.coopIngress) return;
    item.coopIngressId = metadata.coopIngress.ingressId;
    item.coopIngressKey = metadata.coopIngress.key;
    item.coopIngressSequence = metadata.coopIngress.sequence;
    item.coopIngressKind = metadata.coopIngress.kind;
    item.coopReplyPriority = true;
    item.coopIngressPending = true;
  }

  function unavailableProjectRef(ref, ws) {
    if (!ref) return false;
    if (!projectIdentity.normalizeProjectRef(ref)) return true;
    return typeof ctx.isCoopProjectRefAvailable === "function" &&
      !ctx.isCoopProjectRefAvailable(ref, ws);
  }

  function applyText(metadata, msg, fullText) {
    if (!metadata.coopIngress) return fullText;
    fullText = withTopicContext(fullText, msg.coopTopicRef, msg.coopProjectRef);
    if (msg.coopProjectRef) {
      var projectRef = projectIdentity.normalizeProjectRef(msg.coopProjectRef);
      if (projectRef) {
        fullText = [
          "<coop_project_context>",
          JSON.stringify({ projectRef: projectRef }),
          "</coop_project_context>",
          "",
          fullText,
        ].join("\n");
      }
    }
    return ctx.coopControl
      ? ctx.coopControl.foregroundText(metadata.coopIngress, fullText)
      : fullText;
  }

  function recordPrepared(session, metadata, msg, fullText) {
    if (!metadata.coopIngress || !Array.isArray(session.history)) return;
    for (var i = session.history.length - 1; i >= 0; i--) {
      var item = session.history[i];
      if (!item || item.type !== "user_message" ||
          item.coopIngressId !== metadata.coopIngress.ingressId) continue;
      item.coopIngressPreparedText = fullText;
      item.coopProjectRef = msg.coopProjectRef || null;
      item.coopTopicRef = msg.coopTopicRef || null;
      ctx.sm.saveSessionFile(session);
      return;
    }
  }

  function dispatch(prepared) {
    if (!prepared.metadata.coopIngress) return false;
    ctx.queue.dispatchPreparedToSdk(prepared.session, {
      finalText: prepared.fullText,
      images: prepared.msg.images,
      steer: false,
      queueId: null,
      displayText: prepared.msg.text || "",
      imageCount: prepared.metadata.displayImageCount,
      clientMessageId: prepared.metadata.clientMessageId,
      pastes: prepared.msg.pastes || null,
      fromQueue: false,
      intent: "chat",
      coopIngress: true,
      ingressId: prepared.metadata.coopIngress.ingressId,
      ingressSequence: prepared.metadata.coopIngress.sequence,
    });
    return true;
  }

  return {
    applyHistoryMetadata: applyHistoryMetadata,
    applyText: applyText,
    buildMetadata: buildMetadata,
    dispatch: dispatch,
    recordPrepared: recordPrepared,
    unavailableProjectRef: unavailableProjectRef,
  };
}

module.exports = {
  attachCoopForegroundIngress: attachCoopForegroundIngress,
  withTopicContext: withTopicContext,
};
