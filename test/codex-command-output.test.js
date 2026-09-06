var test = require("node:test");
var assert = require("node:assert/strict");
var flatten = require("../lib/yoke/adapters/codex-events").flattenEvent;

function state() {
  return { blockCounter: 0, toolBlocks: {}, thinkingBlocks: {},
    thinkingLengths: {}, commandInputs: {}, commandOutputs: {} };
}

function complete(item, current) {
  return flatten({ method: "item/completed", params: { item: Object.assign({
    id: "command-1", type: "commandExecution", command: "node --version",
    status: "completed", exitCode: 0,
  }, item) } }, current).find(function (event) { return event.yokeType === "tool_result"; });
}

// The installed app-server's CommandExecutionThreadItem schema uses
// aggregatedOutput. Output deltas are optional; the final item is authoritative.
test("Codex completed commands preserve current protocol output without deltas", function () {
  assert.equal(complete({ aggregatedOutput: "v24.1.0\n" }, state()).content, "v24.1.0\n");
});

test("Codex completed commands preserve diagnostic output on failure", function () {
  var result = complete({ status: "failed", exitCode: 1,
    aggregatedOutput: "Error: missing project instructions\n" }, state());
  assert.equal(result.content, "Error: missing project instructions\n");
  assert.equal(result.isError, true);
});

test("Codex final aggregate wins over an incomplete delta stream", function () {
  var current = state();
  flatten({ method: "item/commandExecution/outputDelta",
    params: { itemId: "command-1", delta: "partial\n" } }, current);
  assert.equal(complete({ aggregatedOutput: "partial\nfinal\n" }, current).content,
    "partial\nfinal\n");
  assert.equal(current.commandOutputs["command-1"], undefined);
});

test("Codex retains legacy aggregates and streamed output when the aggregate is absent", function () {
  assert.equal(complete({ aggregated_output: "legacy\n" }, state()).content, "legacy\n");
  assert.equal(complete({ output: "older\n" }, state()).content, "older\n");
  var current = state();
  flatten({ method: "item/commandExecution/outputDelta",
    params: { itemId: "command-1", delta: "stream only\n" } }, current);
  assert.equal(complete({ aggregatedOutput: null }, current).content, "stream only\n");
  assert.equal(complete({ aggregatedOutput: "" }, state()).content, "");
});
