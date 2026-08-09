var fs = require("fs");
var path = require("path");
var config = require("./config");
var utils = require("./utils");
var { isDebateWorkerPrompt } = require("./project-debate-utils");

// Backstage machinery sessions must not surface as importable/visible
// sessions: debate moderator/panelist workers, and mate-memory digest
// sessions (first prompt "[SYSTEM: Initial Memory Summary]" / "[SYSTEM:
// Memory Summary Update]"). Their content already lives in the debate or
// the mate's memory files. (2026-08-02: 20 such rows had accumulated in
// the sidebar/import list.)
function isBackstagePrompt(text) {
  if (!text || typeof text !== "string") return false;
  if (isDebateWorkerPrompt(text)) return true;
  if (/^\s*\[SYSTEM: /.test(text)) return true;
  // Orchestrator worker briefs: workers belong nested under their
  // coordinator, never as standalone importable/adoptable sessions.
  if (/^\s*You are a bounded worker owned by a Clay coordinator\./.test(text)) return true;
  // Debate setup sessions (brief-writing skill runs)
  return /^\s*Use the \/clay-debate-setup skill/i.test(text);
}

function attachSessionCliDescriptors(ctx) {
  var cwd = ctx.cwd;
  var isValidCliSessionId = ctx.isValidCliSessionId;
  var _codexDescCache = new Map();
  var _codexThreadIndex = new Map();
  var _codexIndexBuilt = false;

  function cliSessionsDir() {
    var encodedCwd = utils.encodeCwd(cwd);
    return path.join(config.REAL_HOME, ".claude", "projects", encodedCwd);
  }

  function codexSessionsBase() {
    return path.join(config.REAL_HOME, ".codex", "sessions");
  }

  function readCodexThreadNames() {
    var idx = path.join(config.REAL_HOME, ".codex", "session_index.jsonl");
    var map = new Map();
    var raw;
    try { raw = fs.readFileSync(idx, "utf8"); } catch (e) { return map; }
    var lines = raw.split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      try {
        var ev = JSON.parse(lines[i]);
        if (ev && ev.id && typeof ev.thread_name === "string") {
          map.set(ev.id, ev.thread_name);
        }
      } catch (e) {}
    }
    return map;
  }

  function listCodexRolloutFiles() {
    var base = codexSessionsBase();
    var out = [];
    var years;
    try { years = fs.readdirSync(base); } catch (e) { years = []; }
    for (var yi = 0; yi < years.length; yi++) {
      var yDir = path.join(base, years[yi]);
      var months;
      try { months = fs.readdirSync(yDir); } catch (e) { continue; }
      for (var mi = 0; mi < months.length; mi++) {
        var mDir = path.join(yDir, months[mi]);
        var days;
        try { days = fs.readdirSync(mDir); } catch (e) { continue; }
        for (var di = 0; di < days.length; di++) {
          var dDir = path.join(mDir, days[di]);
          var files;
          try { files = fs.readdirSync(dDir); } catch (e) { continue; }
          for (var fi = 0; fi < files.length; fi++) {
            if (files[fi].indexOf("rollout-") === 0 && files[fi].endsWith(".jsonl")) {
              out.push(path.join(dDir, files[fi]));
            }
          }
        }
      }
    }

    var archivedDir = path.join(config.REAL_HOME, ".codex", "archived_sessions");
    var archived;
    try { archived = fs.readdirSync(archivedDir); } catch (e) { archived = []; }
    for (var ai = 0; ai < archived.length; ai++) {
      if (archived[ai].indexOf("rollout-") === 0 && archived[ai].endsWith(".jsonl")) {
        out.push(path.join(archivedDir, archived[ai]));
      }
    }
    return out;
  }

  function readCodexSessionDescriptor(rolloutPath) {
    var stat;
    var MAX_SCAN = 4 * 1024 * 1024;
    var CHUNK_SIZE = 128 * 1024;
    try {
      stat = fs.statSync(rolloutPath);
    } catch (e) { return null; }

    var meta = null;
    var firstUserText = null;
    var createdAtIso = null;
    var fd = null;
    var remainder = "";
    var offset = 0;
    function readCodexDescriptorLine(line) {
      if (!line) return;
      var ev;
      try { ev = JSON.parse(line); } catch (e) { return; }
      if (!ev || typeof ev !== "object") return;
      if (!meta && ev.type === "session_meta" && ev.payload) {
        meta = ev.payload;
        if (meta.timestamp) createdAtIso = meta.timestamp;
      } else if (firstUserText == null && ev.type === "event_msg" && ev.payload && ev.payload.type === "user_message" && typeof ev.payload.message === "string") {
        firstUserText = ev.payload.message;
      }
    }
    try {
      fd = fs.openSync(rolloutPath, "r");
      while (offset < stat.size && offset < MAX_SCAN && (!meta || firstUserText == null)) {
        var bytesToRead = Math.min(CHUNK_SIZE, stat.size - offset, MAX_SCAN - offset);
        var buf = Buffer.alloc(bytesToRead);
        var bytesRead = fs.readSync(fd, buf, 0, bytesToRead, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        var chunk = remainder + buf.slice(0, bytesRead).toString("utf8");
        var lines = chunk.split("\n");
        remainder = lines.pop() || "";
        for (var li = 0; li < lines.length; li++) {
          readCodexDescriptorLine(lines[li]);
          if (meta && firstUserText != null) break;
        }
      }
      if ((!meta || firstUserText == null) && remainder) readCodexDescriptorLine(remainder);
    } catch (e) {
      return null;
    } finally {
      if (fd != null) {
        try { fs.closeSync(fd); } catch (e) {}
      }
    }

    if (!meta || !meta.id) return null;
    if (meta.cwd && meta.cwd !== cwd) return null;
    if (meta.thread_source === "subagent") return null;
    if (firstUserText == null) return null;
    if (isBackstagePrompt(firstUserText)) return null;

    var title = (firstUserText || "").trim().replace(/\s+/g, " ");
    if (title.length > 60) title = title.slice(0, 57) + "...";
    if (!title) title = "Imported Codex session";

    var createdAt = Date.now();
    if (createdAtIso) {
      var t = Date.parse(createdAtIso);
      if (!isNaN(t)) createdAt = t;
    }
    var lastActivity = stat ? stat.mtimeMs : createdAt;
    var archived = rolloutPath.indexOf(path.sep + "archived_sessions" + path.sep) !== -1;
    return { cliSid: meta.id, title: title, preview: firstUserText || "", createdAt: createdAt, lastActivity: lastActivity, vendor: "codex", archived: archived };
  }

  function ensureCodexThreadIndex() {
    if (_codexIndexBuilt) return;
    _codexIndexBuilt = true;
    var files = listCodexRolloutFiles();
    for (var i = 0; i < files.length; i++) {
      cachedCodexDescriptor(files[i]);
    }
  }

  function codexThreadIndexed(threadId) {
    if (!threadId) return false;
    return _codexThreadIndex.has(threadId);
  }

  function cachedCodexDescriptor(rolloutPath) {
    var mtimeMs = 0;
    try { mtimeMs = fs.statSync(rolloutPath).mtimeMs; } catch (e) {
      _codexDescCache.delete(rolloutPath);
      return null;
    }
    var hit = _codexDescCache.get(rolloutPath);
    if (hit && hit.mtimeMs === mtimeMs) return hit.desc;
    var desc = readCodexSessionDescriptor(rolloutPath);
    _codexDescCache.set(rolloutPath, { mtimeMs: mtimeMs, desc: desc });
    if (desc && desc.cliSid) _codexThreadIndex.set(desc.cliSid, rolloutPath);
    return desc;
  }

  function findCodexRolloutByThreadId(threadId) {
    if (!threadId) return null;
    var cached = _codexThreadIndex.get(threadId);
    if (cached) {
      var cd = cachedCodexDescriptor(cached);
      if (cd && cd.cliSid === threadId) return cached;
      _codexThreadIndex.delete(threadId);
    }
    var files = listCodexRolloutFiles();
    for (var i = 0; i < files.length; i++) {
      var desc = cachedCodexDescriptor(files[i]);
      if (desc && desc.cliSid === threadId) return files[i];
    }
    return null;
  }

  function readCliSessionDescriptor(cliSid) {
    if (!isValidCliSessionId(cliSid)) return null;
    var fp = path.join(cliSessionsDir(), cliSid + ".jsonl");
    // Read in bounded chunks (like readCodexSessionDescriptor) instead of a
    // single fixed-size buffer read. A single flat read cuts a JSON line in
    // half whenever a large embedded attachment (e.g. a pasted screenshot's
    // base64 image data) straddles the read boundary, so JSON.parse silently
    // fails on that (and every later) line and the whole session looks
    // content-free — a real, often long conversation then never surfaces as
    // an import candidate. Chunked reads carry any incomplete trailing line
    // over to the next chunk so no line is ever parsed while truncated.
    var MAX_SCAN = 8 * 1024 * 1024;
    var CHUNK_SIZE = 256 * 1024;
    var stat;
    try { stat = fs.statSync(fp); } catch (e) { return null; }

    var userCount = 0;
    var assistantCount = 0;
    var firstUserText = null;
    var createdAtIso = null;
    function readClaudeDescriptorLine(line) {
      if (!line) return;
      var ev;
      try { ev = JSON.parse(line); } catch (e) { return; }
      if (!ev || typeof ev !== "object") return;
      if (ev.type === "user" && ev.message && ev.message.role === "user") {
        userCount++;
        if (firstUserText == null) {
          var c = ev.message.content;
          if (typeof c === "string") {
            firstUserText = c;
          } else if (Array.isArray(c)) {
            var parts = [];
            for (var ci = 0; ci < c.length; ci++) {
              if (c[ci] && c[ci].type === "text" && typeof c[ci].text === "string") parts.push(c[ci].text);
            }
            firstUserText = parts.join("");
          }
          if (ev.timestamp && !createdAtIso) createdAtIso = ev.timestamp;
        }
      } else if (ev.type === "assistant") {
        assistantCount++;
      }
    }

    var fd = null;
    var remainder = "";
    var offset = 0;
    try {
      fd = fs.openSync(fp, "r");
      while (offset < stat.size && offset < MAX_SCAN) {
        var bytesToRead = Math.min(CHUNK_SIZE, stat.size - offset, MAX_SCAN - offset);
        var buf = Buffer.alloc(bytesToRead);
        var bytesRead = fs.readSync(fd, buf, 0, bytesToRead, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        var chunk = remainder + buf.slice(0, bytesRead).toString("utf8");
        var lines = chunk.split("\n");
        remainder = lines.pop() || "";
        for (var li = 0; li < lines.length; li++) {
          readClaudeDescriptorLine(lines[li]);
        }
      }
      // Only the true end-of-file remainder is a complete line; a remainder
      // left over at the MAX_SCAN cutoff is mid-line and must not be parsed.
      if (offset >= stat.size && remainder) readClaudeDescriptorLine(remainder);
    } catch (e) {
      return null;
    } finally {
      if (fd != null) {
        try { fs.closeSync(fd); } catch (e) {}
      }
    }

    if (userCount === 0) return null;
    if (userCount === 1 && assistantCount === 0 && firstUserText === "hi") return null;
    if (isBackstagePrompt(firstUserText)) return null;

    var title = (firstUserText || "").trim().replace(/\s+/g, " ");
    if (title.length > 60) title = title.slice(0, 57) + "...";
    if (!title) title = "Imported CLI session";

    var createdAt = Date.now();
    if (createdAtIso) {
      var t = Date.parse(createdAtIso);
      if (!isNaN(t)) createdAt = t;
    }
    var lastActivity = stat ? stat.mtimeMs : createdAt;
    return { cliSid: cliSid, title: title, preview: firstUserText || "", createdAt: createdAt, lastActivity: lastActivity };
  }

  return {
    cliSessionsDir: cliSessionsDir,
    readCodexThreadNames: readCodexThreadNames,
    listCodexRolloutFiles: listCodexRolloutFiles,
    readCodexSessionDescriptor: readCodexSessionDescriptor,
    ensureCodexThreadIndex: ensureCodexThreadIndex,
    codexThreadIndexed: codexThreadIndexed,
    findCodexRolloutByThreadId: findCodexRolloutByThreadId,
    readCliSessionDescriptor: readCliSessionDescriptor,
  };
}

module.exports = {
  attachSessionCliDescriptors: attachSessionCliDescriptors,
};
