var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { attachProjectSessionsHandoff } = require("../lib/project-sessions-handoff");
var yoke = require("../lib/yoke");

function makeHarness(session) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-sessions-handoff-"));
  var sent = [];
  var sm = {
    sessions: new Map([[session.localId, session]]),
    availableVendors: ["claude", "codex"],
    installedVendors: ["claude", "codex"],
    modelsByVendor: {
      claude: ["claude-opus-4.8"],
      codex: ["gpt-5.5"],
    },
    verifiedModelsByRoute: {
      "claude-anthropic": ["claude-opus-4.8"],
      "codex-openai": ["gpt-5.5"],
    },
    appendToSessionFile: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    sendAndRecord: function (target, entry) { target.history.push(entry); },
  };
  var handoff = attachProjectSessionsHandoff({
    cwd: root,
    sm: sm,
    adapters: {},
    sendTo: function (ws, message) { sent.push(message); },
    sendToSession: function () {},
    usersModule: {
      isMultiUser: function () { return false; },
      canAccessSession: function () { return true; },
    },
    getSessionForWs: function () { return session; },
    cancelScheduledMessage: function () {},
    clearPendingQueuedMessages: function () {},
    sendConfigForSession: function () {},
  });
  return { root: root, sent: sent, handoff: handoff };
}

function makeSession(vendor, routeId, model) {
  return {
    localId: 1,
    vendor: vendor,
    providerRouteId: routeId,
    model: model,
    requestedModel: model,
    verifiedModel: model,
    history: [{ type: "user_message", text: "Continue the task", _ts: 1 }],
    isProcessing: false,
    cliSessionId: null,
  };
}

test("UI handoffs treat the current model as a source hint, not a target override", function () {
  var cases = [
    {
      source: "config-popup",
      session: makeSession("claude", "claude-anthropic", "claude-opus-4.8"),
      targetVendor: "codex",
      targetRouteId: "codex-openai",
      expectedModel: "gpt-5.5",
    },
    {
      source: "sidebar-menu",
      session: makeSession("codex", "codex-openai", "gpt-5.5"),
      targetVendor: "claude",
      targetRouteId: "claude-anthropic",
      expectedModel: "claude-opus-4.8",
    },
  ];

  for (var i = 0; i < cases.length; i++) {
    var item = cases[i];
    var harness = makeHarness(item.session);
    try {
      harness.handoff.handleHandoffMessage({}, {
        type: "handoff_session",
        targetVendor: item.targetVendor,
        targetRouteId: item.targetRouteId,
        targetModel: item.session.model,
        source: item.source,
      });

      assert.strictEqual(item.session.vendor, item.targetVendor);
      assert.strictEqual(item.session.providerRouteId, item.targetRouteId);
      assert.strictEqual(item.session.model, item.expectedModel);
      assert.strictEqual(harness.sent[harness.sent.length - 1].level, "info");
    } finally {
      fs.rmSync(harness.root, { recursive: true, force: true });
    }
  }
});

