var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var vm = require("node:vm");
var createRequire = require("node:module").createRequire;
var EventEmitter = require("node:events");
require("./helpers/isolated-clay-home");
var config = require("../lib/config");
var utils = require("../lib/utils");
var createSessionManager = require("../lib/sessions").createSessionManager;

var START = "2026-08-13T11:52:18.628Z";
var END = "2026-08-13T11:52:21.000Z";
var LEAF = "You are a canonical direct-leaf worker for a Coop-owned portfolio task.\n" +
  "This conversation lives in the target project and is the only execution copy for binding revision 1.";

function message(type, text, extra) {
  return Object.assign({
    type: type, timestamp: type === "user" ? START : END,
    message: { role: type, content: [{ type: "text", text: text }] },
  }, extra || {});
}

function fixture(t) {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clay-import-pollution-"));
  var previous = config.REAL_HOME;
  config.REAL_HOME = home;
  t.after(function () {
    config.REAL_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    home: home,
    project: function (name) {
      var cwd = path.join(home, name);
      var cliDir = path.join(home, ".claude", "projects", utils.encodeCwd(cwd));
      fs.mkdirSync(cliDir, { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      return {
        cwd: cwd,
        write: function (id, events) {
          var file = path.join(cliDir, id + ".jsonl");
          fs.writeFileSync(file, events.map(function (event) { return JSON.stringify(event); }).join("\n") + "\n");
          return file;
        },
        boot: function () { return createSessionManager({ cwd: cwd, send: function () {} }); },
      };
    },
  };
}

function ids(sm) {
  // SessionManager creates a blank composer when the project has no chats.
  return Array.from(sm.sessions.values()).map(function (session) { return session.cliSessionId; }).filter(Boolean).sort();
}

test("startup excludes replied greeting probes and SDK tasks across projects, preserving external CLI conversations", function (t) {
  var h = fixture(t);
  ["clay", "other-project"].forEach(function (name) {
    var p = h.project(name);
    // Older SDK rollouts lack entrypoint and promptSource. A reply defeated the
    // old hi-only filter, so these exact on-disk records must reach the parser.
    p.write("probe-session", [message("user", "hi"), message("assistant", "hi")]);
    p.write("sdk-task-session", [
      message("user", "Review Clay's task speed measurements for the last 24 hours.", { entrypoint: "sdk-ts" }),
      message("assistant", "Report saved."),
    ]);
    p.write("sdk-prompt-source", [
      message("user", "Repair Coop's project-coordinator control-plane migration.", { promptSource: "sdk" }),
      message("assistant", "Verified."),
    ]);
    p.write("owner-cli-session", [message("user", "Explain this SDK example"), message("assistant", "Here is how it works.")]);
    var sm = p.boot();
    assert.deepEqual(ids(sm), ["owner-cli-session"], name + " must not acquire background sidebar rows");
    assert.deepEqual(ids(p.boot()), ["owner-cli-session"], "restart must not recreate excluded sessions");
  });
});

test("canonical direct-leaf workers stay out of automatic adoption and both vendor import pickers", function (t) {
  var h = fixture(t);
  var p = h.project("workers");
  p.write("claude-leaf-session", [message("user", LEAF), message("assistant", "WORKER_STATUS: completed")]);
  var codexDir = path.join(h.home, ".codex", "sessions", "2026", "08", "13");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "rollout-2026-08-13-codex-leaf-session.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "codex-leaf-session", cwd: p.cwd, timestamp: START } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: LEAF } }),
  ].join("\n") + "\n");
  var sm = p.boot();
  assert.deepEqual(ids(sm), []);
  assert.deepEqual(sm.listAdoptableCliSessions("claude"), []);
  assert.deepEqual(sm.listAdoptableCliSessions("codex"), []);
  assert.equal(sm.importCliSession("claude-leaf-session", "claude"), null);
  assert.equal(sm.importCliSession("codex-leaf-session", "codex"), null);
});

test("real SDK conversations and replied greetings remain recoverable by explicit import", function (t) {
  var h = fixture(t);
  var p = h.project("explicit");
  p.write("real-sdk-session", [message("user", "Help me understand this project", { entrypoint: "sdk-ts" }), message("assistant", "Here is the layout.")]);
  p.write("real-greeting-session", [message("user", "Hi"), message("assistant", "Hello! How can I help?")]);
  var sm = p.boot();
  assert.deepEqual(ids(sm), []);
  var candidates = sm.listAdoptableCliSessions("claude").map(function (row) { return row.cliSessionId; }).sort();
  assert.deepEqual(candidates, ["real-greeting-session", "real-sdk-session"]);
  candidates.forEach(function (id) {
    var localId = sm.importCliSession(id, "claude");
    assert.ok(localId);
    assert.equal(sm.sessions.get(localId).adopted, undefined);
  });
  assert.deepEqual(ids(p.boot()), candidates, "an explicitly imported greeting remains visible after restart");
});

test("a CLI conversation that starts with hi and continues with real work is still adopted", function (t) {
  var h = fixture(t);
  var p = h.project("conversation");
  p.write("real-followup-session", [message("user", "hi"), message("assistant", "Hello"), message("user", "Explain the queue implementation")]);
  assert.deepEqual(ids(p.boot()), ["real-followup-session"]);
});

test("a greeting followed by owner work beyond the first chunk is still adopted", function (t) {
  var h = fixture(t);
  var p = h.project("long-greeting");
  p.write("long-followup-session", [
    message("user", "Hi!"), message("assistant", "Hello"),
    { type: "attachment", data: "x".repeat(300 * 1024) },
    message("user", "Explain the queue implementation"),
  ]);
  assert.deepEqual(ids(p.boot()), ["long-followup-session"]);
});

test("explicit SDK imports retain v2 image intake, saved titles and model metadata", function (t) {
  var h = fixture(t);
  var p = h.project("sdk-metadata");
  var image = message("user", "", { entrypoint: "sdk-ts" });
  image.message.content = [{ type: "image", source: {
    type: "base64", media_type: "image/png", data: "iVBORw0KGgo=",
  } }];
  var reply = message("assistant", "Image received");
  reply.message.model = "claude-opus-5";
  p.write("sdk-image-session", [image, reply,
    { type: "custom-title", customTitle: "Owner screenshot", timestamp: "2026-09-06T11:06:40.000Z" },
  ]);
  var sm = p.boot();
  assert.deepEqual(ids(sm), [], "an SDK image turn must not be automatically adopted");
  var candidates = sm.listAdoptableCliSessions("claude");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].title, "Owner screenshot");
  var localId = sm.importCliSession(candidates[0].cliSessionId, "claude");
  var imported = sm.sessions.get(localId);
  assert.equal(imported.model, "claude-opus-5");
  assert.equal(imported.lastActivity, Date.parse(END));
});

