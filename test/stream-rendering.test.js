var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

test("stream batches are bounded so one animation frame cannot monopolize the UI", async function () {
  var batcher = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "stream-batcher.js")).href + "?stream-test=" + Date.now());
  var input = "x".repeat(batcher.MAX_STREAM_CHUNK_CHARS * 3 + 7);
  var first = batcher.takeStreamChunk(input);
  assert.equal(first.chunk.length, batcher.MAX_STREAM_CHUNK_CHARS);
  assert.equal(first.remaining.length, input.length - batcher.MAX_STREAM_CHUNK_CHARS);
  var second = batcher.takeStreamChunk(first.remaining);
  assert.equal(second.chunk.length, batcher.MAX_STREAM_CHUNK_CHARS);
  assert.equal(second.chunk + second.remaining, first.remaining);
});

test("live assistant streaming appends plain text and defers full Markdown rendering", function () {
  var source = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "app-rendering.js"), "utf8");
  var drainStart = source.indexOf("function drainStreamTick() {");
  var drainEnd = source.indexOf("export function flushStreamBuffer", drainStart);
  var drain = source.slice(drainStart, drainEnd);
  assert.ok(drainStart >= 0 && drainEnd > drainStart,
    "drainStreamTick should remain a bounded, inspectable unit");
  assert.match(drain, /takeStreamChunk\(streamBuffer\)/);
  assert.match(drain, /appendData/);
  assert.doesNotMatch(drain, /renderMarkdown\(/,
    "the growing reply must not be reparsed on every frame");
  assert.match(source, /contentEl\.innerHTML = renderMarkdown\(_s\.currentFullText\)/,
    "the final rich Markdown render remains in flushStreamBuffer");
});
