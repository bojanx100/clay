var fs = require("fs");
var path = require("path");
var readline = require("readline");
var utils = require("./utils");
var { REAL_HOME } = require("./config");
var instructions = require("./yoke/instructions");
var bridgeRecovery = require("./sdk-bridge-recovery");

var encodeCwd = utils.encodeCwd;

/**
 * Read bounded Claude transcript metadata shared with the import picker.
 * Returns null if the file can't be parsed or has no user messages.
 */
function parseSessionFile(filePath) {
  var descriptor = require("./claude-session-descriptor").read(filePath);
  if (!descriptor) return Promise.resolve(null);
  return Promise.resolve({
    sessionId: descriptor.cliSid, firstPrompt: descriptor.preview.slice(0, 100),
    title: descriptor.title, model: descriptor.model, gitBranch: descriptor.gitBranch,
    startTime: new Date(descriptor.createdAt).toISOString(),
    lastActivity: new Date(descriptor.lastActivity).toISOString(),
  });
}

/**
 * List CLI sessions for a given project directory.
 * Reads ~/.claude/projects/{encoded-cwd}/ and parses JSONL metadata.
 * Returns array sorted by lastActivity descending (most recent first).
 */
function listCliSessions(cwd) {
  var encoded = encodeCwd(cwd);
  var projectDir = path.join(REAL_HOME, ".claude", "projects", encoded);

  return new Promise(function (resolve) {
    fs.readdir(projectDir, { withFileTypes: true }, function (err, entries) {
      if (err) return resolve([]);

      var jsonlFiles = [];
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isFile() && entries[i].name.endsWith(".jsonl")) {
          jsonlFiles.push(path.join(projectDir, entries[i].name));
        }
      }

      if (jsonlFiles.length === 0) return resolve([]);

      var next = 0;
      var results = [];

      function readNext() {
        parseSessionFile(jsonlFiles[next++]).then(function (session) {
          if (session) results.push(session);
          if (next === jsonlFiles.length) {
            results.sort(function (a, b) {
              var ta = a.lastActivity || "";
              var tb = b.lastActivity || "";
              return ta < tb ? 1 : ta > tb ? -1 : 0;
            });
            resolve(results);
          } else {
            // Metadata reads are bounded but synchronous; let sockets and UI
            // requests run between files when a project has years of history.
            setImmediate(readNext);
          }
        });
      }
      readNext();
    });
  });
}

/**
 * Get the most recent CLI session for a given project directory.
 * Returns the session object or null if none found.
 */
function getMostRecentCliSession(cwd) {
  return listCliSessions(cwd).then(function (sessions) {
    return sessions.length > 0 ? sessions[0] : null;
  });
}

/**
 * Extract user message text from a CLI JSONL content field.
 * Content can be a string or an array of content blocks.
 */
function extractText(content) {
  return require("./claude-session-record").text(content);
}

var appendCliRecord = require("./claude-session-record").appendHistory;

function readCliSessionHistory(home, cwd, sessionId) {
  var encoded = encodeCwd(cwd);
  var filePath = path.join(home || REAL_HOME, ".claude", "projects", encoded, sessionId + ".jsonl");

  return new Promise(function (resolve) {
    var history = [];
    var stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: "utf8" });
    } catch (e) {
      return resolve([]);
    }

    var rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    var state = { toolCounter: 0 };

    rl.on("line", function (line) {
      var obj;
      try { obj = JSON.parse(line); } catch (e) { return; }
      appendCliRecord(obj, state, history);
    });

    rl.on("close", function () {
      resolve(history);
    });

    rl.on("error", function () {
      resolve([]);
    });

    stream.on("error", function () {
      rl.close();
      resolve([]);
    });
  });
}

// Synchronous variant for callers that run inside a synchronous request
// handler (e.g. switch_session, which must populate session.history before
// the session_switched broadcast). This still reads the full transcript when
// hydration is required; unchanged-history metadata checks must stay bounded.
// Modified-time (ms) of a CLI session's jsonl, or 0 if missing. Lets callers
// cheaply detect that the transcript grew (e.g. after a TUI turn) and re-read.
function cliSessionFileMtime(home, cwd, sessionId) {
  var encoded = encodeCwd(cwd);
  var filePath = path.join(home || REAL_HOME, ".claude", "projects", encoded, sessionId + ".jsonl");
  try { return fs.statSync(filePath).mtimeMs; } catch (e) { return 0; }
}

function readCliSessionHistorySync(home, cwd, sessionId) {
  var encoded = encodeCwd(cwd);
  var filePath = path.join(home || REAL_HOME, ".claude", "projects", encoded, sessionId + ".jsonl");
  var raw;
  try { raw = fs.readFileSync(filePath, "utf8"); } catch (e) { return []; }
  var history = [];
  var state = { toolCounter: 0 };
  var lines = raw.split("\n");
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    var obj;
    try { obj = JSON.parse(lines[i]); } catch (e) { continue; }
    appendCliRecord(obj, state, history);
  }
  return history;
}

