var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var codexAdapter = require("../lib/yoke/adapters/codex");
var claudeEvents = require("../lib/yoke/adapters/claude-events");
var routing = codexAdapter._test;

function codexState() {
  return {
    blockCounter: 0,
    toolBlocks: {},
    thinkingBlocks: {},
    thinkingLengths: {},
    commandInputs: {},
    commandOutputs: {},
  };
}

test("Codex renders native imageView items with the viewed file", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-image-view-"));
  var imagePath = path.join(dir, "preview.webp");
  fs.writeFileSync(imagePath, Buffer.from("preview"));
  try {
    var events = routing.flattenEvent({
      method: "item/completed",
      params: {
        item: {
          id: "image-view-1",
          type: "imageView",
          path: imagePath,
        },
      },
    }, codexState());
    var result = events[2];

    assert.strictEqual(events[0].toolName, "ViewImage");
    assert.deepStrictEqual(events[1].input, { file_path: imagePath });
    assert.deepStrictEqual(result.images, [{
      mediaType: "image/webp",
      data: Buffer.from("preview").toString("base64"),
    }]);
    assert.strictEqual(result.isError, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex completes web search items with action details", function () {
  var events = routing.flattenEvent({
    method: "item/completed",
    params: {
      item: {
        id: "web-search-1",
        type: "webSearch",
        query: "Clay rendering",
        action: { type: "search", queries: ["Clay rendering", "rich output"] },
      },
    },
  }, codexState());

  assert.strictEqual(events[0].toolName, "WebSearch");
  assert.strictEqual(events[1].input.query, "Clay rendering");
  assert.match(events[2].content, /Clay rendering/);
  assert.strictEqual(events[2].isError, false);
});

test("Codex renders collaboration and review-mode items", function () {
  var state = codexState();
  var collabEvents = routing.flattenEvent({
    method: "item/completed",
    params: {
      item: {
        id: "collab-1",
        type: "collabToolCall",
        tool: "spawn_agent",
        status: "completed",
        newThreadId: "thread-child",
        prompt: "Inspect rendering",
      },
    },
  }, state);
  var reviewEvents = routing.flattenEvent({
    method: "item/completed",
    params: {
      item: {
        id: "review-1",
        type: "enteredReviewMode",
        review: "Reviewing the current changes",
      },
    },
  }, state);

  assert.strictEqual(collabEvents[0].toolName, "spawn_agent");
  assert.match(collabEvents[2].content, /thread-child/);
  assert.strictEqual(reviewEvents[0].toolName, "ReviewMode");
  assert.strictEqual(reviewEvents[2].content, "Reviewing the current changes");
});

test("Codex reconciles rich items carried only by turn completion", function () {
  var state = codexState();
  state.model = "gpt-5.6-sol";
  state.aborted = false;
  var events = routing.flattenEvent({
    method: "turn/completed",
    params: {
      turn: {
        status: "completed",
        items: [{
          id: "web-search-turn-only",
          type: "webSearch",
          query: "turn result",
        }],
      },
    },
  }, state);

  assert.ok(events.some(function (event) {
    return event.yokeType === "tool_result" && /turn result/.test(event.content);
  }));
  assert.strictEqual(events[events.length - 1].yokeType, "result");
});

test("Claude maps server tool use blocks into the normal tool lifecycle", function () {
  var event = claudeEvents.flattenEvent({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "server_tool_use",
        id: "server-tool-1",
        name: "web_search",
      },
    },
  });

  assert.strictEqual(event.yokeType, "tool_start");
  assert.strictEqual(event.toolId, "server-tool-1");
  assert.strictEqual(event.toolName, "web_search");
});

test("Claude preserves rich search results and image blocks", function () {
  var event = claudeEvents.flattenEvent({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 3,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: "server-tool-1",
        content: [{
          type: "web_search_result",
          title: "Clay",
          url: "https://example.com/clay",
          snippet: "Rich output support",
        }, {
          type: "image",
          source: {
            media_type: "image/png",
            data: "aGVsbG8=",
          },
        }],
      },
    },
  });

  assert.strictEqual(event.yokeType, "tool_result");
  assert.strictEqual(event.toolId, "server-tool-1");
  assert.match(event.content, /Clay — https:\/\/example.com\/clay/);
  assert.match(event.content, /Rich output support/);
  assert.deepStrictEqual(event.images, [{
    mediaType: "image/png",
    data: "aGVsbG8=",
  }]);
});
