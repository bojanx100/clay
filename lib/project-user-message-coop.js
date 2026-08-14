var projectIdentity = require("./project-identity");
var replyAnchor = require("./coop-topic-reply-anchor");

// `replyTo` is reference-only (topic id plus canonical event indexes) and is
// omitted entirely when there is no anchor, so a pre-anchor message serialises
// byte-identically to how it always did. That matters twice: existing history
// replays unchanged, and the restart rebuild in project-user-message-queue
// reproduces the same text from the same record.
function withTopicContext(fullText, topicRef, projectRef, anchor) {
  if (!topicRef) return fullText;
  var context = { topicRef: topicRef, projectRef: projectRef || null };
  var replyTo = replyAnchor.anchorContextPayload(anchor);
  if (replyTo) context.replyTo = replyTo;
  return [
    "<coop_topic_context>",
    JSON.stringify(context),
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
    fullText = withTopicContext(fullText, msg.coopTopicRef, msg.coopProjectRef, msg.coopTopicAnchor);
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

  // Injection only. Resolving a default here would let any caller that drives
  // the ingress pipeline -- including a test -- write into the owner's real
  // ledger. The daemon injects one; nothing else records.
  function ownerRequestLedger() {
    return ctx.coopOwnerRequests || null;
  }

  // The durable owner-request record is written here, at the point the routed
  // turn is fully resolved and its canonical event index is known. It is
  // reference-only: the ledger stores WHERE the request is, never a copy of it.
  //
  // Recording a request is not the same as answering it. This seam only ever
  // opens a request; only the owner-facing turn completing may close it.
  function recordOwnerRequest(session, metadata, msg, eventIndex) {
    var ledger = ownerRequestLedger();
    if (!ledger) return;
    var storageId = projectIdentity.sessionStorageId(session);
    if (!storageId) return;
    var sessionRef = { projectId: projectIdentity.LEAD_PROJECT_ID, sessionStorageId: storageId };
    var ingress = metadata.coopIngress;
    try {
      ledger.record({
        ingressId: ingress.ingressId,
        ingressSequence: ingress.sequence,
        ingressKind: ingress.kind,
        sessionRef: sessionRef,
        requestRef: { projectId: sessionRef.projectId, sessionStorageId: storageId, eventIndex: eventIndex },
      });
      ledger.classify(ingress.ingressId, {
        kind: msg.coopClassification,
        topicRef: msg.coopTopicRef || null,
        projectRefs: msg.coopProjectRef ? [msg.coopProjectRef] : [],
        implementationDecision: msg.coopImplementationDecision || null,
        source: "ingress_route",
      });
    } catch (e) {}
  }

  // A request whose target could not be resolved never reaches history, so it
  // would otherwise vanish: the owner asked for something and nothing anywhere
  // remembers it. Recording it here keeps it queryable and unanswered, which is
  // exactly what "record attention when a ProjectRef is unresolved" means.
  function recordUnroutable(session, reservation, code) {
    var ledger = ownerRequestLedger();
    if (!ledger || !reservation || !reservation.coop) return null;
    var storageId = projectIdentity.sessionStorageId(session);
    if (!storageId) return null;
    try {
      ledger.record({
        ingressId: reservation.ingressId,
        ingressSequence: reservation.sequence,
        ingressKind: reservation.kind,
        sessionRef: { projectId: projectIdentity.LEAD_PROJECT_ID, sessionStorageId: storageId },
      });
      return ledger.recordAttention(reservation.ingressId, code);
    } catch (e) { return null; }
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
      item.coopThreadRef = msg.coopThreadRef || null;
      item.coopThreadTitle = msg.coopThreadTitle || "";
      item.coopThreadState = msg.coopThreadState || "";
      item.coopClassification = msg.coopClassification || "";
      item.coopImplementationDecision = msg.coopImplementationDecision || null;
      item.coopTopicAnchor = msg.coopTopicAnchor || null;
      ctx.sm.saveSessionFile(session);
      recordOwnerRequest(session, metadata, msg, i);
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
      // Coop-routed turns are still sent by a person, and the Done-workflow
      // gate authorizes on that person.
      actorUserId: (prepared.ws && prepared.ws._clayUser && prepared.ws._clayUser.id) || null,
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
    recordUnroutable: recordUnroutable,
    unavailableProjectRef: unavailableProjectRef,
  };
}

module.exports = {
  attachCoopForegroundIngress: attachCoopForegroundIngress,
  withTopicContext: withTopicContext,
};
