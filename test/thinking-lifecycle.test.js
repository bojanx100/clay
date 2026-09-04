var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function readPublicModule(name) {
  return fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", name), "utf8");
}

test("new thinking blocks close any already-open thinking row before replacing state", function () {
  var source = readPublicModule("tools-thinking.js");
  var startThinkingMatch = source.match(/export function startThinking\(\) \{[\s\S]*?if \(thinkingGroup && thinkingGroup\.el\.classList\.contains\("done"\)\)/);

  assert.ok(startThinkingMatch, "startThinking should keep the reuse branch");
  assert.match(startThinkingMatch[0], /if \(currentThinking\) \{\s*stopThinking\(\);\s*thinkingGroup = null;\s*\}/);
});

test("idle history replay clears stale thinking and activity indicators", function () {
  var source = readPublicModule("app-messages-history.js");
  var idleCleanupMatch = source.match(/if \(!store\.get\('sessionIsProcessing'\)\) \{[\s\S]*?applyDeadSessionTodoCompaction\(\);[\s\S]*?\}/);

  assert.ok(idleCleanupMatch, "history_done should have an idle cleanup block");
  assert.match(idleCleanupMatch[0], /removeMatePreThinking\(\);/);
  assert.match(idleCleanupMatch[0], /setActivity\(null\);/);
  assert.match(idleCleanupMatch[0], /stopThinking\(\);/);
});

test("authoritative user echoes clear stale activity before starting a new visible turn", function () {
  var source = readPublicModule("app-messages-stream.js");
  var userMessageMatch = source.match(/function handleUserMessage\(msg\) \{[\s\S]*?resetThinkingGroup\(\);/);

  assert.ok(userMessageMatch, "handleUserMessage should reset the visible turn state");
  assert.match(userMessageMatch[0], /removeMatePreThinking\(\);\s*setActivity\(null\);\s*resetThinkingGroup\(\);/);
});
