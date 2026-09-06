// Codex Desktop records completed conversation items instead of the older
// user_message/agent_message events. response_item entries are model input and
// output mirrors, so importing those as well would duplicate messages and expose
// injected project instructions as if the owner had typed them.
function completedMessage(event, threadId) {
  var payload = event && event.type === "event_msg" && event.payload;
  var item = payload && payload.type === "item_completed" && payload.item;
  if (!item || (payload.thread_id && payload.thread_id !== threadId)) return null;
  var role = item.type === "UserMessage" ? "user" : item.type === "AgentMessage" ? "assistant" : "";
  if (!role || !Array.isArray(item.content)) return null;
  var text = item.content.filter(function (part) {
    return part && (part.type === "text" || part.type === "Text") && typeof part.text === "string";
  }).map(function (part) { return part.text; }).join("\n");
  return text ? { role: role, text: text, id: item.id || "" } : null;
}

// Keep picker discovery bounded: decode only its display prefix even when the
// first owner message contains a multi-megabyte paste. Quoted JSON embedded in a
// text value has escaped quotes and cannot stand in for these structural fields.
function completedUserPrefix(line, decode, maxChars) {
  // Ordinary records use the full decoder, which is independent of field order.
  // Oversized or truncated records fall back to the Desktop serializer's prefix.
  if (line.length <= 64 * 1024) {
    try {
      var event = JSON.parse(line);
      var message = completedMessage(event, event.payload && event.payload.thread_id);
      return message && message.role === "user" ? message.text.slice(0, maxChars) : null;
    } catch (e) {}
  }
  if (!/(?<!\\)"type"\s*:\s*"event_msg"/.test(line)) return null;
  var item = /(?<!\\)"type"\s*:\s*"item_completed"[\s\S]*?(?<!\\)"item"\s*:\s*\{\s*"type"\s*:\s*"UserMessage"/.exec(line);
  if (!item) return null;
  var content = /(?<!\\)"content"\s*:\s*\[/g;
  content.lastIndex = item.index + item[0].length;
  var foundContent = content.exec(line);
  if (!foundContent) return null;
  var textPart = /(?<!\\)"type"\s*:\s*"(?:text|Text)"\s*,\s*"text"\s*:\s*"/g;
  textPart.lastIndex = foundContent.index + foundContent[0].length;
  var foundText = textPart.exec(line);
  return foundText ? decode(line, foundText.index + foundText[0].length - 1, maxChars) : null;
}

module.exports = { completedMessage: completedMessage, completedUserPrefix: completedUserPrefix };
