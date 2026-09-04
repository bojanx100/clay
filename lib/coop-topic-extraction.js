// Complete immutable canonical user-to-done turn extraction.

function turnText(turn) {
  return [turn.userText, turn.finalText || turn.deltaText].filter(Boolean).join("\n");
}

function completeTurns(history, fromEvent) {
  var turns = [];
  var active = null;
  var nextEvent = history.length;
  for (var i = fromEvent; i < history.length; i++) {
    var event = history[i] || {};
    if (event.type === "user_message") {
      active = {
        startEventIndex: i, userText: String(event.text || ""), deltaText: "", finalText: "",
        topicRef: event.coopTopicRef || event.topicRef || null,
        projectRef: event.coopProjectRef || event.projectRef || null,
        // Carried so classification can tell owner conversation from Coop
        // talking to itself. Without these the turn record was pure text, so an
        // internal-only turn -- already dropped from replay -- could still mint
        // and populate a topic, producing a topic whose lens renders empty.
        internalOnly: event.internalOnly === true,
        synthetic: event.synthetic === true,
        autoAction: event.autoAction === true,
        origin: event.origin || null,
        fromName: event.fromName || "",
        // Owner provenance, so admission can tell a message the owner typed
        // from a control prompt injected into the same user_message carrier.
        // Injected prompts (the scheduled tick, resume markers, worker update
        // envelopes, compaction retries) carry none of these.
        from: event.from || "",
        clientMessageId: event.clientMessageId || "",
        coopIngressId: event.coopIngressId || "",
      };
    }
    if (!active) continue;
    if (event.type === "delta") active.deltaText += String(event.text || "");
    if (event.type === "delta_replace" || event.type === "result") {
      if (event.text) active.finalText = String(event.text);
    }
    if (event.type === "done") {
      active.endEventIndex = i;
      active.text = turnText(active);
      turns.push(active);
      active = null;
    }
  }
  if (active) nextEvent = active.startEventIndex;
  return { turns: turns, nextEvent: nextEvent };
}

module.exports = { completeTurns: completeTurns };
