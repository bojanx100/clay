var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var config = require("../lib/config");
var cli = require("../lib/cli-sessions");
var descriptors = require("../lib/sessions-cli-descriptors");
var createSessionManager = require("../lib/sessions").createSessionManager;

function completed(threadId, type, id, text) {
  return {
    timestamp: "2026-09-05T20:00:01.000Z", type: "event_msg",
    payload: { type: "item_completed", thread_id: threadId, item: {
      type: type, id: id, content: [{ type: type === "UserMessage" ? "text" : "Text", text: text }],
    } },
  };
}

function fixture(run) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-desktop-import-"));
  var previousHome = config.REAL_HOME;
  var projectDir = path.join(root, "project");
  var threadId = "01a07320-baad-7281-8b80-ca6b0cefb97e";
  var rolloutDir = path.join(root, ".codex", "sessions", "2026", "09", "05");
  var rollout = path.join(rolloutDir, "rollout-2026-09-05T20-00-00-" + threadId + ".jsonl");
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.mkdirSync(projectDir);
  config.REAL_HOME = root;
  function write(events) {
    var meta = { type: "session_meta", payload: {
      id: threadId, cwd: projectDir, originator: "Codex Desktop", source: "vscode",
      timestamp: "2026-09-05T20:00:00.000Z", instructions: "x".repeat(22000),
    } };
    fs.writeFileSync(rollout, [meta].concat(events).map(function (event) {
      return JSON.stringify(event);
    }).join("\n") + "\n");
  }
  try { run({ root: root, cwd: projectDir, id: threadId, rollout: rollout, write: write }); }
  finally {
    config.REAL_HOME = previousHome;
    var stored = path.join(config.CONFIG_DIR, "sessions", require("../lib/utils").encodeCwd(projectDir));
    fs.rmSync(stored, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("Desktop sessions are discovered from disk without an index and imported using the discovered ID", function () {
  fixture(function (f) {
    f.write([
      { type: "response_item", payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "# AGENTS.md injected instructions" },
      ] } },
      completed(f.id, "UserMessage", "owner-1", "Review Clay's lead mode"),
      completed(f.id, "AgentMessage", "assistant-1", "I will examine the coordinator lifecycle."),
    ]);
    var sm = createSessionManager({ cwd: f.cwd, send: function () {} });
    var initialCount = sm.sessions.size;
    var candidates = sm.listAdoptableCliSessions("codex");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, "Review Clay's lead mode");
    assert.equal(candidates[0].cliSessionId, f.id);
    var localId = sm.importCliSession(candidates[0].cliSessionId, candidates[0].vendor);
    assert.ok(localId);
    assert.equal(sm.sessions.get(localId).cliSessionId, f.id);
    var history = cli.readCodexHistorySync(f.root, sm.sessions.get(localId).cliSessionId, f.cwd);
    assert.deepEqual(history.map(function (entry) { return entry.type; }), ["user_message", "delta", "done"]);
    assert.equal(history[0].text, "Review Clay's lead mode");
    assert.equal(history[1].text, "I will examine the coordinator lifecycle.");
    assert.equal(sm.importCliSession(candidates[0].cliSessionId, "codex"), localId);
    assert.equal(sm.sessions.size, initialCount + 1);
    assert.equal(sm.listAdoptableCliSessions("codex").length, 0);
    var wrongProject = descriptors.attachSessionCliDescriptors({ cwd: path.join(f.root, "other") });
    assert.equal(wrongProject.findCodexRolloutByThreadId(f.id), null);
    assert.deepEqual(cli.readCodexHistorySync(f.root, f.id, path.join(f.root, "other")), []);
  });
});

test("Desktop history excludes input mirrors, tools and foreign threads while keeping separate repeated messages", function () {
  fixture(function (f) {
    var owner = completed(f.id, "UserMessage", "owner-1", "Please continue");
    var answer = completed(f.id, "AgentMessage", "assistant-1", "I will continue.");
    answer.payload.item.phase = "commentary";
    answer.payload.item.content.push({ type: "Text", text: "The first check passed." });
    f.write([
      { type: "response_item", payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "Injected project instructions" },
      ] } },
      owner, answer, owner, answer,
      { type: "response_item", payload: { type: "message", role: "assistant", id: "assistant-1", content: [
        { type: "output_text", text: "I will continue." },
      ] } },
      completed(f.id, "CommandExecution", "tool-1", "do not render execution output"),
      completed("another-thread", "UserMessage", "foreign-1", "Another owner's message"),
      completed(f.id, "UserMessage", "owner-2", "Please continue"),
      completed(f.id, "AgentMessage", "assistant-2", "Done."),
      { type: "event_msg", payload: { type: "user_message", message: "Legacy follow-up" } },
      { type: "event_msg", payload: { type: "agent_message", message: "Legacy response" } },
    ]);
    var history = cli.readCodexHistorySync(f.root, f.id, f.cwd);
    assert.deepEqual(history.filter(function (entry) { return entry.type !== "done"; }).map(function (entry) {
      return [entry.type, entry.text];
    }), [
      ["user_message", "Please continue"],
      ["delta", "I will continue.\nThe first check passed."],
      ["user_message", "Please continue"],
      ["delta", "Done."],
      ["user_message", "Legacy follow-up"],
      ["delta", "Legacy response"],
    ]);
  });
});

