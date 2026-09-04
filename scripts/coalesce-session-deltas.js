#!/usr/bin/env node
// Retroactively applies the streaming-delta coalescing from
// lib/sessions-persistence.js to session history already on disk. A contiguous
// run of delta entries is rewritten as one delta holding the joined text; every
// other line is copied through byte-for-byte.
//
// Why: streaming records one delta per chunk, so a long turn lands hundreds of
// ~50-byte lines whose JSON framing costs more than their payload. The Coop
// transcript reached 218k items / 42MB that way, and the daemon parses every
// session file into the heap at startup.
//
// This is lossless for the recorded shape: only a run whose entries carry
// exactly type/text/_ts is merged, the joined text is identical to the
// concatenation every reader already performs, and the run's first timestamp is
// kept. Anything else is written through untouched.
//
// Each file it modifies is copied to ~/.clay/session-backups-<stamp>/ first,
// which sits outside the sessions directory so the daemon never loads it.
//
// Usage:
//   node scripts/coalesce-session-deltas.js --dry-run   # report only
//   node scripts/coalesce-session-deltas.js             # migrate
//   node scripts/coalesce-session-deltas.js --skip-active-seconds=600
//
// This rewrites a file by read -> transform -> rename, so anything the daemon
// appends between the read and the rename would be lost. Files written within
// SKIP_ACTIVE_SECONDS are therefore left alone: those are the ones the daemon
// is actively saving, and it already coalesces them itself on every durable
// save. That makes the migration safe to run against a live daemon; it only
// has to reach the transcripts the daemon never re-saves.

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

function mergeableDelta(entry) {
  if (!entry || entry.type !== "delta" || typeof entry.text !== "string") return false;
  var keys = Object.keys(entry);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] !== "type" && keys[i] !== "text" && keys[i] !== "_ts") return false;
  }
  return true;
}

function coalesce(lines) {
  var out = [];
  var pending = null;
  var removed = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line === "") {
      // Preserve the trailing newline exactly as the writer produced it.
      if (pending) { out.push(JSON.stringify(pending)); pending = null; }
      out.push(line);
      continue;
    }
    var obj = null;
    try { obj = JSON.parse(line); } catch (e) { obj = null; }
    if (obj && mergeableDelta(obj)) {
      if (pending) { pending.text += obj.text; removed++; }
      else {
        pending = { type: "delta", text: obj.text };
        if (obj._ts !== undefined) pending._ts = obj._ts;
      }
      continue;
    }
    if (pending) { out.push(JSON.stringify(pending)); pending = null; }
    out.push(line);
  }
  if (pending) out.push(JSON.stringify(pending));
  return { lines: out, removed: removed };
}

var files = walk(sessionsDir, []);
var totalFiles = 0, totalRemoved = 0, totalSaved = 0, skippedActive = 0;
var startedAt = Date.now();

for (var f = 0; f < files.length; f++) {
  var file = files[f];
  var sizeBefore, modifiedAt;
  try {
    var stat = fs.statSync(file);
    sizeBefore = stat.size;
    modifiedAt = stat.mtimeMs;
  } catch (e) { continue; }

  if (skipActiveMs > 0 && startedAt - modifiedAt < skipActiveMs) {
    skippedActive++;
    continue;
  }

  var raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) {
    console.warn("skip (unreadable): " + file + " — " + e.message);
    continue;
  }

  var result = coalesce(raw.split("\n"));
  if (!result.removed) continue;

  totalFiles++;
  totalRemoved += result.removed;

  var rel = path.relative(sessionsDir, file);
  if (dryRun) {
    console.log("would drop " + result.removed + " delta line(s): " + rel);
    continue;
  }

  var dst = path.join(backupDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(file, dst);

  var tmp = file + ".coalesce.tmp";
  fs.writeFileSync(tmp, result.lines.join("\n"));
  try { fs.chmodSync(tmp, 0o600); } catch (e) {}
  fs.renameSync(tmp, file);

  totalSaved += sizeBefore - fs.statSync(file).size;
  console.log("coalesced " + result.removed + " delta line(s): " + rel);
}

console.log("");
console.log((dryRun ? "[dry run] would drop " : "dropped ") + totalRemoved +
  " delta line(s) across " + totalFiles + " file(s)");
if (skippedActive) {
  console.log("skipped " + skippedActive + " recently-written file(s); the daemon " +
    "coalesces those itself on its next durable save");
}
if (!dryRun && totalFiles) {
  console.log("reclaimed " + (totalSaved / (1024 * 1024)).toFixed(1) + " MB");
  console.log("originals backed up to " + backupDir);
}
