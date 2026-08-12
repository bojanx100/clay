// Tests for the switch_provider tool gate (provider-switch-request.js).
//
// The invariant under test: THE MODEL NEVER SWITCHES PROVIDERS ITSELF. Its
// tool call can only post a confirmation card; the switch executor runs
// exclusively from the user's approval callback, with the same model
// suggestion /provider would pick, and auto-continues afterwards.
process.env.CLAY_DISABLE_RECOVERY_LOG = "1";
var test = require("node:test");
var assert = require("node:assert");

var { attachProviderSwitchRequest } = require("../lib/provider-switch-request");

function makeSession(overrides) {
  return Object.assign({
    localId: 7,
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    isProcessing: false,
    history: [],
    pendingUserDialogs: null,
  }, overrides || {});
}

function makeHarness(sessionOverrides, switcherOverrides) {
  var session = makeSession(sessionOverrides);
  var recorded = [];
  var switches = [];
  var continues = [];
  var sm = {
    getActiveSession: function () { return session; },
    sendAndRecord: function (s, obj) { recorded.push(obj); },
  };
  var codexRoute = { id: "codex-openai", vendor: "codex", label: "Codex via OpenAI", enabled: true };
  var switcher = Object.assign({
    resolveSwitchTargetRoute: function (target) {
      return target === "codex" || target === "codex-openai" ? codexRoute : null;
    },
    providerTargetsSummary: function () { return "targets: codex-openai"; },
    suggestionForRoute: function () {
      return { model: "gpt-5.5", match: "comparable", sourceModel: "claude-opus-4-8" };
    },
    executeProviderSwitch: function (params) {
      switches.push(params);
      return { ok: true, toVendor: params.targetVendor, label: "Codex via OpenAI" };
    },
  }, switcherOverrides || {});
  var scheduledMessages = {
    continueAfterProviderSwitch: function (s, prompt, display, label) {
      continues.push({ prompt: prompt, display: display, label: label });
      return true;
    },
  };
  var gate = attachProviderSwitchRequest({ sm: sm, switcher: switcher, scheduledMessages: scheduledMessages });
  return { gate: gate, session: session, recorded: recorded, switches: switches, continues: continues };
}

function pendingDialog(session) {
  var keys = session.pendingUserDialogs ? Object.keys(session.pendingUserDialogs) : [];
  return keys.length === 1 ? session.pendingUserDialogs[keys[0]] : null;
}

test("a valid request posts a confirmation card and does NOT switch", function () {
  var h = makeHarness();
  var result = h.gate.requestSwitch({ target: "codex", reason: "I keep failing at this refactor" });
  assert.ok(!result.isError, "tool call succeeds");
  assert.ok(result.content[0].text.indexOf("End your turn") !== -1, "model told to end its turn");
  assert.strictEqual(h.switches.length, 0, "no switch executed by the tool call itself");
  var dialog = null;
  for (var i = 0; i < h.recorded.length; i++) {
    if (h.recorded[i].type === "user_dialog_request") dialog = h.recorded[i];
  }
  assert.ok(dialog, "confirmation card recorded");
  assert.strictEqual(dialog.dialogKind, "switch_provider");
  assert.ok(dialog.payload.message.indexOf("I keep failing") !== -1, "model's reason shown to the user");
  assert.ok(dialog.payload.message.indexOf("gpt-5.5") !== -1, "suggested model shown");
  assert.ok(pendingDialog(h.session), "pending dialog registered for the WS response path");
});

test("user approval executes the switch with model-request attribution and auto-continues", function (t, done) {
  var h = makeHarness();
  h.gate.requestSwitch({ target: "codex", reason: "need a stronger model" });
  var pending = pendingDialog(h.session);
  pending.resolve({ behavior: "completed" });
  setTimeout(function () {
    assert.strictEqual(h.switches.length, 1, "switch executed once");
    assert.strictEqual(h.switches[0].trigger, "model-request");
    assert.strictEqual(h.switches[0].initiatedBy.source, "switch-provider-tool");
    assert.strictEqual(h.switches[0].targetModel, "gpt-5.5", "uses the /provider-grade suggestion");
    assert.strictEqual(h.continues.length, 1, "auto-continue scheduled");
    done();
  }, 20);
});

test("user decline records a notice and never switches", function (t, done) {
  var h = makeHarness();
  h.gate.requestSwitch({ target: "codex", reason: "want to switch" });
  pendingDialog(h.session).resolve({ behavior: "cancelled" });
  setTimeout(function () {
    assert.strictEqual(h.switches.length, 0, "no switch on decline");
    var declined = false;
    for (var i = 0; i < h.recorded.length; i++) {
      if (h.recorded[i].type === "info" && String(h.recorded[i].text).indexOf("declined") !== -1) declined = true;
    }
    assert.ok(declined, "decline notice recorded");
    done();
  }, 20);
});

