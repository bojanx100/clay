var fs = require("fs");
var path = require("path");
var StringDecoder = require("string_decoder").StringDecoder;
var record = require("./claude-session-record");
var MAX_SCAN = 8 * 1024 * 1024;
var TAIL_SCAN = 512 * 1024;
var PREVIEW_CHARS = 800;

function read(file) {
  var stat;
  var fd;
  try { stat = fs.statSync(file); fd = fs.openSync(file, "r"); } catch (e) { return null; }
  var first = null;
  var userCount = 0;
  var assistantCount = 0;
  var createdAt = null;
  var model = null;
  var branch = null;
  var aiTitle = null;
  var customTitle = null;
  function consume(line, metadataOnly) {
    var event;
    try { event = JSON.parse(line); } catch (e) { return; }
    if (!event || typeof event !== "object") return;
    if (event.type === "custom-title" && typeof event.customTitle === "string") customTitle = event.customTitle;
    if (event.type === "ai-title" && typeof event.aiTitle === "string") aiTitle = event.aiTitle;
    if (event.message && event.message.role === "assistant") {
      if (!metadataOnly) assistantCount++;
      if (typeof event.message.model === "string" && event.message.model !== "<synthetic>") model = event.message.model;
    }
    if (metadataOnly) return;
    var owner = record.ownerMessage(event);
    if (!owner) return;
    userCount++;
    if (first !== null) return;
    first = owner.text.slice(0, PREVIEW_CHARS);
    branch = event.gitBranch || null;
    createdAt = event.timestamp || null;
  }
  function scan(start, end, metadataOnly) {
    var decoder = new StringDecoder("utf8");
    var remainder = "";
    var skipPartial = start > 0;
    var buffer = Buffer.alloc(256 * 1024);
    var offset = start;
    while (offset < end) {
      var count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
      if (!count) break;
      offset += count;
      var lines = (remainder + decoder.write(buffer.subarray(0, count))).split("\n");
      remainder = lines.pop();
      lines.forEach(function (line) {
        if (skipPartial) { skipPartial = false; return; }
        consume(line, metadataOnly);
      });
      // Once a conversation is established, only its tail is needed for later
      // title/model changes. Keep scanning lone probes to recognize "hi" stubs.
      if (!metadataOnly && first !== null && (assistantCount || userCount > 1)) break;
    }
    if (offset >= stat.size && !skipPartial) consume(remainder + decoder.end(), metadataOnly);
    return offset;
  }
  try {
    var headEnd = scan(0, Math.min(stat.size, MAX_SCAN), false);
    if (stat.size > headEnd) scan(Math.max(0, stat.size - TAIL_SCAN), stat.size, true);
  } catch (e) { return null; }
  finally { fs.closeSync(fd); }
  if (!userCount) return null;
  var title = (customTitle || aiTitle || "").trim();
  if (!title) {
    title = first.trim().replace(/\s+/g, " ");
    if (title.length > 60) title = title.slice(0, 57) + "...";
  }
  var at = Date.parse(createdAt);
  return {
    cliSid: path.basename(file, ".jsonl"), vendor: "claude", model: model,
    title: title || "Image attachment", preview: first,
    createdAt: Number.isFinite(at) ? at : stat.birthtimeMs || stat.mtimeMs,
    lastActivity: stat.mtimeMs, gitBranch: branch, userCount: userCount, assistantCount: assistantCount,
  };
}

module.exports = { read: read };
