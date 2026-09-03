#!/usr/bin/env node

// Exports an immutable evidence bundle before a targeted session-history repair.
// Clay session JSONL and provider rollouts are copied byte-for-byte, while
// timestamp-ordered views make append-order crossings inspectable without
// modifying the source records. Image references are copied when their source
// directory is supplied.

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

var HANDOFF_PREFIXES = [
  "[Context from previous claude conversation]",
  "[Context from previous Claude conversation, prepared for Codex handoff]",
  "[Context from this Clay session before the current thread was persisted, " +
    "prepared for the current vendor handoff]",
];

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function safeLabel(value) {
  var label = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error("Invalid source label: " + value);
  return label;
}

function parseSpec(value) {
  var separator = String(value || "").indexOf("=");
  if (separator <= 0) throw new Error("Expected label=/absolute/path, got: " + value);
  var label = safeLabel(value.slice(0, separator));
  var filePath = path.resolve(value.slice(separator + 1));
  return { label: label, path: filePath };
}

function parseArgs(argv) {
  var options = { clay: [], provider: [], source: [], imageRoot: [] };
  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === "--output") options.output = path.resolve(argv[++i]);
    else if (arg === "--clay") options.clay.push(parseSpec(argv[++i]));
    else if (arg === "--provider") options.provider.push(parseSpec(argv[++i]));
    else if (arg === "--source") options.source.push(parseSpec(argv[++i]));
    else if (arg === "--image-root") options.imageRoot.push(parseSpec(argv[++i]));
    else throw new Error("Unknown argument: " + arg);
  }
  if (!options.output) throw new Error("--output is required");
  if (options.clay.length === 0) throw new Error("At least one --clay source is required");
  return options;
}

function parseJsonl(filePath) {
  var raw = fs.readFileSync(filePath, "utf8");
  var lines = raw.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  var rows = [];
  for (var i = 0; i < lines.length; i++) {
    try {
      rows.push(JSON.parse(lines[i]));
    } catch (error) {
      throw new Error("Malformed JSONL at " + filePath + ":" + (i + 1) + ": " + error.message);
    }
  }
  return rows;
}

