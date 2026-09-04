var test = require("node:test");
var assert = require("node:assert/strict");

var policy = require("../lib/coop-model-policy");
var providerHealth = require("../lib/provider-health");
var attachBridgeQueryStart = require("../lib/sdk-bridge-query-start").attachBridgeQueryStart;

function states(values) {
  return function (designation) {
    return values[designation.id] || "healthy";
  };
}

test("canonical Coop prefers Sol for execution and Fable for hard judgment", function () {
  var execution = policy.selectRoute("execution");
  var research = policy.selectRoute("research");
  var judgment = policy.selectRoute("architecture");

  assert.equal(execution.ok, true);
  assert.equal(execution.providerRouteId, "codex-openai");
  assert.equal(execution.model, "gpt-5.6-sol");
  assert.equal(research.model, "gpt-5.6-sol");
  assert.equal(judgment.ok, true);
  assert.equal(judgment.providerRouteId, "claude-anthropic");
  assert.equal(judgment.model, "fable");
});

test("degraded and unhealthy designated routes are unavailable to Coop", function () {
  var selected = policy.selectRoute("execution", {
    healthForCandidate: states({
      "codex-openai/gpt-5.6-sol": "degraded",
      "claude-anthropic/fable": "healthy",
    }),
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.model, "fable");

  var unavailable = policy.selectRoute("execution", {
    healthForCandidate: states({
      "codex-openai/gpt-5.6-sol": "degraded",
      "claude-anthropic/fable": "unhealthy",
    }),
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, "coop_top_tier_unavailable");
  assert.match(unavailable.message, /will not fall back/i);
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
    version: 2,
    designations: policy.TOP_TIER_POLICY.designations.concat([{
      id: "codex-openai/gpt-6-sol",
      topTier: true,
      track: "execution",
      generation: 2,
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
    model: "gpt-5.6-sol",
  }, { policy: successorPolicy });
  assert.equal(old.code, "coop_top_tier_required");

  var fallback = policy.selectRoute("execution", {
    policy: successorPolicy,
    healthForCandidate: states({
      "codex-openai/gpt-6-sol": "unhealthy",
      "codex-openai/gpt-5.6-sol": "healthy",
      "claude-anthropic/fable": "healthy",
    }),
  });
  assert.equal(fallback.model, "fable");
  assert.notEqual(fallback.model, "gpt-5.6-sol");
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
  providerHealth.recordFailure("codex", "transient Sol failure", {
    providerRouteId: "codex-openai",
    model: "gpt-5.6-sol",
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
    model: "gpt-5.6-sol",
    queryInstance: query,
  };
  var worker = {
    localId: 2,
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.6-sol",
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
  providerHealth.recordFailure("codex", "Sol unavailable", {
    providerRouteId: "codex-openai",
    model: "gpt-5.6-sol",
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
    model: "gpt-5.6-sol",
    isProcessing: true,
  };

  var result = await bridge.startQuery(session, "continue", null, null);

  assert.deepEqual(result, { ok: false, reason: "coop_top_tier_unavailable" });
  assert.equal(adapterStarts, 0);
  assert.equal(session.isProcessing, false);
  assert.match(recorded[0].text, /no designated top-tier route is healthy/i);
  providerHealth._reset();
});
