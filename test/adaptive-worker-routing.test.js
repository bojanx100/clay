var test = require("node:test");
var assert = require("node:assert/strict");
require("./helpers/isolated-clay-home");
var routing = require("../lib/adaptive-worker-routing");
var providerHealth = require("../lib/provider-health");

function route(id, vendor, family, label, enabled) {
  return {
    id: id,
    vendor: vendor,
    provider: vendor === "github-copilot" ? "github-copilot" : (vendor === "claude" ? "anthropic" : "openai"),
    modelFamily: family,
    label: label,
    enabled: enabled !== false,
    health: "healthy",
    catalogVerified: true,
    catalogSource: "live",
  };
}

function routingState() {
  providerHealth._reset();
  return {
    providerRoutes: [
      route("claude-anthropic", "claude", "claude", "Claude", true),
      route("codex-openai", "codex", "gpt", "Codex", true),
      route("claude-github-copilot", "github-copilot", "claude", "Claude via Copilot", false),
      route("codex-github-copilot", "github-copilot", "gpt", "Codex via Copilot", false),
    ],
    modelsByVendor: {
      claude: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8", "claude-fable-5"],
      codex: ["gpt-5.4-mini", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
      "github-copilot": ["claude-sonnet-4.6", "claude-opus-5", "gpt-5.6-sol"],
    },
  };
}

function parent() {
  return { vendor: "codex", providerRouteId: "codex-openai", model: "gpt-5.6-sol" };
}

function fableTokenState() {
  var state = routingState();
  state.verifiedModelsByRoute = {
    "claude-anthropic": [{
      value: "claude-fable-5[1m]",
      resolvedModel: "claude-fable-5",
      displayName: "Fable",
    }],
  };
  return state;
}

test("phase floors route verification work to the cheapest eligible everyday model", function () {
  var result = routing.selectWorkerRoute(routingState(), parent(), {
    title: "Add regression tests",
    objective: "Add bounded test coverage for the parser.",
  });
  assert.equal(result.tier, "routine");
  assert.equal(result.phase, "verification");
  assert.equal(result.capabilityFloor, 2);
  assert.equal(result.provider, "codex");
  assert.equal(result.model, "gpt-5.6-luna");
  assert.match(result.rationale, /cost rank/);
});

test("architecture and security tasks require a strict frontier route", function () {
  var result = routing.selectWorkerRoute(routingState(), parent(), {
    title: "Review authentication architecture",
    objective: "Threat model the new cross-cutting authorization boundary.",
  });
  assert.equal(result.tier, "strong");
  assert.equal(result.capabilityFloor, 4);
  assert.equal(result.providerRouteId, "claude-anthropic");
  assert.equal(result.model, "claude-fable-5");
});

test("owner provider and model pins are preserved after catalog and capability gates", function () {
  var result = routing.selectWorkerRoute(routingState(), parent(), {
    provider: "claude",
    model: "claude-sonnet-4-6",
    providerPinned: true,
    modelPinned: true,
  });
  assert.equal(result.tier, "pinned");
  assert.equal(result.provider, "claude");
  assert.equal(result.model, "claude-sonnet-4-6");
});

test("Fable pins resolve only through advertised selectable and resolved-model identities", function () {
  var state = fableTokenState();
  var pins = ["fable", "claude-fable-5", "claude-fable-5[1m]"];
  for (var i = 0; i < pins.length; i++) {
    var result = routing.selectWorkerRoute(state, parent(), {
      provider: "claude",
      model: pins[i],
      providerPinned: true,
      modelPinned: true,
    });
    assert.equal(result.blocked, false, pins[i] + " should resolve");
    assert.equal(result.model, "claude-fable-5[1m]",
      pins[i] + " should return the real selectable token");
  }

  var future = routing.selectWorkerRoute(state, parent(), {
    provider: "claude",
    model: "claude-fable-6",
    providerPinned: true,
    modelPinned: true,
  });
  assert.equal(future.blocked, true);
  assert.match(future.rationale, /not advertised/i);
  assert.doesNotMatch(future.rationale, /unhealthy/i);
});

test("a Fable alias is gated by the selected token's health bucket", function () {
  var state = fableTokenState();
  providerHealth.recordFailure("claude", "rate-limit-rejected", {
    providerRouteId: "claude-anthropic",
    model: "claude-fable-5[1m]",
    immediate: true,
  });
  var result = routing.selectWorkerRoute(state, parent(), {
    provider: "claude",
    model: "fable",
    providerPinned: true,
    modelPinned: true,
  });
  assert.equal(result.blocked, true);
  assert.match(result.rationale, /unhealthy/i);
  assert.doesNotMatch(result.rationale, /not advertised/i);
});

test("a provider-only pin still demotes routine work on that provider", function () {
  var result = routing.selectWorkerRoute(routingState(), parent(), {
    title: "Routine documentation",
    objective: "Update docs.",
    provider: "claude",
    providerPinned: true,
  });
  assert.equal(result.provider, "claude");
  assert.equal(result.model, "claude-haiku-4-5");
});

test("disabled or unverified routes fail closed instead of retaining an unsupported model", function () {
  var state = routingState();
  state.providerRoutes[0].enabled = false;
  state.providerRoutes[1].enabled = false;
  var result = routing.selectWorkerRoute(state, {
    vendor: "claude", providerRouteId: "claude-anthropic", model: "best",
  }, {
    title: "Security review",
    objective: "Find vulnerabilities.",
  });
  assert.equal(result.blocked, true);
  assert.equal(result.model, null);
  assert.match(result.rationale, /verified catalog/);
});

test("Fable quota is model-scoped and preserves native Opus availability", function () {
  var state = routingState();
  providerHealth.recordFailure("claude", "rate-limit-rejected", {
    providerRouteId: "claude-anthropic",
    model: "claude-fable-5",
    immediate: true,
  });
  var fable = providerHealth.getRouteHealth("claude", "claude-anthropic", "claude-fable-5");
  var opus = providerHealth.getRouteHealth("claude", "claude-anthropic", "claude-opus-4-8");
  assert.equal(fable.state, "unhealthy");
  assert.equal(opus.state, "healthy");

  var result = routing.selectWorkerRoute(state, parent(), {
    title: "Review provider integration",
    objective: "Audit the bounded failover implementation.",
  });
  assert.equal(result.capabilityFloor, 3);
  assert.notEqual(result.model, "claude-fable-5");
});

test("native Claude never selects Opus 5 when its verified catalog omits it", function () {
  var state = routingState();
  var result = routing.selectWorkerRoute(state, parent(), {
    provider: "claude",
    model: "claude-opus-5",
    providerPinned: true,
    modelPinned: true,
  });
  assert.equal(result.blocked, true);
  assert.match(result.rationale, /verified catalog/);
});

test("frontier fallback prefers a verified compatible Copilot route before Sol", function () {
  var state = routingState();
  state.providerRoutes[2].enabled = true;
  state.verifiedModelsByRoute = {
    "claude-anthropic": ["claude-fable-5"],
    "claude-github-copilot": ["claude-opus-5"],
    "codex-openai": ["gpt-5.6-sol"],
  };
  providerHealth.recordFailure("claude", "rate-limit-rejected", {
    providerRouteId: "claude-anthropic",
    model: "claude-fable-5",
    immediate: true,
  });
  var result = routing.selectWorkerRoute(state, parent(), {
    title: "Security architecture review",
  });
  assert.equal(result.providerRouteId, "claude-github-copilot");
  assert.equal(result.model, "claude-opus-5");
});

test("frontier fallback reaches OpenAI Sol when the compatible Copilot route is unavailable", function () {
  var state = routingState();
  state.verifiedModelsByRoute = {
    "claude-anthropic": ["claude-fable-5"],
    "codex-openai": ["gpt-5.6-sol"],
  };
  providerHealth.recordFailure("claude", "rate-limit-rejected", {
    providerRouteId: "claude-anthropic",
    model: "claude-fable-5",
    immediate: true,
  });
  var result = routing.selectWorkerRoute(state, parent(), {
    title: "Security architecture review",
  });
  assert.equal(result.providerRouteId, "codex-openai");
  assert.equal(result.model, "gpt-5.6-sol");
});

test("stale disabled route snapshots reconcile from an available Codex adapter before selection", function () {
  var state = routingState();
  state.availableVendors = ["codex"];
  state.installedVendors = [];
  state.providerRoutes = [route("codex-openai", "codex", "gpt", "Codex", false)];
  state.verifiedModelsByRoute = { "codex-openai": ["gpt-5.6-sol"] };

  var result = routing.selectWorkerRoute(state, parent(), {
    title: "Repair the cross-project scheduling architecture",
    objective: "Fix the root cause of stale provider-route readiness.",
  });

  assert.equal(result.blocked, false);
  assert.equal(result.providerRouteId, "codex-openai");
  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(state.providerRoutes.find(function (item) {
    return item.id === "codex-openai";
  }).enabled, true);
  assert.deepEqual(state.installedVendors, ["codex"]);
});

test("project route-cost overrides change ranking without lowering the capability floor", function () {
  var state = routingState();
  state.workerRoutingPolicy = {
    routeCosts: { "codex-openai": 50, "claude-anthropic": 0 },
  };
  var result = routing.selectWorkerRoute(state, parent(), {
    title: "Implement the settings panel",
  });
  assert.equal(result.capabilityFloor, 2);
  assert.equal(result.provider, "claude");
  assert.equal(result.model, "claude-sonnet-4-6");
});
