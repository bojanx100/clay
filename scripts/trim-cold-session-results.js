#!/usr/bin/env node
// Retention pass for cold transcripts: caps stored tool_result bodies in
// sessions nobody has touched for a while.
//
// Why: tool_result is 65% of all session bytes (456MB of 706MB measured), and
// the live cap in lib/sdk-message-processor.js is 256KB per result. That cap
// exists to stop one runaway result from OOM-ing the daemon, not to bound how
// much a finished conversation keeps forever. A transcript nobody is reading
// does not need full tool bodies; it needs to stay loadable and readable.
//
// What is preserved: every entry, in order, with its type and metadata. Only
// the `content` string of an oversized tool_result in a cold session is
// shortened, and it is marked so the truncation is visible rather than implied.
// Conversation text -- user messages and assistant deltas -- is never touched.
//
// Age comes from the session's own meta.lastActivity, NOT the file mtime: any
// maintenance pass (including this one) rewrites files and would otherwise make
// every transcript look brand new.
//
// Usage:
//   node scripts/trim-cold-session-results.js --dry-run
//   node scripts/trim-cold-session-results.js --older-than-days=30 --cap-bytes=8192
//
// Files written within --skip-active-seconds are skipped: the daemon may be
// saving them, and this rewrites by read -> transform -> rename.

var fs = require("fs");
var os = require("os");
var path = require("path");

var dryRun = process.argv.indexOf("--dry-run") !== -1;

function numericFlag(name, fallback) {
  var argv = process.argv;
  for (var i = 0; i < argv.length; i++) {
    if (argv[i].indexOf(name + "=") !== 0) continue;
    var parsed = Number(argv[i].slice(name.length + 1));
    if (isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

var olderThanMs = numericFlag("--older-than-days", 30) * 86400000;
var capBytes = numericFlag("--cap-bytes", 8192);
var skipActiveMs = numericFlag("--skip-active-seconds", 300) * 1000;

var sessionsDir = path.join(os.homedir(), ".clay", "sessions");
var backupDir = path.join(os.homedir(), ".clay",
  "session-backups-" + new Date().toISOString().replace(/[:.]/g, "-"));

function walk(dir, out) {
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (var i = 0; i < entries.length; i++) {
    var full = path.join(dir, entries[i].name);
    if (entries[i].isDirectory()) walk(full, out);
    else if (entries[i].name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

// The transcript's own idea of when it was last used. Falls back to createdAt,
// and treats an unreadable meta as "unknown age" so the session is left alone.
function lastActivityOf(firstLine) {
  var meta;
  try { meta = JSON.parse(firstLine); } catch (e) { return null; }
  if (!meta || meta.type !== "meta") return null;
  var value = meta.lastActivity || meta.createdAt;
  return typeof value === "number" && value > 0 ? value : null;
}

function trimLines(lines, startedAt) {
  var out = [];
  var trimmed = 0;
  var reclaimed = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line === "") { out.push(line); continue; }
    var obj = null;
    try { obj = JSON.parse(line); } catch (e) { obj = null; }
    if (!obj || obj.type !== "tool_result" || typeof obj.content !== "string" ||
        obj.content.length <= capBytes) {
      out.push(line);
      continue;
    }
    var dropped = obj.content.length - capBytes;
    obj.content = obj.content.slice(0, capBytes) +
      "\n\n[Clay trimmed " + dropped + " characters of tool output from this cold session on " +
      new Date(startedAt).toISOString().slice(0, 10) + "]";
    out.push(JSON.stringify(obj));
    trimmed++;
    reclaimed += dropped;
  }
  return { lines: out, trimmed: trimmed, reclaimed: reclaimed };
}

var files = walk(sessionsDir, []);
var startedAt = Date.now();
var touchedFiles = 0, totalTrimmed = 0, totalSaved = 0;
var skippedActive = 0, skippedWarm = 0, skippedUnknown = 0;

for (var f = 0; f < files.length; f++) {
  var file = files[f];
  var stat;
  try { stat = fs.statSync(file); } catch (e) { continue; }

  if (skipActiveMs > 0 && startedAt - stat.mtimeMs < skipActiveMs) {
    skippedActive++;
    continue;
  }

  var raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) {
    console.warn("skip (unreadable): " + file + " — " + e.message);
    continue;
  }

  var lines = raw.split("\n");
  var lastActivity = lastActivityOf(lines[0]);
  if (lastActivity === null) { skippedUnknown++; continue; }
  if (startedAt - lastActivity < olderThanMs) { skippedWarm++; continue; }

  var result = trimLines(lines, startedAt);
  if (!result.trimmed) continue;

  touchedFiles++;
  totalTrimmed += result.trimmed;

  var rel = path.relative(sessionsDir, file);
  if (dryRun) {
    console.log("would trim " + result.trimmed + " result(s), " +
      (result.reclaimed / 1e6).toFixed(1) + " MB: " + rel);
    totalSaved += result.reclaimed;
    continue;
  }

  var dst = path.join(backupDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(file, dst);

  var sizeBefore = stat.size;
  var tmp = file + ".trim.tmp";
  fs.writeFileSync(tmp, result.lines.join("\n"));
  try { fs.chmodSync(tmp, 0o600); } catch (e) {}
  fs.renameSync(tmp, file);

  totalSaved += sizeBefore - fs.statSync(file).size;
  console.log("trimmed " + result.trimmed + " result(s): " + rel);
}

console.log("");
console.log((dryRun ? "[dry run] would trim " : "trimmed ") + totalTrimmed +
  " tool_result(s) across " + touchedFiles + " file(s)");
console.log("reclaimed " + (totalSaved / (1024 * 1024)).toFixed(1) + " MB" +
  " (cap " + capBytes + " bytes, older than " + (olderThanMs / 86400000) + " days)");
console.log("skipped: " + skippedWarm + " still-warm, " + skippedActive +
  " recently-written, " + skippedUnknown + " with no readable meta");
if (!dryRun && touchedFiles) console.log("originals backed up to " + backupDir);
