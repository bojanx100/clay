var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var codexAdapter = require("../lib/yoke/adapters/codex");
var routing = codexAdapter._test;

test("Codex item events with another thread id are ignored", function () {
  var state = { threadId: "thread-a", turnId: "turn-a" };
  var ok = routing.shouldRouteServerEvent(state, {}, "item/completed", {
    threadId: "thread-b",
    turnId: "turn-b",
    item: { id: "item-b", type: "agentMessage" },
  });

  assert.strictEqual(ok, false);
});

test("Codex item events with matching nested turn id are routed", function () {
  var state = { threadId: "thread-a", turnId: "turn-a" };
  var ok = routing.shouldRouteServerEvent(state, {}, "item/started", {
    item: {
      id: "item-a",
      type: "userMessage",
      turnId: "turn-a",
    },
  });

  assert.strictEqual(ok, true);
});

test("Codex dynamic tool image output is preserved for the client", function () {
  var state = {
    blockCounter: 0,
    toolBlocks: {},
    thinkingBlocks: {},
    thinkingLengths: {},
    commandInputs: {},
    commandOutputs: {},
  };
  var events = routing.flattenEvent({
    method: "item/completed",
    params: {
      item: {
        id: "image-tool-1",
        type: "dynamicToolCall",
        tool: "imagegen",
        arguments: { prompt: "Urban icon" },
        status: "completed",
        success: true,
        contentItems: [
          { type: "inputImage", imageUrl: "data:image/png;base64,aGVsbG8=" },
          { type: "inputText", text: "Saved preview" },
        ],
      },
    },
  }, state);
  var result = events.filter(function (event) {
    return event.yokeType === "tool_result";
  })[0];

  assert.strictEqual(events[0].yokeType, "tool_start");
  assert.strictEqual(events[1].toolName, "imagegen");
  assert.strictEqual(result.content, "Saved preview");
  assert.deepStrictEqual(result.images, [
    { url: "data:image/png;base64,aGVsbG8=" },
  ]);
  assert.strictEqual(result.isError, false);
});

