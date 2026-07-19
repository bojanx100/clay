// Tests for the extracted provider-switch executor and provider commands.
//
// The executor is the single producer of vendor_switched entries; these tests
// pin its guard behavior (idempotence, processing refusal, unavailable
// vendor), the success path's session mutations + recorded entry shape
// (trigger/tier), and the /switch target resolution + info notices.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { attachProviderSwitch } = require("../lib/provider-switch");
var copilotEntitlements = require("../lib/yoke/adapters/github-copilot-entitlements");
require("../lib/recovery-log").recordRecoveryEvent = function () {};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-provider-switch-"));
}

function makeSm(overrides) {
  var sm = {
    availableVendors: ["claude", "codex"],
    installedVendors: ["claude", "codex"],
    providerRoutes: null,
    modelsByVendor: { claude: ["claude-opus-4.8"], codex: ["gpt-5.5"] },
    recorded: [],
    sendAndRecord: function (session, obj) {
      session.history.push(obj);
      sm.recorded.push(obj);
    },
    appendToSessionFile: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
  };
  return Object.assign(sm, overrides || {});
}

function makeSession(overrides) {
  return Object.assign({
    localId: 1,
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    model: "claude-opus-4.8",
    history: [{ type: "user_message", text: "build the widget", _ts: 1 }],
    isProcessing: false,
    cliSessionId: null,
  }, overrides || {});
}

function makeSwitcher(sm, extra) {
  var ctx = Object.assign({
    cwd: tmpDir(),
    imagesDir: null,
    sm: sm,
    sendTo: function () {},
    sendToSession: function () {},
    sendConfigForSession: function () {},
    cancelScheduledMessage: function () {},
    clearPendingQueuedMessages: function () {},
  }, extra || {});
  return attachProviderSwitch(ctx);
}

function lastEntryOfType(session, type) {
  for (var i = session.history.length - 1; i >= 0; i--) {
    if (session.history[i] && session.history[i].type === type) return session.history[i];
  }
  return null;
}

test("same vendor+route is a no-op and records nothing", function () {
  var sm = makeSm();
  var switcher = makeSwitcher(sm);
  var session = makeSession();
  var before = session.history.length;
  var result = switcher.executeProviderSwitch({
    session: session,
    targetVendor: "claude",
    targetRouteId: "claude-anthropic",
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "same-target");
  assert.strictEqual(session.history.length, before, "no history entry appended");
  assert.strictEqual(session.vendor, "claude");
});

test("refuses while processing unless allowWhileProcessing is set", function () {
  var sm = makeSm();
  var switcher = makeSwitcher(sm);
  var session = makeSession({ isProcessing: true });
  var refused = switcher.executeProviderSwitch({
    session: session,
    targetVendor: "codex",
  });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, "processing");
  assert.strictEqual(session.vendor, "claude", "session untouched");

  var forced = switcher.executeProviderSwitch({
    session: session,
    targetVendor: "codex",
    allowWhileProcessing: true,
  });
  assert.strictEqual(forced.ok, true);
  assert.strictEqual(session.vendor, "codex");
});

