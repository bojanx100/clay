var fs = require("fs");
var path = require("path");
var config = require("./config");
var utils = require("./utils");
var { isDebateWorkerPrompt } = require("./project-debate-utils");

var CODEX_CATALOG_TTL_MS = 60 * 1000;
var CODEX_PREVIEW_CHARS = 800;
var sharedCodexDescriptorCache = new Map();
var sharedCodexCatalog = {
  home: null,
  builtAt: 0,
  byCwd: new Map(),
  unscoped: [],
};

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

function copiedTextPrefix(value, maxChars) {
  var source = typeof value === "string" ? value : "";
  var length = Math.min(source.length, maxChars);
  var chars = new Array(length);
  for (var i = 0; i < length; i++) chars[i] = source.charAt(i);
  return chars.join("");
}

// Decode only the prefix Clay displays from a JSON string. Codex's first user
// message can contain megabytes of injected instructions, so JSON.parse on the
// whole event creates correspondingly large temporary strings and objects.
function decodeJsonStringPrefix(line, quoteIndex, maxChars) {
  if (line.charAt(quoteIndex) !== '"') return null;
  var chars = [];
  for (var i = quoteIndex + 1; i < line.length && chars.length < maxChars; i++) {
    var ch = line.charAt(i);
    if (ch === '"') return chars.join("");
    if (ch !== "\\") {
      chars.push(ch);
      continue;
    }
    i++;
    if (i >= line.length) return null;
    var escaped = line.charAt(i);
    if (escaped === '"' || escaped === "\\" || escaped === "/") chars.push(escaped);
    else if (escaped === "b") chars.push("\b");
    else if (escaped === "f") chars.push("\f");
    else if (escaped === "n") chars.push("\n");
    else if (escaped === "r") chars.push("\r");
    else if (escaped === "t") chars.push("\t");
    else if (escaped === "u") {
      var hex = line.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      chars.push(String.fromCharCode(parseInt(hex, 16)));
      i += 4;
    } else return null;
  }
  return chars.join("");
}

function readCodexUserMessagePrefix(line) {
  var eventType = /"type"\s*:\s*"event_msg"/g;
  var eventMatch = eventType.exec(line);
  if (!eventMatch) return null;
  var userType = /"type"\s*:\s*"user_message"/g;
  userType.lastIndex = eventMatch.index + eventMatch[0].length;
  var userMatch = userType.exec(line);
  if (!userMatch) return null;
  var messageField = /"message"\s*:\s*"/g;
  messageField.lastIndex = userMatch.index + userMatch[0].length;
  var messageMatch = messageField.exec(line);
  if (!messageMatch) return null;
  return decodeJsonStringPrefix(line,
    messageMatch.index + messageMatch[0].length - 1, CODEX_PREVIEW_CHARS);
}

function codexSessionsBase() {
  return path.join(config.REAL_HOME, ".codex", "sessions");
}