function timestampOf(row) {
  if (row && Number.isFinite(Number(row._ts))) return Number(row._ts);
  if (row && row.timestamp) {
    var parsed = Date.parse(row.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function orderedRows(rows, label) {
  var wrapped = [];
  for (var i = 0; i < rows.length; i++) {
    wrapped.push({ source: label, appendIndex: i, timestamp: timestampOf(rows[i]), record: rows[i] });
  }
  wrapped.sort(function(a, b) {
    if (a.timestamp == null && b.timestamp == null) return a.appendIndex - b.appendIndex;
    if (a.timestamp == null) return -1;
    if (b.timestamp == null) return 1;
    return a.timestamp - b.timestamp || a.appendIndex - b.appendIndex;
  });
  return wrapped;
}

function handoffPrefix(text) {
  var value = String(text || "").trim();
  for (var i = 0; i < HANDOFF_PREFIXES.length; i++) {
    if (value.indexOf(HANDOFF_PREFIXES[i]) === 0) return HANDOFF_PREFIXES[i];
  }
  return null;
}

function textPreview(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function uploadedReferences(text) {
  var value = String(text || "");
  var pattern = /\[Uploaded (file|image): ([^\]\n]+)\]/g;
  var references = [];
  var match;
  while ((match = pattern.exec(value)) !== null) {
    references.push({ kind: match[1], path: match[2] });
  }
  return references;
}

function summarizeClay(rows) {
  var summary = {
    rows: rows.length,
    types: {},
    generatedHandoffBlocks: [],
    restartMarkers: [],
    userMessages: 0,
    latestRealUser: null,
    imageRefs: [],
    uploadedReferences: [],
  };
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i] || {};
    summary.types[row.type || "<missing>"] = (summary.types[row.type || "<missing>"] || 0) + 1;
    if (row.type !== "user_message") continue;
    summary.userMessages++;
    var prefix = handoffPrefix(row.text);
    if (prefix) {
      summary.generatedHandoffBlocks.push({
        appendIndex: i,
        fileLine: i + 1,
        timestamp: timestampOf(row),
        prefix: prefix,
        bytes: Buffer.byteLength(String(row.text || "")),
        classified: row.internalOnly === true && row.synthetic === true,
      });
    }
    var trimmed = String(row.text || "").trim();
    if (/^(?:↻ Resuming after restart|Resume the work that was interrupted when Clay restarted\.)/.test(trimmed)) {
      summary.restartMarkers.push({
        appendIndex: i,
        fileLine: i + 1,
        timestamp: timestampOf(row),
        preview: textPreview(row.text),
        synthetic: row.synthetic === true,
        autoAction: row.autoAction === true,
      });
    }
    if (!prefix && !row.internalOnly && !row.synthetic && !row.autoAction) {
      summary.latestRealUser = {
        appendIndex: i,
        fileLine: i + 1,
        timestamp: timestampOf(row),
        clientMessageId: row.clientMessageId || null,
        preview: textPreview(row.text),
        imageCount: Array.isArray(row.imageRefs) ? row.imageRefs.length : 0,
      };
    }
    if (Array.isArray(row.imageRefs)) {
      for (var ri = 0; ri < row.imageRefs.length; ri++) {
        summary.imageRefs.push({
          appendIndex: i,
          fileLine: i + 1,
          timestamp: timestampOf(row),
          file: row.imageRefs[ri] && row.imageRefs[ri].file,
          mediaType: row.imageRefs[ri] && row.imageRefs[ri].mediaType,
        });
      }
    }
    var uploads = uploadedReferences(row.text);
    for (var ui = 0; ui < uploads.length; ui++) {
      summary.uploadedReferences.push({
        appendIndex: i,
        fileLine: i + 1,
        timestamp: timestampOf(row),
        kind: uploads[ui].kind,
        path: uploads[ui].path,
      });
    }
  }
  return summary;
}

function summarizeProvider(rows) {
  var summary = { rows: rows.length, types: {}, responseItemTypes: {}, roles: {}, orphanedCalls: [] };
  var calls = {};
  var outputs = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i] || {};
    summary.types[row.type || "<missing>"] = (summary.types[row.type || "<missing>"] || 0) + 1;
    if (row.type !== "response_item" || !row.payload) continue;
    var item = row.payload;
    summary.responseItemTypes[item.type || "<missing>"] =
      (summary.responseItemTypes[item.type || "<missing>"] || 0) + 1;
    if (item.role) summary.roles[item.role] = (summary.roles[item.role] || 0) + 1;
    if ((item.type === "custom_tool_call" || item.type === "function_call") && item.call_id) {
      calls[item.call_id] = { appendIndex: i, type: item.type, name: item.name || null };
    }
    if ((item.type === "custom_tool_call_output" || item.type === "function_call_output") && item.call_id) {
      outputs[item.call_id] = true;
    }
  }
  Object.keys(calls).forEach(function(callId) {
    if (!outputs[callId]) summary.orphanedCalls.push(Object.assign({ callId: callId }, calls[callId]));
  });
  return summary;
}