test("approval waits for the requesting turn to end before switching", function (t, done) {
  var h = makeHarness({ isProcessing: true });
  h.gate.requestSwitch({ target: "codex", reason: "stuck" });
  pendingDialog(h.session).resolve({ behavior: "completed" });
  setTimeout(function () {
    assert.strictEqual(h.switches.length, 0, "no switch while the turn is still processing");
    var queuedNotice = false;
    for (var i = 0; i < h.recorded.length; i++) {
      if (h.recorded[i].type === "info" && String(h.recorded[i].text).indexOf("waiting for the current turn") !== -1) queuedNotice = true;
    }
    assert.ok(queuedNotice, "user told the switch is queued behind the running turn");
    h.session.isProcessing = false;
  }, 50);
  setTimeout(function () {
    assert.strictEqual(h.switches.length, 1, "switch runs once the turn ended");
    done();
  }, 400);
});

test("unknown target returns an error with the targets summary and posts nothing", function () {
  var h = makeHarness();
  var result = h.gate.requestSwitch({ target: "gemini", reason: "why not" });
  assert.ok(result.isError);
  assert.ok(result.content[0].text.indexOf("targets: codex-openai") !== -1);
  assert.ok(!pendingDialog(h.session), "no confirmation card posted");
});

test("no comparable model refuses and points at the manual escape hatch", function () {
  var h = makeHarness(null, {
    suggestionForRoute: function () { return { model: null, match: "none", sourceModel: "claude-opus-4-8" }; },
  });
  var result = h.gate.requestSwitch({ target: "codex", reason: "try codex" });
  assert.ok(result.isError);
  assert.ok(result.content[0].text.indexOf("/switch codex-openai") !== -1);
  assert.strictEqual(h.switches.length, 0);
});

test("missing target or reason is rejected", function () {
  var h = makeHarness();
  assert.ok(h.gate.requestSwitch({ target: "codex" }).isError, "reason required");
  assert.ok(h.gate.requestSwitch({ reason: "because" }).isError, "target required");
});

test("autonomous loop sessions cannot request switches", function () {
  var h = makeHarness({ loop: { active: true, role: "worker" } });
  var result = h.gate.requestSwitch({ target: "codex", reason: "stuck" });
  assert.ok(result.isError);
  assert.ok(result.content[0].text.indexOf("autonomous") !== -1);
});

test("requesting the current provider is a no-op error", function () {
  var h = makeHarness(null, {
    resolveSwitchTargetRoute: function () {
      return { id: "claude-anthropic", vendor: "claude", label: "Claude via Anthropic", enabled: true };
    },
  });
  var result = h.gate.requestSwitch({ target: "claude", reason: "switch to claude" });
  assert.ok(result.isError);
  assert.ok(result.content[0].text.indexOf("already on") !== -1);
});

test("a coordinator-authorized switch runs immediately with durable attribution", function () {
  var h = makeHarness();
  var result = h.gate.switchControlledSession({
    session: h.session,
    target: "codex-openai",
    model: "gpt-5.5",
    reason: "GitHub Copilot quota exhausted",
    idempotencyKey: "portfolio-task-r1-switch-openai",
    sourceSessionStorageId: "coop-home",
    portfolioTaskId: "portfolio-task",
    bindingRevision: 1,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(h.switches.length, 1);
  assert.strictEqual(h.switches[0].trigger, "coordinator-request");
  assert.strictEqual(h.switches[0].initiatedBy.source, "coop-coordinator");
  assert.strictEqual(h.switches[0].targetRouteId, "codex-openai");
  assert.strictEqual(h.switches[0].targetModel, "gpt-5.5");
  assert.strictEqual(h.switches[0].idempotencyKey, "portfolio-task-r1-switch-openai");
  assert.match(h.switches[0].routingRationale, /portfolio-task revision 1/);
  assert.strictEqual(h.continues.length, 1);
});

test("a coordinator-authorized switch refuses to mutate a processing session", function () {
  var h = makeHarness({ isProcessing: true });
  var result = h.gate.switchControlledSession({
    session: h.session,
    target: "codex-openai",
    model: "gpt-5.5",
    reason: "quota exhausted",
    idempotencyKey: "switch-processing",
    sourceSessionStorageId: "coop-home",
    portfolioTaskId: "portfolio-task",
    bindingRevision: 1,
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "processing");
  assert.strictEqual(h.switches.length, 0);
});
