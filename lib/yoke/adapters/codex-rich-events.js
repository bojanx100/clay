var fs = require("fs");
var path = require("path");

function itemType(item) {
  return item && item.type ? String(item.type).replace(/_/g, "").toLowerCase() : "";
}

function isRichItem(item) {
  var type = itemType(item);
  return type === "imageview" ||
    type === "websearch" ||
    type === "collabtoolcall" ||
    type === "enteredreviewmode" ||
    type === "exitedreviewmode";
}

function imageMediaType(filePath) {
  var ext = path.extname(filePath || "").toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".avif") return "image/avif";
  if (ext === ".svg") return "image/svg+xml";
  return "image/png";
}

var IMAGE_MAX_BYTES = 8 * 1024 * 1024; // skip huge files: they block the loop and bloat state

function imageFromPath(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  try {
    // statSync is cheap (no content read); bail before reading an oversized
    // screenshot synchronously on the event hot path.
    if (fs.statSync(filePath).size > IMAGE_MAX_BYTES) return null;
    return {
      mediaType: imageMediaType(filePath),
      data: fs.readFileSync(filePath).toString("base64"),
    };
  } catch (e) {
    return null;
  }
}

function ensureTool(item, state, toolName, input) {
  var events = [];
  if (state.toolBlocks[item.id]) return events;
  state.blockCounter++;
  state.toolBlocks[item.id] = "blk_" + state.blockCounter;
  events.push({
    yokeType: "tool_start",
    blockId: state.toolBlocks[item.id],
    toolId: item.id,
    toolName: toolName,
  });
  events.push({
    yokeType: "tool_executing",
    blockId: state.toolBlocks[item.id],
    toolId: item.id,
    toolName: toolName,
    input: input || {},
  });
  return events;
}

function actionInput(item) {
  var action = item.action && typeof item.action === "object" ? item.action : {};
  var input = Object.assign({}, action);
  if (item.query && !input.query) input.query = item.query;
  return input;
}

function webSearchSummary(item) {
  var input = actionInput(item);
  if (input.type === "openPage" || input.type === "open_page") {
    return input.url ? "Opened " + input.url : "Opened web page";
  }
  if (input.type === "findInPage" || input.type === "find_in_page") {
    var location = input.url ? " in " + input.url : "";
    return input.pattern ? "Found “" + input.pattern + "”" + location : "Searched within page";
  }
  var queries = Array.isArray(input.queries) ? input.queries : [];
  var query = input.query || item.query || queries.join(", ");
  return query ? "Searched the web for “" + query + "”" : "Web search completed";
}

function collabInput(item) {
  return {
    prompt: item.prompt || undefined,
    sender_thread_id: item.senderThreadId || item.sender_thread_id || undefined,
    receiver_thread_id: item.receiverThreadId || item.receiver_thread_id || undefined,
    new_thread_id: item.newThreadId || item.new_thread_id || undefined,
  };
}

function collabSummary(item) {
  var status = item.agentStatus || item.agent_status || item.status || "completed";
  var target = item.receiverThreadId || item.receiver_thread_id ||
    item.newThreadId || item.new_thread_id || "";
  return "Collaboration " + status + (target ? " (" + target + ")" : "");
}

function flattenRichItem(item, evtPhase, state) {
  var events = [];
  if (!item || !item.id || !isRichItem(item)) return events;
  if (!state.richItemResults) state.richItemResults = {};
  var type = itemType(item);
  var toolName = "Activity";
  var input = {};

  if (type === "imageview") {
    toolName = "ViewImage";
    input = { file_path: item.path || "" };
  } else if (type === "websearch") {
    toolName = "WebSearch";
    input = actionInput(item);
  } else if (type === "collabtoolcall") {
    toolName = item.tool || "Collaboration";
    input = collabInput(item);
  } else {
    toolName = "ReviewMode";
    input = { review: item.review || "" };
  }

  events = events.concat(ensureTool(item, state, toolName, input));
  if (evtPhase !== "completed" || state.richItemResults[item.id]) return events;
  state.richItemResults[item.id] = true;

  var content = "";
  var images = [];
  var isError = item.status === "failed";
  if (type === "imageview") {
    var image = imageFromPath(item.path);
    if (image) images.push(image);
    content = image ? "" : "Could not load image preview: " + (item.path || "unknown path");
    isError = !image;
  } else if (type === "websearch") {
    content = webSearchSummary(item);
  } else if (type === "collabtoolcall") {
    content = collabSummary(item);
  } else if (type === "enteredreviewmode") {
    content = item.review || "Entered review mode";
  } else {
    content = item.review || "Exited review mode";
  }

  events.push({
    yokeType: "tool_result",
    toolId: item.id,
    blockId: state.toolBlocks[item.id],
    content: content,
    images: images,
    isError: isError,
  });
  return events;
}

module.exports = {
  isRichItem: isRichItem,
  flattenRichItem: flattenRichItem,
  imageFromPath: imageFromPath,
};