function copyVerified(sourcePath, destinationPath, manifest) {
  if (!fs.statSync(sourcePath).isFile()) throw new Error("Source is not a file: " + sourcePath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  var before = hashFile(sourcePath);
  fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  var after = hashFile(destinationPath);
  if (before !== after) throw new Error("Copy hash mismatch for " + sourcePath);
  manifest.push({
    source: sourcePath,
    copy: destinationPath,
    bytes: fs.statSync(destinationPath).size,
    sha256: after,
  });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

function writeJsonl(filePath, rows) {
  var lines = [];
  for (var i = 0; i < rows.length; i++) lines.push(JSON.stringify(rows[i]));
  fs.writeFileSync(filePath, lines.join("\n") + "\n", { flag: "wx", mode: 0o600 });
}

function keyedSpecs(specs) {
  var map = {};
  for (var i = 0; i < specs.length; i++) {
    if (map[specs[i].label]) throw new Error("Duplicate source label: " + specs[i].label);
    map[specs[i].label] = specs[i];
  }
  return map;
}

function exportSessionHistory(options) {
  var output = path.resolve(options.output);
  if (fs.existsSync(output)) throw new Error("Output already exists: " + output);
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  var rawDir = path.join(output, "raw");
  var chronologyDir = path.join(output, "chronology");
  var attachmentsDir = path.join(output, "attachments");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(chronologyDir, { recursive: true });

  var manifest = [];
  var audit = { createdAt: new Date().toISOString(), clay: {}, provider: {}, attachments: [] };
  var copiedUploadPaths = {};
  var imageRoots = keyedSpecs(options.imageRoot || []);
  var groups = [
    { kind: "clay", specs: options.clay || [] },
    { kind: "provider", specs: options.provider || [] },
    { kind: "source", specs: options.source || [] },
  ];
  for (var gi = 0; gi < groups.length; gi++) {
    for (var si = 0; si < groups[gi].specs.length; si++) {
      var spec = groups[gi].specs[si];
      var copyName = groups[gi].kind + "--" + spec.label + "--" + path.basename(spec.path);
      copyVerified(spec.path, path.join(rawDir, copyName), manifest);
      if (groups[gi].kind === "source") continue;
      var rows = parseJsonl(spec.path);
      writeJsonl(path.join(chronologyDir, spec.label + "." + groups[gi].kind + ".jsonl"),
        orderedRows(rows, spec.label));
      if (groups[gi].kind === "provider") {
        audit.provider[spec.label] = summarizeProvider(rows);
        continue;
      }
      audit.clay[spec.label] = summarizeClay(rows);
      var root = imageRoots[spec.label] && imageRoots[spec.label].path;
      var refs = audit.clay[spec.label].imageRefs;
      for (var ii = 0; root && ii < refs.length; ii++) {
        if (!refs[ii].file || path.basename(refs[ii].file) !== refs[ii].file) continue;
        var imagePath = path.join(root, refs[ii].file);
        var record = Object.assign({ label: spec.label, source: imagePath, exists: fs.existsSync(imagePath) }, refs[ii]);
        if (record.exists) {
          var imageCopy = path.join(attachmentsDir, spec.label, refs[ii].file);
          copyVerified(imagePath, imageCopy, manifest);
          record.copy = imageCopy;
          record.sha256 = hashFile(imageCopy);
        }
        audit.attachments.push(record);
      }
      var uploads = audit.clay[spec.label].uploadedReferences;
      for (var ui = 0; ui < uploads.length; ui++) {
        var uploadPath = path.resolve(uploads[ui].path);
        var uploadKey = spec.label + "\0" + uploadPath;
        var uploadRecord = Object.assign({
          label: spec.label,
          source: uploadPath,
          exists: fs.existsSync(uploadPath) && fs.statSync(uploadPath).isFile(),
          referenceKind: uploads[ui].kind,
        }, uploads[ui]);
        if (uploadRecord.exists && !copiedUploadPaths[uploadKey]) {
          var uploadName = shaPath(uploadPath) + "--" + path.basename(uploadPath);
          var uploadCopy = path.join(attachmentsDir, "uploaded-references", spec.label, uploadName);
          copyVerified(uploadPath, uploadCopy, manifest);
          copiedUploadPaths[uploadKey] = { copy: uploadCopy, sha256: hashFile(uploadCopy) };
        }
        if (copiedUploadPaths[uploadKey]) {
          uploadRecord.copy = copiedUploadPaths[uploadKey].copy;
          uploadRecord.sha256 = copiedUploadPaths[uploadKey].sha256;
        }
        audit.attachments.push(uploadRecord);
      }
    }
  }

  writeJson(path.join(output, "audit.json"), audit);
  writeJson(path.join(output, "manifest.json"), {
    createdAt: audit.createdAt,
    output: output,
    copiedFiles: manifest,
    generatedFiles: ["audit.json", "chronology/*.jsonl", "manifest.json"],
  });
  return { output: output, copiedFiles: manifest.length, audit: audit };
}

function shaPath(filePath) {
  return crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 16);
}

function usage() {
  return [
    "Usage: node scripts/export-session-history.js --output <dir>",
    "  --clay label=/absolute/session.jsonl       repeatable",
    "  --provider label=/absolute/rollout.jsonl   repeatable",
    "  --source label=/absolute/file              repeatable",
    "  --image-root label=/absolute/image/dir     repeatable",
  ].join("\n");
}

if (require.main === module) {
  try {
    var result = exportSessionHistory(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ output: result.output, copiedFiles: result.copiedFiles }, null, 2));
  } catch (error) {
    console.error(error.message + "\n\n" + usage());
    process.exitCode = 1;
  }
}

module.exports = {
  exportSessionHistory: exportSessionHistory,
  parseArgs: parseArgs,
  summarizeClay: summarizeClay,
  summarizeProvider: summarizeProvider,
};
