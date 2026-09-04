#!/usr/bin/env node
// Retroactively applies the tool_result cap from lib/sdk-message-processor.js to
// session history already on disk. A tool_result whose content exceeds the cap is
// rewritten to a bounded prefix plus a truncation marker; every other line is
// copied through byte-for-byte.
//
// Why: an unbounded grep result (130MB in one case) was recorded verbatim into
// session history. The daemon parses every session file into the heap at startup,
// so those entries pushed it past the 4GB V8 limit and OOM-crash-looped it.
//
// Each file it modifies is copied to ~/.clay/session-backups-<stamp>/ first, which
// sits outside the sessions directory so the daemon never loads it.
//
// Usage:
//   node scripts/truncate-oversized-tool-results.js --dry-run   # report only
//   node scripts/truncate-oversized-tool-results.js             # migrate
//
// Stop the daemon before migrating, or it may re-save a file from memory mid-run.

var fs = require("fs");
var os = require("os");
var path = require("path");

var CAP = 256 * 1024; // must match MAX_TOOL_RESULT_CHARS
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

var files = walk(sessionsDir, []);
var totalFiles = 0, totalResults = 0, totalSaved = 0;

for (var f = 0; f < files.length; f++) {
  var file = files[f];
  var sizeBefore;
  try { sizeBefore = fs.statSync(file).size; } catch (e) { continue; }
  if (sizeBefore < CAP) continue;

  var lines;
  try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch (e) {
    console.warn("skip (unreadable): " + file + " — " + e.message);
    continue;
  }

  var touched = 0;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].length <= CAP) continue;
    var obj;
    try { obj = JSON.parse(lines[i]); } catch (e) { continue; }
    if (!obj || obj.type !== "tool_result") continue;
    if (typeof obj.content !== "string" || obj.content.length <= CAP) continue;
    var dropped = obj.content.length - CAP;
    obj.content = obj.content.slice(0, CAP) +
      "\n\n[Clay truncated " + dropped + " characters of tool output]";
    lines[i] = JSON.stringify(obj);
    touched++;
  }
  if (!touched) continue;

  totalFiles++;
  totalResults += touched;

  if (dryRun) {
    console.log(touched + " oversized result(s) in " + file);
    continue;
  }

  var rel = path.relative(sessionsDir, file);
  var dst = path.join(backupDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(file, dst);

  var tmp = file + ".migrate.tmp";
  fs.writeFileSync(tmp, lines.join("\n"));
  try { fs.chmodSync(tmp, 0o600); } catch (e) {}
  fs.renameSync(tmp, file);

  totalSaved += sizeBefore - fs.statSync(file).size;
  console.log("rewrote " + touched + " result(s): " + rel);
}

console.log("");
console.log((dryRun ? "[dry run] would rewrite " : "rewrote ") + totalResults +
  " oversized tool_result(s) across " + totalFiles + " file(s)");
if (!dryRun && totalFiles) {
  console.log("reclaimed " + (totalSaved / (1024 * 1024 * 1024)).toFixed(2) + " GB");
  console.log("originals backed up to " + backupDir);
}
