var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var config = require("../lib/config");
var cli = require("../lib/cli-sessions");
var PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

function user(content, time) {
  return { type: "user", timestamp: time || "2026-09-06T10:00:00Z", message: { role: "user", content: content } };
}
function assistant(content, model) {
  return { type: "assistant", timestamp: "2026-09-06T10:00:01Z",
    message: { role: "assistant", content: content, model: model || "claude-opus-5" } };
}
function screenshot() {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } };
}
async function fixture(events, run) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-claude-transcript-"));
  var cwd = path.join(root, "project");
  var id = "adcd21c1-ef81-4b0d-9b34-55e681a7e803";
  var folder = path.join(root, ".claude/projects", cli.encodeCwd(cwd));
  var file = path.join(folder, id + ".jsonl");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(file, events.map(function (event) { return JSON.stringify(event); }).join("\n") + "\n");
  var previous = config.REAL_HOME;
  config.REAL_HOME = root;
  var descriptors = require("../lib/sessions-cli-descriptors").attachSessionCliDescriptors({
    cwd: cwd, isValidCliSessionId: function (value) { return /^[a-z0-9-]+$/.test(value); },
  });
  var sessions = new Map();
  var next = 0;
  var importer = require("../lib/sessions-cli-import").attachSessionCliImport(Object.assign({}, descriptors, {
    cwd: cwd, sessions: sessions, allocateLocalId: function () { return ++next; },
    saveSessionFile: function () {}, broadcastSessionList: function () {},
    isValidCliSessionId: function (value) { return /^[a-z0-9-]+$/.test(value); },
  }));
  try { await run({ root: root, cwd: cwd, id: id, file: file, descriptors: descriptors, importer: importer, sessions: sessions }); }
  finally { config.REAL_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); }
}

test("Claude history preserves screenshots, image-only turns and original text in both readers", async function () {
  await fixture([user([null, screenshot(), { type: "text", text: "What changed?" }]),
    assistant([{ type: "text", text: "Please show the next screen." }]), user([screenshot()])], async function (f) {
    var sync = cli.readCliSessionHistorySync(f.root, f.cwd, f.id);
    assert.equal(sync.length, 3);
    assert.equal(sync[0].text, "What changed?");
    assert.deepEqual(sync[0].images, [{ mediaType: "image/png", data: PNG }]);
    assert.equal(sync[2].text, "");
    assert.deepEqual(sync[2].images, sync[0].images);
    assert.deepEqual(await cli.readCliSessionHistory(f.root, f.cwd, f.id), sync);
  });
});

test("Claude tool results retain real outputs, errors, image output and native call pairing", async function () {
  await fixture([user("Inspect"), assistant([
    { type: "tool_use", id: "call-a", name: "Read", input: { file_path: "a" } },
    { type: "tool_use", id: "call-b", name: "Bash", input: { command: "check" } },
  ]), user([
    { type: "tool_result", tool_use_id: "call-b", content: "Check failed", is_error: true },
    { type: "tool_result", tool_use_id: "call-a", content: [{ type: "text", text: "Actual contents" }, screenshot()] },
    { type: "text", text: "Also inspect B" },
  ])], async function (f) {
    var history = cli.readCliSessionHistorySync(f.root, f.cwd, f.id);
    var calls = history.filter(function (event) { return event.type === "tool_start"; });
    var results = history.filter(function (event) { return event.type === "tool_result"; });
    assert.equal(results.length, 2, "no invented empty success results");
    assert.equal(results[0].id, calls[1].id);
    assert.equal(results[0].content, "Check failed");
    assert.equal(results[0].is_error, true);
    assert.equal(results[1].id, calls[0].id);
    assert.equal(results[1].content, "Actual contents");
    assert.equal(results[1].images[0].data, PNG);
    assert.deepEqual(history.filter(function (event) { return event.type === "user_message"; }).map(function (event) {
      return event.text;
    }), ["Inspect", "Also inspect B"]);
    assert.deepEqual(await cli.readCliSessionHistory(f.root, f.cwd, f.id), history);
  });
});

test("an interrupted Claude tool call is not reported as successful", async function () {
  await fixture([user("Inspect"), assistant([{ type: "tool_use", id: "pending", name: "Read", input: {} }])], function (f) {
    var history = cli.readCliSessionHistorySync(f.root, f.cwd, f.id);
    assert.equal(history.filter(function (event) { return event.type === "tool_start"; }).length, 1);
    assert.equal(history.filter(function (event) { return event.type === "tool_result"; }).length, 0);
  });
});

