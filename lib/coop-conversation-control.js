// Durable foreground-ingress control for permanent Coop conversations.
//
// The ordinary queued-message mechanism remains the recovery/backpressure
// path for normal sessions. Coop uses its own ordered ingress lane so an
// owner can keep talking while a brief foreground turn is being completed.

var coopWorkActivity = require("./coop-work-activity");
var projectIdentity = require("./project-identity");

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
    // Bounded code from coop-work-activity's closed set, or "". The client owns
    // the wording; the server never ships a reason it cannot substantiate.
    workReason: activity.reason,
    backgroundTaskCount: activity.backgroundTaskCount,
    // Normalized on read as well as on write: a session file written before
    // recordAttention bounded its input may still hold prose on disk, and it
    // must not reach a client just because it predates the guard.
    attention: state && coopWorkActivity.normalizeAttentionCode(state.attention) || null,
  };
}

// Reconnect and live publish must resolve work targets identically.
function clientStateFor(ctx, session, actor) {
  return clientState(session, coopWorkActivity.resolversFor(ctx, actor));
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

// Events that are the assistant actually SAYING something to the owner.
//
// `result` is deliberately excluded: it is bookkeeping that carries cost and
// usage (see the Lead tick's budget snapshot, which reads exactly that field)
// and it is emitted on turns that produced no owner-visible text at all.
// Counting it meant a turn could be marked answered having said nothing.
var ASSISTANT_OUTPUT = { delta: true, delta_replace: true, plan_content: true };

// The exact canonical event that ended the turn, and whether it ended by
// answering.
//
// A `done` alone is not evidence of an answer. Clay writes `done` with code 0
// on paths where nobody replied: an interrupted turn (sdk-bridge-stream emits
// info + done(0) when the owner stops or pre-empts it) and, more subtly, the
// stream-drop auto-retry, which emits info + done(0) and then RESUMES the same
// turn. Reading either as an answer is exactly the failure this ledger exists
// to prevent, so the terminator only counts when the turn between the owner's
// message and that `done` actually produced assistant output.
function answeringEvent(session) {
  var history = session && Array.isArray(session.history) ? session.history : [];
  for (var i = history.length - 1; i >= 0; i--) {
    var item = history[i];
    if (!item || item.type !== "done") continue;
    var spoke = false;
    for (var j = i - 1; j >= 0; j--) {
      var earlier = history[j];
      if (!earlier) continue;
      // Stop at the start of this turn: output from an EARLIER turn is not
      // this turn's answer.
      if (earlier.type === "user_message" || earlier.type === "done") break;
      if (ASSISTANT_OUTPUT[earlier.type]) { spoke = true; break; }
    }
    return { eventIndex: i, answered: !item.code && spoke };
  }
  return null;
}

// The owner is answered when their foreground turn completed with a reply.
//
// Deliberately NOT an answer: a worker starting, a coordinator being bound, a
// task reaching running, or this turn being cut short by the owner's own next
// message (a Coop priority interrupt aborts mid-reply, and the pending ingress
// that caused it becomes the live one). Treating any of those as an answer is
// precisely how an unanswered owner used to disappear behind a busy spinner.
function markIngressAnswered(session, ledger) {
  if (!isCoopConversation(session)) return false;
  var state = stateFor(session);
  var ingressId = state.activeIngressId;
  if (!ingressId) return false;
  var storageId = projectIdentity.sessionStorageId(session);
  // Injection only: see project-user-message-coop.js.
  if (!storageId || !ledger) return false;

  // The owner pre-empted their own question with the next message. That
  // request is superseded, not answered and not left dangling -- and the flag
  // is CONSUMED here. It is set in enqueueCoopIngress and reset nowhere else in
  // the daemon (unlike its siblings taskStopRequested/steerInterruptRequested,
  // which sdk-bridge-stream clears), so leaving it set made one routine
  // interrupt silently stop every later turn from ever being marked answered.
  var interrupted = !!session.coopPriorityInterruptRequested;
  if (interrupted) session.coopPriorityInterruptRequested = false;

  // The stream dropped and Clay queued a resume. The `done(0)` just written is
  // retry bookkeeping; the turn has not finished answering anyone.
  //
  // streamEndedAutoRetryQueued cannot be the signal: scheduleInterruptResume
  // clears it before this hook ever runs. The queued auto-resume itself is the
  // durable evidence that the turn is being continued rather than finished.
  var scheduled = session.scheduledMessage;
  var resuming = !!(session.streamEndedAutoRetryQueued ||
    (scheduled && scheduled.autoAction));

  try {
    // Idempotent: markAnswered keeps the first answer, so a repeated turn-done
    // for the same ingress cannot restamp it.
    ledger.record({
      ingressId: ingressId,
      sessionRef: { projectId: projectIdentity.LEAD_PROJECT_ID, sessionStorageId: storageId },
    });
    if (interrupted) return !!ledger.supersede(ingressId, "owner_interrupt");
    if (resuming) return false;
    var event = answeringEvent(session);
    if (!event || !event.answered) return false;
    return !!ledger.markAnswered(ingressId, { eventIndex: event.eventIndex });
  } catch (e) { return false; }
}

function attachCoopConversationControl(ctx) {
  var sendToSession = ctx.sendToSession || function () {};
  var sendTo = ctx.sendTo;
  var clients = ctx.clients;
  var sm = ctx.sm;
  var onIngressDrained = typeof ctx.onIngressDrained === "function" ? ctx.onIngressDrained : null;

  function attachedClientState(session, actor) {
    return clientState(session, coopWorkActivity.resolversFor(ctx, actor));
  }

  function publish(session) {
    if (!isCoopConversation(session)) return null;
    var state = null;
    // Work labels are recipient-projected data. Build and send one state per
    // connected viewer instead of resolving a title once and broadcasting that
    // shared object to everyone watching the Coop session.
    if (clients && typeof clients.forEach === "function" && typeof sendTo === "function") {
      clients.forEach(function (ws) {
        if (!ws || ws._clayActiveSession !== session.localId) return;
        state = attachedClientState(session, ws);
        sendTo(ws, state);
      });
    } else {
      state = attachedClientState(session);
      sendToSession(session.localId, state);
    }
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

  // Attention is stored as a code from the closed vocabulary in
  // coop-work-activity.js, never as caller-supplied prose, so neither the
  // durable session file nor the wire can accumulate reason text.
  function recordAttention(session, reason) {
    if (!isCoopConversation(session)) return;
    stateFor(session).attention =
      coopWorkActivity.normalizeAttentionCode(reason) || "attention_required";
    if (sm && typeof sm.saveSessionFile === "function") sm.saveSessionFile(session);
    publish(session);
  }

  // Attention is what holds Coop at Waiting instead of Idle, so it must be
  // resolvable. The route that recorded it succeeding IS the resolution; without
  // this, one unavailable target would pin Coop at Waiting forever.
  function clearAttention(session) {
    if (!isCoopConversation(session)) return false;
    var state = stateFor(session);
    if (!state.attention) return false;
    delete state.attention;
    if (sm && typeof sm.saveSessionFile === "function") sm.saveSessionFile(session);
    publish(session);
    return true;
  }

  var ownerRequestLedger = ctx.coopOwnerRequests || null;

  // Called from the per-turn done hook, before the ingress lane drains, so the
  // ingress that was live for this turn is still the active one.
  function markAnswered(session) {
    if (!markIngressAnswered(session, ownerRequestLedger)) return false;
    publish(session);
    return true;
  }

  return {
    clearAttention: clearAttention,
    clientState: attachedClientState,
    foregroundText: foregroundText,
    isCoopConversation: isCoopConversation,
    markAnswered: markAnswered,
    markDispatched: markDispatched,
    markIdle: markIdle,
    publish: publish,
    recordAttention: recordAttention,
    reserveIngress: reserveIngress,
  };
}

module.exports = {
  answeringEvent: answeringEvent,
  attachCoopConversationControl: attachCoopConversationControl,
  clientState: clientState,
  clientStateFor: clientStateFor,
  foregroundText: foregroundText,
  ingressKind: ingressKind,
  isCoopConversation: isCoopConversation,
  markIngressAnswered: markIngressAnswered,
  reserveIngress: reserveIngress,
};