test("Codex extracts images wrapped in an MCP JSON tool result", function () {
  var state = {
    blockCounter: 0,
    toolBlocks: {},
    thinkingBlocks: {},
    thinkingLengths: {},
    commandInputs: {},
    commandOutputs: {},
  };
  var events = routing.flattenEvent({
    method: "item/completed",
    params: {
      item: {
        id: "node-repl-image-1",
        type: "dynamicToolCall",
        tool: "js",
        arguments: { code: "await nodeRepl.emitImage(...)" },
        status: "completed",
        success: true,
        contentItems: [{
          type: "inputText",
          text: JSON.stringify({
            content: [
              { type: "text", text: "Preview ready" },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
            isError: false,
          }),
        }],
      },
    },
  }, state);
  var result = events.filter(function (event) {
    return event.yokeType === "tool_result";
  })[0];

  assert.strictEqual(result.content, "Preview ready");
  assert.deepStrictEqual(result.images, [{
    mediaType: "image/png",
    data: "aGVsbG8=",
  }]);
  assert.strictEqual(result.isError, false);
});

test("Codex preserves image blocks from a completed MCP tool call", function () {
  var state = {
    blockCounter: 0,
    toolBlocks: {},
    thinkingBlocks: {},
    thinkingLengths: {},
    commandInputs: {},
    commandOutputs: {},
  };
  var events = routing.flattenEvent({
    method: "item/completed",
    params: {
      item: {
        id: "mcp-node-repl-image-1",
        type: "mcpToolCall",
        tool: "js",
        arguments: { code: "await nodeRepl.emitImage(...)" },
        status: "completed",
        result: {
          content: [
            { type: "text", text: "Preview ready" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
          isError: false,
        },
      },
    },
  }, state);
  var result = events.filter(function (event) {
    return event.yokeType === "tool_result";
  })[0];

  assert.strictEqual(result.content, "Preview ready");
  assert.deepStrictEqual(result.images, [{
    mediaType: "image/png",
    data: "aGVsbG8=",
  }]);
  assert.strictEqual(result.isError, false);
});

test("Codex reconciles dynamic image tools carried only by turn completion", function () {
  var state = {
    blockCounter: 0,
    toolBlocks: {},
    thinkingBlocks: {},
    thinkingLengths: {},
    commandInputs: {},
    commandOutputs: {},
    model: "gpt-5.6-sol",
    aborted: false,
  };
  var events = routing.flattenEvent({
    method: "turn/completed",
    params: {
      turn: {
        status: "completed",
        items: [{
          id: "image-tool-turn-only",
          type: "dynamicToolCall",
          tool: "view_image",
          arguments: { path: "/tmp/preview.png" },
          status: "completed",
          success: true,
          contentItems: [{
            type: "inputImage",
            imageUrl: "data:image/png;base64,aGVsbG8=",
          }],
        }],
      },
    },
  }, state);
  var result = events.filter(function (event) {
    return event.yokeType === "tool_result";
  })[0];

  assert.ok(result);
  assert.deepStrictEqual(result.images, [
    { url: "data:image/png;base64,aGVsbG8=" },
  ]);
  assert.strictEqual(events[events.length - 1].yokeType, "result");
});

test("Codex does not repeat a dynamic tool result at turn completion", function () {
  var state = {
    blockCounter: 0,
    toolBlocks: {},
    thinkingBlocks: {},
    thinkingLengths: {},
    commandInputs: {},
    commandOutputs: {},
    model: "gpt-5.6-sol",
    aborted: false,
  };
  var item = {
    id: "image-tool-repeated",
    type: "dynamicToolCall",
    tool: "imagegen",
    arguments: { prompt: "Urban icon" },
    status: "completed",
    success: true,
    contentItems: [{
      type: "inputImage",
      imageUrl: "data:image/png;base64,aGVsbG8=",
    }],
  };
  var itemEvents = routing.flattenEvent({
    method: "item/completed",
    params: { item: item },
  }, state);
  var turnEvents = routing.flattenEvent({
    method: "turn/completed",
    params: {
      turn: {
        status: "completed",
        items: [item],
      },
    },
  }, state);
  var resultCount = itemEvents.concat(turnEvents).filter(function (event) {
    return event.yokeType === "tool_result";
  }).length;

  assert.strictEqual(resultCount, 1);
});

test("Codex image generation output is preserved for the client", function () {
  var state = {
    blockCounter: 0,
    toolBlocks: {},
    thinkingBlocks: {},
    thinkingLengths: {},
    commandInputs: {},
    commandOutputs: {},
  };
  var events = routing.flattenEvent({
    method: "item/completed",
    params: {
      item: {
        id: "generated-image-1",
        type: "imageGeneration",
        status: "completed",
        revisedPrompt: "A refined urban icon",
        result: "aGVsbG8=",
        savedPath: "/tmp/generated.png",
      },
    },
  }, state);
  var result = events.filter(function (event) {
    return event.yokeType === "tool_result";
  })[0];

  assert.strictEqual(events[0].yokeType, "tool_start");
  assert.strictEqual(events[1].toolName, "imagegen");
  assert.deepStrictEqual(events[1].input, { prompt: "A refined urban icon" });
  assert.deepStrictEqual(result.images, [
    { url: "data:image/png;base64,aGVsbG8=" },
  ]);
  assert.strictEqual(result.isError, false);
});

test("Codex reconciles image generation carried only by turn completion", function () {
  var state = {
    blockCounter: 0,
    toolBlocks: {},
    thinkingBlocks: {},
    thinkingLengths: {},
    commandInputs: {},
    commandOutputs: {},
    model: "gpt-5.6-sol",
    aborted: false,
  };
  var events = routing.flattenEvent({
    method: "turn/completed",
    params: {
      turn: {
        status: "completed",
        items: [{
          id: "generated-image-turn-only",
          type: "imageGeneration",
          status: "completed",
          result: "aGVsbG8=",
        }],
      },
    },
  }, state);
  var result = events.filter(function (event) {
    return event.yokeType === "tool_result";
  })[0];

  assert.ok(result);
  assert.deepStrictEqual(result.images, [
    { url: "data:image/png;base64,aGVsbG8=" },
  ]);
  assert.strictEqual(events[events.length - 1].yokeType, "result");
});

test("Codex does not render empty reasoning blocks", function () {
  var state = {
    blockCounter: 0,
    toolBlocks: {},
    thinkingBlocks: {},
    thinkingLengths: {},
    commandInputs: {},
    commandOutputs: {},
  };
  var events = routing.flattenEvent({
    method: "item/completed",
    params: {
      item: {
        id: "empty-reasoning-1",
        type: "reasoning",
        summary: [],
      },
    },
  }, state);

  assert.deepStrictEqual(events, []);
});

test("Codex streams readable reasoning deltas without repeating completed text", function () {
  var state = {
    blockCounter: 0,
    toolBlocks: {},
    thinkingBlocks: {},
    thinkingLengths: {},
    commandInputs: {},
    commandOutputs: {},
    planTexts: {},
  };
  var events = [];
  events = events.concat(routing.flattenEvent({
    method: "item/reasoning/summaryTextDelta",
    params: { itemId: "reasoning-1", delta: "First" },
  }, state));
  events = events.concat(routing.flattenEvent({
    method: "item/reasoning/summaryPartAdded",
    params: { itemId: "reasoning-1" },
  }, state));
  events = events.concat(routing.flattenEvent({
    method: "item/reasoning/textDelta",
    params: { itemId: "reasoning-1", delta: "Second" },
  }, state));
  events = events.concat(routing.flattenEvent({
    method: "item/completed",
    params: { item: { id: "reasoning-1", type: "reasoning", text: "First\n\nSecond" } },
  }, state));

  assert.deepStrictEqual(events.map(function (event) { return event.yokeType; }), [
    "thinking_start", "thinking_delta", "thinking_delta", "thinking_delta", "thinking_stop",
  ]);
  assert.strictEqual(events.filter(function (event) {
    return event.yokeType === "thinking_delta";
  }).map(function (event) { return event.text; }).join(""), "First\n\nSecond");
});

test("Codex command output coalescing keeps retained state bounded", function () {
  var state = {
    blockCounter: 0,
    toolBlocks: { "command-1": "block-1" },
    thinkingBlocks: {},
    thinkingLengths: {},
    commandInputs: {},
    commandOutputs: {},
  };
  var delta = "x".repeat(2048);
  var outputEvents = [];

  for (var i = 0; i < 200; i++) {
    outputEvents = outputEvents.concat(routing.flattenEvent({
      method: "item/commandExecution/outputDelta",
      params: { itemId: "command-1", delta: delta },
    }, state));
  }

  var buffer = state.commandOutputs["command-1"];
  assert.strictEqual(outputEvents.length, 200);
  assert.strictEqual(outputEvents[0].text, delta);
  assert.strictEqual(buffer.pendingLength, 0);
  assert.strictEqual(buffer.pendingChunks.length, 0);
  assert.ok(buffer.fallbackLength < delta.length * 200,
    "the completion fallback must not retain the full streamed output");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(buffer, "text"), false);

  var completed = routing.flattenEvent({
    method: "item/completed",
    params: {
      item: {
        id: "command-1",
        type: "commandExecution",
        command: "large-output",
        status: "completed",
      },
    },
  }, state);
  var result = completed.filter(function (event) {
    return event.yokeType === "tool_result";
  })[0];
  assert.match(result.content, /output truncated by Clay after 262144 characters/);
  assert.strictEqual(state.commandOutputs["command-1"], undefined);
});

test("Tool results render every image, preserve text, and expand their group", function () {
  function FakeClassList() {
    this.values = [];
  }
  FakeClassList.prototype.add = function (value) {
    if (this.values.indexOf(value) === -1) this.values.push(value);
  };
  FakeClassList.prototype.remove = function (value) {
    var index = this.values.indexOf(value);
    if (index !== -1) this.values.splice(index, 1);
  };
  FakeClassList.prototype.toggle = function (value) {
    if (this.values.indexOf(value) === -1) this.add(value);
    else this.remove(value);
  };

  function FakeElement(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.className = "";
    this.classList = new FakeClassList();
    this.textContent = "";
    this.listeners = {};
  }
  FakeElement.prototype.appendChild = function (child) {
    this.children.push(child);
    return child;
  };
  FakeElement.prototype.addEventListener = function (name, handler) {
    this.listeners[name] = handler;
  };
  FakeElement.prototype.querySelector = function () { return null; };
  FakeElement.prototype.remove = function () {};

  var sourcePath = path.join(__dirname, "../lib/public/modules/tools-results.js");
  var source = fs.readFileSync(sourcePath, "utf8")
    .replace(/^import .*$/gm, "")
    .replace(/^export /gm, "");
  var sandbox = {
    Set: Set,
    document: {
      createElement: function (tagName) { return new FakeElement(tagName); },
    },
    window: {},
    requestAnimationFrame: function (callback) {
      callback();
      return 1;
    },
    lucide: { createIcons: function () {} },
    iconHtml: function () { return ""; },
    refreshIcons: function () {},
    renderUnifiedDiff: function () {},
    renderSplitDiff: function () {},
    renderPatchDiff: function () {},
    reconstructPatchSources: function () { return { oldStr: "", newStr: "" }; },
    openFile: function () {},
  };
  vm.runInNewContext(source +
    "\nthis.toolResultsTestApi = { initToolResultTools: initToolResultTools, updateToolResult: updateToolResult };",
    sandbox);

  var header = new FakeElement("div");
  var subtitle = new FakeElement("span");
  var statusIcon = new FakeElement("span");
  var toolElement = new FakeElement("div");
  toolElement.querySelector = function (selector) {
    if (selector === ".tool-header") return header;
    if (selector === ".tool-subtitle-text") return subtitle;
    if (selector === ".tool-status-icon") return statusIcon;
    return null;
  };
  var tool = {
    name: "imagegen",
    input: {},
    el: toolElement,
    done: false,
    hasResult: false,
    groupId: "g1",
  };
  var toolGroupElement = new FakeElement("div");
  toolGroupElement.classList.add("collapsed");
  var toolGroup = {
    el: toolGroupElement,
    doneCount: 0,
    errorCount: 0,
  };
  sandbox.toolResultsTestApi.initToolResultTools({
    showImageModal: function () {},
  }, {
    getTools: function () { return { imageTool: tool }; },
    findToolGroup: function () { return toolGroup; },
  });

  sandbox.toolResultsTestApi.updateToolResult("imageTool", "Saved two previews", false, [
    { url: "/images/first.png" },
    { mediaType: "image/png", data: "c2Vjb25k" },
  ]);

  var resultBlock = toolElement.children[0];
  assert.strictEqual(resultBlock.children.length, 3);
  assert.strictEqual(resultBlock.children[0].children[0].src, "/images/first.png");
  assert.strictEqual(resultBlock.children[1].children[0].src, "data:image/png;base64,c2Vjb25k");
  assert.strictEqual(resultBlock.children[2].tagName, "pre");
  assert.strictEqual(resultBlock.children[2].textContent, "Saved two previews");
  assert.strictEqual(toolGroup.autoExpanded, true);
  assert.strictEqual(toolGroupElement.classList.values.indexOf("collapsed"), -1);
});

test("Codex item events without thread or turn identity are ignored after thread binding", function () {
  var state = { threadId: "thread-a", turnId: "turn-a" };
  var ok = routing.shouldRouteServerEvent(state, {}, "item/started", {
    item: {
      id: "shared-item",
      type: "userMessage",
    },
  });

  assert.strictEqual(ok, false);
});

test("Codex resume handle ignores pre-bind events from other threads", function () {
  var state = { threadId: null, turnId: null };
  var ok = routing.shouldRouteServerEvent(state, { resumeSessionId: "thread-a" }, "turn/started", {
    threadId: "thread-b",
    turnId: "turn-b",
  });

  assert.strictEqual(ok, false);
});

test("Codex new-thread handle ignores shared events before thread binding", function () {
  var state = { threadId: null, turnId: null };

  assert.strictEqual(routing.shouldRouteServerEvent(state, {}, "item/agentMessage/delta", {
    threadId: "thread-other",
    turnId: "turn-other",
    delta: "foreign output",
  }), false);
  assert.strictEqual(routing.shouldRouteServerEvent(state, {}, "turn/completed", {
    turn: { id: "turn-other", status: "completed" },
  }), false);
});

test("Codex context usage uses current context tokens, not cumulative total tokens", function () {
  var state = {
    _tokenUsageShapeLogged: true,
    model: "gpt-5.5",
    threadId: "thread-a",
    turnId: "turn-a",
    aborted: false,
  };

  routing.flattenEvent({
    method: "thread/tokenUsage/updated",
    params: {
      tokenUsage: {
        last: {
          inputTokens: 247000,
          outputTokens: 1200,
          totalTokens: 248200,
        },
        total: {
          inputTokens: 760000,
          outputTokens: 12000,
          totalTokens: 772000,
        },
        modelContextWindow: 258400,
      },
    },
  }, state);

  assert.strictEqual(state.lastContextUsedTokens, 247000);
  assert.strictEqual(state.contextWindowTokens, 258400);

  var events = routing.flattenEvent({
    method: "turn/completed",
    params: {
      usage: {
        input_tokens: 120,
        output_tokens: 20,
      },
    },
  }, state);
  var result = events.filter(function (event) {
    return event.yokeType === "result";
  })[0];

  assert.strictEqual(result.contextUsedTokens, 247000);
  assert.strictEqual(result.contextWindow, 258400);
});

test("Codex rate limit credits keep the account-state update out of rejected state", function () {
  var events = routing.flattenEvent({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 100,
          windowDurationMins: 10080,
          resetsAt: 1784489784,
        },
        secondary: null,
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: "500",
        },
        rateLimitReachedType: "rate_limit_reached",
      },
      rateLimitResetCredits: {
        availableCount: 4,
      },
    },
  }, makeStreamState());

  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].yokeType, "rate_limit");
  assert.strictEqual(events[0].rateLimitInfo.status, "allowed_warning");
  assert.strictEqual(events[0].rateLimitInfo.rateLimitType, "seven_day");
  assert.strictEqual(events[0].rateLimitInfo.utilization, 1);
  assert.strictEqual(events[0].rateLimitInfo.isUsingOverage, true);
});

