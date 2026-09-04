var test = require("node:test");
var assert = require("node:assert/strict");

var formatHistoryEntry = require("../lib/clay-history-mcp-server").formatHistoryEntry;

// Persisted `tool_result` entries are recorded as
// { type, id, content, is_error } by lib/sdk-message-processor.js -- they carry
// no `name` and no `input`, which belong to `tool_executing`. read_session
// rendered both types through the `name`/`input` branch, so every tool result
// in a transcript came back as a contentless "[TOOL] " line: an orphaned
// result as far as any reader of this tool could tell.
test("a tool_result renders its content instead of an empty TOOL line", function () {
  var line = formatHistoryEntry({
    type: "tool_result",
    id: "toolu_1",
    content: "42 files scanned",
    is_error: false,
  });
  assert.ok(line.indexOf("42 files scanned") !== -1,
    "the recorded tool output must appear in the rendered line, got: " + JSON.stringify(line));
});

test("a failed tool_result is marked as an error", function () {
  var line = formatHistoryEntry({
    type: "tool_result",
    id: "toolu_2",
    content: "ENOENT: no such file",
    is_error: true,
  });
  assert.ok(line.indexOf("ENOENT: no such file") !== -1, "error output must be rendered");
  assert.ok(/error/i.test(line), "an errored result must be distinguishable, got: " + JSON.stringify(line));
});

test("tool_executing still renders its name and input", function () {
  var line = formatHistoryEntry({
    type: "tool_executing",
    id: "toolu_3",
    name: "Bash",
    input: { command: "ls -la" },
  });
  assert.ok(line.indexOf("Bash") !== -1, "the tool name must be rendered");
  assert.ok(line.indexOf("ls -la") !== -1, "the tool input must be rendered");
});

test("unrenderable and empty entries are skipped, not crashed on", function () {
  assert.equal(formatHistoryEntry({ type: "tool_start", id: "x" }), null);
  assert.equal(formatHistoryEntry(null), null);
  assert.equal(formatHistoryEntry({ type: "user_message", text: "hi" }), "[USER] hi");
});

test("oversized tool_result content is truncated", function () {
  var line = formatHistoryEntry({
    type: "tool_result",
    id: "toolu_4",
    content: new Array(3000).join("x"),
  });
  assert.ok(line.length < 1000, "a huge tool result must not be rendered in full");
  assert.ok(line.indexOf("...") !== -1, "truncation must be visible");
});
