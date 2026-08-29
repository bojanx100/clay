var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var handoffModule = require("../lib/project-session-handoff");

function clearSessionModuleCache() {
  delete require.cache[require.resolve("../lib/config")];
  delete require.cache[require.resolve("../lib/tombstones")];
  delete require.cache[require.resolve("../lib/sessions")];
}

function resultText(result) {
  return result.content[0].text;
}

test("handoff source and target settings survive restart through stable session references", async function () {
  var clayHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-handoff-home-"));
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-handoff-project-"));
  var priorClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = clayHome;
  clearSessionModuleCache();

  try {
    var sm = require("../lib/sessions").createSessionManager({
      cwd: projectDir,
      send: function () {},
    });
    sm.installedVendors = ["claude"];
    sm.currentEffort = "medium";
    sm.currentEffortByVendor = {};
    var source = [...sm.sessions.values()][0];
    source.storageId = "handoff-source-stable";
    source.vendor = "claude";
    source.title = "Durable source";
    source.history.push(
      { type: "user_message", text: "Keep this restart-safe context.", _ts: Date.now() },
      { type: "delta", text: "The source work is still available.", _ts: Date.now() + 1 },
      { type: "done", code: 0, _ts: Date.now() + 2 }
    );
    sm.saveSessionFile(source, { durable: true });

    var sent = [];
    var ws = { _clayActiveSession: source.localId, _clayUser: null };
    var attachedBeforeRestart = handoffModule.attachSessionHandoff({
      cwd: projectDir,
      sm: sm,
      isMate: false,
      splitStore: { groupForMember: function () { return null; } },
      getSdk: function () {
        return { startQuery: function () { return Promise.resolve(); } };
      },
      sendTo: function (targetWs, message) { sent.push(message); },
      usersModule: { isMultiUser: function () { return false; } },
      adapters: { claude: {} },
      getLinuxUserForSession: function () { return null; },
      onProcessingChanged: function () {},
    });
    attachedBeforeRestart.handleMessage(ws, {
      type: "handoff_session",
      targetVendor: "claude",
      model: "claude-sonnet-4-6",
      effort: "high",
    });
    var target = sm.sessions.get(ws._clayActiveSession);
    assert.ok(target);
    assert.notStrictEqual(target, source);
    assert.strictEqual(target.handoff.sourceSessionId, "handoff-source-stable");
    assert.strictEqual(sent[sent.length - 1].ok, true);
    var targetStorageId = target.storageId;

    clearSessionModuleCache();
    var restored = require("../lib/sessions").createSessionManager({
      cwd: projectDir,
      send: function () {},
    });
    var restoredTarget = [...restored.sessions.values()].find(function (session) {
      return session.storageId === targetStorageId;
    });
    assert.ok(restoredTarget);
    assert.strictEqual(restoredTarget.model, "claude-sonnet-4-6");
    assert.strictEqual(restoredTarget.effort, "high");
    assert.strictEqual(restoredTarget.handoff.sourceSessionId, "handoff-source-stable");

    var attached = handoffModule.attachSessionHandoff({
      cwd: projectDir,
      sm: restored,
      isMate: false,
    });
    var result = await attached.getToolDefs(restoredTarget)[0].handler({});
    assert.strictEqual(result.isError, undefined);
    assert.match(resultText(result), /Keep this restart-safe context/);
    assert.match(resultText(result), /The source work is still available/);
  } finally {
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
    if (typeof priorClayHome === "string") process.env.CLAY_HOME = priorClayHome;
    else delete process.env.CLAY_HOME;
    clearSessionModuleCache();
    fs.rmSync(clayHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
