// Codex interrupted-resume history repair
// ---------------------------------------
// A daemon restart can stop between a custom tool call and its output. Codex
// persists the call first, so every later request built from that rollout logs
// a missing-output error. Resume from a filtered in-memory history instead of
// rewriting the provider's rollout on disk.

var fs = require("fs");

function parseResponseHistory(raw) {
  var lines = String(raw || "").split("\n");
  var history = [];
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    var record;
    try {
      record = JSON.parse(lines[i]);
    } catch (error) {
      // A process killed while appending may leave only the final line
      // truncated. Earlier malformed records make the history unsafe to use.
      if (i === lines.length - 1) continue;
      return null;
    }
    if (record && record.type === "response_item" && record.payload) {
      history.push(record.payload);
    }
  }
  return history;
}

function removeOrphanedCustomToolCalls(history) {
  var outputIds = {};
  var removedCallIds = [];
  for (var i = 0; i < history.length; i++) {
    var item = history[i];
    if (item && item.type === "custom_tool_call_output" && item.call_id) {
      outputIds[item.call_id] = true;
    }
  }

  var repaired = history.filter(function(item) {
    var orphaned = item && item.type === "custom_tool_call" && item.call_id && !outputIds[item.call_id];
    if (orphaned) removedCallIds.push(item.call_id);
    return !orphaned;
  });
  return { history: repaired, removedCallIds: removedCallIds };
}

async function prepareInterruptedResume(appServer, threadId) {
  var result;
  try {
    result = await appServer.send("thread/read", { threadId: threadId, includeTurns: false }, 30000);
  } catch (error) {
    return null;
  }
  var rolloutPath = result && result.thread && result.thread.path;
  if (!rolloutPath) return null;

  var raw;
  try {
    raw = await fs.promises.readFile(rolloutPath, "utf8");
  } catch (error) {
    return null;
  }
  var history = parseResponseHistory(raw);
  if (!history) return null;
  var repair = removeOrphanedCustomToolCalls(history);
  if (repair.removedCallIds.length === 0) return null;
  return repair;
}

module.exports = {
  prepareInterruptedResume: prepareInterruptedResume,
  _test: {
    parseResponseHistory: parseResponseHistory,
    removeOrphanedCustomToolCalls: removeOrphanedCustomToolCalls,
  },
};
