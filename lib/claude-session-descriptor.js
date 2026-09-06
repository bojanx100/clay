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
  var sdkSession = false;
  var lastMessageAt = 0;
  function consume(line, metadataOnly) {
    var event;
    try { event = JSON.parse(line); } catch (e) { return; }
    if (!event || typeof event !== "object") return;
    if (event.type === "user" || event.type === "assistant") {
      if (event.entrypoint === "sdk-ts" || event.promptSource === "sdk") sdkSession = true;
      var messageAt = Date.parse(event.timestamp);
      if (Number.isFinite(messageAt) && messageAt > lastMessageAt) lastMessageAt = messageAt;
    }
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
      // Keep scanning replied greetings until another owner turn establishes
      // real work. Ordinary conversations only need the head and metadata tail.
      if (!metadataOnly && first !== null && (userCount > 1 ||
          (assistantCount && !/^hi[?!,.]*$/i.test(first.trim())))) break;
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
  if (!Number.isFinite(at)) at = stat.birthtimeMs || stat.mtimeMs;
  return {
    cliSid: path.basename(file, ".jsonl"), vendor: "claude", model: model,
    title: title || "Image attachment", preview: first,
    createdAt: at, lastActivity: lastMessageAt || at,
    autoAdoptable: !sdkSession && !(userCount === 1 && /^hi[?!,.]*$/i.test(first.trim())),
    gitBranch: branch, userCount: userCount, assistantCount: assistantCount,
  };
}

module.exports = { read: read };