test("refuses a vendor without a runnable adapter", function () {
  var sm = makeSm({ availableVendors: ["claude"] });
  var switcher = makeSwitcher(sm);
  var session = makeSession();
  var result = switcher.executeProviderSwitch({
    session: session,
    targetVendor: "codex",
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "vendor-unavailable");
  assert.ok(result.message.indexOf("not available") !== -1);
  assert.strictEqual(session.vendor, "claude", "session untouched");
});

test("successful switch mutates session and records vendor_switched with trigger/tier", function () {
  var sm = makeSm();
  var sent = [];
  var switcher = makeSwitcher(sm, {
    sendToSession: function (localId, obj) { sent.push(obj); },
  });
  var session = makeSession({ cliSessionId: null });
  var result = switcher.executeProviderSwitch({
    session: session,
    targetVendor: "codex",
    trigger: "manual",
    initiatedBy: { source: "test", userId: "u1" },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(session.vendor, "codex");
  assert.strictEqual(session.providerRouteId, "codex-openai");
  assert.strictEqual(session.cliSessionId, null, "fresh native session");
  assert.strictEqual(session.mode, "gui");
  assert.ok(session.handoffContext, "Tier-1 brief stashed for next send");

  var entry = lastEntryOfType(session, "vendor_switched");
  assert.ok(entry, "vendor_switched recorded");
  assert.strictEqual(entry.fromVendor, "claude");
  assert.strictEqual(entry.toVendor, "codex");
  assert.strictEqual(entry.trigger, "manual");
  assert.strictEqual(entry.tier, "brief");
  assert.strictEqual(entry.initiatedBy.source, "test");
  assert.strictEqual(entry.initiatedBy.userId, "u1");

  var pushed = false;
  for (var i = 0; i < sent.length; i++) {
    if (sent[i].type === "vendor_switched") pushed = true;
  }
  assert.ok(pushed, "divider pushed to session subscribers");
});

test("executor is idempotent: repeating the same switch is a no-op", function () {
  var sm = makeSm();
  var switcher = makeSwitcher(sm);
  var session = makeSession();
  var first = switcher.executeProviderSwitch({ session: session, targetVendor: "codex" });
  assert.strictEqual(first.ok, true);
  var count = session.history.length;
  var second = switcher.executeProviderSwitch({ session: session, targetVendor: "codex" });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, "same-target");
  assert.strictEqual(session.history.length, count, "no duplicate vendor_switched");
});

test("parseSwitchCommand detects command forms", function () {
  var switcher = makeSwitcher(makeSm());
  assert.strictEqual(switcher.parseSwitchCommand("fix the bug"), null);
  assert.strictEqual(switcher.parseSwitchCommand("/switched wording"), null);
  assert.deepStrictEqual(switcher.parseSwitchCommand("/switch"), { list: true });
  assert.deepStrictEqual(switcher.parseSwitchCommand("  /switch  "), { list: true });
  assert.deepStrictEqual(switcher.parseSwitchCommand("/switch codex"), { target: "codex" });
  assert.deepStrictEqual(switcher.parseSwitchCommand("/SWITCH Codex via OpenAI"), { target: "Codex via OpenAI" });
});

test("parseProviderCommand detects safe provider command forms", function () {
  var switcher = makeSwitcher(makeSm());
  assert.strictEqual(switcher.parseProviderCommand("/switch codex"), null);
  assert.deepStrictEqual(switcher.parseProviderCommand("/provider"), { list: true });
  assert.deepStrictEqual(switcher.parseProviderCommand(" /PROVIDER copilot "), { target: "copilot" });
});

test("resolveSwitchTargetRoute resolves vendors, route ids, aliases, and label prefixes", function () {
  var switcher = makeSwitcher(makeSm());
  var session = makeSession();
  assert.strictEqual(switcher.resolveSwitchTargetRoute("codex", session).id, "codex-openai");
  assert.strictEqual(switcher.resolveSwitchTargetRoute("claude", session).id, "claude-anthropic");
  assert.strictEqual(switcher.resolveSwitchTargetRoute("claude-github-copilot", session).id, "claude-github-copilot");
  // Copilot alias follows the source session's model family (claude here).
  assert.strictEqual(switcher.resolveSwitchTargetRoute("copilot", session).id, "claude-github-copilot");
  // Label prefix, case-insensitive.
  assert.strictEqual(switcher.resolveSwitchTargetRoute("codex via openai", session).id, "codex-openai");
  assert.strictEqual(switcher.resolveSwitchTargetRoute("gemini", session), null);
});

test("unknown /switch target records an info notice and does not switch", function () {
  var sm = makeSm();
  var switcher = makeSwitcher(sm);
  var session = makeSession();
  var consumed = switcher.handleSwitchCommand(null, session, "/switch gemini");
  assert.strictEqual(consumed, true, "command consumed, never reaches the model");
  assert.strictEqual(session.vendor, "claude", "no switch happened");
  var notice = lastEntryOfType(session, "info");
  assert.ok(notice, "info notice recorded");
  assert.ok(notice.text.indexOf("Unknown switch target") !== -1);
  assert.ok(notice.text.indexOf("codex-openai") !== -1, "lists valid targets");
});

test("bare /switch lists targets with current marker and health", function () {
  var sm = makeSm();
  var switcher = makeSwitcher(sm);
  var session = makeSession();
  var consumed = switcher.handleSwitchCommand(null, session, "/switch");
  assert.strictEqual(consumed, true);
  var notice = lastEntryOfType(session, "info");
  assert.ok(notice, "info notice recorded");
  assert.ok(notice.text.indexOf("claude-anthropic") !== -1);
  assert.ok(notice.text.indexOf("current") !== -1, "marks the current route");
});

test("/switch to a valid target executes the switch with chat-command attribution", function () {
  var sm = makeSm();
  var toasts = [];
  var switcher = makeSwitcher(sm, {
    sendTo: function (ws, obj) { toasts.push(obj); },
  });
  var session = makeSession();
  var consumed = switcher.handleSwitchCommand({ _clayUser: { id: "u9" } }, session, "/switch codex");
  assert.strictEqual(consumed, true);
  assert.strictEqual(session.vendor, "codex");
  var entry = lastEntryOfType(session, "vendor_switched");
  assert.strictEqual(entry.trigger, "manual");
  assert.strictEqual(entry.initiatedBy.source, "chat-command");
  assert.strictEqual(entry.initiatedBy.userId, "u9");
  assert.ok(toasts.length > 0 && toasts[0].type === "toast", "success toast sent");
});

test("/provider uses the exact organization-enabled model on Copilot", function () {
  copilotEntitlements._test.setSnapshot(["auto", "claude-fable-5", "claude-opus-4.8"]);
  var sm = makeSm({
    availableVendors: ["claude", "github-copilot"],
    installedVendors: ["claude", "github-copilot"],
    modelsByVendor: { claude: ["fable"], "github-copilot": ["claude-opus-4.8"] },
  });
  var switcher = makeSwitcher(sm);
  var session = makeSession({ model: "fable" });

  var consumed = switcher.handleProviderCommand(null, session, "/provider copilot");

  assert.strictEqual(consumed, true);
  assert.strictEqual(session.vendor, "github-copilot");
  assert.strictEqual(session.providerRouteId, "claude-github-copilot");
  assert.strictEqual(session.model, "claude-fable-5");
  assert.strictEqual(lastEntryOfType(session, "vendor_switched").initiatedBy.source, "provider-command");
  copilotEntitlements._test.reset();
});

test("/provider chooses the closest comparable model when exact is unavailable", function () {
  var sm = makeSm({
    modelsByVendor: { claude: ["fable"], codex: ["gpt-5.5", "gpt-5.6-sol"] },
    serverDefaultModelsByVendor: { codex: "gpt-5.5" },
  });
  var switcher = makeSwitcher(sm);
  var session = makeSession({ model: "fable" });

  var consumed = switcher.handleProviderCommand(null, session, "/provider openai");

  assert.strictEqual(consumed, true);
  assert.strictEqual(session.vendor, "codex");
  assert.strictEqual(session.model, "gpt-5.6-sol");
});

test("/provider refuses a silent downgrade and points to the permissive command", function () {
  copilotEntitlements._test.setSnapshot(["auto", "claude-opus-4.8"]);
  var sm = makeSm({
    availableVendors: ["claude", "github-copilot"],
    installedVendors: ["claude", "github-copilot"],
    modelsByVendor: { claude: ["fable"], "github-copilot": ["claude-opus-4.8"] },
  });
  var switcher = makeSwitcher(sm);
  var session = makeSession({ model: "fable" });

  var consumed = switcher.handleProviderCommand(null, session, "/provider copilot");

  assert.strictEqual(consumed, true);
  assert.strictEqual(session.vendor, "claude");
  var notice = lastEntryOfType(session, "info");
  assert.ok(notice.text.indexOf("No exact or comparable model") !== -1);
  assert.ok(notice.text.indexOf("/switch claude-github-copilot") !== -1);
  copilotEntitlements._test.reset();
});

test("/provider keeps Copilot route families separate when comparing models", function () {
  copilotEntitlements._test.setSnapshot(["auto", "claude-fable-5", "gpt-5.5"]);
  var sm = makeSm({
    availableVendors: ["codex", "github-copilot"],
    installedVendors: ["codex", "github-copilot"],
    modelsByVendor: { codex: ["gpt-5.6-sol"], "github-copilot": ["claude-fable-5", "gpt-5.5"] },
  });
  var switcher = makeSwitcher(sm);
  var session = makeSession({ vendor: "codex", providerRouteId: "codex-openai", model: "gpt-5.6-sol" });

  var consumed = switcher.handleProviderCommand(null, session, "/provider copilot");

  assert.strictEqual(consumed, true);
  assert.strictEqual(session.vendor, "codex");
  assert.ok(lastEntryOfType(session, "info").text.indexOf("No exact or comparable model") !== -1);
  copilotEntitlements._test.reset();
});

test("bare /provider lists exact and comparable model choices", function () {
  var sm = makeSm({
    modelsByVendor: { claude: ["fable"], codex: ["gpt-5.5", "gpt-5.6-sol"] },
  });
  var switcher = makeSwitcher(sm);
  var session = makeSession({ model: "fable" });

  var consumed = switcher.handleProviderCommand(null, session, "/provider");

  assert.strictEqual(consumed, true);
  var notice = lastEntryOfType(session, "info");
  assert.ok(notice.text.indexOf("without downgrading") !== -1);
  assert.ok(notice.text.indexOf("gpt-5.6-sol (comparable)") !== -1);
});

test("non-switch text is not consumed by handleSwitchCommand", function () {
  var switcher = makeSwitcher(makeSm());
  var session = makeSession();
  assert.strictEqual(switcher.handleSwitchCommand(null, session, "please switch to codex"), false);
  assert.strictEqual(session.vendor, "claude");
});

test("listProviderRoutes decorates routes with vendor health", function () {
  var providerHealth = require("../lib/provider-health");
  var { listProviderRoutes } = require("../lib/provider-routes");
  providerHealth._reset();
  var routes = listProviderRoutes(["claude", "codex"], ["claude", "codex"]);
  for (var i = 0; i < routes.length; i++) {
    assert.strictEqual(routes[i].health, "healthy");
  }
  providerHealth.recordFailure("codex", "transient: test", { now: 1000 });
  providerHealth.recordFailure("codex", "transient: test", { now: 2000 });
  providerHealth.recordFailure("codex", "transient: test", { now: 3000 });
  routes = listProviderRoutes(["claude", "codex"], ["claude", "codex"]);
  for (var j = 0; j < routes.length; j++) {
    if (routes[j].vendor === "codex") assert.strictEqual(routes[j].health, "unhealthy");
    if (routes[j].vendor === "claude") assert.strictEqual(routes[j].health, "healthy");
  }
  providerHealth._reset();
});