test("Codex rate limit reached type only rejects the window it names, not the sibling window", function () {
  var events = routing.flattenEvent({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 100,
          windowDurationMins: 300,
          resetsAt: 1784489784,
        },
        secondary: {
          // No usedPercent reported for this window; previously the bare
          // truthy rateLimitReachedType check leaked the primary window's
          // rejection into this untouched 7-day window too.
          windowDurationMins: 10080,
          resetsAt: 1784999999,
        },
        credits: null,
        rateLimitReachedType: "primary",
      },
    },
  }, makeStreamState());

  assert.strictEqual(events.length, 2);
  var primaryEvent = events[0];
  var secondaryEvent = events[1];
  assert.strictEqual(primaryEvent.rateLimitInfo.rateLimitType, "five_hour");
  assert.strictEqual(primaryEvent.rateLimitInfo.status, "rejected");
  assert.strictEqual(secondaryEvent.rateLimitInfo.rateLimitType, "seven_day");
  assert.strictEqual(secondaryEvent.rateLimitInfo.status, "allowed");
});

test("Codex rate limit normalization reads the codex multi-bucket fallback", function () {
  var events = routing.flattenEvent({
    method: "account/rateLimits/updated",
    params: {
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: 1784489784,
          },
          credits: null,
        },
        codex_spark: {
          limitId: "codex_spark",
          primary: {
            usedPercent: 0,
            windowDurationMins: 10080,
            resetsAt: 1784489784,
          },
          credits: null,
        },
      },
    },
  }, makeStreamState());

  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].rateLimitInfo.status, "rejected");
  assert.strictEqual(events[0].rateLimitInfo.rateLimitType, "five_hour");
  assert.strictEqual(events[0].rateLimitInfo.isUsingOverage, false);
});