// Find the Codex rollout file for a thread id by scanning both the dated tree
// and the archived_sessions/ directory. Returns absolute path or null.
function findCodexRolloutPath(home, threadId, expectedCwd) {
  if (!threadId) return null;
  var base = path.join(home || REAL_HOME, ".codex", "sessions");
  var candidates = [];
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
          if (files[fi].indexOf("rollout-") === 0 && files[fi].endsWith(".jsonl") && files[fi].indexOf(threadId) !== -1) {
            candidates.push(path.join(dDir, files[fi]));
          }
        }
      }
    }
  }
  var archived = path.join(home || REAL_HOME, ".codex", "archived_sessions");
  var aFiles;
  try { aFiles = fs.readdirSync(archived); } catch (e) { aFiles = []; }
  for (var ai = 0; ai < aFiles.length; ai++) {
    if (aFiles[ai].indexOf("rollout-") === 0 && aFiles[ai].endsWith(".jsonl") && aFiles[ai].indexOf(threadId) !== -1) {
      candidates.push(path.join(archived, aFiles[ai]));
    }
  }
  // Confirm the session_meta payload matches before returning
  for (var ci = 0; ci < candidates.length; ci++) {
    try {
      var ev = require("./jsonl-first-record").read(candidates[ci]);
      if (ev && ev.type === "session_meta" && ev.payload && ev.payload.id === threadId) {
        if (!expectedCwd || !ev.payload.cwd || ev.payload.cwd === expectedCwd) {
          return candidates[ci];
        }
      }
    } catch (e) { /* skip */ }
  }
  return null;
}

function codexRolloutMtime(home, threadId, expectedCwd) {
  var p = findCodexRolloutPath(home, threadId, expectedCwd);
  if (!p) return 0;
  try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; }
}

// Synchronously read a Codex rollout and synthesize a minimal Clay history of
// owner messages with image attachments and assistant text. Tool calls, exec
// output, reasoning and patch_apply events are not part of this conversation reader.
function readCodexHistorySync(home, threadId, expectedCwd) {
  var p = findCodexRolloutPath(home, threadId, expectedCwd);
  if (!p) return [];
  var raw;
  try { raw = fs.readFileSync(p, "utf8"); } catch (e) { return []; }
  var history = [];
  var completedIds = new Set();
  var lines = raw.split("\n");
  function eventTs(ev) {
    var t = ev && ev.timestamp ? Date.parse(ev.timestamp) : NaN;
    return isNaN(t) ? Date.now() : t;
  }
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    var ev;
    try { ev = JSON.parse(lines[i]); } catch (e) { continue; }
    if (!ev || ev.type !== "event_msg" || !ev.payload) continue;
    var p2 = ev.payload;
    var completed = require("./codex-rollout-message").completedMessage(ev, threadId);
    if (completed) {
      if (completed.id && completedIds.has(completed.id)) continue;
      if (completed.id) completedIds.add(completed.id);
      p2 = { type: completed.role === "user" ? "user_message" : "agent_message",
        message: completed.text, imageContent: completed.imageContent };
    }
    if (p2.type === "user_message" && typeof p2.message === "string") {
      // The rollout records what the MODEL received. Strip the Clay-injected
      // project-instructions block (codex.js prepends it to a conversation's
      // first message) and map known synthetic prompts back to their display
      // labels, so imports show what the user actually saw — not the raw
      // "--- Instructions from CLAUDE.md ---" + resume-prompt composition.
      var text = instructions.stripInjectedInstructions(p2.message, expectedCwd, "codex");
      if (text === bridgeRecovery.RESUME_AFTER_INTERRUPT_PROMPT) {
        text = bridgeRecovery.RESUME_DISPLAY_LABEL;
      }
      var attachments = require("./codex-rollout-images").read(p2);
      if (attachments.unavailable.length) text += (text ? "\n\n" : "") + attachments.unavailable.map(function (name) {
        return "[Image attachment unavailable: " + name + "]";
      }).join("\n");
      if (text || attachments.images.length) {
        var ownerEvent = { type: "user_message", text: text, _ts: eventTs(ev) };
        if (attachments.images.length) ownerEvent.images = attachments.images;
        history.push(ownerEvent);
      }
    } else if (p2.type === "agent_message" && typeof p2.message === "string") {
      var ts = eventTs(ev);
      history.push({ type: "delta", text: p2.message, _ts: ts });
      history.push({ type: "done", code: 0, _ts: ts + 1 });
    }
  }
  return history;
}

module.exports = {
  HISTORY_FORMAT_VERSION: 2,
  listCliSessions: listCliSessions,
  getMostRecentCliSession: getMostRecentCliSession,
  readCliSessionHistory: readCliSessionHistory,
  readCliSessionHistorySync: readCliSessionHistorySync,
  cliSessionFileMtime: cliSessionFileMtime,
  codexRolloutMtime: codexRolloutMtime,
  readCodexHistorySync: readCodexHistorySync,
  parseSessionFile: parseSessionFile,
  encodeCwd: encodeCwd,
  extractText: extractText,
};
