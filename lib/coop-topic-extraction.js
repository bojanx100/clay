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