function makeStreamState() {
  return {
    blockCounter: 0,
    threadId: "thread-a",
    turnId: "turn-a",
    textBlocks: {},
    textLengths: {},
    thinkingBlocks: {},
    thinkingLengths: {},
    toolBlocks: {},
    commandInputs: {},
    planTexts: {},
    agentBlockId: null,
    agentTextLen: 0,
    agentText: "",
  };
}

function streamText(state, sequence) {
  var out = "";
  for (var i = 0; i < sequence.length; i++) {
    var events = routing.flattenEvent(sequence[i], state) || [];
    for (var j = 0; j < events.length; j++) {
      if (events[j].yokeType === "text_delta") out += events[j].text;
      if (events[j].yokeType === "text_replace") out = events[j].text;
    }
  }
  return out;
}

// Regression: Codex app-server streams agent text via item/agentMessage/delta
// AND emits item/updated/item/completed carrying the growing full text. When
// the delta event's item id can't be linked to item.id, the two paths used to
// track length under separate keys and BOTH streamed the text, producing
// per-token doubling in the chat bubble ("HelloHello  world world").
test("Codex agentMessage does not double text when deltas lack a linkable item id", function () {
  var state = makeStreamState();
  var out = streamText(state, [
    { method: "item/started", params: { item: { id: "msg1", type: "agentMessage", text: "" } } },
    { method: "item/agentMessage/delta", params: { delta: "Hello" } },
    { method: "item/updated", params: { item: { id: "msg1", type: "agentMessage", text: "Hello" } } },
    { method: "item/agentMessage/delta", params: { delta: " world" } },
    { method: "item/updated", params: { item: { id: "msg1", type: "agentMessage", text: "Hello world" } } },
    { method: "item/completed", params: { item: { id: "msg1", type: "agentMessage", text: "Hello world" } } },
  ]);
  assert.strictEqual(out, "Hello world");
});

