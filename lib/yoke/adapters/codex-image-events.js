function isImageGenerationItem(item) {
  return !!item && (item.type === "imageGeneration" || item.type === "image_generation");
}

function isDynamicToolItem(item) {
  return !!item && (item.type === "dynamicToolCall" || item.type === "dynamic_tool_call");
}

function imageResultUrl(item) {
  if (!item || typeof item.result !== "string" || !item.result) return "";
  if (item.result.indexOf("data:") === 0) return item.result;
  return "data:image/png;base64," + item.result;
}

function flattenImageGenerationItem(item, evtPhase, state) {
  var events = [];
  if (!item || !item.id) return events;
  if (!state.imageGenerationResults) state.imageGenerationResults = {};

  if (!state.toolBlocks[item.id]) {
    state.blockCounter++;
    state.toolBlocks[item.id] = "blk_" + state.blockCounter;
    events.push({
      yokeType: "tool_start",
      blockId: state.toolBlocks[item.id],
      toolId: item.id,
      toolName: "imagegen",
    });
    events.push({
      yokeType: "tool_executing",
      blockId: state.toolBlocks[item.id],
      toolId: item.id,
      toolName: "imagegen",
      input: item.revisedPrompt ? { prompt: item.revisedPrompt } : {},
    });
  }

  if (evtPhase === "completed" && !state.imageGenerationResults[item.id]) {
    state.imageGenerationResults[item.id] = true;
    var imageUrl = imageResultUrl(item);
    events.push({
      yokeType: "tool_result",
      toolId: item.id,
      blockId: state.toolBlocks[item.id],
      content: "",
      images: imageUrl ? [{ url: imageUrl }] : [],
      isError: item.status === "failed" || !imageUrl,
    });
  }

  return events;
}

function flattenDynamicToolItem(item, evtPhase, state) {
  var events = [];
  if (!state.dynamicToolResults) state.dynamicToolResults = {};
  if (!state.toolBlocks[item.id]) {
    state.blockCounter++;
    state.toolBlocks[item.id] = "blk_" + state.blockCounter;
    events.push({
      yokeType: "tool_start",
      blockId: state.toolBlocks[item.id],
      toolId: item.id,
      toolName: item.tool || "tool",
    });
    events.push({
      yokeType: "tool_executing",
      blockId: state.toolBlocks[item.id],
      toolId: item.id,
      toolName: item.tool || "tool",
      input: item.arguments || {},
    });
  }
  if (evtPhase !== "completed" || state.dynamicToolResults[item.id]) return events;

  state.dynamicToolResults[item.id] = true;
  var dynamicText = [];
  var dynamicImages = [];
  var contentItems = Array.isArray(item.contentItems) ? item.contentItems : [];
  for (var i = 0; i < contentItems.length; i++) {
    var contentItem = contentItems[i];
    if (!contentItem) continue;
    if ((contentItem.type === "inputText" || contentItem.type === "input_text") &&
        typeof contentItem.text === "string") {
      dynamicText.push(contentItem.text);
    } else if ((contentItem.type === "inputImage" || contentItem.type === "input_image") &&
               typeof contentItem.imageUrl === "string") {
      dynamicImages.push({ url: contentItem.imageUrl });
    }
  }
  events.push({
    yokeType: "tool_result",
    toolId: item.id,
    blockId: state.toolBlocks[item.id],
    content: dynamicText.join("\n"),
    images: dynamicImages,
    isError: item.status === "failed" || item.success === false,
  });
  return events;
}

module.exports = {
  isImageGenerationItem: isImageGenerationItem,
  isDynamicToolItem: isDynamicToolItem,
  flattenImageGenerationItem: flattenImageGenerationItem,
  flattenDynamicToolItem: flattenDynamicToolItem,
};