test("Desktop discovery keeps oversized first messages bounded and cannot mistake quoted events for owner messages", function () {
  fixture(function (f) {
    var fakeOwner = JSON.stringify(completed(f.id, "UserMessage", "fake", "Wrong title"));
    var prefix = "A large owner message\nwith \"quotes\" and a \\ path: ";
    f.write([
      completed(f.id, "AgentMessage", "quoted-1", fakeOwner),
      completed(f.id, "UserMessage", "owner-1", prefix + "x".repeat(2 * 1024 * 1024)),
    ]);
    var realParse = JSON.parse;
    try {
      JSON.parse = function (value) {
        assert.ok(value.length < 64 * 1024, "discovery must not parse the oversized message");
        return realParse.apply(JSON, arguments);
      };
      var api = descriptors.attachSessionCliDescriptors({ cwd: f.cwd });
      api.ensureCodexThreadIndex();
      assert.equal(api.codexThreadIndexed(f.id), true);
      var found = api.findCodexRolloutByThreadId(f.id);
      assert.equal(found, f.rollout);
      var desc = api.readCodexSessionDescriptor(found);
      assert.equal(desc.preview.length, 800);
      assert.equal(desc.preview.slice(0, prefix.length), prefix);
    } finally { JSON.parse = realParse; }
  });
});


test("Desktop discovery accepts reordered JSON fields", function () {
  fixture(function (f) {
    f.write([{ payload: { item: {
      content: [{ text: "Reordered owner message", type: "text" }], id: "owner-1", type: "UserMessage",
    }, thread_id: f.id, type: "item_completed" }, type: "event_msg" }]);
    var api = descriptors.attachSessionCliDescriptors({ cwd: f.cwd });
    api.ensureCodexThreadIndex();
    assert.equal(api.codexThreadIndexed(f.id), true);
    var desc = api.readCodexSessionDescriptor(api.findCodexRolloutByThreadId(f.id));
    assert.equal(desc.title, "Reordered owner message");
  });
});

test("Codex replay preserves local Desktop screenshots and legacy embedded images", function () {
  fixture(function (f) {
    var png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    var file = path.join(f.root, "screenshot.png");
    fs.writeFileSync(file, Buffer.from(png, "base64"));
    var owner = completed(f.id, "UserMessage", "screenshot-1", "Review this screenshot");
    owner.payload.item.content.push({ type: "local_image", path: file });
    f.write([owner, { type: "event_msg", payload: { type: "user_message", message: "",
      images: ["data:image/png;base64," + png], local_images: [file] } }]);
    var history = cli.readCodexHistorySync(f.root, f.id, f.cwd);
    assert.equal(history.length, 2);
    assert.equal(history[0].text, "Review this screenshot");
    assert.deepEqual(history[0].images, [{ mediaType: "image/png", data: png }]);
    assert.equal(history[1].text, "");
    assert.equal(history[1].images.length, 2);
    assert.equal(history[1].images[1].data, png);
  });
});

test("image-only Desktop sessions remain discoverable including large embedded images", function () {
  fixture(function (f) {
    var owner = completed(f.id, "UserMessage", "image-only", "");
    owner.payload.item.content = [{ type: "image", url: "data:image/png;base64," + "A".repeat(200000) }];
    f.write([owner]);
    var sm = createSessionManager({ cwd: f.cwd, send: function () {} });
    var candidates = sm.listAdoptableCliSessions("codex");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, "Image attachment");
    assert.equal(candidates[0].cliSessionId, f.id);
  });
});

test("missing or non-image local attachments stay visible without importing arbitrary file contents", function () {
  fixture(function (f) {
    var file = path.join(f.root, "private.txt");
    fs.writeFileSync(file, "private text is not an image");
    var owner = completed(f.id, "UserMessage", "unavailable", "");
    owner.payload.item.content = [{ type: "local_image", path: file },
      { type: "local_image", path: path.join(f.root, "missing.png") },
      { type: "image", url: "https://example.com/image.png" }];
    f.write([owner]);
    var history = cli.readCodexHistorySync(f.root, f.id, f.cwd);
    assert.equal(history.length, 1);
    assert.match(history[0].text, /Image attachment unavailable: missing.png/);
    assert.equal(history[0].images, undefined);
    assert.doesNotMatch(JSON.stringify(history), /private text is not an image/);
  });
});

test("Codex activity lookup reads bounded metadata rather than the entire transcript", function () {
  fixture(function (f) {
    f.write([completed(f.id, "UserMessage", "owner-1", "Review the project"),
      completed(f.id, "AgentMessage", "large", "x".repeat(8 * 1024 * 1024))]);
    var original = fs.readFileSync;
    var originalRead = fs.readSync;
    var total = 0;
    try {
      fs.readFileSync = function (file) {
        assert.notEqual(file, f.rollout, "metadata lookup must not read the complete rollout");
        return original.apply(fs, arguments);
      };
      fs.readSync = function () { var count = originalRead.apply(fs, arguments); total += count; return count; };
      assert.ok(cli.codexRolloutMtime(f.root, f.id, f.cwd) > 0);
      assert.ok(total < 128 * 1024, "identity is resolved from the actual first record");
      assert.equal(cli.codexRolloutMtime(f.root, f.id, path.join(f.root, "other")), 0);
    } finally { fs.readFileSync = original; fs.readSync = originalRead; }
  });
});