test("non-UI handoffs retain explicit target-model validation", function () {
  var session = makeSession("claude", "claude-anthropic", "claude-opus-4.8");
  var harness = makeHarness(session);
  try {
    harness.handoff.handleHandoffMessage({}, {
      type: "handoff_session",
      targetVendor: "codex",
      targetRouteId: "codex-openai",
      targetModel: "claude-opus-4.8",
      source: "automation",
    });

    assert.strictEqual(session.vendor, "claude");
    assert.strictEqual(session.providerRouteId, "claude-anthropic");
    assert.strictEqual(harness.sent[harness.sent.length - 1].level, "warn");
    assert.match(harness.sent[harness.sent.length - 1].message, /not present in the verified catalog/);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("provider switch UI actions leave target-model selection to the server", function () {
  var panels = fs.readFileSync(path.join(__dirname, "../lib/public/modules/app-panels.js"), "utf8");
  var sidebar = fs.readFileSync(path.join(__dirname, "../lib/public/modules/sidebar-sessions-context-menu.js"), "utf8");

  assert.match(panels, /handoff_session[^\n]+source: "config-popup"/);
  assert.doesNotMatch(panels.match(/handoff_session[^\n]+source: "config-popup"/)[0], /targetModel/);
  assert.match(sidebar, /handoff_session[^\n]+source: "sidebar-menu"/);
  assert.doesNotMatch(sidebar.match(/handoff_session[^\n]+source: "sidebar-menu"/)[0], /targetModel/);
});

test("provider refresh reports each failed runtime and continues verifying the rest", async function () {
  var originalInstalled = yoke.checkInstalled;
  var originalAuth = yoke.checkAuth;
  var sent = [];
  var calls = [];
  var sm = {
    sessions: new Map(),
    modelsByVendor: {},
    providerVerificationByVendor: {},
  };
  yoke.checkInstalled = function () { return { claude: true, qwen: true }; };
  yoke.checkAuth = function () { return { claude: true, qwen: true }; };
  try {
    var handoff = attachProjectSessionsHandoff({
      cwd: "/tmp/provider-refresh",
      slug: "provider-refresh",
      adapters: { claude: {}, qwen: {} },
      sdk: {
        refreshVendor: async function (vendor) {
          calls.push(vendor);
          if (vendor === "claude") {
            sm.providerVerificationByVendor.claude = {
              status: "error",
              error: "Authentication required",
            };
            throw new Error("Authentication required");
          }
          sm.modelsByVendor.qwen = ["auto"];
          sm.verifiedModelsByRoute = {
            "qwen-alibaba": { models: ["auto"], verified: true, source: "live-initialization" },
          };
          sm.providerVerificationByVendor.qwen = {
            status: "ready",
            modelCount: 1,
          };
        },
      },
      sm: sm,
      sendTo: function (ws, message) { sent.push(message); },
      sendToSession: function () {},
      usersModule: { isMultiUser: function () { return false; } },
      getSessionForWs: function () { return { vendor: "qwen" }; },
      cancelScheduledMessage: function () {},
      clearPendingQueuedMessages: function () {},
      sendConfigForSession: function () {},
    });

    handoff.handleHandoffMessage({}, { type: "refresh_vendors" });
    await new Promise(function (resolve) { setImmediate(function () { setImmediate(resolve); }); });

    assert.deepStrictEqual(calls, ["claude", "qwen"]);
    assert.ok(sent.some(function (message) { return message.type === "provider_status"; }));
    var warning = sent.filter(function (message) { return message.type === "toast" && message.level === "warn"; }).pop();
    assert.ok(warning);
    assert.match(warning.message, /1 provider/);
    assert.match(warning.detail, /claude: Authentication required/);
  } finally {
    yoke.checkInstalled = originalInstalled;
    yoke.checkAuth = originalAuth;
  }
});

test("a stalled provider verification times out and does not block later providers", async function () {
  var originalInstalled = yoke.checkInstalled;
  var originalAuth = yoke.checkAuth;
  var calls = [];
  var sent = [];
  var handoffState = { sessions: new Map(), modelsByVendor: {}, providerVerificationByVendor: {} };
  yoke.checkInstalled = function () { return { claude: true, qwen: true }; };
  yoke.checkAuth = function () { return { claude: true, qwen: true }; };
  try {
    var handoff = attachProjectSessionsHandoff({
      cwd: "/tmp/provider-refresh-timeout",
      slug: "provider-refresh-timeout",
      adapters: { claude: {}, qwen: {} },
      providerRefreshTimeoutMs: 5,
      sdk: {
        refreshVendor: function (vendor) {
          calls.push(vendor);
          if (vendor === "claude") return new Promise(function () {});
          handoffState.providerVerificationByVendor.qwen = { status: "ready", modelCount: 1 };
          return Promise.resolve();
        },
      },
      sm: handoffState,
      sendTo: function (ws, message) { sent.push(message); },
      sendToSession: function () {},
      usersModule: { isMultiUser: function () { return false; } },
      getSessionForWs: function () { return { vendor: "qwen" }; },
      cancelScheduledMessage: function () {},
      clearPendingQueuedMessages: function () {},
      sendConfigForSession: function () {},
    });

    handoff.handleHandoffMessage({}, { type: "refresh_vendors" });
    await new Promise(function (resolve) { setTimeout(resolve, 20); });

    assert.deepStrictEqual(calls, ["claude", "qwen"]);
    var warning = sent.filter(function (message) { return message.type === "toast" && message.level === "warn"; }).pop();
    assert.ok(warning);
    assert.match(warning.detail, /Timed out while verifying claude/);
  } finally {
    yoke.checkInstalled = originalInstalled;
    yoke.checkAuth = originalAuth;
  }
});