test("Claude discovery and actual import retain saved title and latest real model", async function () {
  await fixture([user([{ type: "tool_result", tool_use_id: "old", content: "Prior machinery" }]),
    user("Review this UI"), assistant([{ type: "text", text: "Reviewing" }], "claude-sonnet-4-6"),
    assistant([{ type: "text", text: "Done" }], "claude-opus-5"),
    { type: "ai-title", aiTitle: "Generated title" }, { type: "custom-title", customTitle: "Owner's chosen title" },
    assistant([{ type: "text", text: "Interrupted" }], "<synthetic>")], async function (f) {
    var candidates = f.importer.listAdoptableCliSessions("claude");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, "Owner's chosen title");
    var selected = f.importer.importCliSession(candidates[0].cliSessionId, "claude");
    assert.equal(f.sessions.get(selected).model, "claude-opus-5");
    var descriptor = f.descriptors.readCliSessionDescriptor(candidates[0].cliSessionId);
    assert.equal(descriptor.preview, "Review this UI");
    var other = await cli.parseSessionFile(f.file);
    assert.equal(other.title, descriptor.title);
    assert.equal(other.model, descriptor.model);
    assert.equal(other.firstPrompt, descriptor.preview);
  });
});

test("Claude's latest title is read from the tail of a large transcript with a bounded preview", async function () {
  await fixture([user("Owner prompt " + "x".repeat(10000)),
    assistant([{ type: "text", text: "Starting" }], "claude-sonnet-4-6"),
    { type: "attachment", data: "x".repeat(9 * 1024 * 1024) },
    { type: "custom-title", customTitle: "Renamed after a long session" },
    assistant([{ type: "text", text: "Completed" }])], function (f) {
    var readSync = fs.readSync;
    var bytesRead = 0;
    var descriptor;
    fs.readSync = function () {
      var count = readSync.apply(fs, arguments);
      bytesRead += count;
      return count;
    };
    try { descriptor = f.descriptors.readCliSessionDescriptor(f.id); }
    finally { fs.readSync = readSync; }
    assert.equal(descriptor.title, "Renamed after a long session");
    assert.equal(descriptor.model, "claude-opus-5");
    assert.equal(descriptor.preview.length, 800);
    assert.ok(bytesRead <= 1024 * 1024, "ordinary metadata needs only a bounded head and tail");
  });
});

test("Claude metadata discovery crosses non-message prefixes instead of stopping at 20 lines", async function () {
  var events = Array.from({ length: 25 }, function () { return { type: "queue-operation", operation: "dequeue" }; });
  events.push(user([screenshot()]), assistant([{ type: "text", text: "I see the image" }]));
  await fixture(events, async function (f) {
    var result = await cli.parseSessionFile(f.file);
    assert.ok(result);
    assert.equal(result.title, "Image attachment");
    assert.equal(result.model, "claude-opus-5");
  });
});

test("cached Claude history upgrades without needing another native turn", async function () {
  await fixture([user([screenshot()]), assistant([{ type: "text", text: "Image received" }])], function (f) {
    var saves = 0;
    var tui = require("../lib/project-sessions-tui").attachProjectSessionsTui({
      cwd: f.cwd, sm: { saveSessionFile: function () { saves++; } },
      resolveSessionHome: function () { return f.root; },
    });
    var session = { cliSessionId: f.id, history: [{ type: "delta", text: "Old incomplete history" }],
      _historyMtime: fs.statSync(f.file).mtimeMs };
    tui.prepareTuiSessionForGuiView(session);
    assert.equal(session.history[0].images[0].data, PNG);
    assert.equal(session._historyFormatVersion, cli.HISTORY_FORMAT_VERSION);
    assert.equal(saves, 1);
    tui.prepareTuiSessionForGuiView(session);
    assert.equal(saves, 1);
    fs.unlinkSync(f.file);
    session._historyFormatVersion = 0;
    tui.prepareTuiSessionForGuiView(session);
    assert.equal(session.history[0].images[0].data, PNG, "a missing native file cannot erase the saved history");
    assert.equal(saves, 1);
  });
});
