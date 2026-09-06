// Shared Claude transcript interpretation for discovery and history replay.
function text(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(function (block) {
    return block && block.type === "text" && typeof block.text === "string";
  }).map(function (block) { return block.text; }).join("");
}

function images(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(function (block) {
    return block && block.type === "image" && block.source &&
      block.source.type === "base64" && typeof block.source.data === "string" &&
      /^image\/(png|jpeg|gif|webp)$/.test(block.source.media_type);
  }).map(function (block) {
    return { mediaType: block.source.media_type, data: block.source.data };
  });
}

function ownerMessage(record) {
  if (!record || record.type !== "user" || !record.message || record.message.role !== "user") return null;
  var content = record.message.content;
  var value = text(content);
  var attachments = images(content);
  if (!value && !attachments.length) return null;
  var result = { text: value };
  if (attachments.length) result.images = attachments;
  return result;
}

function appendHistory(record, state, history) {
  if (!record || !record.message || record.parent_tool_use_id) return;
  var ts = Date.parse(record.timestamp);
  function push(item) {
    if (Number.isFinite(ts)) item._ts = ts;
    history.push(item);
  }
  var owner = ownerMessage(record);
  if (owner) push(Object.assign({ type: "user_message" }, owner));
  var content = record.message.content;
  if (!Array.isArray(content)) return;
  content.forEach(function (block) {
    if (!block) return;
    if (record.message.role === "assistant" && block.type === "text" && block.text) {
      push({ type: "delta", text: block.text });
    } else if (record.message.role === "assistant" &&
        ["tool_use", "server_tool_use", "mcp_tool_use"].indexOf(block.type) !== -1) {
      var id = "cli-tool-" + (block.id || ++state.toolCounter);
      var name = block.name || "Tool";
      push({ type: "tool_start", id: id, name: name });
      push({ type: "tool_executing", id: id, name: name, input: block.input || {} });
      // Replay must never leave an old question disabling the owner's composer.
      if (name === "AskUserQuestion") push({ type: "ask_user_answered", toolId: id });
    } else if (block.type === "tool_result" && block.tool_use_id) {
      var result = { type: "tool_result", id: "cli-tool-" + block.tool_use_id,
        content: text(block.content), is_error: block.is_error === true };
      var attachments = images(block.content);
      if (attachments.length) result.images = attachments;
      push(result);
    }
  });
}

module.exports = { text: text, images: images, ownerMessage: ownerMessage, appendHistory: appendHistory };
