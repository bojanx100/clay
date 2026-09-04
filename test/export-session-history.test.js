var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var exporter = require("../scripts/export-session-history");

test("session export preserves raw evidence and produces a chronological audit", function(t) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-history-export-"));
  t.after(function() { fs.rmSync(root, { recursive: true, force: true }); });
  var clayPath = path.join(root, "session.jsonl");
  var providerPath = path.join(root, "rollout.jsonl");
  var imageRoot = path.join(root, "images");
  var imageName = "proof.png";
  var uploadedPath = path.join(root, "historical upload.pdf");
  fs.mkdirSync(imageRoot);
  fs.writeFileSync(path.join(imageRoot, imageName), "image-bytes");
  fs.writeFileSync(uploadedPath, "uploaded-bytes");
  fs.writeFileSync(clayPath, [
    JSON.stringify({ type: "meta", storageId: "target" }),
    JSON.stringify({ type: "user_message", text: "latest real\n[Uploaded file: " + uploadedPath + "]" +
      "\n[Uploaded file: /missing/report.pdf]", imageRefs: [{ file: imageName }], _ts: 30 }),
    JSON.stringify({ type: "delta", text: "earlier assistant", _ts: 20 }),
    JSON.stringify({ type: "user_message", text: "queued later", queueId: "q-1", clientMessageId: "cm-1", _ts: 50 }),
    JSON.stringify({ type: "tool_result", text: "still finishing", _ts: 40 }),
    JSON.stringify({ type: "user_message", text: "↻ Resuming after restart", synthetic: true, autoAction: true, _ts: 10 }),
  ].join("\n") + "\n");
  fs.writeFileSync(providerPath, [
    JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name: "exec" } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: "ok" } }),
  ].join("\n") + "\n");

  var output = path.join(root, "export");
  var result = exporter.exportSessionHistory({
    output: output,
    clay: [{ label: "target", path: clayPath }],
    provider: [{ label: "target", path: providerPath }],
    source: [],
    imageRoot: [{ label: "target", path: imageRoot }],
  });

  assert.equal(result.audit.clay.target.latestRealUser.preview, "queued later");
  assert.equal(result.audit.clay.target.restartMarkers.length, 1);
  assert.deepEqual(result.audit.clay.target.queuedTimestampExcursions, [{
    appendIndex: 3,
    fileLine: 4,
    timestamp: 50,
    clientMessageId: "cm-1",
    queueId: "q-1",
    preview: "queued later",
    nextAppendIndex: 4,
    nextTimestamp: 40,
    classified: false,
  }]);
  assert.deepEqual(result.audit.provider.target.orphanedCalls, []);
  assert.equal(result.audit.attachments[0].exists, true);
  assert.deepEqual(result.audit.clay.target.uploadedReferences.map(function(ref) { return ref.path; }),
    [uploadedPath, "/missing/report.pdf"]);
  assert.equal(result.audit.attachments.filter(function(item) {
    return item.referenceKind === "file" && item.exists;
  }).length, 1);
  assert.equal(result.audit.attachments.filter(function(item) {
    return item.referenceKind === "file" && !item.exists;
  }).length, 1);
  assert.equal(fs.readFileSync(path.join(output, "raw", "clay--target--session.jsonl"), "utf8"),
    fs.readFileSync(clayPath, "utf8"));
  var chronology = fs.readFileSync(path.join(output, "chronology", "target.clay.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  assert.deepEqual(chronology.slice(1).map(function(row) { return row.timestamp; }), [10, 20, 30, 40, 50]);
  assert.equal(fs.existsSync(path.join(output, "attachments", "target", imageName)), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, "manifest.json"))).copiedFiles.length, 4);
});
