#!/usr/bin/env node

// Applies the narrow, evidence-backed classification repair for legacy Clay
// session records. The default is a dry run. Applying requires an export
// manifest whose byte-for-byte source copy matches the file being changed.

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

var loaderHistory = require("../lib/sessions-loader-history");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseSpec(value) {
  var separator = String(value || "").indexOf("=");
  if (separator <= 0) throw new Error("Expected label=/absolute/path, got: " + value);
  var label = value.slice(0, separator);
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error("Invalid session label: " + label);
  return { label: label, path: path.resolve(value.slice(separator + 1)) };
}

function parseArgs(argv) {
  var options = { sessions: [], apply: false };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") options.sessions.push(parseSpec(argv[++i]));
    else if (argv[i] === "--evidence-manifest") options.evidenceManifest = path.resolve(argv[++i]);
    else if (argv[i] === "--apply") options.apply = true;
    else throw new Error("Unknown argument: " + argv[i]);
  }
  if (options.sessions.length === 0) throw new Error("At least one --session is required");
  if (options.apply && !options.evidenceManifest) {
    throw new Error("--evidence-manifest is required with --apply");
  }
  return options;
}

function repairContent(raw) {
  var trailingNewline = raw.endsWith("\n");
  var lines = raw.split("\n");
  if (trailingNewline) lines.pop();
  var output = lines.slice();
  var changedRows = [];
  var changedFields = 0;
  for (var i = 0; i < lines.length; i++) {
    var row;
    try {
      row = JSON.parse(lines[i]);
    } catch (error) {
      throw new Error("Malformed JSONL at line " + (i + 1) + ": " + error.message);
    }
    var before = JSON.stringify(row);
    var count = loaderHistory.classifyLegacyInjectedHistory([row]);
    if (!count) continue;
    output[i] = JSON.stringify(row);
    changedFields += count;
    changedRows.push({
      fileLine: i + 1,
      appendIndex: i,
      type: row.type,
      timestamp: row._ts == null ? null : row._ts,
      beforeBytes: Buffer.byteLength(lines[i]),
      afterBytes: Buffer.byteLength(output[i]),
      beforeSha256: sha256(before),
      afterSha256: sha256(output[i]),
    });
  }
  return {
    content: output.join("\n") + (trailingNewline ? "\n" : ""),
    changedFields: changedFields,
    changedRows: changedRows,
  };
}

function loadEvidence(manifestPath) {
  var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  var bySource = {};
  var copiedFiles = Array.isArray(manifest.copiedFiles) ? manifest.copiedFiles : [];
  for (var i = 0; i < copiedFiles.length; i++) bySource[path.resolve(copiedFiles[i].source)] = copiedFiles[i];
  return bySource;
}

function verifyEvidence(filePath, raw, evidence) {
  var entry = evidence[path.resolve(filePath)];
  if (!entry) throw new Error("Evidence manifest has no source copy for " + filePath);
  var currentHash = sha256(raw);
  if (entry.sha256 !== currentHash) {
    throw new Error("Source changed after export: " + filePath + " (expected " +
      entry.sha256 + ", found " + currentHash + ")");
  }
  if (!entry.copy || !fs.existsSync(entry.copy)) throw new Error("Evidence copy is missing: " + entry.copy);
  if (sha256(fs.readFileSync(entry.copy)) !== entry.sha256) {
    throw new Error("Evidence copy hash mismatch: " + entry.copy);
  }
  return entry;
}

function applyRepair(filePath, raw, result) {
  var stat = fs.statSync(filePath);
  var tempPath = filePath + ".history-repair.tmp." + process.pid;
  fs.writeFileSync(tempPath, result.content, { flag: "wx", mode: stat.mode });
  try {
    if (sha256(fs.readFileSync(filePath)) !== sha256(raw)) {
      throw new Error("Source changed while repair was being prepared: " + filePath);
    }
    fs.renameSync(tempPath, filePath);
    var repaired = fs.readFileSync(filePath);
    if (sha256(repaired) !== sha256(result.content)) {
      throw new Error("Repaired file hash mismatch after atomic rename: " + filePath);
    }
  } finally {
    try { fs.unlinkSync(tempPath); } catch (error) {}
  }
}

function repairSessions(options) {
  var evidence = options.apply ? loadEvidence(options.evidenceManifest) : null;
  var report = { applied: options.apply, sessions: [] };
  for (var i = 0; i < options.sessions.length; i++) {
    var spec = options.sessions[i];
    var raw = fs.readFileSync(spec.path, "utf8");
    var result = repairContent(raw);
    var item = {
      label: spec.label,
      path: spec.path,
      beforeSha256: sha256(raw),
      afterSha256: sha256(result.content),
      changedFields: result.changedFields,
      changedRows: result.changedRows,
    };
    if (options.apply && result.changedRows.length) {
      item.evidence = verifyEvidence(spec.path, raw, evidence).copy;
      applyRepair(spec.path, raw, result);
    }
    report.sessions.push(item);
  }
  return report;
}

function usage() {
  return [
    "Usage: node scripts/repair-session-history.js --session label=/absolute/session.jsonl ...",
    "  [--evidence-manifest /absolute/export/manifest.json --apply]",
  ].join("\n");
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(repairSessions(parseArgs(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error.message + "\n\n" + usage());
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs: parseArgs,
  repairContent: repairContent,
  repairSessions: repairSessions,
};