function listCodexRolloutFilesFromDisk() {
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

function parseCodexSessionDescriptor(rolloutPath, stat) {
  var MAX_SCAN = 4 * 1024 * 1024;
  var CHUNK_SIZE = 128 * 1024;
  var meta = null;
  var firstUserText = null;
  var createdAtIso = null;
  var fd = null;
  var remainder = "";
  var offset = 0;
  function readCodexDescriptorLine(line) {
    if (!line) return;
    if (!meta && /"type"\s*:\s*"session_meta"/.test(line)) {
      var ev;
      try { ev = JSON.parse(line); } catch (e) { return; }
      if (ev && ev.type === "session_meta" && ev.payload) {
        meta = ev.payload;
        if (meta.timestamp) createdAtIso = meta.timestamp;
      }
    }
    if (firstUserText == null) {
      var preview = readCodexUserMessagePrefix(line);
      if (preview != null) firstUserText = preview;
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

  if (!meta || !meta.id || meta.thread_source === "subagent" || firstUserText == null) return null;
  if (isBackstagePrompt(firstUserText)) return null;
  // Copy, rather than slice, so a short preview cannot retain the backing
  // storage of a multi-megabyte injected prompt in the process-wide cache.
  var preview = copiedTextPrefix(firstUserText, CODEX_PREVIEW_CHARS);
  var title = preview.trim().replace(/\s+/g, " ");
  if (title.length > 60) title = title.slice(0, 57) + "...";
  if (!title) title = "Imported Codex session";
  var createdAt = Date.now();
  if (createdAtIso) {
    var time = Date.parse(createdAtIso);
    if (!isNaN(time)) createdAt = time;
  }
  return {
    cwd: meta.cwd || null,
    desc: {
      cliSid: meta.id,
      title: title,
      // The picker truncates this to 800 characters and handoff detection only
      // reads the first 400. Retaining multi-megabyte injected prompts for every
      // rollout would turn the shared catalog into another startup heap spike.
      preview: preview,
      createdAt: createdAt,
      lastActivity: stat.mtimeMs || createdAt,
      vendor: "codex",
      archived: rolloutPath.indexOf(path.sep + "archived_sessions" + path.sep) !== -1,
    },
  };
}

function sharedCodexDescriptor(rolloutPath) {
  var stat;
  try { stat = fs.statSync(rolloutPath); } catch (e) {
    sharedCodexDescriptorCache.delete(rolloutPath);
    return null;
  }
  var hit = sharedCodexDescriptorCache.get(rolloutPath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
  var value = parseCodexSessionDescriptor(rolloutPath, stat);
  sharedCodexDescriptorCache.set(rolloutPath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    value: value,
  });
  return value;
}

function refreshSharedCodexCatalog(force) {
  var now = Date.now();
  if (sharedCodexCatalog.home === config.REAL_HOME && sharedCodexCatalog.builtAt &&
      !force && (now - sharedCodexCatalog.builtAt) < CODEX_CATALOG_TTL_MS) {
    return sharedCodexCatalog;
  }
  if (sharedCodexCatalog.home !== config.REAL_HOME) sharedCodexDescriptorCache.clear();
  var files = listCodexRolloutFilesFromDisk();
  var byCwd = new Map();
  var unscoped = [];
  var livePaths = new Set();
  for (var i = 0; i < files.length; i++) {
    livePaths.add(files[i]);
    var raw = sharedCodexDescriptor(files[i]);
    if (!raw || !raw.desc || !raw.desc.cliSid) continue;
    var record = { path: files[i], desc: raw.desc };
    if (!raw.cwd) {
      unscoped.push(record);
      continue;
    }
    var records = byCwd.get(raw.cwd);
    if (!records) {
      records = [];
      byCwd.set(raw.cwd, records);
    }
    records.push(record);
  }
  sharedCodexDescriptorCache.forEach(function (_entry, filePath) {
    if (!livePaths.has(filePath)) sharedCodexDescriptorCache.delete(filePath);
  });
  sharedCodexCatalog = {
    home: config.REAL_HOME,
    builtAt: now,
    byCwd: byCwd,
    unscoped: unscoped,
  };
  return sharedCodexCatalog;
}

function attachSessionCliDescriptors(ctx) {
  var cwd = ctx.cwd;
  var isValidCliSessionId = ctx.isValidCliSessionId;
  var _codexThreadIndex = new Map();
  var _codexIndexBuilt = false;

  function cliSessionsDir() {
    var encodedCwd = utils.encodeCwd(cwd);
    return path.join(config.REAL_HOME, ".claude", "projects", encodedCwd);
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
    return listCodexRolloutFilesFromDisk();
  }

  function readCodexSessionDescriptor(rolloutPath) {
    var raw = sharedCodexDescriptor(rolloutPath);
    if (!raw || (raw.cwd && raw.cwd !== cwd)) return null;
    return raw.desc;
  }

  function loadCodexThreadIndex(force) {
    var catalog = refreshSharedCodexCatalog(force);
    _codexThreadIndex.clear();
    var records = catalog.unscoped.concat(catalog.byCwd.get(cwd) || []);
    for (var i = 0; i < records.length; i++) {
      _codexThreadIndex.set(records[i].desc.cliSid, records[i].path);
    }
    _codexIndexBuilt = true;
  }

  function ensureCodexThreadIndex() {
    if (_codexIndexBuilt) return;
    loadCodexThreadIndex(false);
  }

  function codexThreadIndexed(threadId) {
    if (!threadId) return false;
    return _codexThreadIndex.has(threadId);
  }

  function cachedCodexDescriptor(rolloutPath) {
    var desc = readCodexSessionDescriptor(rolloutPath);
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
    loadCodexThreadIndex(true);
    var refreshed = _codexThreadIndex.get(threadId);
    if (refreshed) {
      var refreshedDesc = cachedCodexDescriptor(refreshed);
      if (refreshedDesc && refreshedDesc.cliSid === threadId) return refreshed;
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
