var test = require("node:test");
var assert = require("node:assert");

var { attachProjectSessionsLifecycle } = require("../lib/project-sessions-lifecycle");

function makeLifecycle(modelsByVendor, serverDefaults) {
  var created = [];
  var sm = {
    defaultVendor: "claude",
    modelsByVendor: modelsByVendor,
    serverDefaultModelsByVendor: serverDefaults || {},
    serverDefaultMode: "default",
    serverDefaultEffort: "medium",
    createSession: function (opts) {
      var session = Object.assign({ localId: created.length + 1 }, opts);
      created.push(session);
      return session;
    },
  };
  var lifecycle = attachProjectSessionsLifecycle({
    slug: "test-project",
    sm: sm,
    tm: null,
    sendTo: function () {},
    usersModule: { isMultiUser: function () { return false; } },
    userPresence: { setPresence: function () {} },
    getSessionForWs: function () { return null; },
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function () {},
    broadcastPresence: function () {},
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    getClaudeOpenModeForWs: function () { return "gui"; },
    viewHandlers: {},
    tuiHandlers: {},
    email: { getEmailDefaults: function () { return []; } },
  });
  return { lifecycle: lifecycle, created: created };
}

test("ordinary new sessions use the strongest provider model by default", function () {
  var h = makeLifecycle({
    claude: [{ value: "default" }, { value: "best" }, { value: "claude-opus-4-8" }],
    codex: [{ value: "gpt-5.6-terra", isDefault: true }, { value: "gpt-5.6-sol" }],
  });
  var ws = {};

  assert.strictEqual(h.lifecycle.handleLifecycleMessage(ws, { type: "new_session", vendor: "claude" }), true);
  assert.strictEqual(h.created[0].model, "best");

  assert.strictEqual(h.lifecycle.handleLifecycleMessage(ws, { type: "new_session", vendor: "codex" }), true);
  assert.strictEqual(h.created[1].model, "gpt-5.6-sol");
});

test("ordinary new sessions preserve a configured model default", function () {
  var h = makeLifecycle({}, { claude: "claude-opus-4-8" });

  h.lifecycle.handleLifecycleMessage({}, { type: "new_session", vendor: "claude" });

  assert.strictEqual(h.created[0].model, "claude-opus-4-8");
});
