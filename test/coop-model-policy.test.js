var test = require("node:test");
var assert = require("node:assert/strict");

var policy = require("../lib/coop-model-policy");
var provenance = require("../lib/coop-control-provenance");
var providerHealth = require("../lib/provider-health");
var attachBridgeQueryStart = require("../lib/sdk-bridge-query-start").attachBridgeQueryStart;
var attachProjectSessionsSettings =
  require("../lib/project-sessions-settings").attachProjectSessionsSettings;

function states(values) {
  return function (designation) {
    return values[designation.id] || "healthy";
  };
}

test("canonical Coop prefers Astra for execution and Fable for hard judgment", function () {
  var active = policy.activeDesignations(policy.TOP_TIER_POLICY);
  var execution = policy.selectRoute("execution");
  var research = policy.selectRoute("research");
  var judgment = policy.selectRoute("architecture");

  assert.equal(policy.TOP_TIER_POLICY.version, 2);
  assert.deepEqual(active.filter(function (designation) {
    return designation.track === "execution";
  }).map(function (designation) { return designation.model; }), ["gpt-6-astra"]);
  assert.equal(execution.ok, true);
  assert.equal(execution.providerRouteId, "codex-openai");
  assert.equal(execution.model, "gpt-6-astra");
  assert.equal(research.model, "gpt-6-astra");
  assert.equal(judgment.ok, true);
  assert.equal(judgment.providerRouteId, "claude-anthropic");
  assert.equal(judgment.model, "fable");
});