test("Codex agentMessage streams once when deltas carry a matching itemId", function () {
  var state = makeStreamState();
  var out = streamText(state, [
    { method: "item/agentMessage/delta", params: { itemId: "msg1", delta: "Hello" } },
    { method: "item/agentMessage/delta", params: { itemId: "msg1", delta: " world" } },
    { method: "item/completed", params: { item: { id: "msg1", type: "agentMessage", text: "Hello world" } } },
  ]);
  assert.strictEqual(out, "Hello world");
});

test("Codex agentMessage trims overlapping delta tails", function () {
  var state = makeStreamState();
  var out = streamText(state, [
    { method: "item/agentMessage/delta", params: { delta: "I'm" } },
    { method: "item/agentMessage/delta", params: { delta: "I'm going" } },
    { method: "item/agentMessage/delta", params: { delta: " going to" } },
    { method: "item/agentMessage/delta", params: { delta: " to make" } },
    { method: "item/completed", params: { item: { id: "msg1", type: "agentMessage", text: "I'm going to make this" } } },
  ]);
  assert.strictEqual(out, "I'm going to make this");
});

test("Codex agentMessage reconciles a tail the deltas never streamed", function () {
  var state = makeStreamState();
  var out = streamText(state, [
    { method: "item/agentMessage/delta", params: { itemId: "msg1", delta: "Hello" } },
    // Final text is longer than what deltas delivered (dropped tail).
    { method: "item/completed", params: { item: { id: "msg1", type: "agentMessage", text: "Hello world" } } },
  ]);
  assert.strictEqual(out, "Hello world");
});

test("Codex agentMessage replaces final revised text instead of appending it", function () {
  var state = makeStreamState();
  var out = streamText(state, [
    { method: "item/agentMessage/delta", params: { delta: "No. OAuth / S" } },
    { method: "item/agentMessage/delta", params: { delta: "O flow." } },
    { method: "item/completed", params: { item: { id: "msg1", type: "agentMessage", text: "No. OAuth / SSO flow." } } },
  ]);
  assert.strictEqual(out, "No. OAuth / SSO flow.");
});

test("Codex streams two sequential agent messages in one turn without bleed", function () {
  var state = makeStreamState();
  var out = streamText(state, [
    { method: "item/agentMessage/delta", params: { delta: "First." } },
    { method: "item/completed", params: { item: { id: "msg1", type: "agentMessage", text: "First." } } },
    { method: "item/agentMessage/delta", params: { delta: "Second." } },
    { method: "item/completed", params: { item: { id: "msg2", type: "agentMessage", text: "Second." } } },
  ]);
  assert.strictEqual(out, "First.Second.");
});