test("provider file touches and title edits do not change the imported conversation date", function (t) {
  var h = fixture(t);
  var p = h.project("dates");
  var file = p.write("old-session", [
    message("user", "Inspect the project"), message("assistant", "Inspection complete."),
    { type: "custom-title", customTitle: "Renamed today", timestamp: "2026-09-06T11:06:40.000Z" },
    { type: "queue-operation", operation: "dequeue", timestamp: "2026-09-06T11:06:41.000Z" },
  ]);
  fs.utimesSync(file, new Date(), new Date());
  var sm = p.boot();
  var session = Array.from(sm.sessions.values())[0];
  assert.equal(session.createdAt, Date.parse(START));
  assert.equal(session.lastActivity, Date.parse(END));
});

// Execute the actual adapter and worker warmup paths with an SDK boundary that
// can flush a transcript AFTER abort/cleanup. No provider process is launched.
function warmupHarness(t, worker, failBeforeInit) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-warmup-persistence-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var transcript = path.join(dir, "warmup.jsonl");
  var calls = [];
  var messages = [];
  var sdk = {
    query: function (request) {
      calls.push(request);
      if (failBeforeInit) throw new Error("SDK failed before init");
      var stream = (async function* () {
        yield { type: "system", subtype: "init", session_id: "warmup-session", model: "test-model", skills: ["skill"], slash_commands: [] };
      })();
      stream.supportedModels = async function () { return ["test-model"]; };
      return stream;
    },
  };
  var filename = path.resolve(__dirname, "../lib/yoke/adapters/" + (worker ? "claude-worker.js" : "claude.js"));
  var nativeRequire = createRequire(filename);
  var connection = new EventEmitter();
  connection.write = function (line) { messages.push(JSON.parse(line)); };
  var fakeProcess = {
    env: {}, argv: ["node", filename, "/isolated-socket"], pid: 1,
    cwd: function () { return dir; }, on: function () {},
    exit: function () { throw new Error("unexpected worker exit"); },
  };
  var sandbox = {
    module: { exports: {} }, __dirname: path.dirname(filename), process: fakeProcess,
    console: { log: function () {}, error: function () {}, warn: function () {} },
    AbortController: AbortController, Buffer: Buffer, setTimeout: setTimeout,
    setInterval: function () { return { unref: function () {} }; }, clearInterval: function () {},
    require: function (name) {
      if (name === "child_process") return { execSync: function () { throw new Error("no CLI in fixture"); } };
      if (name === "fs") return Object.assign({}, fs, {
        writeSync: function () {}, existsSync: function () { return false; },
        unlinkSync: function () { if (fs.existsSync(transcript)) fs.unlinkSync(transcript); },
      });
      if (name === "net") return { connect: function () { return connection; } };
      return nativeRequire(name);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(filename, "utf8"), sandbox, { filename: filename });
  if (worker) sandbox.sdkModule = sdk;
  else sandbox._sdkPromise = Promise.resolve(sdk);
  return {
    calls: calls, messages: messages, transcript: transcript,
    run: async function () {
      if (worker) return sandbox.handleWarmup({ options: { cwd: dir, persistSession: true } });
      return sandbox.module.exports.createClaudeAdapter({ cwd: dir }).init({});
    },
    flushLateWrite: function () {
      calls.forEach(function (call) {
        if (call.options.persistSession !== false) fs.writeFileSync(transcript, "hi\n");
      });
    },
  };
}

[false, true].forEach(function (worker) {
  var mode = worker ? "OS-user worker" : "in-process adapter";
  test(mode + " warmup discovers models without a late transcript write", async function (t) {
    var h = warmupHarness(t, worker, false);
    var result = await h.run();
    if (worker) result = h.messages.filter(function (msg) { return msg.type === "warmup_done"; })[0].result;
    assert.deepEqual(Array.from(result.models), ["test-model"]);
    assert.equal(h.calls.length, 1);
    h.flushLateWrite();
    assert.equal(fs.existsSync(h.transcript), false, "late SDK writes must not resurrect the warmup transcript");
  });
  test(mode + " warmup disables persistence even when the SDK fails before returning a session id", async function (t) {
    var h = warmupHarness(t, worker, true);
    if (worker) {
      await h.run();
      assert.ok(h.messages.some(function (msg) { return msg.type === "warmup_error"; }));
    } else {
      await assert.rejects(h.run(), /SDK failed before init/);
    }
    assert.equal(h.calls.length, 1);
    h.flushLateWrite();
    assert.equal(fs.existsSync(h.transcript), false);
  });
});
