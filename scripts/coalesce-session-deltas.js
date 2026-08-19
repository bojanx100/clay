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
//
// Stop the daemon before migrating, or it may re-save a file from memory mid-run.

var fs = require("fs");
var os = require("os");
var path = require("path");

var dryRun = process.argv.indexOf("--dry-run") !== -1;
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
var totalFiles = 0, totalRemoved = 0, totalSaved = 0;

for (var f = 0; f < files.length; f++) {
  var file = files[f];
  var sizeBefore;
  try { sizeBefore = fs.statSync(file).size; } catch (e) { continue; }

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
if (!dryRun && totalFiles) {
  console.log("reclaimed " + (totalSaved / (1024 * 1024)).toFixed(1) + " MB");
  console.log("originals backed up to " + backupDir);
}