test("degraded and unhealthy designated routes are unavailable to Coop", function () {
  var selected = policy.selectRoute("execution", {
    healthForCandidate: states({
      "codex-openai/gpt-6-astra": "degraded",
      "claude-anthropic/fable": "healthy",
    }),
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.model, "fable");

  var unavailable = policy.selectRoute("execution", {
    healthForCandidate: states({
      "codex-openai/gpt-6-astra": "degraded",
      "claude-anthropic/fable": "unhealthy",
    }),
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, "coop_top_tier_unavailable");
  assert.match(unavailable.message, /will not fall back/i);
});

// Canonical Coop is defined by coop-control-provenance as coopHome OR
// coopChannel. This policy scoped itself to coopHome only, so every canonical
// project Coop channel silently bypassed the no-degradation rule. These tests
// pin the scope to the provenance definition in both directions.
function projectChannel(extra) {
  var session = {
    localId: 7,
    coopChannel: {
      projectSlug: "clay",
      projectTitle: "Clay",
      projectPath: "/Users/bojansubotic/Desktop/clay",
    },
  };
  return Object.assign(session, extra || {});
}

test("canonical Coop scope follows coop-control-provenance, not coopHome alone", function () {
  var channel = projectChannel();

  assert.equal(provenance.isCanonicalCoopSession(channel), true,
    "provenance already treats a project Coop channel as canonical");
  assert.equal(policy.appliesToSession(channel), true,
    "the model policy must scope to the same canonical set as provenance");
  assert.equal(policy.appliesToSession({ coopHome: true }), true);

  // The scope must widen to canonical channels without swallowing ordinary
  // project sessions, which keep their existing unrestricted routing.
  assert.equal(policy.appliesToSession({ coordinationMode: true }), false);
  assert.equal(policy.appliesToSession({ orchestrationParent: { taskId: "worker-1" } }), false);
  assert.equal(policy.appliesToSession({ coopChannel: null }), false);
  assert.equal(policy.appliesToSession({}), false);
  assert.equal(policy.appliesToSession(null), false);
});

test("audit repro: warm canonical coopChannel turn on a lower tier is refused", function () {
  // Reproduces the gate's finding verbatim: a warm turn on a canonical project
  // Coop channel bound to codex-openai/gpt-5.4 was observed as
  // {policyScoped:false, accepted:true, pushed:1} -- the policy never engaged.
  var channel = projectChannel({
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.4",
  });

  var route = policy.currentSessionRoute(channel);
  var policyScoped = route.scoped !== false;

  assert.equal(policyScoped, true, "the turn must be in policy scope");
  assert.equal(route.ok, false, "gpt-5.4 is not a designated top-tier model");
  assert.equal(route.code, "coop_top_tier_required");

  var pushed = 0;
  var bridge = attachBridgeQueryStart({
    adapters: {},
    sm: {},
    vendorReadiness: { ensure: function () { return Promise.resolve({}); } },
  });
  channel.queryInstance = { pushMessage: function () { pushed += 1; } };

  var accepted = bridge.pushMessage(channel, "continue", null);

  assert.equal(accepted, false, "the warm turn must be refused, not accepted");
  assert.equal(pushed, 0, "no message may reach a lower-tier Coop route");
});

test("canonical coopChannel fails closed when no designated route is healthy", function () {
  var channel = projectChannel({
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    model: "fable",
  });
  var allDown = {
    healthForCandidate: states({
      "codex-openai/gpt-6-astra": "unhealthy",
      "claude-anthropic/fable": "unhealthy",
    }),
  };

  var route = policy.currentSessionRoute(channel, allDown);
  assert.equal(route.ok, false);
  assert.equal(route.code, "coop_top_tier_unavailable");
  assert.match(route.message, /will not fall back/i);

  // Fail closed rather than degrade: with both tracks down there is no
  // surviving lower-tier candidate anywhere in the result.
  var selected = policy.selectRoute(policy.purposeForSession(channel), allDown);
  assert.equal(selected.ok, false);
  assert.equal(selected.code, "coop_top_tier_unavailable");
  assert.equal(selected.model, undefined);
});

test("canonical coopChannel excludes a degraded route and keeps the healthy tier", function () {
  var channel = projectChannel();
  var selected = policy.selectRoute(policy.purposeForSession(channel), {
    healthForCandidate: states({
      "codex-openai/gpt-6-astra": "degraded",
      "claude-anthropic/fable": "healthy",
    }),
  });

  assert.equal(selected.ok, true);
  assert.equal(selected.model, "fable");
  assert.notEqual(selected.model, "gpt-6-astra");
});

test("governed successor preference applies on a canonical coopChannel too", function () {
  var successorPolicy = {
    version: 2,
    designations: policy.TOP_TIER_POLICY.designations.concat([{
      id: "claude-anthropic/fable-next",
      topTier: true,
      track: "judgment",
      generation: 2,
      vendor: "claude",
      providerRouteId: "claude-anthropic",
      model: "fable-next",
    }]),
  };
  var channel = projectChannel({
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    model: "fable",
  });

  var selected = policy.selectRoute("judgment", { policy: successorPolicy });
  assert.equal(selected.model, "fable-next");

  // The superseded model must not remain acceptable on a canonical channel.
  // provider-health collapses every "fable"-containing model onto one key, so
  // without an explicit superseded check the old Fable loosely matches its own
  // successor and keeps running as if it were compliant.
  var superseded = policy.currentSessionRoute(channel, { policy: successorPolicy });
  assert.equal(superseded.ok, false);
  assert.equal(superseded.code, "coop_top_tier_required");

  // ...but alias tolerance for the *active* designation must survive: a
  // verified concrete identity for the successor is still the successor.
  var verified = policy.currentSessionRoute(projectChannel({
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    verifiedModel: "claude-fable-next-20260901",
  }), { policy: successorPolicy });
  assert.equal(verified.ok, true);
  assert.equal(verified.model, "fable-next");
});

test("project coordinator and worker routing is unchanged by the widened scope", function () {
  var coordinator = {
    localId: 11,
    coordinationMode: true,
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.4",
  };
  var worker = {
    localId: 12,
    orchestrationParent: { taskId: "worker-1" },
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    model: "sonnet",
  };

  assert.deepEqual(policy.currentSessionRoute(coordinator), { ok: true, scoped: false });
  assert.deepEqual(policy.currentSessionRoute(worker), { ok: true, scoped: false });

  var pushed = 0;
  var bridge = attachBridgeQueryStart({
    adapters: {},
    sm: {},
    vendorReadiness: { ensure: function () { return Promise.resolve({}); } },
  });
  coordinator.queryInstance = { pushMessage: function () { pushed += 1; } };
  worker.queryInstance = { pushMessage: function () { pushed += 1; } };

  assert.equal(bridge.pushMessage(coordinator, "continue", null), true);
  assert.equal(bridge.pushMessage(worker, "continue", null), true);
  assert.equal(pushed, 2, "ordinary project sessions keep their existing routing");
});

test("canonical coopChannel surfaces unavailable through the real health store", async function (t) {
  // Cleanup must not depend on the assertions passing: a failure here would
  // otherwise leak recorded failures into every later test in this file.
  t.after(function () { providerHealth._reset(); });
  // Drives the real provider-health store rather than a healthForCandidate
  // stub: recordFailure is the actual mechanism by which an out-of-tokens
  // provider becomes unhealthy at runtime, so this exercises the live
  // fail-closed path instead of asserting against an injected answer.
  providerHealth._reset();
  providerHealth.recordFailure("codex", "Astra out of tokens", {
    providerRouteId: "codex-openai",
    model: "gpt-6-astra",
    immediate: true,
  });
  providerHealth.recordFailure("claude", "Fable unavailable", {
    providerRouteId: "claude-anthropic",
    model: "fable",
    immediate: true,
  });

  var recorded = [];
  var adapterStarts = 0;
  var sm = {
    modelsByVendor: {},
    ensureCoopTopTierRoute: function () { return policy.selectRoute("execution"); },
    broadcastSessionList: function () {},
  };
  var bridge = attachBridgeQueryStart({
    adapters: {},
    sm: sm,
    onProcessingChanged: function () {},
    sendAndRecord: function (session, item) { recorded.push(item); },
    vendorReadiness: {
      ensure: function () { adapterStarts += 1; return Promise.resolve({}); },
    },
  });
  var channel = projectChannel({
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-6-astra",
    isProcessing: true,
  });

  var result = await bridge.startQuery(channel, "continue", null, null);

  assert.deepEqual(result, { ok: false, reason: "coop_top_tier_unavailable" });
  assert.equal(adapterStarts, 0, "must not start an adapter on a degraded route");
  assert.equal(channel.isProcessing, false);
  assert.match(recorded[0].text, /no designated top-tier route is healthy/i);
  assert.doesNotMatch(recorded[0].text, /gpt-5\.4|terra|luna|sonnet|haiku/i,
    "unavailable must be surfaced, never a lower-tier substitute");
});

test("lower-tier and non-native targets are rejected only for canonical Coop", function () {
  assert.equal(policy.appliesToSession({ coopHome: true }), true);
  assert.equal(policy.appliesToSession({ coordinationMode: true }), false);
  assert.equal(policy.appliesToSession({ orchestrationParent: { taskId: "worker-1" } }), false);

  var lower = policy.resolveTarget({
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.6-terra",
  });
  var copilot = policy.resolveTarget({
    vendor: "github-copilot",
    providerRouteId: "codex-github-copilot",
    model: "gpt-5.6-sol",
  });
  assert.equal(lower.code, "coop_top_tier_required");
  assert.equal(copilot.code, "coop_top_tier_required");
});

test("a designated successor supersedes its track without reopening the old route", function () {
  var successorPolicy = {
    version: 3,
    designations: policy.TOP_TIER_POLICY.designations.concat([{
      id: "codex-openai/gpt-6-sol",
      topTier: true,
      track: "execution",
      generation: 3,
      vendor: "codex",
      providerRouteId: "codex-openai",
      model: "gpt-6-sol",
    }]),
  };
  var selected = policy.selectRoute("execution", { policy: successorPolicy });
  assert.equal(selected.model, "gpt-6-sol");

  var old = policy.resolveTarget({
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-6-astra",
  }, { policy: successorPolicy });
  assert.equal(old.code, "coop_top_tier_required");

  var fallback = policy.selectRoute("execution", {
    policy: successorPolicy,
    healthForCandidate: states({
      "codex-openai/gpt-6-sol": "unhealthy",
      "codex-openai/gpt-6-astra": "healthy",
      "claude-anthropic/fable": "healthy",
    }),
  });
  assert.equal(fallback.model, "fable");
  assert.notEqual(fallback.model, "gpt-6-astra");
});

test("verified Fable identities remain equivalent to the governed Fable alias", function () {
  var resolved = policy.resolveTarget({
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    verifiedModel: "claude-fable-5",
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.model, "fable");

  var metaAlias = policy.resolveTarget({
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    model: "best",
  });
  assert.equal(metaAlias.code, "coop_top_tier_required",
    "best may resolve to Opus and therefore is not an exact Fable guarantee");
});

test("warm continuation refuses a degraded Coop route but leaves project sessions unchanged", function () {
  providerHealth._reset();
  providerHealth.recordFailure("codex", "transient Astra failure", {
    providerRouteId: "codex-openai",
    model: "gpt-6-astra",
  });
  var pushed = 0;
  var bridge = attachBridgeQueryStart({
    adapters: {},
    sm: {},
    vendorReadiness: { ensure: function () { return Promise.resolve({}); } },
  });
  var query = { pushMessage: function () { pushed += 1; } };
  var coop = {
    localId: 1,
    coopHome: true,
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-6-astra",
    queryInstance: query,
  };
  var worker = {
    localId: 2,
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-6-astra",
    queryInstance: query,
  };

  assert.equal(bridge.pushMessage(coop, "continue", null), false);
  assert.equal(pushed, 0);
  assert.equal(bridge.pushMessage(worker, "continue", null), true);
  assert.equal(pushed, 1);
  providerHealth._reset();
});

test("fresh Coop routing returns a typed unavailable result before adapter startup", async function () {
  providerHealth._reset();
  providerHealth.recordFailure("codex", "Astra unavailable", {
    providerRouteId: "codex-openai",
    model: "gpt-6-astra",
    immediate: true,
  });
  providerHealth.recordFailure("claude", "Fable unavailable", {
    providerRouteId: "claude-anthropic",
    model: "fable",
    immediate: true,
  });
  var recorded = [];
  var adapterStarts = 0;
  var sm = {
    modelsByVendor: {},
    ensureCoopTopTierRoute: function () {
      return policy.selectRoute("execution");
    },
    broadcastSessionList: function () {},
  };
  var bridge = attachBridgeQueryStart({
    adapters: {},
    sm: sm,
    onProcessingChanged: function () {},
    sendAndRecord: function (session, item) { recorded.push(item); },
    vendorReadiness: {
      ensure: function () {
        adapterStarts += 1;
        return Promise.resolve({});
      },
    },
  });
  var session = {
    localId: 3,
    coopHome: true,
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-6-astra",
    isProcessing: true,
  };

  var result = await bridge.startQuery(session, "continue", null, null);

  assert.deepEqual(result, { ok: false, reason: "coop_top_tier_unavailable" });
  assert.equal(adapterStarts, 0);
  assert.equal(session.isProcessing, false);
  assert.match(recorded[0].text, /no designated top-tier route is healthy/i);
  providerHealth._reset();
});

test("server and project defaults never rebind the canonical Coop session", function () {
  var session = {
    coopHome: true,
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-6-astra",
  };
  var setModelCalls = 0;
  var sm = {
    currentModel: "gpt-6-astra",
    defaultModelsByVendor: {},
    serverDefaultModelsByVendor: {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
  };
  var handler = attachProjectSessionsSettings({
    slug: "lead",
    sm: sm,
    sdk: { setModel: function () { setModelCalls += 1; } },
    send: function () {},
    sendTo: function () {},
    opts: {
      onSetServerDefaultModel: function () {},
      onSetProjectDefaultModel: function () {},
    },
    getSessionForWs: function () { return session; },
    sendConfigForSession: function () {},
    applyAutomationModeToSession: function () {},
    copilotRouteIdForModel: function () { return null; },
    isKnownCodexSession: function () { return false; },
  });

  assert.equal(handler.handleSettingsMessage({}, {
    type: "set_server_default_model",
    vendor: "codex",
    model: "gpt-5.6-terra",
  }), true);
  assert.equal(handler.handleSettingsMessage({}, {
    type: "set_project_default_model",
    vendor: "codex",
    model: "gpt-5.6-luna",
  }), true);
  assert.equal(session.model, "gpt-6-astra");
  assert.equal(setModelCalls, 0);
  assert.equal(sm.serverDefaultModelsByVendor.codex, "gpt-5.6-terra");
  assert.equal(sm.defaultModelsByVendor.codex, "gpt-5.6-luna");
});
