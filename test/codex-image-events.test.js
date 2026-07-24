var test = require("node:test");
var assert = require("node:assert");

var imageEvents = require("../lib/yoke/adapters/codex-image-events");

function resultEvent(events) {
  for (var i = 0; i < events.length; i++) {
    if (events[i].yokeType === "tool_result") return events[i];
  }
  return null;
}

test("image generation result honors the declared media type", function () {
  var state = { toolBlocks: {}, blockCounter: 0 };
  var events = imageEvents.flattenImageGenerationItem(
    { id: "x1", result: "AAAA", mimeType: "image/jpeg" }, "completed", state);
  assert.strictEqual(resultEvent(events).images[0].url, "data:image/jpeg;base64,AAAA");
});

test("image generation result expands a bare format token to a MIME type", function () {
  var state = { toolBlocks: {}, blockCounter: 0 };
  var events = imageEvents.flattenImageGenerationItem(
    { id: "x2", result: "CCCC", format: "webp" }, "completed", state);
  assert.strictEqual(resultEvent(events).images[0].url, "data:image/webp;base64,CCCC");
});

test("image generation result defaults to png when no format is declared", function () {
  var state = { toolBlocks: {}, blockCounter: 0 };
  var events = imageEvents.flattenImageGenerationItem(
    { id: "x3", result: "BBBB" }, "completed", state);
  assert.strictEqual(resultEvent(events).images[0].url, "data:image/png;base64,BBBB");
});

test("an already-formed data URL result is passed through untouched", function () {
  var state = { toolBlocks: {}, blockCounter: 0 };
  var events = imageEvents.flattenImageGenerationItem(
    { id: "x4", result: "data:image/gif;base64,ZZZZ" }, "completed", state);
  assert.strictEqual(resultEvent(events).images[0].url, "data:image/gif;base64,ZZZZ");
});
