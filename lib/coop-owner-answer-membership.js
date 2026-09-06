// Older automated answers predate the explicit conversation marker. Keep only
// answers whose durable UUID still resolves on this canonical lineage. Never
// use a stale numeric response offset to recover a different turn.
var resolution = require("./coop-owner-response-resolution");
var ownerRequests = require("./coop-owner-requests");

function indexes(view, topicRef, suppliedLedger) {
  var history = view && view.history || [];
  var entries = view && view.entries || [];
  var ledger = suppliedLedger || ownerRequests.getDefaultOwnerRequests();
  var records = ledger && ledger.list ? ledger.list() : [];
  var kept = Object.create(null);
  var scoped = false;
  history.forEach(function (item, index) {
    if (!item) return;
    if (item.type === "user_message" && item.compactedRetry !== true || item.type === "done") scoped = false;
    if (scoped && (item.type === "delta" || item.type === "delta_replace")) kept[index] = true;
    if (item.coopOwnerResponseStartsAfter === true) {
      scoped = !topicRef || (item.coopOwnerResponseTopicRefs || []).some(function (ref) {
        return ref.topicId === topicRef.topicId;
      });
    }
  });
  records.forEach(function (record) {
    if (topicRef && (!record.topicRef || record.topicRef.topicId !== topicRef.topicId)) return;
    var response = record.response;
    var ref = response && response.responseRef;
    if (!response || response.state !== "answered" || !ref ||
        ref.projectId !== "system-lead" || !ref.messageUuid) return;
    var end = resolution.resolveDoneByAnchor(history, ref.messageUuid);
    if (end < 0 || !entries[end] || entries[end].sessionStorageId !== ref.sessionStorageId || history[end].code) return;
    for (var i = end - 1; i >= 0 && entries[i] && entries[i].sessionStorageId === ref.sessionStorageId; i--) {
      var item = history[i];
      if (!item || item.type === "user_message" || item.type === "done") break;
      // Preserve the actual final assistant message, including its chunks.
      // Earlier execution commentary in the same turn remains internal.
      if (item.type === "tool_start" || item.type === "tool_result" || item.type === "tool_executing") break;
      if (item.type === "delta" || item.type === "delta_replace") kept[i] = true;
    }
  });
  return Object.keys(kept).map(Number).sort(function (a, b) { return a - b; });
}

module.exports = { indexes: indexes };
