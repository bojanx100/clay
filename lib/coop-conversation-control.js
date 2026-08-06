// Durable foreground-ingress control for permanent Coop conversations.
//
// The ordinary queued-message mechanism remains the recovery/backpressure
// path for normal sessions. Coop uses its own ordered ingress lane so an
// owner can keep talking while a brief foreground turn is being completed.

var coopWorkActivity = require("./coop-work-activity");

var MAX_RECENT_INGRESS = 128;

function isCoopConversation(session) {
  return !!(session && (session.coopHome || session.coopChannel));
}

function storageId(session) {
  return session && (session.storageId || session.cliSessionId || session.localId) || "unknown";
}

function ingressKind(msg) {
  if (msg && (msg.ingressType === "voice" || msg.source === "voice" || msg.voice === true)) return "voice";
  return "text";
}

function externalIngressKey(msg) {
  var id = msg && (msg.ingressId || msg.clientMessageId || msg.voiceMessageId);
  if (typeof id !== "string" || !id.trim()) return "";
  return "input:" + id.trim();
}

function stateFor(session) {
  var state = session.coopConversationIngress;
  if (!state || typeof state !== "object") {
    state = { nextSequence: 1, recent: [], activeIngressId: null };
    session.coopConversationIngress = state;
  }
  if (!Number.isInteger(state.nextSequence) || state.nextSequence < 1) state.nextSequence = 1;
  if (!Array.isArray(state.recent)) state.recent = [];
  return state;
}

function historyIngress(session, key) {
  var history = session && Array.isArray(session.history) ? session.history : [];
  for (var i = history.length - 1; i >= 0; i--) {
    var item = history[i];
    if (item && item.type === "user_message" && item.coopIngressKey === key) {
      return {
        ingressId: item.coopIngressId || null,
        sequence: item.coopIngressSequence || null,
      };
    }
  }
  return null;
}

function recentIngress(state, key) {
  for (var i = state.recent.length - 1; i >= 0; i--) {
    if (state.recent[i] && state.recent[i].key === key) return state.recent[i];
  }
  return null;
}

function reserveIngress(session, msg) {
  if (!isCoopConversation(session)) return { coop: false, accepted: true };
  var state = stateFor(session);
  var kind = ingressKind(msg);
  var key = externalIngressKey(msg);
  if (!key) key = "server:" + storageId(session) + ":" + state.nextSequence;
  var prior = recentIngress(state, key) || historyIngress(session, key);
  if (prior) {
    return {
      coop: true,
      accepted: false,
      duplicate: true,
      ingressId: prior.ingressId,
      sequence: prior.sequence,
      kind: kind,
      key: key,
    };
  }
  var sequence = state.nextSequence++;
  var ingressId = "coop:" + storageId(session) + ":" + sequence;
  state.recent.push({ key: key, ingressId: ingressId, sequence: sequence, kind: kind });
  if (state.recent.length > MAX_RECENT_INGRESS) {
    state.recent.splice(0, state.recent.length - MAX_RECENT_INGRESS);
  }
  return {
    coop: true,
    accepted: true,
    ingressId: ingressId,
    sequence: sequence,
    kind: kind,
    key: key,
  };
}

// The work state is derived durably in coop-work-activity.js. Nothing derived
// from prompt or task text is serialized: the owner-visible label is a topic or
// project title, and background work is reported as a count only.
function clientState(session, options) {
  var state = isCoopConversation(session) ? stateFor(session) : null;
  var pending = session && Array.isArray(session.pendingCoopIngress) ? session.pendingCoopIngress.length : 0;
  var activity = coopWorkActivity.coopWorkActivity(session, options);
  return {
    type: "coop_conversation_state",
    sessionId: session && session.localId || null,
    active: !!state,
    replying: !!(session && session.isProcessing),
    activeIngressId: state && state.activeIngressId || null,
    pendingIngressCount: pending,
    // Persistent work activity. "Listening" is not reported here: it is a voice
    // input state owned by the client and may coexist with any work state.
    workState: activity.state,
    workTarget: activity.target,
    backgroundTaskCount: activity.backgroundTaskCount,
    attention: state && state.attention || null,
  };
}

// Reconnect and live publish must resolve work targets identically.
function clientStateFor(ctx, session) {
  return clientState(session, coopWorkActivity.resolversFor(ctx));
}

function foregroundText(reservation, text) {
  if (!reservation || !reservation.coop) return text;
  return [
    "<coop_foreground_turn>",
    "This is an owner-facing Coop foreground turn. Acknowledge and answer the immediate request briefly, then end this turn.",
    "Route any planning, research, review, implementation, testing, monitoring, or cleanup to project-bound helpers/workers; do not hold this turn for that work.",
    "Preserve explicit canonical ProjectRef execution. If a required target is missing, record durable attention and do not fall back to Lead-local execution.",
    "Owner ingress id: " + reservation.ingressId + "; source: " + reservation.kind + ".",
    "</coop_foreground_turn>",
    "",
    text || "",
  ].join("\n");
}

function attachCoopConversationControl(ctx) {
  var sendToSession = ctx.sendToSession || function () {};
  var sm = ctx.sm;
  var onIngressDrained = typeof ctx.onIngressDrained === "function" ? ctx.onIngressDrained : null;
  var workResolvers = coopWorkActivity.resolversFor(ctx);

  function attachedClientState(session) {
    return clientState(session, workResolvers);
  }

  function publish(session) {
    if (!isCoopConversation(session)) return null;
    var state = attachedClientState(session);
    sendToSession(session.localId, state);
    if (sm && typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
    return state;
  }

  function markDispatched(session, ingressId) {
    if (!isCoopConversation(session)) return;
    stateFor(session).activeIngressId = ingressId || null;
    var history = Array.isArray(session.history) ? session.history : [];
    for (var i = history.length - 1; i >= 0; i--) {
      var item = history[i];
      if (!item || item.type !== "user_message" || item.coopIngressId !== ingressId) continue;
      delete item.coopIngressPending;
      item.coopIngressDispatchedAt = Date.now();
      break;
    }
    if (sm && typeof sm.saveSessionFile === "function") sm.saveSessionFile(session);
    publish(session);
  }

  function markIdle(session) {
    if (!isCoopConversation(session)) return;
    stateFor(session).activeIngressId = null;
    if (sm && typeof sm.saveSessionFile === "function") sm.saveSessionFile(session);
    publish(session);
    if (onIngressDrained && !session.isProcessing &&
        (!session.pendingCoopIngress || session.pendingCoopIngress.length === 0)) {
      onIngressDrained();
    }
  }

  function recordAttention(session, reason) {
    if (!isCoopConversation(session)) return;
    stateFor(session).attention = String(reason || "target_unavailable").slice(0, 240);
    if (sm && typeof sm.saveSessionFile === "function") sm.saveSessionFile(session);
    publish(session);
  }

  return {
    clientState: attachedClientState,
    foregroundText: foregroundText,
    isCoopConversation: isCoopConversation,
    markDispatched: markDispatched,
    markIdle: markIdle,
    publish: publish,
    recordAttention: recordAttention,
    reserveIngress: reserveIngress,
  };
}

module.exports = {
  attachCoopConversationControl: attachCoopConversationControl,
  clientState: clientState,
  clientStateFor: clientStateFor,
  foregroundText: foregroundText,
  ingressKind: ingressKind,
  isCoopConversation: isCoopConversation,
  reserveIngress: reserveIngress,
};
