var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var assert = require("node:assert/strict");

var userMessage = require("../lib/project-user-message");
var accessModule = require("../lib/project-user-message-access");

test("Coop-channel access preserves project, owner, hidden, and direct-session boundaries", function () {
  var users = {
    isMultiUser: function () { return true; },
    canAccessSession: function (id, session) { return id === session.ownerId; },
  };
  var options = { getProjectList: function (id) {
    return id === "owner-a" || id === "owner-b" ? [{ slug: "webapp" }] : [];
  } };
  var channel = { ownerId: "owner-a", coopChannel: { projectSlug: "webapp" } };
  assert.equal(userMessage.canAccessCoopChannel(channel, { _clayUser: { id: "owner-a" } }, options, users, "lead"), true);
  assert.equal(userMessage.canAccessCoopChannel(channel, { _clayUser: { id: "owner-b" } }, options, users, "lead"), false);
  assert.equal(userMessage.canAccessCoopChannel(channel, { _clayUser: { id: "owner-a" } }, options, users, "webapp"), false);
  assert.equal(userMessage.canAccessCoopChannel({ hidden: true }, {}, options, users, "lead"), true);
  assert.equal(userMessage.canAccessCoopChannel({ ownerId: "owner-a" }, {}, options, users, "lead"), true);

  var hidden = { localId: 1, hidden: true, coopChannel: { projectSlug: "webapp" } };
  var owned = { localId: 2, ownerId: "owner-b", coopChannel: { projectSlug: "webapp" } };
  var sessions = new Map([[1, hidden], [2, owned]]);
  var access = accessModule.attachProjectUserMessageAccess({
    sm: { sessions: sessions }, opts: options, usersModule: users, slug: "lead",
    getSessionForWs: function () { return hidden; },
  });
  assert.equal(access.getSessionForMessage({ _clayUser: { id: "owner-a" } }, { sessionId: 1 }), null);
  assert.equal(access.getSessionForMessage({ _clayUser: { id: "owner-a" } }, { sessionId: 2 }), null);
  assert.equal(access.getSessionForMessage({ _clayUser: { id: "owner-b" } }, { sessionId: 2 }).localId, 2);
});

function accessHarness(cwd) {
  return accessModule.attachProjectUserMessageAccess({
    cwd: cwd,
    imagesDir: path.join(cwd, "images"),
    sm: { sessions: new Map() },
    opts: {},
    usersModule: { isMultiUser: function () { return false; } },
    slug: "test",
    getSessionForWs: function () { return null; },
  });
}

test("handoff recovery rebuilds vendor context, honors package pointers, and never revives consumed/native sessions", function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-user-message-access-"));
  var storageId = "stable-session";
  var packageDir = path.join(cwd, ".clay", "handoffs", storageId);
  fs.mkdirSync(path.join(packageDir, "images"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "transcript.md"), "# complete transcript\n", "utf8");

  var recovered = {
    storageId: storageId,
    vendor: "codex",
    history: [
      { type: "user_message", text: "Earlier request" },
      { type: "delta", text: "Earlier answer" },
      { type: "vendor_switched", fromVendor: "claude", toVendor: "codex" },
    ],
  };
  var api = accessHarness(cwd);
  api.recoverHandoffContextForSend(recovered);
  assert.ok(recovered.handoffContext);
  assert.match(recovered.handoffContext, /Earlier request/);
  assert.match(recovered.handoffContext, /COMPLETE untruncated transcript/);
  assert.equal(recovered.handoffContextRecovered, true);
  assert.equal(recovered.handoffContextTurnsRemaining, 4);

  var withNativeOutput = {
    vendor: "codex",
    history: [
      { type: "user_message", text: "Earlier" },
      { type: "vendor_switched", fromVendor: "claude", toVendor: "codex" },
      { type: "delta", text: "Native output" },
    ],
  };
  api.recoverHandoffContextForSend(withNativeOutput);
  assert.equal(withNativeOutput.handoffContext, undefined);

  var consumed = {
    vendor: "codex", handoffContextConsumed: true,
    history: [{ type: "user_message", text: "Earlier" }, { type: "vendor_switched" }],
  };
  api.recoverHandoffContextForSend(consumed);
  assert.equal(consumed.handoffContext, undefined);
});
